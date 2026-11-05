import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cache, Feed, cacheName } from "./feed.ts";
import { startViewer } from "./server.ts";

export async function main(args: string[]) {
  const help =
    "用法：agent-autoloop overview [--port 端口] [--no-open]\n\n打开只读的每日处理记录。按 Ctrl+C 退出，不影响中台。";
  if (args.includes("--help") || args.includes("-h")) return void console.log(help);
  let port = 0,
    open = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-open") open = false;
    else if (args[i] === "--port" && /^\d+$/.test(args[i + 1] ?? "")) {
      port = Number(args[++i]);
      if (port < 1 || port > 65535) throw new Error("端口要在 1 到 65535 之间");
    } else throw new Error(help);
  }
  const home = process.env.AGENT_AUTOLOOP_HOME || join(homedir(), ".agent-autoloop");
  let config: { url: string; owner?: string };
  try {
    config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch {
    throw new Error("读不到本机配置，请先运行 agent-autoloop init");
  }
  if (!config.owner) throw new Error("配置里没有本人密钥，请在装好中台的电脑上运行");
  const file = join(home, "cache", "daily-overview", cacheName(config.url, config.owner));
  const cache = new Cache(file);
  let feed: Feed;
  try {
    feed = new Feed(cache, config.url, config.owner);
  } catch (error) {
    cache.close();
    throw error;
  }
  let viewer: Awaited<ReturnType<typeof startViewer>>;
  try {
    viewer = await startViewer(feed, port);
  } catch {
    cache.close();
    throw new Error("页面服务没有启动，请检查端口是否被占用");
  }
  feed.start();
  console.log(`每日处理记录：${viewer.url}\n按 Ctrl+C 退出，不影响中台。`);
  if (open) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
    const parameters = process.platform === "win32" ? ["url.dll,FileProtocolHandler", viewer.url] : [viewer.url];
    const child = spawn(command, parameters, { stdio: "ignore" });
    child.on("error", () => console.log("浏览器没有自动打开，请复制上面的链接。"));
    child.unref();
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    viewer.server.closeAllConnections();
    viewer.server.close();
    await feed.close();
    cache.close();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
if (import.meta.main)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
