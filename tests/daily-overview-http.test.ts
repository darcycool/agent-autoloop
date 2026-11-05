// Failure modes: another website reads the owner's history, a write is proxied to the hub, arbitrary files are served,
// secrets or unsafe event markup reach HTML, or a historical view changes to today's state.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { Cache } from "../plugins/daily-overview/feed.ts";
import { startViewer } from "../plugins/daily-overview/server.ts";
import { setup } from "./helpers.ts";
import { join } from "node:path";
import { request } from "node:http";
const home = setup("overview-http");
const cache = new Cache(join(home, "cache", "facts.sqlite"));
const now = Date.parse("2026-11-05T02:00:00Z");
const viewer = await startViewer({
  cache,
  now: () => now,
  timezone: () => "Asia/Shanghai",
  status: () => ({ covered: true, connection: "connected" }),
});
after(() => {
  viewer.server.closeAllConnections();
  viewer.server.close();
  cache.close();
});
const base = new URL(viewer.url).origin;
const opening = await fetch(viewer.url, { redirect: "manual" });
const cookie = opening.headers.get("set-cookie")!.split(";")[0];
const get = (path: string, headers = {}) => fetch(base + path, { headers: { cookie, ...headers } });

test("bootstrap keeps the hub credential out of the browser and protects local requests", async () => {
  assert.equal(opening.status, 303);
  assert.match(opening.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base + "/api/day")).status, 401);
  assert.equal((await get("/api/day", { origin: "https://evil.test" })).status, 403);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    request(base + "/api/day", { headers: { host: "evil.test", cookie } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on("error", reject)
      .end();
  });
  assert.equal(badHost, 403);
  assert.equal((await get("/api/day", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await fetch(base + "/api/day", { method: "POST", headers: { cookie } })).status, 405);
  assert.equal((await get("/server.ts")).status, 404);
  const page = await get("/");
  assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.ok(!(await page.text()).includes(new URL(viewer.url).pathname));
});

test("date endpoints reject bad/future dates and preserve the end-of-day state", async () => {
  const at = Date.parse("2026-11-04T01:00:00Z");
  cache.append({
    version: 1,
    seq: 1,
    at,
    type: "ingest",
    changes: [
      {
        table: "events",
        key: "1",
        row: { id: 1, source: "app", type: "work", subject: "42", summary: '<img src=x onerror="alert(1)">' },
      },
      {
        table: "runs",
        key: "1",
        row: { id: 1, rule: "测试", state: "queued", attempts: 0, created_at: new Date(at).toISOString() },
      },
      { table: "run_events", key: "1:1", row: { run_id: 1, event_id: 1 } },
    ],
  });
  cache.append({
    version: 1,
    seq: 2,
    at: now,
    type: "cancel",
    changes: [
      {
        table: "runs",
        key: "1",
        row: { id: 1, rule: "测试", state: "cancelled", created_at: new Date(at).toISOString() },
      },
    ],
  });
  const yesterday = (await (await get("/api/day?date=2026-11-04")).json()) as any;
  assert.equal(yesterday.pending[0].state, "queued");
  const detail = (await (await get("/api/things/thing-1?date=2026-11-04")).json()) as any;
  assert.equal(detail.thing.state, "queued");
  assert.equal(detail.latest.state, "cancelled");
  assert.match(detail.thing.title, /<img/);
  assert.equal((await get("/api/day?date=2026-02-30")).status, 400);
  assert.equal((await get("/api/day?date=2026-11-06")).status, 400);
});
