// Polling and project selection use ordinary command-agent receipts. Neither task prose nor a source URL selects cwd.
import { readFileSync } from "node:fs";

type Project = { name: string; cwd: string };
export type Settings = { url: string; dataRoot: string; projects: Record<string, Project> };
type Row = {
  id: string;
  type: string;
  status: string;
  handlingMode: string;
  version: number;
  displayTitle: string;
  body: string;
};
type Envelope = { generationId: string; data: { items: Row[]; total: number }; error?: { code: string } };
type Event = { id: string; type: string; subject: string; summary: string; detail: string; link: string };
type Context = {
  events: { id: string; subject: string; summary?: string; detail?: string }[];
  answers: { about: string; options: string[]; choice: number }[];
  open: { title: string; text?: string }[];
};
type Receipt = {
  events?: Event[];
  ask?: { title: string; text: string; options: string[]; about: string; key: string }[];
};
const clip = (text: string, length: number) => [...text].slice(0, length).join("");
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const subjectPattern = new RegExp(`^${uuid}/${uuid}$`);

export function loadSettings(file: string): Settings {
  const settings: Settings = JSON.parse(readFileSync(file, "utf8"));
  const url = new URL(settings.url);
  if (url.origin !== settings.url || url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Tooodo 地址须为本机 http://127.0.0.1:端口，不含路径");
  }
  const entries = Object.entries(settings.projects);
  if (!entries.length || entries.length > 19) throw new Error("须配置 1 到 19 个项目");
  if (new Set(entries.map(([, p]) => p.name)).size !== entries.length) throw new Error("项目名称不能重复");
  for (const [key, project] of entries) {
    if (
      !/^[a-z][a-z0-9_-]{0,39}$/.test(key) ||
      key === "pending" ||
      !project.name ||
      [...project.name].length > 100 ||
      project.name === "暂不执行" ||
      project.name === "更多项目" ||
      !project.cwd.startsWith("/")
    ) {
      throw new Error("项目须使用固定的英文标识、中文名称和绝对目录");
    }
  }
  return settings;
}

export function client(settings: Settings) {
  return async (path: string): Promise<Envelope> => {
    const { token } = JSON.parse(readFileSync(`${settings.dataRoot}/config/access.json`, "utf8"));
    const response = await fetch(`${settings.url}/api/v1${path}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Tooodo 查询失败（HTTP ${response.status}）`);
    const result = (await response.json()) as Envelope;
    if (result.error) throw new Error("Tooodo 查询未成功");
    return result;
  };
}

export async function collect(
  settings: Settings,
  request = client(settings),
  minute = Math.floor(Date.now() / 60_000),
): Promise<Event[]> {
  const path = (page: number) =>
    `/records?${new URLSearchParams({ type: "task", status: "pending,in_progress", pageSize: "100", page: String(page) })}`;
  const first = await request(path(1));
  const page = (minute % Math.max(1, Math.ceil(first.data.total / 100))) + 1;
  const result = page === 1 ? first : await request(path(page));
  if (first.generationId !== result.generationId) throw new Error("Tooodo 数据代次变化，下次重新采集");
  return result.data.items.map((row) => {
    const subject = `${result.generationId}/${row.id}`;
    const type =
      row.handlingMode === "automation" && row.status === "pending" ? "task.automation.pending" : "task.observed";
    return {
      id: `${subject}/${row.version}`,
      type,
      subject,
      summary: clip(row.displayTitle, 200),
      detail: clip(
        `处理方式：${row.handlingMode === "automation" ? "自动化处理" : "本人处理"}\n状态：${row.status}\n版本：${row.version}\n${row.body}\n完整正文、原话、图片和进展请从 Tooodo 详情读取。`,
        4000,
      ),
      link: `${settings.url}/records/${row.id}`,
    };
  });
}

export function selectProject(settings: Settings, context: Context): Receipt {
  const entries = Object.entries(settings.projects);
  const pageOptions = (offset: number) => [
    ...entries.slice(offset, offset + 3).map(([, project]) => project.name),
    ...(offset + 3 < entries.length ? ["更多项目"] : []),
    "暂不执行",
  ];
  const ready = (subject: string, id: string, key: string): Event => {
    if (!subjectPattern.test(subject)) throw new Error("任务标识无效");
    return {
      id: `selected/${id}`,
      type: `task.automation.${key}`,
      subject,
      summary: "本人已确定自动化任务所属项目",
      detail: "",
      link: `${settings.url}/records/${subject.split("/")[1]}`,
    };
  };
  const ask = (subject: string, event: string, offset = 0): Receipt => ({
    ask: [
      {
        title: "这条待办在哪个项目处理？",
        text: `这条自动化待办应在哪个项目实施？\n${settings.url}/records/${subject.split("/")[1]}\n项目目录由已配置规则固定，选择后交给 Codex。`,
        options: pageOptions(offset),
        about: JSON.stringify({ subject, event, keys: entries.map(([key]) => key), offset }),
        key: `project-${subject}-${offset}`,
      },
    ],
  });
  if (context.answers.length) {
    const answer = context.answers.at(-1)!;
    const selected: { subject: string; event: string; keys: string[]; offset: number } = JSON.parse(answer.about);
    if (
      !subjectPattern.test(selected.subject) ||
      !Number.isInteger(selected.offset) ||
      selected.offset < 0 ||
      selected.offset >= entries.length
    )
      throw new Error("项目选择无效");
    const options = pageOptions(selected.offset);
    if (
      JSON.stringify(answer.options) !== JSON.stringify(options) ||
      JSON.stringify(selected.keys) !== JSON.stringify(entries.map(([key]) => key))
    ) {
      throw new Error("项目设置已变化，请重新选择项目");
    }
    if (!Number.isInteger(answer.choice) || answer.choice < 0 || answer.choice >= options.length)
      throw new Error("项目选择无效");
    if (answer.choice === options.length - 1) return {};
    if (options[answer.choice] === "更多项目") return ask(selected.subject, selected.event, selected.offset + 3);
    return { events: [ready(selected.subject, selected.event, entries[selected.offset + answer.choice][0])] };
  }
  const event = context.events.at(-1);
  if (!event) return {};
  if (!subjectPattern.test(event.subject)) throw new Error("任务标识无效");
  if (entries.length === 1) return { events: [ready(event.subject, event.id, entries[0][0])] };
  const link = `${settings.url}/records/${event.subject.split("/")[1]}`;
  if (context.open.some((card) => card.title === "这条待办在哪个项目处理？" && card.text?.includes(link))) return {};
  const result = ask(event.subject, event.id);
  if (event.summary) result.ask![0].text = `${clip(event.summary, 200)}\n\n${result.ask![0].text}`;
  return result;
}

if (import.meta.main) {
  try {
    const settings = loadSettings(process.argv[3]);
    const receipt =
      process.argv[2] === "poll"
        ? { events: await collect(settings) }
        : process.argv[2] === "select"
          ? selectProject(settings, JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8")))
          : (() => {
              throw new Error("用法：bridge.ts poll|select 设置文件");
            })();
    console.log(`已核对 Tooodo 待办\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``);
  } catch {
    console.error("Tooodo 接入未完成：检查服务、访问凭据和项目配置后重试。");
    process.exitCode = 1;
  }
}
