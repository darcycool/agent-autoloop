// Failure modes: chunk boundaries corrupt Chinese SSE text; reconnect duplicates work or skips a gap; a cache for
// another owner is reused; historical views include later answers; upstream errors expose credentials to the browser.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache, readFacts, cacheName } from "../plugins/daily-overview/feed.ts";
const directory = mkdtempSync(join(tmpdir(), "overview-cache-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const facts = [1, 2, 3].map((seq) => ({ version: 1, seq, at: seq * 1000, type: "heartbeat", changes: [] }));

test("SSE decoding preserves split UTF8, CRLF and multiline data", async () => {
  const text = `: comment\r\nid: 1\r\nevent: fact\r\ndata: ${JSON.stringify({ ...facts[0], type: "中文" })}\r\n\r\nevent: other\ndata: {}\n\nevent: fact\ndata: ${JSON.stringify(facts[1])}\n\n`;
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const received = [];
  for await (const fact of readFacts(stream)) received.push(fact);
  assert.equal(received.length, 2);
  assert.equal(received[0].type, "中文");
  assert.equal(received[1].seq, 2);
});

test("the disposable private cache replays, deduplicates and refuses gaps", () => {
  const file = join(directory, "facts.sqlite");
  const cache = new Cache(file);
  cache.append(facts[0]);
  cache.append(facts[0]);
  cache.append(facts[1]);
  assert.throws(() => cache.append({ ...facts[2], seq: 4 }), /缺少/);
  assert.equal(cache.seq, 2);
  assert.equal(cache.model(1500).seq, 1);
  cache.close();
  const reopened = new Cache(file);
  assert.equal(reopened.seq, 2);
  assert.equal(reopened.model().seq, 2);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  reopened.close();
  assert.notEqual(cacheName("http://localhost:3350", "ownerA"), cacheName("http://localhost:3350", "ownerB"));
  assert.ok(!cacheName("http://localhost:3350", "ownerA").includes("ownerA"));
});
