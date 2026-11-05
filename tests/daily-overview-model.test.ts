// Failure modes: retry time disappears or includes backoff; a heartbeat invents daily work; yesterday changes after an
// answer today; answers and timers lose their originating business; merged queued work is counted twice; batches are split.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Overview, dayRange, type Fact } from "../plugins/daily-overview/model.ts";

const base = Date.parse("2026-11-04T23:50:00+08:00");
const time = (minutes: number) => base + minutes * 60000;
function fixture() {
  const view = new Overview();
  let seq = 0;
  const rows = new Map<string, Record<string, any>>();
  const fact = (minute: number, type: string, changes: [string, string | number, Record<string, any> | null][]) => {
    const item: Fact = {
      version: 1,
      seq: ++seq,
      at: time(minute),
      type,
      changes: changes.map(([table, key, patch]) => {
        const identity = `${table}:${key}`;
        const row = patch === null ? null : { ...rows.get(identity), ...patch };
        if (row) rows.set(identity, row);
        else rows.delete(identity);
        return { table, key: String(key), row };
      }),
    };
    view.apply(item);
    return item;
  };
  const event = (id: number, subject = "#42", type = "feedback.new") =>
    [
      "events",
      id,
      {
        id,
        source: "app",
        subject,
        type,
        summary: `处理 ${subject}`,
        detail: "原始资料",
        received_at: new Date(time(0)).toISOString(),
      },
    ] as [string, number, any];
  const run = (id: number, eventId = id) =>
    [
      [
        "runs",
        id,
        { id, rule: "处理反馈", lane: "", state: "queued", attempts: 0, created_at: new Date(time(0)).toISOString() },
      ],
      ["run_events", `${id}:${eventId}`, { run_id: id, event_id: eventId }],
    ] as [string, string | number, any][];
  const claim = (id: number, minute: number) =>
    fact(minute, "claimNext", [
      ["runs", id, { state: "claimed", issued: seq + 1, claimed_at: new Date(time(minute)).toISOString() }],
    ]);
  const finish = (id: number, minute: number, failed = false, extras: [string, string | number, any][] = []) =>
    fact(minute, "finish", [
      [
        "runs",
        id,
        {
          issued: null,
          last_issued: rows.get(`runs:${id}`)!.issued,
          last_result: `result-${seq}`,
          state: failed ? "queued" : "done",
          attempts: failed ? 1 : 0,
          claimed_at: failed ? null : rows.get(`runs:${id}`)!.claimed_at,
          finished_at: failed ? null : new Date(time(minute)).toISOString(),
          summary: failed ? "" : "本轮结束",
          error: failed ? "连接失败" : null,
        },
      ],
      ...extras,
    ]);
  return { view, fact, event, run, claim, finish };
}

test("each attempt is counted once, backoff excluded, and running across midnight is activity", () => {
  const f = fixture();
  f.fact(0, "ingest", [f.event(1), ...f.run(1)]);
  f.claim(1, 1);
  f.fact(2, "claimNext", [["runs", 1, { seen_at: new Date(time(2)).toISOString() }]]);
  f.finish(1, 4, true);
  f.claim(1, 9);
  const across = f.view.report("2026-11-05", time(11));
  assert.equal(across.activities.length, 1);
  assert.equal(across.activities[0].executionMs, 5 * 60000);
  f.finish(1, 12);
  const today = f.view.report("2026-11-05", time(20));
  assert.equal(today.activities[0].executionMs, 6 * 60000);
  assert.equal(today.activities[0].elapsedMs, 12 * 60000);
  assert.equal(today.pending.length, 0);
});

test("an answer continues the original thing, while the previous day remains waiting", () => {
  const f = fixture();
  const facts: Fact[] = [
    f.fact(0, "ingest", [f.event(1), ...f.run(1)]),
    f.claim(1, 1),
    f.finish(1, 2, false, [
      [
        "cards",
        7,
        {
          id: 7,
          run_id: 1,
          rule: "处理反馈",
          kind: "ask",
          state: "open",
          title: "确认环境",
          text: "请选择",
          created_at: new Date(time(2)).toISOString(),
        },
      ],
    ]),
  ];
  const id = f.view.report("2026-11-04", time(8)).activities[0].id;
  facts.push(
    f.fact(15, "answer", [
      f.event(2, "", "card.answered"),
      ["cards", 7, { state: "decided", answer_event: 2, answer: "测试环境" }],
      ...f.run(2),
    ]),
    f.claim(2, 16),
    f.finish(2, 17, false, [["cards", 7, { state: "done" }]]),
  );
  assert.equal(f.view.report("2026-11-05", time(20)).activities[0].id, id);
  assert.equal(f.view.report("2026-11-05", time(20)).activities[0].runs, 2);
  const yesterday = new Overview();
  for (const fact of facts) if (fact.at < dayRange("2026-11-04", "Asia/Shanghai").end) yesterday.apply(fact);
  assert.equal(yesterday.report("2026-11-04", time(20)).pending[0].state, "waiting");
  f.fact(21, "ingest", [f.event(3), ...f.run(3)]);
  assert.equal(f.view.report("2026-11-05", time(22)).activities.length, 2);
});

test("waiting alone is pending, and presence updates do not invent activity", () => {
  const f = fixture();
  f.fact(0, "ingest", [f.event(1), ...f.run(1)]);
  f.claim(1, 1);
  f.finish(1, 2, false, [["cards", 1, { id: 1, run_id: 1, kind: "ask", state: "open", title: "确认", text: "内容" }]]);
  f.fact(20, "heartbeat", [["seen", "worker:w1", { seen_at: new Date(time(20)).toISOString() }]]);
  const report = f.view.report("2026-11-05", time(30));
  assert.equal(report.activities.length, 0);
  assert.equal(report.pending.length, 1);
});

test("a batch retains shared time, and a merged queued run leaves one thing", () => {
  const f = fixture();
  f.fact(0, "ingest", [f.event(1, "A"), ...f.run(1)]);
  f.claim(1, 1);
  f.fact(2, "ingest", [f.event(2, "B"), ...f.run(2)]);
  f.finish(1, 3, true, [
    ["run_events", "1:2", { run_id: 1, event_id: 2 }],
    ["run_events", "2:2", null],
    ["runs", 2, null],
  ]);
  const report = f.view.report("2026-11-04", time(8));
  assert.equal(report.activities.length, 1);
  assert.equal(report.activities[0].batch, true);
  assert.equal(report.activities[0].executionMs, 2 * 60000);
});

test("timer continuation attaches to its receipt, and separate scheduled triggers stay separate", () => {
  const f = fixture();
  f.fact(0, "tick", [f.event(1, "", "schedule.tick"), ...f.run(1)]);
  f.claim(1, 1);
  f.finish(1, 2, false, [
    [
      "timers",
      9,
      { id: 9, rule: "处理反馈", lane: "", event_id: null, about: "再看一次", at: new Date(time(20)).toISOString() },
    ],
  ]);
  f.fact(20, "tick", [f.event(2, "", "timer.due"), ["timers", 9, { event_id: 2 }], ...f.run(2)]);
  assert.equal(f.view.report("2026-11-05", time(21)).activities[0].runs, 2);
  f.fact(22, "tick", [f.event(3, "", "schedule.tick"), ...f.run(3)]);
  assert.equal(f.view.report("2026-11-05", time(23)).activities.length, 2);
});

test("unknown execution and missing time stay uncertain; Shanghai and DST dates use real boundaries", () => {
  const f = fixture();
  f.fact(0, "ingest", [f.event(1), ...f.run(1)]);
  f.claim(1, 1);
  f.fact(20, "tick", [["runs", 1, { state: "unknown" }]]);
  assert.equal(f.view.report("2026-11-05", time(30)).pending[0].executionMs, null);
  assert.equal(dayRange("2026-11-05", "Asia/Shanghai").start, Date.parse("2026-11-04T16:00:00Z"));
  const dst = dayRange("2026-11-01", "America/New_York");
  assert.equal(dst.end - dst.start, 25 * 3600000);
  assert.throws(() => dayRange("2026-02-30", "Asia/Shanghai"));
});

test("final writes in one fact win, clock reversal is uncertain, and cancellation waits for exit", () => {
  const f = fixture();
  f.fact(0, "ingest", [f.event(1), ...f.run(1)]);
  f.claim(1, 2);
  f.fact(3, "cancel", [["runs", 1, { cancel_at: new Date(time(3)).toISOString() }]]);
  assert.equal(f.view.report("2026-11-04", time(4)).pending[0].state, "stopping");
  f.finish(1, 1);
  assert.equal(f.view.report("2026-11-04", time(5)).activities[0].executionMs, null);
  assert.equal(f.view.report("2026-11-04", time(5)).activities[0].elapsedMs, 60000);
});

test("completed work with no claim time is unknown and later episodes stay associated by object", () => {
  const f = fixture();
  f.fact(0, "ingest", [f.event(1), ...f.run(1)]);
  f.fact(2, "finish", [
    ["runs", 1, { state: "done", finished_at: new Date(time(2)).toISOString(), claimed_at: null, summary: "完成" }],
  ]);
  const first = f.view.report("2026-11-04", time(3)).activities[0];
  assert.equal(first.executionMs, null);
  f.fact(4, "ingest", [f.event(2), ...f.run(2)]);
  assert.equal(f.view.detail(first.id, time(5))!.related.length, 1);
});

test("a later scheduled trigger replacing a shared timer takes its ownership without keeping the old episode pending", () => {
  const f = fixture();
  f.fact(0, "tick", [f.event(1, "", "schedule.tick"), ...f.run(1)]);
  f.claim(1, 1);
  f.finish(1, 2, false, [
    ["timers", 9, { id: 9, rule: "处理反馈", event_id: null, at: new Date(time(30)).toISOString() }],
  ]);
  f.fact(10, "tick", [f.event(2, "", "schedule.tick"), ...f.run(2)]);
  f.claim(2, 11);
  f.finish(2, 12, false, [["timers", 9, { at: new Date(time(40)).toISOString() }]]);
  const report = f.view.report("2026-11-05", time(15));
  assert.equal(report.pending.length, 1);
  assert.equal(report.pending[0].id, "thing-2");
  assert.equal(f.view.detail("thing-1", time(15))!.closedAt, time(12));
});

test("a queued continuation preserves the last receipt instead of claiming there is none", () => {
  const f = fixture();
  f.fact(0, "ingest", [f.event(1), ...f.run(1)]);
  f.claim(1, 1);
  f.finish(1, 2, false, [["cards", 7, { id: 7, run_id: 1, kind: "ask", state: "open", title: "确认" }]]);
  f.fact(15, "answer", [
    f.event(2, "", "card.answered"),
    ["cards", 7, { state: "decided", answer_event: 2 }],
    ...f.run(2),
    ["runs", 2, { created_at: new Date(time(15)).toISOString() }],
  ]);
  assert.equal(f.view.report("2026-11-05", time(16)).pending[0].summary, "本轮结束");
});
