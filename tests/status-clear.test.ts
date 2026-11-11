// Failure modes: clearing known unmatched events hides new events too, forgets on the next CLI invocation, or changes
// the hub's history and event deduplication. The local display preference must preserve credentials and raw JSON output.
// A failed status request or conflicting --json must not advance the saved cutoff.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { setup } from "./helpers.ts";

const home = setup("status-clear");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const server = serve(0);
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});
const file = join(home, "config.json");
const config = {
  url: `http://127.0.0.1:${(server.address() as any).port}`,
  owner: hub.addKey("owner", "reader"),
  worker: { name: "w1", key: "keep-this-worker-key", capacity: 3 },
};
writeFileSync(file, JSON.stringify(config));
const saved = () => JSON.parse(readFileSync(file, "utf8"));
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      [join(import.meta.dirname, "../bin/agent-autoloop.ts"), "status", ...args],
      {
        env: { ...process.env },
      },
    )
  ).stdout;

test("clear-unrouted persists only the local display cutoff, preserves history, and still shows new events", async () => {
  const events = Array.from({ length: 30 }, (_, index) => ({
    id: `known-${index}`,
    type: "unmatched.event",
    summary: `已知事件-${index}`,
  }));
  for (const event of events) hub.ingest("app", event);
  assert.match(await cli(), /没有规则接的事件/);
  const before = hub.stateOf().unrouted;
  const cleared = await cli("--clear-unrouted");
  assert.doesNotMatch(cleared, /没有规则接的事件\n|已知事件-/);
  assert.doesNotMatch(await cli(), /没有规则接的事件|已知事件-/);
  const updated = saved();
  assert.deepEqual(updated.worker, config.worker);
  assert.equal(updated.owner, config.owner);
  assert.equal(updated.status.unroutedThrough, before[0].id);
  assert.deepEqual(hub.stateOf().unrouted, before, "no business facts are changed");
  assert.deepEqual(JSON.parse(await cli("--json")).unrouted, before, "JSON stays the raw protocol response");
  assert.equal(hub.ingest("app", events[29]).duplicate, true, "deduplication remains intact");

  hub.ingest("app", { id: "new-after-clear", type: "unmatched.event", summary: "后来新来的事件" });
  const next = await cli();
  assert.match(next, /后来新来的事件/);
  assert.doesNotMatch(next, /已知事件-/);
  await cli("--clear-unrouted");
  const cutoff = saved().status.unroutedThrough;
  await cli("--clear-unrouted");
  assert.equal(saved().status.unroutedThrough, cutoff, "clearing twice does not forget the cutoff");
});

test("JSON and failed requests never change the saved cutoff", async () => {
  const before = readFileSync(file, "utf8");
  await assert.rejects(cli("--json", "--clear-unrouted"), /不能.*一起用/);
  assert.equal(readFileSync(file, "utf8"), before);
  writeFileSync(file, JSON.stringify({ ...saved(), owner: "wrong-owner-key" }));
  const bad = readFileSync(file, "utf8");
  await assert.rejects(cli("--clear-unrouted"));
  assert.equal(readFileSync(file, "utf8"), bad);
  writeFileSync(file, before);
});
