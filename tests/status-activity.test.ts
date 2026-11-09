// Failure modes: minute-by-minute polls crowd other matters and older active runs out of status; summaries merge
// different lanes, hide manual or stopped runs, count retries or the wrong day's work, or change raw history paging.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, beforeEach, test } from "node:test";
import { dayStart } from "../kernel/cron.ts";
import { setup } from "./helpers.ts";

const home = setup("status-activity");
const hub = await import("./hub.ts");
// Serve the real snapshot on the test's clock without a wall-clock scheduler changing the history under it.
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(hub.stateOf(readAt)));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}`, owner: hub.addKey("owner", "reader") }),
);
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(process.execPath, [join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args], {
      env: process.env,
    })
  ).stdout;
const start = dayStart(Date.now(), "Asia/Shanghai") + 10 * 3600_000;
const at = (minute: number) => start + minute * 60_000;
let readAt = at(66);
const configuration = {
  timezone: "Asia/Shanghai",
  sources: { app: { name: "应用" } },
  agents: {
    jobs: { name: "助手", worker: "jobs", use: "command", command: ["true"] },
    poll: { name: "采集", worker: "poll", use: "command", command: ["true"] },
    idle: { name: "年报", worker: "idle", use: "command", command: ["true"] },
  },
  channels: {},
  rules: [
    { name: "处理待办", when: { source: "app", types: ["work.new"] }, to: "jobs", cwd: "~/x", parallel: 20 },
    { name: "串行处理", when: { source: "app", types: ["serial.new"] }, to: "jobs", cwd: "~/x" },
    { name: "采集待办", when: { cron: "* * * * *" }, to: "poll", cwd: "~/x" },
    { name: "年报", when: { cron: "0 0 1 1 *" }, to: "idle", cwd: "~/x" },
  ],
  elsewhere: [{ name: "外部清理", source: "app", to: "jobs", cron: "0 6 * * 0", where: "另一个应用" }],
};
beforeEach(() => {
  readAt = at(66);
  for (const table of [
    "run_events",
    "runs",
    "events",
    "seen",
    "cards",
    "deliveries",
    "timers",
    "schedules",
    "due",
    "pauses",
  ] as const)
    hub.fixtureClear(table);
  hub.execute("rules", [hub.parseRules(JSON.stringify(configuration), at(0))], at(0));
  hub.execute("tick", [], at(0));
});

let stamp = 0;
function work(subject: string, minute: number, type = "work.new") {
  const id = `work-${++stamp}`;
  hub.ingest("app", { id, type, subject }, at(minute));
  return hub.claimNext("jobs", id, at(minute))!;
}
function done(subject: string, minute: number, summary = "做完了", type = "work.new") {
  const job = work(subject, minute, type);
  hub.finish(job.run, job.token, { outcome: "done", summary }, at(minute) + 1000);
  return job;
}
function poll(minute: number, outcome = "done") {
  hub.execute("tick", [], at(minute));
  const job = hub.claimNext("poll", `poll-${++stamp}`, at(minute))!;
  hub.finish(job.run, job.token, { outcome, summary: "已核对待办" }, at(minute) + 1000);
  return job;
}

test("normal scheduled runs share a summary while other matters survive beyond the raw history page", async () => {
  const memo = done("#memo", 0, "已完成备忘编辑");
  let latest;
  for (let minute = 1; minute <= 65; minute++) latest = poll(minute);
  const state = hub.stateOf(at(66));
  assert.ok(Array.isArray(state.recentMatters));
  assert.deepEqual(
    state.recentMatters.map((run: any) => [run.id, run.lane]),
    [[memo.run, "#memo"]],
  );
  assert.ok(!state.runs.some((run) => run.id === memo.run));
  const next = hub.stateOf(at(66), state.nextBefore!);
  assert.ok(next.runs.some((run) => run.id === memo.run));
  assert.ok(next.runs.every((run) => run.id < state.nextBefore!));
  assert.deepEqual(next.recentMatters, []);
  assert.ok(next.lines.every((line) => line.scheduleSummary === null));
  const summary = state.lines.find((line) => line.name === "采集待办")!.scheduleSummary!;
  assert.equal(summary.latest!.id, latest!.run);
  assert.equal(summary.normalToday, 65);
  assert.equal(state.lines.find((line) => line.name === "处理待办")!.scheduleSummary, null);

  const human = await cli("status");
  const recent = human.split("\n最近处理的事项\n")[1]?.split("\n定时运行\n")[0];
  assert.match(recent ?? "", /#memo.*已完成备忘编辑/);
  assert.doesNotMatch(recent ?? "", /采集待办/);
  assert.match(human, /定时运行[\s\S]*采集待办[\s\S]*今天正常结束 65 轮/);
  assert.match(human, /年报[\s\S]*尚未运行/);
  assert.match(human, /外部清理（在别处：另一个应用）/);
  assert.doesNotMatch(human, /最近几轮/);
});

test("every active run remains visible, with retry, uncertainty and stopping distinguished", async () => {
  const lost = work("#lost", 0);
  const retrying = work("#retry", 0);
  hub.finish(retrying.run, retrying.token, { outcome: "failed", error: "连接失败" }, at(0));
  const stopping = work("#stop", 0);
  hub.cancel(stopping.run, at(0));
  const running = work("#running", 0);
  const queued = Array.from({ length: 9 }, (_, i) => {
    const id = `queued-${i}`;
    return hub.ingest("app", { id, type: "work.new", subject: `#${id}` }, at(0));
  });
  hub.heartbeat("jobs", [stopping.run, running.run], at(6));
  hub.sweep(at(6));
  for (let minute = 7; minute <= 71; minute++) poll(minute);
  readAt = at(72);
  const state = hub.stateOf(readAt);
  assert.equal(state.runs.find((run) => run.id === lost.run)!.state, "unknown");
  assert.equal(state.runs.find((run) => run.id === lost.run)!.lane, "#lost");
  const human = await cli("status");
  const active = human.split("\n当前在做与异常\n")[1]?.split("\n定时运行\n")[0] ?? "";
  assert.match(active, new RegExp(`#${lost.run} .*不确定`));
  assert.match(active, new RegExp(`#${retrying.run} .*等重派：连接失败，下次 `));
  assert.match(active, new RegExp(`#${stopping.run} .*正在停止`));
  assert.match(active, new RegExp(`#${running.run} .*在跑`));
  for (let i = 0; i < queued.length; i++) assert.ok(active.includes(`#queued-${i} 排队`));
  const ids = [...active.matchAll(/^  #(\d+) /gm)].map((match) => Number(match[1]));
  assert.deepEqual(
    ids,
    state.runs.filter((run) => ["claimed", "queued", "unknown"].includes(run.state)).map((run) => run.id),
  );
});

test("recent matters use actual lanes and completion order, including a long-running older round", () => {
  const long = work("#memo", 0);
  const first = done("#user", 1, "同样的标题");
  const other = done("#other", 2, "同样的标题");
  const serial = done("#one", 3, "旧串行结果", "serial.new");
  const latestSerial = done("#two", 4, "最新串行结果", "serial.new");
  const latestUser = done("#user", 5, "最新用户结果");
  hub.finish(long.run, long.token, { outcome: "done", summary: "旧轮次最后完成" }, at(6));
  const recent = hub.stateOf(at(7)).recentMatters;
  assert.deepEqual(
    recent.map((run) => [run.id, run.lane]),
    [
      [long.run, "#memo"],
      [latestUser.run, "#user"],
      [latestSerial.run, ""],
      [other.run, "#other"],
    ],
  );
  assert.ok(!recent.some((run) => run.id === first.run || run.id === serial.run));
});

test("the recent limit applies after grouping and ties favor the newer round", () => {
  const old = done("#old", 0);
  const jobs = Array.from({ length: 8 }, (_, i) => work(`#matter-${i}`, 0));
  for (const job of jobs) hub.finish(job.run, job.token, { outcome: "done" }, at(1));
  for (let i = 0; i < 10; i++) {
    const repeated = work("#matter-0", 2);
    hub.finish(repeated.run, repeated.token, { outcome: "nothing" }, at(3));
  }
  const recent = hub.stateOf(at(4)).recentMatters;
  assert.deepEqual(
    recent.map((run) => run.lane),
    ["#matter-0", "#matter-7", "#matter-6", "#matter-5", "#matter-4", "#matter-3", "#matter-2", "#matter-1"],
  );
  assert.ok(!recent.some((run) => run.id === old.run));
});

test("manual and stopped schedule runs stay in recent matters after later normal polls", async () => {
  const stopped = hub.execute("runRule", ["采集待办", "owner", {}], at(0));
  const job = hub.claimNext("poll", "stop-poll", at(0))!;
  hub.finish(job.run, job.token, { outcome: "failed", error: "网络断开" }, at(0));
  hub.cancel(stopped.run, at(0));
  poll(1);
  const before = hub.stateOf(at(2)).recentMatters;
  assert.deepEqual(
    before.map((run) => [run.id, run.state]),
    [[stopped.run, "cancelled"]],
  );
  assert.equal(before[0].error, "网络断开");
  const human = await cli("status");
  assert.match(human, new RegExp(`#${stopped.run} 采集待办 停了.*网络断开`));
  assert.doesNotMatch(human, new RegExp(`#${stopped.run} 采集待办 失败`));

  const manual = hub.execute("runRule", ["采集待办", "owner", {}], at(2));
  const manualJob = hub.claimNext("poll", "manual-poll", at(2))!;
  hub.finish(manualJob.run, manualJob.token, { outcome: "done", summary: "手动核对结果" }, at(2));
  const automatic = poll(3);
  const state = hub.stateOf(at(4));
  assert.deepEqual(
    state.recentMatters.map((run) => [run.id, run.manual]),
    [[manual.run, true]],
  );
  const summary = state.lines.find((line) => line.name === "采集待办")!.scheduleSummary!;
  assert.equal(summary.latest!.id, automatic.run);
  assert.equal(summary.normalToday, 2);
});

test("schedule counts include nothing once and follow the finish day's rule timezone", () => {
  hub.fixtureClear("schedules");
  hub.execute("tick", [], at(-602));
  poll(-601);
  poll(-600, "nothing");
  hub.execute("tick", [], at(1));
  const retry = hub.claimNext("poll", "first-try", at(1))!;
  hub.finish(retry.run, retry.token, { outcome: "failed", error: "暂时断开" }, at(1));
  const waiting = hub.stateOf(at(2)).lines.find((line) => line.name === "采集待办")!.scheduleSummary!;
  assert.equal(waiting.latest!.state, "queued");
  assert.equal(waiting.latest!.attempts, 1);
  assert.equal(waiting.normalToday, 1, "midnight in Shanghai already belongs to today");
  const retried = hub.claimNext("poll", "second-try", at(6))!;
  assert.equal(retried.run, retry.run);
  hub.finish(retried.run, retried.token, { outcome: "done" }, at(6));
  const state = hub.stateOf(at(7));
  const summary = state.lines.find((line) => line.name === "采集待办")!.scheduleSummary!;
  assert.equal(summary.normalToday, 2);
  assert.equal(summary.latest!.state, "done");
});

test("empty history and removed rules remain readable without changing JSON output", async () => {
  const empty = hub.stateOf(at(0));
  assert.deepEqual(empty.recentMatters, []);
  assert.deepEqual(empty.lines.find((line) => line.name === "采集待办")!.scheduleSummary, {
    latest: null,
    normalToday: 0,
  });
  const old = poll(1);
  const noRules = { ...configuration, rules: [], elsewhere: [] };
  hub.execute("rules", [hub.parseRules(JSON.stringify(noRules), at(2))], at(2));
  assert.deepEqual(
    hub.stateOf(at(2)).recentMatters.map((run) => run.id),
    [old.run],
  );
  assert.match(await cli("status"), /采集待办 做完了/);
  const json = JSON.parse(await cli("status", "--json"));
  assert.deepEqual(json, hub.stateOf(readAt));
  assert.equal(json.runs[0].lane, "");
  assert.equal(json.nextBefore, null);
  assert.equal(json.hasMore, false);
});
