// This is a client's disposable interpretation of public facts, never the hub's business state.
export type Row = Record<string, any>;
export type Fact = {
  version: number;
  seq: number;
  at: number;
  type: string;
  changes: { table: string; key: string; row: Row | null }[];
};
type Step = { id: string; at: number; title: string; text: string; run?: number };
type Attempt = { start: number; end?: number };
type Thing = {
  id: string;
  rule: string;
  opened: number;
  closed: number | null;
  runIds: Set<number>;
  eventIds: Set<number>;
  cardIds: Set<number>;
  timerIds: Set<number>;
  activity: Set<number>;
  steps: Step[];
  keys: Set<string>;
  batch: boolean;
};
export const STATES: Record<string, string> = {
  running: "正在执行",
  stopping: "正在停止",
  queued: "排队中",
  retrying: "等待重试",
  unknown: "结果待确认",
  waiting: "等待你",
  scheduled: "等待复查",
  done: "执行结束",
  nothing: "无事可做",
  cancelled: "已取消",
};
const numberTime = (value: unknown): number => (typeof value === "number" ? value : Date.parse(String(value)));
const dayFormat = new Map<string, Intl.DateTimeFormat>();
export function dateAt(at: number, timezone: string) {
  let formatter = dayFormat.get(timezone);
  if (!formatter)
    dayFormat.set(
      timezone,
      (formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })),
    );
  return formatter.format(at);
}
export function dayRange(day: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day)
    throw new Error("日期不正确");
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const boundary = (target: string) => {
    const center = Date.parse(`${target}T00:00:00Z`);
    let low = center - 2 * 86400000,
      high = center + 2 * 86400000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (dateAt(mid, timezone) < target) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const start = boundary(day),
    end = boundary(next);
  if (dateAt(start, timezone) !== day) throw new Error("所选时区没有这一天");
  return { start, end };
}

export class Overview {
  seq = 0;
  timezone = "Asia/Shanghai";
  private tables = new Map<string, Map<string, Row>>();
  private things = new Map<string, Thing>();
  private byRun = new Map<number, Thing>();
  private byKey = new Map<string, Thing>();
  private byEvent = new Map<number, Set<number>>();
  private byRunEvents = new Map<number, Set<number>>();
  private eventParent = new Map<number, Thing>();
  private timerOwner = new Map<number, Thing>();
  private attempts = new Map<number, Attempt[]>();
  private aliases = new Map<string, string>();
  private table(name: string) {
    let found = this.tables.get(name);
    if (!found) this.tables.set(name, (found = new Map()));
    return found;
  }
  private get(table: string, id: string | number) {
    return this.table(table).get(String(id));
  }
  get configuredTimezone(): string | undefined {
    return this.get("config", "rules")?.value?.timezone;
  }
  private runs(thing: Thing) {
    return [...thing.runIds].map((id) => this.get("runs", id)).filter((r): r is Row => !!r);
  }
  private state(thing: Thing, read = (table: string, key: number) => this.get(table, key)) {
    const runs = [...thing.runIds].map((id) => read("runs", id)).filter((r): r is Row => !!r);
    if (runs.some((r) => r.state === "claimed" && r.cancel_at)) return "stopping";
    if (runs.some((r) => r.state === "claimed")) return "running";
    if (runs.some((r) => r.state === "unknown")) return "unknown";
    if (runs.some((r) => r.state === "queued" && r.attempts > 0)) return "retrying";
    if (runs.some((r) => r.state === "queued")) return "queued";
    if (
      [...thing.cardIds].some((id) => {
        const c = read("cards", id);
        return c?.kind === "ask" && ["open", "decided"].includes(c.state);
      })
    )
      return "waiting";
    if (
      [...thing.timerIds].some((id) => {
        const t = read("timers", id);
        return t && t.event_id == null;
      })
    )
      return "scheduled";
    const latest = runs.sort(
      (a, b) => numberTime(b.finished_at ?? b.created_at) - numberTime(a.finished_at ?? a.created_at),
    )[0];
    return latest?.state === "cancelled" ? "cancelled" : latest?.state === "nothing" ? "nothing" : "done";
  }
  private active(thing: Thing, read?: (table: string, key: number) => Row | undefined) {
    return !["done", "nothing", "cancelled"].includes(this.state(thing, read));
  }
  private merge(target: Thing, other: Thing) {
    if (target === other) return;
    for (const id of other.runIds) {
      target.runIds.add(id);
      this.byRun.set(id, target);
    }
    for (const id of other.eventIds) target.eventIds.add(id);
    for (const id of other.cardIds) target.cardIds.add(id);
    for (const id of other.timerIds) {
      target.timerIds.add(id);
      this.timerOwner.set(id, target);
    }
    for (const at of other.activity) target.activity.add(at);
    for (const key of other.keys) {
      target.keys.add(key);
      this.byKey.set(key, target);
    }
    for (const [event, parent] of this.eventParent) if (parent === other) this.eventParent.set(event, target);
    target.steps.push(...other.steps);
    target.opened = Math.min(target.opened, other.opened);
    target.batch ||= other.batch;
    this.aliases.set(other.id, target.id);
    this.things.delete(other.id);
  }
  apply(fact: Fact) {
    if (fact.seq <= this.seq) return;
    if (fact.version !== 1 || !Number.isFinite(fact.at)) throw new Error("暂不支持这份日志格式");
    const changes = new Map(
      fact.changes
        .filter((c) => ["events", "runs", "run_events", "cards", "timers", "config"].includes(c.table))
        .map((c) => [`${c.table}:${c.key}`, c]),
    );
    const before = new Map([...changes].map(([key, c]) => [key, this.get(c.table, c.key)]));
    const old = (table: string, id: number) =>
      before.has(`${table}:${id}`) ? before.get(`${table}:${id}`) : this.get(table, id);
    const affected = new Set<Thing>();
    const touch = (thing: Thing, title: string, text = "", run?: number) => {
      affected.add(thing);
      thing.activity.add(fact.at);
      thing.steps.push({ id: `${fact.seq}:${thing.steps.length}`, at: fact.at, title, text, ...(run && { run }) });
    };
    const finishing = [...changes.values()].find(
      (c) =>
        c.table === "runs" &&
        c.row &&
        before.get(`runs:${c.key}`)?.issued != null &&
        c.row.issued == null &&
        c.row.last_issued === before.get(`runs:${c.key}`)?.issued,
    );
    for (const c of changes.values()) {
      if (c.row) this.table(c.table).set(c.key, c.row);
      else this.table(c.table).delete(c.key);
      if (c.table === "config" && c.key === "rules" && c.row?.value?.timezone) this.timezone = c.row.value.timezone;
    }
    for (const c of changes.values()) {
      if (c.table === "run_events") {
        const prior = before.get(`run_events:${c.key}`);
        if (prior) {
          this.byEvent.get(prior.event_id)?.delete(prior.run_id);
          this.byRunEvents.get(prior.run_id)?.delete(prior.event_id);
        }
        if (c.row) {
          const { run_id: run, event_id: event } = c.row;
          let linked = this.byEvent.get(event);
          if (!linked) this.byEvent.set(event, (linked = new Set()));
          linked.add(run);
          let events = this.byRunEvents.get(run);
          if (!events) this.byRunEvents.set(run, (events = new Set()));
          events.add(event);
        }
      }
      if (c.table === "cards" && c.row?.answer_event && c.row.run_id) {
        const parent = this.byRun.get(c.row.run_id);
        if (parent) this.eventParent.set(c.row.answer_event, parent);
      }
      if (c.table === "timers" && c.row?.event_id) {
        const parent = this.timerOwner.get(c.row.id);
        if (parent) this.eventParent.set(c.row.event_id, parent);
      }
    }
    const eventIds = (id: number) => [...(this.byRunEvents.get(id) ?? [])];
    const changedRuns = new Set([...changes.values()].filter((c) => c.table === "runs").map((c) => Number(c.key)));
    for (const c of changes.values()) if (c.table === "run_events" && c.row) changedRuns.add(c.row.run_id);
    for (const runId of changedRuns) {
      const run = this.get("runs", runId);
      if (!run) continue;
      const ids = eventIds(runId),
        events = ids.map((id) => this.get("events", id)).filter((e): e is Row => !!e);
      const keys = events
        .filter((e) => !["card.answered", "timer.due"].includes(e.type))
        .map(
          (e) =>
            `${run.rule}|${e.type === "schedule.tick" || !e.subject ? `event:${e.id}` : JSON.stringify([e.source, e.subject])}`,
        );
      let thing = this.byRun.get(runId);
      const parent = ids.map((id) => this.eventParent.get(id)).find((p) => p?.rule === run.rule);
      if (!thing) {
        const continuing = keys.length && keys.every((k) => k === keys[0]) ? this.byKey.get(keys[0]) : undefined;
        thing = parent ?? (continuing && this.active(continuing, old) ? continuing : undefined);
        if (!thing) {
          thing = {
            id: `thing-${runId}`,
            rule: run.rule,
            opened: Number.isFinite(numberTime(run.created_at)) ? numberTime(run.created_at) : fact.at,
            closed: null,
            runIds: new Set(),
            eventIds: new Set(),
            cardIds: new Set(),
            timerIds: new Set(),
            activity: new Set(),
            steps: [],
            keys: new Set(),
            batch: false,
          };
          this.things.set(thing.id, thing);
        }
        thing.runIds.add(runId);
        this.byRun.set(runId, thing);
      } else if (parent && parent !== thing) (this.merge(parent, thing), (thing = parent));
      for (const id of ids)
        if (!thing.eventIds.has(id)) {
          const event = this.get("events", id);
          if (event)
            touch(
              thing,
              event.type === "schedule.tick"
                ? "定时触发"
                : event.type === "card.answered"
                  ? "收到回答"
                  : event.type === "timer.due"
                    ? "复查到期"
                    : "收到事件",
              event.summary || event.type,
              runId,
            );
          thing.eventIds.add(id);
        }
      for (const key of keys) {
        thing.keys.add(key);
        this.byKey.set(key, thing);
      }
      thing.batch = thing.batch || new Set(keys).size > 1;
      affected.add(thing);
    }
    // Retry merges move all event links to a surviving run, then remove the unclaimed duplicate.
    for (const c of changes.values())
      if (c.table === "runs" && !c.row) {
        const removed = this.byRun.get(Number(c.key));
        if (!removed) continue;
        const priorEvents = [...before.values()]
          .filter((r) => r?.run_id === Number(c.key) && r.event_id)
          .map((r) => r!.event_id);
        const target = priorEvents
          .flatMap((id) => [...(this.byEvent.get(id) ?? [])])
          .map((id) => this.byRun.get(id))
          .find((t) => t && t !== removed);
        if (target) {
          this.merge(target, removed);
          affected.delete(removed);
          affected.add(target);
        }
      }
    for (const c of changes.values()) {
      const prior = before.get(`${c.table}:${c.key}`),
        row = c.row;
      if (c.table === "runs" && row) {
        const thing = this.byRun.get(row.id);
        if (!thing) continue;
        const attempts = this.attempts.get(row.id) ?? [];
        this.attempts.set(row.id, attempts);
        if (
          row.state === "claimed" &&
          (!prior || prior.claimed_at !== row.claimed_at || !["claimed", "unknown"].includes(prior.state))
        ) {
          attempts.push({ start: numberTime(row.claimed_at) });
          touch(thing, "开始执行", `第 ${attempts.length} 次执行 · ${row.agent ?? "Agent"}`, row.id);
        }
        if (finishing?.key === c.key) {
          const attempt = attempts.at(-1);
          if (attempt && attempt.end === undefined) attempt.end = fact.at;
          touch(
            thing,
            row.state === "queued" ? "本次未跑成，等待重试" : row.state === "cancelled" ? "确认停止" : "本轮执行结束",
            row.error || row.summary || "未上报回执摘要",
            row.id,
          );
        } else if (prior && row.state !== prior.state && row.state !== "claimed")
          touch(
            thing,
            row.state === "unknown" ? "执行结果待确认" : row.state === "cancelled" ? "轮次已取消" : "执行状态变化",
            row.summary ?? "",
            row.id,
          );
        if (row.cancel_at && !prior?.cancel_at) touch(thing, "已请求停止，等待执行退出", "", row.id);
        if (fact.type === "started" && (row.link !== prior?.link || row.session !== prior?.session))
          touch(thing, "会话已开始", row.session ?? "", row.id);
      }
      if (c.table === "cards") {
        const card = row ?? prior;
        const thing = card?.run_id ? this.byRun.get(card.run_id) : undefined;
        if (!thing) continue;
        thing.cardIds.add(card!.id);
        affected.add(thing);
        if (!prior && row)
          touch(thing, row.kind === "ask" ? "向你提问" : "产生通知", `${row.title}\n${row.text ?? ""}`);
        else if (row && row.state !== prior?.state)
          touch(thing, row.state === "decided" ? "你已回答" : "卡片状态变化", row.answer ?? row.result ?? row.title);
      }
      if (c.table === "timers") {
        const timer = row ?? prior;
        const previousOwner = this.timerOwner.get(timer?.id);
        let thing = previousOwner;
        if (finishing && row) thing = this.byRun.get(Number(finishing.key)) ?? thing;
        if (!thing || !timer) continue;
        if (previousOwner && previousOwner !== thing) {
          previousOwner.timerIds.delete(timer.id);
          touch(previousOwner, "复查由后续处理接手", timer.about ?? "");
        }
        this.timerOwner.set(timer.id, thing);
        thing.timerIds.add(timer.id);
        affected.add(thing);
        if (row?.event_id) this.eventParent.set(row.event_id, thing);
        if (!row) touch(thing, "取消复查", prior?.about ?? "");
        else if (!prior || row.at !== prior.at) touch(thing, "安排复查", `${row.at ?? ""}\n${row.about ?? ""}`);
        else if (row.event_id !== prior.event_id) touch(thing, "复查到期", row.about ?? "");
      }
    }
    for (const thing of affected)
      if (this.things.has(thing.id)) {
        if (this.active(thing)) thing.closed = null;
        else if (thing.closed === null) thing.closed = fact.at;
      }
    this.seq = fact.seq;
  }
  private serialize(thing: Thing, cutoff: number, details = false) {
    const runs = this.runs(thing).sort((a, b) => a.id - b.id);
    const events = [...thing.eventIds].map((id) => this.get("events", id)).filter((e): e is Row => !!e);
    const external = events.filter((e) => !["card.answered", "timer.due"].includes(e.type));
    const latest = [...runs].sort(
      (a, b) =>
        numberTime(b.finished_at ?? b.claimed_at ?? b.created_at) -
        numberTime(a.finished_at ?? a.claimed_at ?? a.created_at),
    )[0];
    const state = this.state(thing);
    const receipts = thing.steps
      .filter((step) => ["本次未跑成，等待重试", "本轮执行结束", "确认停止"].includes(step.title))
      .sort((a, b) => Number(a.id.split(":")[0]) - Number(b.id.split(":")[0]));
    let executionMs: number | null = 0,
      ongoing = false;
    for (const id of thing.runIds) {
      const run = this.get("runs", id),
        attempts = this.attempts.get(id) ?? [];
      if (run?.state === "unknown" || (run?.finished_at && run.state !== "cancelled" && !attempts.length))
        executionMs = null;
      for (const attempt of attempts) {
        const end = attempt.end ?? cutoff;
        if (attempt.end === undefined) ongoing = true;
        if (!Number.isFinite(attempt.start) || end < attempt.start) executionMs = null;
        else if (executionMs !== null) executionMs += end - attempt.start;
      }
    }
    const titleEvent = external.find((e) => e.subject) ?? external[0];
    const title = thing.batch
      ? `${thing.rule} · 合批处理`
      : titleEvent?.summary || (titleEvent?.subject ? `${thing.rule} · ${titleEvent.subject}` : thing.rule);
    const end = thing.closed ?? cutoff;
    const result = {
      id: thing.id,
      rule: thing.rule,
      agent: latest?.agent ?? "",
      title,
      state,
      stateLabel: STATES[state],
      summary:
        receipts.at(-1)?.text || latest?.summary || latest?.error || (state === "queued" ? "等待领取" : "暂无回执结论"),
      openedAt: thing.opened,
      closedAt: thing.closed,
      executionMs,
      ongoing,
      elapsedMs: end >= thing.opened ? end - thing.opened : null,
      runs: runs.length,
      batch: thing.batch,
      lastActivity: [...thing.activity].reduce((latest, at) => Math.max(latest, at), thing.opened),
      subjects: [...new Set(external.map((e) => e.subject).filter(Boolean))],
    };
    if (!details) return result;
    return {
      ...result,
      steps: [...thing.steps].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
      events: events.map((e) => ({
        id: e.id,
        source: e.source,
        type: e.type,
        subject: e.subject,
        summary: e.summary,
        detail: e.detail,
        link: e.link,
      })),
      links: [...new Set([...events.map((e) => e.link), ...runs.map((r) => r.link)].filter(Boolean))],
      cards: [...thing.cardIds]
        .map((id) => this.get("cards", id))
        .filter(Boolean)
        .map((c) => ({
          id: c!.id,
          kind: c!.kind,
          title: c!.title,
          text: c!.text,
          state: c!.state,
          answer: c!.answer,
          choice: c!.choice,
          options: parse(c!.options, []),
          result: c!.result,
        })),
      attempts: [...thing.runIds].flatMap((run) =>
        (this.attempts.get(run) ?? []).map((a) => ({
          run,
          ...a,
          uncertain: this.get("runs", run)?.state === "unknown",
        })),
      ),
      receipts,
    };
  }
  report(day: string, now: number) {
    const { start, end } = dayRange(day, this.timezone),
      cutoff = Math.min(now, end - 1);
    const things = [...this.things.values()].filter((t) => t.opened <= cutoff);
    const activeOnDay = (thing: Thing) =>
      [...thing.activity].some((at) => at >= start && at <= cutoff) ||
      [...thing.runIds].some((id) =>
        (this.attempts.get(id) ?? []).some((a) => a.start <= cutoff && (a.end ?? cutoff) >= start),
      );
    const summaries = things
      .map((t) => ({ t, row: this.serialize(t, cutoff) }))
      .sort((a, b) => b.row.lastActivity - a.row.lastActivity);
    return {
      day,
      timezone: this.timezone,
      cutoff,
      seq: this.seq,
      activities: summaries.filter(({ t }) => activeOnDay(t)).map((x) => x.row),
      pending: summaries.filter(({ t }) => this.active(t)).map((x) => x.row),
    };
  }
  detail(id: string, cutoff: number): Row | undefined {
    const visited = new Set<string>();
    while (this.aliases.has(id) && !visited.has(id)) {
      visited.add(id);
      id = this.aliases.get(id)!;
    }
    const thing = this.things.get(id);
    if (!thing) return undefined;
    const related = [...this.things.values()]
      .filter(
        (other) => other !== thing && other.rule === thing.rule && [...other.keys].some((key) => thing.keys.has(key)),
      )
      .map((other) => ({ id: other.id, openedAt: other.opened, title: this.serialize(other, cutoff).title }));
    return { ...this.serialize(thing, cutoff, true), related };
  }
}
function parse(value: unknown, fallback: any) {
  try {
    return typeof value === "string" ? JSON.parse(value) : (value ?? fallback);
  } catch {
    return fallback;
  }
}
