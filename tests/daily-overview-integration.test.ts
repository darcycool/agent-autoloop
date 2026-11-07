// Failure modes: synthetic client fixtures disagree with real public facts, replay misses answers/timers/receipts,
// or restart loses history. This runs only a temporary hub, no worker, external agent, channel or notification.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Cache, Feed } from "../plugins/daily-overview/feed.ts";
import { dateAt } from "../plugins/daily-overview/model.ts";
import { setup } from "./helpers.ts";
const home = setup("overview-integration");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const server = serve(0);
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const owner = hub.addKey("owner", "viewer");
const file = join(home, "cache", "facts.sqlite");
let cache = new Cache(file),
  feed = new Feed(cache, url, owner);
after(async () => {
  await feed.close();
  cache.close();
  server.closeAllConnections();
  server.close();
});
async function caughtUp() {
  const seq = hub.logAfter(0, 10000).at(-1)!.seq;
  for (let i = 0; i < 200; i++) {
    if (cache.seq >= seq) return;
    await delay(10);
  }
  assert.fail(JSON.stringify(feed.status()));
}

test("the plugin consumes real HTTP history and follows a question and timer after restart", async () => {
  const at = Date.now();
  const rules = hub.parseRules(
    JSON.stringify({
      timezone: "Asia/Shanghai",
      sources: { app: { name: "应用" } },
      agents: { helper: { name: "助手", worker: "local", use: "command", command: ["true"] } },
      channels: {},
      rules: [
        {
          name: "跟进",
          when: { source: "app", types: ["work"] },
          to: "helper",
          cwd: "/tmp",
          parallel: 2,
          prompt: "处理",
        },
      ],
    }),
    at,
  );
  hub.execute("rules", [rules], at);
  hub.ingest("app", { id: "one", type: "work", subject: "42", summary: "处理42" }, at + 10);
  const first = hub.claimNext("local", "one", at + 20)!;
  hub.finish(
    first.run,
    first.token,
    {
      outcome: "done",
      summary: "等待选择",
      ask: [{ key: "env", title: "哪个环境", text: "请选择", options: ["测试", "生产"] }],
      later: [{ key: "check", at: new Date(at + 100000).toISOString(), about: "核对结果" }],
    },
    at + 40,
  );
  feed.start();
  await caughtUp();
  let report = cache.latest.report(dateAt(at, "Asia/Shanghai"), at + 50);
  assert.equal(report.activities.length, 1);
  assert.equal(report.pending[0].state, "waiting");
  assert.equal(report.activities[0].executionMs, 20);
  const id = report.activities[0].id;
  const card = hub.stateOf(at + 50).cards.find((card: any) => card.kind === "ask")!;
  hub.answer(card.id, { choice: 1, by: "本人" }, at + 60);
  const continued = hub.claimNext("local", "two", at + 70)!;
  hub.finish(continued.run, continued.token, { outcome: "done", summary: "完成处理" }, at + 90);
  await caughtUp();
  assert.equal(cache.latest.detail(id, at + 95)!.runs, 2);
  assert.equal(cache.latest.detail(id, at + 95)!.executionMs, 40);
  assert.equal(cache.latest.detail(id, at + 95)!.state, "scheduled");
  await feed.close();
  cache.close();
  cache = new Cache(file);
  feed = new Feed(cache, url, owner);
  feed.start();
  // Advance the fixture's clock without reloading the unrelated rules file over its in-memory configuration.
  hub.execute("tick", [], at + 100010);
  await caughtUp();
  report = cache.latest.report(dateAt(at, "Asia/Shanghai"), at + 100020);
  assert.equal(report.activities.length, 1);
  assert.equal(report.activities[0].id, id);
  assert.equal(cache.latest.detail(id, at + 100020)!.runs, 3);
  assert.equal(cache.latest.detail(id, at + 100020)!.state, "queued");
  hub.execute("rules", [{ ...rules, timezone: "America/New_York" }], at + 100030);
  await caughtUp();
  assert.equal(feed.timezone(), "America/New_York");
});

test("one command opens a read-only local endpoint and SIGTERM leaves the hub running", async () => {
  const { spawn } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, owner }));
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(import.meta.dirname, "../bin/agent-autoloop.ts"),
      "overview",
      "--no-open",
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  try {
    for (let i = 0; i < 300 && !/http:\/\/127\.0\.0\.1:\d+\/open\/[a-f0-9]+/.test(output); i++) await delay(10);
    const entry = /http:\/\/127\.0\.0\.1:\d+\/open\/[a-f0-9]+/.exec(output)?.[0];
    assert.ok(entry, errors || output);
    assert.ok(!output.includes(owner));
    const response = await fetch(entry, { redirect: "manual" });
    assert.equal(response.status, 303);
    const base = new URL(entry).origin,
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(base + "/api/day", { headers: { cookie } })).status, 200);
    child.kill("SIGTERM");
    assert.deepEqual(await exited, [0, null]);
    assert.equal((await fetch(url + "/healthz")).status, 200);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
