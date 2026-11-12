// rules.json: the sources that may send events, the agents that do the work, the channels that reach the owner, the
// rules between them and, only to be shown, the scheduled tasks that run elsewhere. A mistake is caught here with a
// message saying where: at start it stops the hub, later it leaves the old rules running and the owner is told.
import { nextRun, parseCron } from "../kernel/cron.ts";
import { SCHEDULE, type Rule, type Rules } from "../kernel/rules.ts";

export class RulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`rules.json 有问题：\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
const ID = /^[a-z][a-z0-9-]*$/;
const TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
const ASK_FIRST = ["删数据", "停服", "花钱", "对外发消息", "改产品方向", "新建或轮换密钥", "修改权限"];
const NOT_EMPTY = "不能为空";
const ID_WORDS = "只能用小写字母、数字和 -";

type Check = (value: unknown) => boolean;
type Field = [name: string, check: Check, problem: string, optional?: boolean];

const isText: Check = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isWords: Check = (value) => Array.isArray(value) && value.every(isText);
const isSomeWords: Check = (value) => isWords(value) && (value as string[]).length > 0;
const isId: Check = (value) => typeof value === "string" && ID.test(value);
const isCount: Check = (value) => Number.isInteger(value) && (value as number) > 0;
const isTypes: Check = (value) => isSomeWords(value) && (value as string[]).every((type) => TYPE_PATTERN.test(type));
const isCron: Check = (value) => typeof value === "string" && parseCron(value) !== null;
const isTime: Check = (value) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const isDates: Check = (value) =>
  Array.isArray(value) &&
  value.every((day) => {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const at = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day;
  });
// One word, as a client may name a session after the first word of its first message. It leads the prompt, which goes to
// the Agent's command line as an argument: started with a subject from outside it could be read as an option or command.
const isTitle: Check = (value) =>
  typeof value === "string" &&
  /^[\p{L}\p{N}]\S*$/u.test(value) &&
  !/[{}]/.test(value.replaceAll("{id}", "").replaceAll("{subject}", ""));
const isFolder: Check = (value) =>
  typeof value === "string" && /^(~[/\\]|\/|[a-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/i.test(value);
const FOLDER = "要是绝对目录（如 ~/code、/srv/app、C:\\code 或 \\\\服务器\\共享目录）";

function isKeyOf(table: object): Check {
  return (value) => typeof value === "string" && value in table;
}

function isZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone as string });
    return isText(zone);
  } catch {
    return false;
  }
}

/** Each field present and well formed, and no others: a misspelt field would otherwise be silently ignored. */
function checkFields(issues: string[], where: string, value: unknown, spec: Field[]) {
  if (!isObject(value)) return void issues.push(`${where}要是一个对象`);
  for (const [name, check, problem, optional] of spec) {
    if (!(name in value)) {
      if (!optional) issues.push(`${where}缺少 ${name}`);
    } else if (!check(value[name])) issues.push(`${where}的 ${name} ${problem}`);
  }
  for (const name of Object.keys(value)) {
    if (!spec.some(([known]) => known === name)) issues.push(`${where}有不认识的字段 ${name}`);
  }
}

const nameOf = (entry: unknown) => (isObject(entry) && typeof entry.name === "string" ? entry.name : "");

function checkRule(issues: string[], rules: Rules, rule: Rule, names: Set<string>, now: number) {
  const name = nameOf(rule);
  if (names.has(name)) issues.push(`规则名「${name}」重复了`);
  names.add(name);
  const where = `规则「${name}」`;
  const when = isObject(rule) ? rule.when : undefined;
  checkFields(issues, where, rule, [
    ["name", isText, NOT_EMPTY],
    ["when", isObject, "要是一个对象"],
    ["to", isKeyOf(rules.agents), `不是已登记的 Agent：${isObject(rule) ? rule.to : ""}`],
    ["cwd", isFolder, FOLDER],
    ["skill", isText, NOT_EMPTY, true],
    ["prompt", isText, NOT_EMPTY, true],
    ["title", isTitle, "要是字母或数字开头、不含空白的一个词，占位符只能用 {id}、{subject}", true],
    ["group", isText, NOT_EMPTY, true],
    ["parallel", isCount, "要是正整数", true],
    ["maxActive", isCount, "要是正整数", true],
    ["resume", (value) => typeof value === "boolean", "只能是 true 或 false", true],
    ["tell", (value) => TELLS.includes(value as string), `只能是 ${TELLS.join("、")}`, true],
    ["emits", isObject, "要是一个对象", true],
    ["channels", isSomeWords, "要是通道编号的列表", true],
  ]);
  if (isObject(when) && "source" in when) {
    checkFields(issues, `${where}的 when `, when, [
      ["source", isKeyOf(rules.sources), `不是已登记的来源：${when.source}`],
      ["types", isTypes, "要是事件类型的列表，可以用 x.* 或 *"],
    ]);
  } else if (isObject(when)) {
    if (isCron(when.cron) && nextRun(parseCron(when.cron as string)!, now, rules.timezone) === null) {
      issues.push(`${where}的定时永远不会到来：${when.cron}`);
    }
    checkFields(issues, `${where}的 when `, when, [["cron", isCron, "不是有效的 cron"]]);
  }
  if (!isObject(rule)) return;
  // A plain command needs no words: a script that polls something is an agent too.
  if (!rule.skill && !rule.prompt && rules.agents[rule.to]?.use !== "command") {
    issues.push(`${where}的 skill 和 prompt 至少写一个`);
  }
  if (isObject(rule.emits)) {
    const emittable: Check = (value) => value !== SCHEDULE && isKeyOf(rules.sources)(value);
    checkFields(issues, `${where}的 emits `, rule.emits, [
      ["source", emittable, `不是已登记的来源：${rule.emits.source}`],
      ["types", isTypes, "要是事件类型的列表"],
    ]);
  }
  for (const channel of isSomeWords(rule.channels) ? (rule.channels as string[]) : []) {
    if (!Object.hasOwn(rules.channels, channel)) issues.push(`${where}的 channels 不是已登记的通道：${channel}`);
  }
  rule.group ??= rule.name;
  rule.tell ??= "needed";
}

export function parseRules(json: string, now: number, timezone: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RulesError([`不是 JSON：${(error as Error).message}`]);
  }
  const issues: string[] = [];
  checkFields(issues, "rules.json ", parsed, [
    ["timezone", isZone, "不是有效的时区", true],
    ["workerOffline", isObject, "要是一个对象", true],
    ["askFirst", isWords, "要是文字的列表", true],
    ["sources", isObject, "要是一个对象"],
    ["agents", isObject, "要是一个对象"],
    ["channels", isObject, "要是一个对象", true],
    ["defaultChannels", isSomeWords, "要是通道编号的列表", true],
    ["rules", Array.isArray, "要是一个列表"],
    ["elsewhere", Array.isArray, "要是一个列表", true],
  ]);
  if (issues.length) throw new RulesError(issues);
  const rules = parsed as Rules;
  rules.timezone ??= timezone;
  rules.askFirst ??= ASK_FIRST;
  rules.channels ??= {};
  rules.elsewhere ??= [];
  if (rules.workerOffline) {
    const hours = rules.workerOffline;
    checkFields(issues, "workerOffline ", hours, [
      ["start", isTime, "要写成 HH:mm（00:00 到 23:59）"],
      ["end", isTime, "要写成 HH:mm（00:00 到 23:59）"],
      ["daysOff", isDates, "要是真实日期 YYYY-MM-DD 的列表", true],
      ["daysOn", isDates, "要是真实日期 YYYY-MM-DD 的列表", true],
    ]);
    if (isTime(hours.start) && isTime(hours.end) && hours.start >= hours.end) {
      issues.push("workerOffline 的 end 要晚于 start，不跨天");
    }
    if (isDates(hours.daysOff) && isDates(hours.daysOn) && hours.daysOn!.some((day) => hours.daysOff!.includes(day))) {
      issues.push("workerOffline 的同一天不能既在 daysOff 又在 daysOn");
    }
  }
  if (SCHEDULE in rules.sources) issues.push(`来源 ${SCHEDULE} 是保留的，定时用规则的 cron`);
  for (const [id, source] of Object.entries(rules.sources)) {
    if (!ID.test(id)) issues.push(`来源的编号${ID_WORDS}：${id}`);
    checkFields(issues, `来源 ${id} `, source, [
      ["name", isText, NOT_EMPTY],
      ["adapter", isText, NOT_EMPTY, true],
    ]);
  }
  rules.sources[SCHEDULE] = { name: "定时" };
  for (const [id, channel] of Object.entries(rules.channels)) {
    if (!ID.test(id)) issues.push(`通道的编号${ID_WORDS}：${id}`);
    checkFields(issues, `通道 ${id} `, channel, [
      ["name", isText, NOT_EMPTY],
      ["answerers", isWords, "要是文字的列表", true],
      ["links", (value) => typeof value === "boolean", "要是 true 或 false", true],
    ]);
  }
  for (const channel of rules.defaultChannels ?? []) {
    if (!Object.hasOwn(rules.channels, channel))
      issues.push(`rules.json 的 defaultChannels 不是已登记的通道：${channel}`);
  }
  for (const [id, agent] of Object.entries(rules.agents)) {
    if (!ID.test(id)) issues.push(`Agent 的编号${ID_WORDS}：${id}`);
    checkFields(issues, `Agent ${id} `, agent, [
      ["name", isText, NOT_EMPTY],
      ["worker", isId, ID_WORDS],
      ["use", isId, ID_WORDS],
      ["model", isText, NOT_EMPTY, true],
      ["effort", isText, NOT_EMPTY, true],
      ["tier", isText, NOT_EMPTY, true],
      ["access", (value) => ACCESS.includes(value as string), `只能是 ${ACCESS.join("、")}`, true],
      ["command", isSomeWords, "要是命令行的列表", !isObject(agent) || agent.use !== "command"],
      ["program", isText, "要是一个程序的路径", true],
      ["timeout", isCount, "要是正整数（分钟）", true],
      ["maxActive", isCount, "要是正整数", true],
    ]);
    if (isObject(agent)) agent.access ??= "edit";
  }
  const names = new Set<string>();
  for (const rule of rules.rules) checkRule(issues, rules, rule, names, now);
  if (issues.length) throw new RulesError(issues);
  const limits = new Map<string, number | undefined>();
  for (const { group, parallel } of rules.rules) {
    if (limits.has(group) && limits.get(group) !== parallel) issues.push(`组「${group}」里的规则 parallel 要一致`);
    limits.set(group, parallel);
  }
  for (const task of rules.elsewhere) {
    const name = nameOf(task);
    if (names.has(name)) issues.push(`定时任务「${name}」和别的规则或定时任务重名`);
    names.add(name);
    checkFields(issues, `定时任务「${name}」`, task, [
      ["name", isText, NOT_EMPTY],
      ["source", isKeyOf(rules.sources), "不是已登记的来源"],
      ["to", isKeyOf(rules.agents), "不是已登记的 Agent"],
      ["cron", isCron, "不是有效的 cron"],
      ["where", isText, NOT_EMPTY],
      ["cwd", isFolder, FOLDER, true],
      ["skill", isText, NOT_EMPTY, true],
      ["prompt", isText, NOT_EMPTY, true],
    ]);
    if (!isObject(task)) continue;
    // Its answers go on like a round of a rule, so they need what a rule needs.
    const words = task.skill !== undefined || task.prompt !== undefined;
    if (words && task.cwd === undefined) issues.push(`定时任务「${name}」写了回答后照什么做，还要写 cwd：在哪接着做`);
    if (task.cwd !== undefined && !words && rules.agents[task.to]?.use !== "command") {
      issues.push(`定时任务「${name}」写了 cwd，skill 和 prompt 至少写一个：回答后照什么做`);
    }
  }
  if (issues.length) throw new RulesError(issues);
  return rules;
}
