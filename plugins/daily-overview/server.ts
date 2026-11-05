import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { dayRange, dateAt, type Overview } from "./model.ts";
import type { Cache } from "./feed.ts";

type Source = { cache: Cache; now(): number; timezone(): string; status(): object };
const assets: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};
export async function startViewer(source: Source, port = 0) {
  const token = randomBytes(32).toString("hex"),
    session = randomBytes(32).toString("hex");
  const snapshots = new Map<string, { seq: number; model: Overview }>();
  let authority = "";
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    if (
      req.headers.host !== authority ||
      (req.headers.origin && req.headers.origin !== `http://${authority}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return void send(403, { error: "只能在本机直接打开这个页面" });
    if (req.method !== "GET") return void send(405, { error: "此插件只支持查看" });
    const url = new URL(req.url!, `http://${authority}`);
    if (url.pathname === `/open/${token}`) {
      res.setHeader("set-cookie", `overview_session=${session}; Path=/; HttpOnly; SameSite=Strict`);
      return void res.writeHead(303, { location: "/" }).end();
    }
    if (!req.headers.cookie?.split(/;\s*/).includes(`overview_session=${session}`))
      return void send(401, { error: "请使用启动命令输出的链接打开页面" });
    try {
      if (assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        const body = await readFile(new URL(`./public/${file}`, import.meta.url));
        return void res.writeHead(200, { "content-type": type }).end(body);
      }
      if (url.pathname === "/api/day" || /^\/api\/things\/thing-\d+$/.test(url.pathname)) {
        const now = source.now(),
          timezone = source.timezone(),
          today = dateAt(now, timezone);
        const day = url.searchParams.get("date") || today;
        let end: number;
        try {
          end = dayRange(day, timezone).end;
          if (day > today) throw new Error();
        } catch {
          return void send(400, { error: "请选择今天或更早的有效日期" });
        }
        const historical = day < today,
          cutoff = Math.min(now, end - 1);
        let model = source.cache.latest;
        if (historical) {
          const prior = snapshots.get(day);
          if (prior?.seq === source.cache.seq) model = prior.model;
          else {
            model = source.cache.model(cutoff);
            snapshots.set(day, { seq: source.cache.seq, model });
            if (snapshots.size > 7) snapshots.delete(snapshots.keys().next().value!);
          }
        }
        // The date picker always uses the currently configured rule timezone, also for historical cutoffs.
        model.timezone = timezone;
        const meta = { today, historical, sync: source.status() };
        if (url.pathname === "/api/day") return void send(200, { ...model.report(day, now), ...meta });
        const id = url.pathname.split("/").at(-1)!;
        const thing = model.detail(id, cutoff);
        if (!thing) return void send(404, { error: "这个日期没有这条记录" });
        return void send(200, {
          thing,
          latest: historical ? source.cache.latest.detail(id, now) : null,
          cutoff,
          timezone,
          ...meta,
        });
      }
      send(404, { error: "没有这个页面" });
    } catch {
      send(500, { error: "记录暂时读不到，请刷新页面；仍然失败时重新启动插件" });
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  authority = `127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, url: `http://${authority}/open/${token}` };
}
