// Failure modes: a sleeping worker interrupts the owner outside working hours, on a holiday, or on a weekend;
// a deferred warning never wakes at opening time, spins the due timer, ignores a makeup workday, or arrives after recovery.
// Cards already waiting for a channel escape the hours gate; ordinary questions get silenced along with offline notices.
// Invalid hours or calendar dates silently turn the protection off; a rules reload leaves the old warning deadline behind.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";

const environment = { secret: "offline-hours-test", publicUrl: "https://hub.test" };
const time = (at: string) => Date.parse(`${at}+08:00`);
const hours = {
  start: "09:00",
  end: "19:00",
  daysOff: ["2026-01-01", "2026-01-02", "2026-01-03"],
  daysOn: ["2026-01-04"],
};
const fixture = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
fixture.rules = fixture.rules.filter((rule: any) => "source" in rule.when);
function configured(workerOffline?: unknown) {
  return parseRules(JSON.stringify({ ...fixture, workerOffline }), 0, "UTC");
}
function hub(at: string, workerOffline: unknown = hours) {
  let view = empty();
  const log: Fact[] = [];
  const act = (at: string, type: string, ...args: unknown[]) => {
    const decision = decide(view, { type, args }, time(at), environment);
    log.push(...decision.facts);
    view = evolve(view, decision.facts);
    return decision.value;
  };
  act(at, "rules", configured(workerOffline));
  return {
    act,
    cards: () => rows(view, "cards").filter((card) => card.key.startsWith("worker:w1:offline:")),
    due: () => rows(view, "due").filter((due) => due.kind === "offline"),
    cardDue: () => rows(view, "due").filter((due) => due.kind === "offline-card"),
    replay: () => assert.deepEqual(snapshot(evolve(empty(), log)), snapshot(view)),
  };
}

test("offline warnings wait for working hours, including statutory holidays and makeup Sundays", () => {
  for (const [away, opening] of [
    ["2026-11-11T08:00:00", "2026-11-11T09:00:00"],
    ["2026-11-11T19:00:00", "2026-11-12T09:00:00"],
    ["2026-11-13T18:50:00", "2026-11-16T09:00:00"],
    ["2026-11-14T10:00:00", "2026-11-16T09:00:00"],
    ["2025-12-31T19:00:00", "2026-01-04T09:00:00"],
  ]) {
    for (const seen of [false, true]) {
      const h = hub(away);
      if (seen) h.act(away, "heartbeat", "w1", []);
      h.act(away, "ingest", "app", { id: "waiting", type: "feedback.new" });
      const afterTen = new Date(time(away) + 600001 + 8 * 3600000).toISOString().slice(0, -1);
      h.act(afterTen, "tick");
      assert.equal(h.cards().length, 0, `${away}: quiet after ten minutes`);
      assert.deepEqual(
        h.due().map((due) => due.at),
        [time(opening)],
      );
      h.act(opening, "tick");
      assert.equal(h.cards().length, 1, `${opening}: still away when working hours begin`);
      assert.equal(h.act(opening, "nextCard", "chat").title, "接单程序没连上");
      assert.deepEqual(h.due(), [], "no immediate timer loop or second warning");
      h.replay();
    }
  }
});

test("working hours keep the ten-minute threshold, include 09:00 and exclude 19:00", () => {
  const h = hub("2026-11-11T08:49:59.999");
  h.act("2026-11-11T08:49:59.999", "ingest", "app", { id: "waiting", type: "feedback.new" });
  h.act("2026-11-11T08:59:59.999", "tick");
  assert.equal(h.cards().length, 0);
  h.act("2026-11-11T09:00:00", "tick");
  assert.equal(h.cards().length, 1);
  const late = hub("2026-11-11T18:49:00");
  late.act("2026-11-11T18:49:00", "ingest", "app", { id: "waiting", type: "feedback.new" });
  late.act("2026-11-11T18:59:00", "tick");
  assert.equal(late.cards().length, 0, "ten minutes exactly is still allowed");
  late.act("2026-11-11T18:59:00.001", "tick");
  assert.equal(late.cards().length, 1);
});

test("a worker that recovers and finishes its work during quiet hours owes no warning", () => {
  const h = hub("2026-11-13T20:00:00");
  h.act("2026-11-13T20:00:00", "ingest", "app", { id: "waiting", type: "feedback.new" });
  h.act("2026-11-13T20:11:00", "tick");
  h.act("2026-11-14T08:00:00", "heartbeat", "w1", []);
  const job = h.act("2026-11-14T08:00:00", "claimNext", "w1", "back");
  h.act("2026-11-14T08:01:00", "finish", job.run, job.token, { outcome: "nothing" });
  h.act("2026-11-16T09:00:00", "tick");
  assert.deepEqual(h.cards(), []);
  assert.deepEqual(h.due(), []);
});

test("a delayed channel cannot first deliver an offline warning during quiet hours, but questions still arrive", () => {
  const h = hub("2026-11-13T18:40:00");
  h.act("2026-11-13T18:40:00", "ingest", "app", { id: "waiting", type: "feedback.new" });
  h.act("2026-11-13T18:51:00", "tick");
  assert.equal(h.cards().length, 1);
  assert.equal(h.act("2026-11-13T20:00:00", "nextCard", "chat"), null);
  h.act("2026-11-13T20:00:00", "createCard", {
    key: "ordinary",
    kind: "ask",
    title: "要你决定",
    text: "",
    options: ["好", "不好"],
  });
  assert.equal(h.act("2026-11-13T20:00:00", "nextCard", "chat").title, "要你决定");
  h.act("2026-11-16T09:00:00", "tick");
  assert.equal(h.act("2026-11-16T09:00:00", "nextCard", "chat").title, "接单程序没连上");
});

test("changing offline hours recalculates the warning deadline and omitting them preserves old behavior", () => {
  const h = hub("2026-11-13T20:00:00");
  h.act("2026-11-13T20:00:00", "ingest", "app", { id: "waiting", type: "feedback.new" });
  h.act("2026-11-13T20:11:00", "tick");
  h.act("2026-11-13T20:12:00", "rules", configured({ ...hours, daysOn: ["2026-11-14"] }));
  assert.deepEqual(
    h.due().map((due) => due.at),
    [time("2026-11-14T09:00:00")],
  );
  h.act("2026-11-13T20:13:00", "rules", configured(undefined));
  h.act("2026-11-13T20:13:00", "tick");
  assert.equal(h.cards().length, 1);
});

test("a late timer still waits for the next opening in the configured timezone and hours", () => {
  const h = hub("2026-11-11T08:00:00", { start: "10:30", end: "18:30" });
  h.act("2026-11-11T08:00:00", "ingest", "app", { id: "waiting", type: "feedback.new" });
  assert.deepEqual(
    h.due().map((due) => due.at),
    [time("2026-11-11T10:30:00")],
  );
  h.act("2026-11-11T20:00:00", "tick");
  assert.deepEqual(h.cards(), [], "the missed opening does not authorize a late alert");
  assert.deepEqual(
    h.due().map((due) => due.at),
    [time("2026-11-12T10:30:00")],
  );
  h.act("2026-11-12T10:30:00", "tick");
  assert.equal(h.cards().length, 1);
});

test("a deferred first delivery is discarded when the worker returns before opening", () => {
  const h = hub("2026-11-13T18:40:00");
  h.act("2026-11-13T18:40:00", "ingest", "app", { id: "waiting", type: "feedback.new" });
  h.act("2026-11-13T18:51:00", "tick");
  assert.equal(h.act("2026-11-13T20:00:00", "nextCard", "chat"), null);
  h.act("2026-11-16T08:59:00", "heartbeat", "w1", []);
  h.act("2026-11-16T09:00:00", "tick");
  assert.equal(h.act("2026-11-16T09:00:00", "nextCard", "chat"), null);
  assert.equal(h.cards()[0].state, "closed");
});

test("pending offline cards follow changed makeup days and disabling hours immediately", () => {
  const h = hub("2026-11-13T18:40:00");
  h.act("2026-11-13T18:40:00", "ingest", "app", { id: "waiting", type: "feedback.new" });
  h.act("2026-11-13T18:51:00", "tick");
  assert.equal(h.act("2026-11-13T20:00:00", "nextCard", "chat"), null);
  h.act("2026-11-13T20:01:00", "rules", configured({ ...hours, daysOn: ["2026-11-14"] }));
  assert.deepEqual(
    h.cardDue().map((due) => due.at),
    [time("2026-11-14T09:00:00")],
  );
  h.act("2026-11-14T09:00:00", "tick");
  assert.equal(h.act("2026-11-14T09:00:00", "nextCard", "chat").title, "接单程序没连上");
  h.act("2026-11-14T20:00:00", "nextCard", "plain");
  h.act("2026-11-14T20:01:00", "rules", configured());
  assert.equal(h.act("2026-11-14T20:01:00", "nextCard", "plain").title, "接单程序没连上");
});

test("offline hours reject malformed, empty or reversed time windows and invalid or conflicting calendar dates", () => {
  for (const invalid of [
    null,
    {},
    { ...hours, start: "25:00" },
    { ...hours, end: "9:00" },
    { ...hours, end: "09:00" },
    { ...hours, end: "08:00" },
    { ...hours, daysOff: ["2026-02-30"] },
    { ...hours, daysOn: ["2026-01-01"] },
    { ...hours, typo: true },
  ]) {
    assert.throws(() => configured(invalid), /workerOffline/);
  }
});

test("the supplied calendar suppresses National Day and permits its makeup workdays in both years", () => {
  const example = JSON.parse(readFileSync(new URL("../examples/worker-offline-hours.json", import.meta.url), "utf8"));
  for (const [away, opening] of [
    ["2026-09-30T19:00:00", "2026-10-08T09:00:00"],
    ["2026-10-09T19:00:00", "2026-10-10T09:00:00"],
    ["2027-09-30T19:00:00", "2027-10-08T09:00:00"],
    ["2027-10-08T19:00:00", "2027-10-09T09:00:00"],
  ]) {
    const h = hub(away, example.workerOffline);
    h.act(away, "ingest", "app", { id: "waiting", type: "feedback.new" });
    assert.deepEqual(
      h.due().map((due) => due.at),
      [time(opening)],
    );
    h.act(opening, "tick");
    assert.equal(h.cards().length, 1);
  }
});
