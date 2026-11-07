// Generates ordinary rules; the local settings are trusted, and must not be supplied by a task or its source text.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings } from "./bridge.ts";

export function configuration(settingsFile: string, worker: string) {
  const settings = loadSettings(settingsFile);
  const bridge = resolve(import.meta.dirname, "bridge.ts");
  const instructions = readFileSync(new URL("implement.md", import.meta.url), "utf8");
  const command = (mode: string) => [process.execPath, bridge, mode, resolve(settingsFile)];
  return {
    sources: { tooodo: { name: "Tooodo 待办" } },
    agents: {
      "tooodo-poll": { name: "采集 Tooodo", worker, use: "command", command: command("poll") },
      "tooodo-select": { name: "确定待办项目", worker, use: "command", command: command("select") },
      "tooodo-codex": { name: "Tooodo Codex", worker, use: "codex", access: "edit" },
    },
    rules: [
      {
        name: "采集 Tooodo 待办",
        when: { cron: "* * * * *" },
        to: "tooodo-poll",
        cwd: import.meta.dirname,
        tell: "never",
        prompt: "通过现有 HTTP 接口采集待办。",
        emits: { source: "tooodo", types: ["task.observed", "task.automation.pending"] },
      },
      {
        name: "选择 Tooodo 项目",
        when: { source: "tooodo", types: ["task.automation.pending"] },
        to: "tooodo-select",
        cwd: import.meta.dirname,
        parallel: 1,
        prompt: "只按本人选择的已配置项目分流。",
        emits: { source: "tooodo", types: Object.keys(settings.projects).map((key) => `task.automation.${key}`) },
      },
      ...Object.entries(settings.projects).map(([key, project]) => ({
        name: `实施 Tooodo：${project.name}`,
        when: { source: "tooodo", types: [`task.automation.${key}`] },
        to: "tooodo-codex",
        cwd: project.cwd,
        group: "tooodo-implementation",
        parallel: 1,
        prompt: instructions,
      })),
    ],
  };
}

if (import.meta.main) {
  const [settingsFile, worker, rulesFile] = process.argv.slice(2);
  if (!settingsFile || !worker || !rulesFile) throw new Error("用法：setup.ts 设置文件 接单电脑 rules.json");
  const addition = configuration(settingsFile, worker);
  const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
  const names = new Set(addition.rules.map((r) => r.name));
  if (
    Object.keys(addition.agents).some((id) => rules.agents?.[id]) ||
    rules.sources?.tooodo ||
    rules.rules.some((r: { name: string }) => names.has(r.name))
  ) {
    throw new Error("Tooodo 已配置，请核对现有规则，不重复覆盖");
  }
  const merged = {
    ...rules,
    sources: { ...rules.sources, ...addition.sources },
    agents: { ...rules.agents, ...addition.agents },
    rules: [...rules.rules, ...addition.rules],
  };
  writeFileSync(`${rulesFile}.tooodo-backup`, readFileSync(rulesFile), { mode: 0o600, flag: "wx" });
  writeFileSync(`${rulesFile}.tooodo-next`, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(`${rulesFile}.tooodo-next`, rulesFile);
  console.log("已合并 Tooodo 规则，原规则已备份；运行 agent-autoloop check 核对。");
}
