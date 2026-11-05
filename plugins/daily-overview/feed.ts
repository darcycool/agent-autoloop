import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Overview, type Fact } from "./model.ts";

export const cacheName = (url: string, owner: string) =>
  createHash("sha256").update(`${url}\n${owner}`).digest("hex").slice(0, 32) + ".sqlite";
export class Cache {
  private db: DatabaseSync;
  seq = 0;
  latest = new Overview();
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(file), 0o700);
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS received_facts (seq INTEGER PRIMARY KEY, at REAL NOT NULL, json TEXT NOT NULL)",
    );
    for (const row of this.db.prepare("SELECT json FROM received_facts ORDER BY seq").iterate()) {
      const fact = JSON.parse(String(row.json)) as Fact;
      this.latest.apply(fact);
      this.seq = fact.seq;
    }
  }
  append(fact: Fact) {
    if (
      !Number.isSafeInteger(fact.seq) ||
      fact.seq < 1 ||
      fact.version !== 1 ||
      !Number.isFinite(fact.at) ||
      !Array.isArray(fact.changes)
    )
      throw new Error("暂不支持这份日志格式");
    if (fact.seq <= this.seq) return;
    if (fact.seq !== this.seq + 1) throw new Error("记录缺少一段，请清理此插件缓存后重新读取");
    this.db.prepare("INSERT INTO received_facts VALUES (?, ?, ?)").run(fact.seq, fact.at, JSON.stringify(fact));
    this.latest.apply(fact);
    this.seq = fact.seq;
  }
  model(cutoff = Infinity) {
    if (cutoff === Infinity) return this.latest;
    const model = new Overview();
    // Wall clocks can move backwards; sequence order remains authoritative, even across the cutoff.
    for (const row of this.db.prepare("SELECT json FROM received_facts WHERE at <= ? ORDER BY seq").iterate(cutoff))
      model.apply(JSON.parse(String(row.json)));
    return model;
  }
  close() {
    this.db.close();
  }
}

export async function* readFacts(body: ReadableStream<Uint8Array>): AsyncGenerator<Fact> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    event = "",
    data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (line === "") {
          if (event === "fact" && data.length) yield JSON.parse(data.join("\n")) as Fact;
          event = "";
          data = [];
        } else if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class Feed {
  private url: URL;
  private owner: string;
  private stopped = new AbortController();
  private task?: Promise<void>;
  private target: number | null = null;
  private checkedAt: number | null = null;
  private connection = "connecting";
  private message = "正在读取历史记录";
  private hubNow: number | null = null;
  private clockAt = 0;
  private zone: string | null = null;
  readonly cache: Cache;
  constructor(cache: Cache, url: string, owner: string) {
    this.cache = cache;
    this.url = new URL(url);
    if (
      !["http:", "https:"].includes(this.url.protocol) ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== "/"
    )
      throw new Error("配置里的中台地址不正确");
    if (!owner) throw new Error("配置里没有本人密钥，请先在本机运行 init");
    this.owner = owner;
  }
  now() {
    return this.hubNow === null ? Date.now() : this.hubNow + Date.now() - this.clockAt;
  }
  timezone() {
    return this.cache.latest.configuredTimezone ?? this.zone ?? this.cache.latest.timezone;
  }
  status() {
    const covered = this.target !== null && this.cache.seq >= this.target;
    return {
      connection: this.connection,
      message: this.message,
      seq: this.cache.seq,
      covered,
      checkedAt: covered ? this.checkedAt : null,
    };
  }
  private async get(path: string, timed = true) {
    const signal = timed ? AbortSignal.any([this.stopped.signal, AbortSignal.timeout(15000)]) : this.stopped.signal;
    const response = await fetch(new URL(path, this.url), {
      method: "GET",
      headers: { authorization: `Bearer ${this.owner}` },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401 || response.status === 403
          ? "本人密钥不可用，请检查本机配置"
          : "暂时读不到中台，请检查中台是否运行",
      );
    }
    return response;
  }
  private async coverage() {
    const ids = new Set<number>();
    let before: number | null = null;
    do {
      const state = (await (await this.get(`/v1/state${before === null ? "" : `?before=${before}`}`)).json()) as {
        runs: { id: number }[];
        nextBefore: number | null;
        timezone: string;
        now: string;
      };
      if (before === null) {
        this.zone = state.timezone;
        this.hubNow = Date.parse(state.now);
        this.clockAt = Date.now();
      }
      for (const run of state.runs) ids.add(run.id);
      if (state.nextBefore !== null && state.nextBefore === before) throw new Error("中台分页没有前进");
      before = state.nextBefore;
    } while (before !== null);
    let target = 0;
    const runs = [...ids];
    for (let i = 0; i < runs.length; i += 4) {
      const facts = await Promise.all(
        runs.slice(i, i + 4).map(async (id) => (await (await this.get(`/v1/runs/${id}/why`)).json()) as Fact[]),
      );
      for (const group of facts) for (const fact of group) target = Math.max(target, fact.seq);
    }
    this.target = target;
    this.checkedAt = Date.now();
  }
  start() {
    if (this.task) return;
    this.task = this.run();
  }
  private async run() {
    while (!this.stopped.signal.aborted) {
      let covering: Promise<void> | undefined;
      try {
        this.connection = "connecting";
        covering = this.coverage().catch(() => {
          this.message = "轮次核对未完成，仍在接收记录";
        });
        const response = await this.get(`/v1/stream?after=${this.cache.seq}`, false);
        if (!response.body) throw new Error("中台没有返回记录流");
        this.connection = "connected";
        this.message = "持续接收记录";
        for await (const fact of readFacts(response.body)) this.cache.append(fact);
        throw new Error("记录连接已断开");
      } catch (error) {
        if (this.stopped.signal.aborted) break;
        this.connection = "disconnected";
        this.message =
          error instanceof Error && /密钥|记录缺少|日志格式/.test(error.message)
            ? error.message
            : "连接中断，正在重连；暂时显示已收到的记录";
        if (/记录缺少|日志格式/.test(this.message)) return;
      } finally {
        await covering;
      }
      await delay(2000, undefined, { signal: this.stopped.signal }).catch(() => {});
    }
  }
  async close() {
    this.stopped.abort();
    await this.task;
  }
}
