"use strict";
const $ = id => document.getElementById(id);
const stateNames = { running: "正在执行", stopping: "正在停止", queued: "排队中", retrying: "等待重试", unknown: "结果待确认", waiting: "等待你", scheduled: "等待复查", done: "执行结束", nothing: "无事可做", cancelled: "已取消" };
for (const [value, name] of Object.entries(stateNames)) $("state").add(new Option(name, value));
const params = new URLSearchParams(location.search);
let selected = params.get("thing"), data = null, busy = false, generation = 0, detailGeneration = 0;
let scrollToDetail = false;
let detailKey = "", limits = { activities: 100, pending: 100 };
$("date").value = params.get("date") || "";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function duration(ms) {
  if (ms === null || !Number.isFinite(ms)) return "无法确认";
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 时`;
  if (hours) return `${hours} 时 ${minutes % 60} 分`;
  if (minutes) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}
function time(at, full = false) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: data?.timezone || "Asia/Shanghai", ...(full ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(at);
}
function address() {
  const query = new URLSearchParams();
  if ($("date").value) query.set("date", $("date").value);
  if (selected) query.set("thing", selected);
  history.replaceState(null, "", `/?${query}`);
}
async function json(path) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "读取失败，请稍后刷新记录");
  return body;
}
function syncText() {
  const sync = data.sync;
  const source = sync.covered ? "已核对启动时可见轮次" : "历史仍在读取，列表可能不全";
  const state = sync.connection === "disconnected" ? sync.message : sync.covered ? source : `${source} · ${sync.message || "正在连接"}`;
  $("sync").textContent = `${state} · 已收到 ${sync.seq || 0} 条记录`;
  $("sync").title = "中台没有提供日志末尾标记；轮次核对仅覆盖启动核对时已知的轮次，不表示全局日志已到末尾。";
  $("observation").textContent = `${data.historical ? "日终视图" : "今天自动更新"} · ${data.day} ${time(data.cutoff)} · ${data.timezone}`;
}
async function load(manual = false) {
  if (busy && !manual) return;
  const ticket = ++generation;
  busy = true; $("workspace").setAttribute("aria-busy", "true");
  $("refresh").disabled = true;
  if (manual) $("error").hidden = true;
  try {
    const day = $("date").value;
    const result = await json(`/api/day${day ? `?date=${encodeURIComponent(day)}` : ""}`);
    if (ticket !== generation) return;
    data = result; $("date").value = data.day; $("date").max = data.today;
    $("next").disabled = data.day >= data.today;
    $("today").disabled = data.day === data.today;
    $("day-label").textContent = data.day;
    const rule = $("rule").value;
    const names = [...new Set([...data.activities, ...data.pending].map(row => row.rule))].sort();
    $("rule").replaceChildren(new Option("全部规则", ""), ...names.map(name => new Option(name, name)));
    if (names.includes(rule)) $("rule").value = rule;
    syncText(); renderLists(); address(); $("error").hidden = true;
  } catch (error) {
    if (ticket !== generation) return;
    $("error").textContent = `${error.message}。可点击“刷新记录”重试。`;
    $("error").hidden = false;
    if (!data) {
      $("activities").replaceChildren(element("p", "暂时读不到记录，请检查中台连接后刷新。", "empty"));
      $("pending").replaceChildren(); $("sync").textContent = "记录未读取";
    }
  } finally {
    if (ticket === generation) { busy = false; $("workspace").setAttribute("aria-busy", "false"); $("refresh").disabled = false; }
  }
}
function filtered(rows) {
  const query = $("search").value.trim().toLocaleLowerCase(), rule = $("rule").value, state = $("state").value;
  return rows.filter(row => (!rule || row.rule === rule) && (!state || row.state === state) && (!query || [row.title, row.summary, row.rule, ...row.subjects].join(" ").toLocaleLowerCase().includes(query)));
}
function rowButton(row) {
  const button = element("button", undefined, `row${selected === row.id ? " selected" : ""}`);
  button.type = "button"; button.dataset.thing = row.id;
  button.setAttribute("aria-pressed", String(selected === row.id));
  const body = element("span"), title = element("span", row.title, "row-title");
  title.title = row.title; body.append(title);
  body.append(element("span", `${row.rule}${row.batch ? ` · 合批 · ${row.subjects.length} 个对象，共享耗时` : ""}`, "row-meta"));
  const summary = element("span", row.summary, "summary"); summary.title = row.summary; body.append(summary);
  const execution = element("span", duration(row.executionMs), "duration"); execution.dataset.label = "执行";
  if (row.ongoing && row.executionMs !== null) execution.append(element("small", "进行中"));
  const elapsed = element("span", duration(row.elapsedMs), "duration"); elapsed.dataset.label = "历时";
  button.append(body, element("span", row.stateLabel, `state ${row.state}`), execution, elapsed);
  button.addEventListener("click", () => { selected = row.id; detailKey = ""; scrollToDetail = matchMedia("(max-width: 940px)").matches; renderLists(false); address(); });
  return button;
}
function renderLists(resetSelection = true) {
  if (!data) return;
  const focus = document.activeElement;
  const focusedThing = focus?.dataset?.thing, focusedGroup = focus?.parentElement?.id;
  const groups = { activities: filtered(data.activities), pending: filtered(data.pending) };
  const all = [...groups.activities, ...groups.pending];
  if (resetSelection && !all.some(row => row.id === selected)) selected = all[0]?.id || null;
  for (const [group, rows] of Object.entries(groups)) {
    const total = data[group].length;
    $(group === "activities" ? "activity-count" : "pending-count").textContent = rows.length === total ? `${total} 件` : `${rows.length} / ${total} 件`;
    const holder = $(group); holder.replaceChildren(...rows.slice(0, limits[group]).map(rowButton));
    if (!rows.length) {
      const text = total ? "没有符合筛选条件的记录。可清除筛选后再看。" : !data.sync.covered ? "记录仍在读取，暂不能确认这一组为空。" : group === "activities" ? "这一天尚未发现处理活动。" : "截至观察时刻，没有发现仍待处理的事情。";
      holder.append(element("p", text, "empty"));
    }
    if (rows.length > limits[group]) {
      const more = element("button", `再显示 ${Math.min(100, rows.length - limits[group])} 件（还有 ${rows.length - limits[group]} 件）`, "more");
      more.addEventListener("click", () => { limits[group] += 100; renderLists(false); }); holder.append(more);
    }
  }
  $("clear").hidden = !$("rule").value && !$("state").value && !$("search").value;
  if (focusedThing && ["activities", "pending"].includes(focusedGroup)) {
    [...$(focusedGroup).querySelectorAll("button[data-thing]")].find(node => node.dataset.thing === focusedThing)?.focus({ preventScroll: true });
  }
  showDetail();
}
function safeLink(value) {
  try {
    const url = new URL(value);
    const web = ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
    const session = /^codex:\/\/threads\/[a-zA-Z0-9-]+$/.test(value) || /^claude:\/\/resume\?session=[a-zA-Z0-9-]+$/.test(value);
    return web || session ? url.href : null;
  } catch { return null; }
}
function links(values) {
  const holder = element("div", undefined, "links");
  [...new Set(values)].forEach((value, index) => {
    const href = safeLink(value); if (!href) return;
    const link = element("a", `打开来源或会话 ${index + 1}`);
    link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.title = href; holder.append(link);
  });
  return holder;
}
function disclosure(title, rows, render) {
  const details = element("details"), body = element("div"); details.dataset.section = title;
  details.append(element("summary", `${title} · ${rows.length}`));
  for (const row of rows) body.append(render(row));
  details.append(body); return details;
}
async function showDetail() {
  const key = `${data.day}:${selected}:${data.cutoff}:${data.seq}:${data.sync.seq}`;
  if (key === detailKey) return;
  detailKey = key;
  const ticket = ++detailGeneration, holder = $("detail");
  if (!selected) {
    holder.replaceChildren(element("div", "选择一件事情，查看回执与处理依据。", "detail-empty")); return;
  }
  const id = selected;
  holder.setAttribute("aria-busy", "true");
  if (holder.dataset.thing !== id) holder.replaceChildren(element("p", "正在读取处理过程…", "empty"));
  try {
    const result = await json(`/api/things/${encodeURIComponent(id)}?date=${data.day}`);
    if (ticket !== detailGeneration) return;
    const thing = result.thing, open = new Set([...holder.querySelectorAll("details[open]")].map(node => node.dataset.section));
    const scroll = holder.dataset.thing === id ? holder.scrollTop : 0;
    const top = element("div", undefined, "detail-top");
    top.append(element("span", `${thing.rule} · ${thing.id.replace("thing-", "记录 #")}`, "reference"), element("span", thing.stateLabel, `state ${thing.state}`));
    const context = element("p", `${thing.runs} 轮处理 · ${thing.attempts.length} 次领取${thing.batch ? " · 多对象合批，共享执行耗时" : ""}`, "context");
    const numbers = element("div", undefined, "numbers");
    for (const [label, value] of [["累计执行耗时", duration(thing.executionMs)], ["整个处理历时", duration(thing.elapsedMs)]]) {
      const part = element("div"); part.append(element("p", label), element("strong", value)); numbers.append(part);
    }
    const receipt = element("section", undefined, "receipt");
    receipt.append(element("h3", "最后回执摘要"), element("p", thing.summary, "prose"));
    if (thing.ongoing) receipt.append(element("p", "执行仍未结束；结果待确认时，耗时也无法确认。", "note"));
    const back = element("button", "返回所选记录", "detail-back quiet");
    back.addEventListener("click", () => {
      const row = [...document.querySelectorAll(".row")].find(node => node.dataset.thing === id);
      if (row) { row.scrollIntoView({ block: "center" }); row.focus({ preventScroll: true }); }
      else $("activity-title").scrollIntoView({ block: "start" });
    });
    holder.replaceChildren(back, top, element("h2", thing.title), context, numbers, receipt);
    if (result.historical && result.latest) {
      const latest = element("section", undefined, "latest");
      latest.append(element("h3", "后来进展（截至当前已收到的记录）"), element("span", result.latest.stateLabel, `state ${result.latest.state}`), element("p", result.latest.summary, "prose"));
      holder.append(latest);
    }
    holder.append(element("h3", "处理过程"));
    const timeline = element("ol", undefined, "timeline");
    for (const step of thing.steps) {
      const item = element("li"), stamp = element("time", time(step.at, true)), body = element("div"); stamp.dateTime = new Date(step.at).toISOString();
      body.append(element("b", step.title), element("p", step.text || (step.run ? `第 ${step.run} 轮` : "")));
      item.append(stamp, body); timeline.append(item);
    }
    holder.append(timeline);
    if (thing.attempts.length) holder.append(disclosure("各次执行耗时", thing.attempts, attempt => {
      const item = element("div");
      const end = attempt.end ?? result.cutoff;
      const elapsed = attempt.uncertain || !Number.isFinite(attempt.start) || end < attempt.start ? null : end - attempt.start;
      item.append(element("h4", `第 ${attempt.run} 轮 · ${duration(elapsed)}`), element("p", `${Number.isFinite(attempt.start) ? time(attempt.start, true) : "领取时间缺失"} → ${attempt.end === undefined ? "尚无结束依据" : time(attempt.end, true)}`, "note"));
      return item;
    }));
    if (thing.receipts.length) holder.append(disclosure("各次回执摘要", thing.receipts, row => {
      const item = element("div"); item.append(element("h4", `${time(row.at, true)} · ${row.title}`), element("p", row.text, "prose")); return item;
    }));
    if (thing.cards.length) holder.append(disclosure("提问、回答与通知", thing.cards, card => {
      const item = element("div"); item.append(element("h4", card.title), element("p", card.text, "prose"));
      if (card.options?.length) item.append(element("p", `选项：${card.options.join(" / ")}`, "note"));
      const answer = card.answer || (Number.isInteger(card.choice) ? card.options?.[card.choice] : "");
      item.append(element("p", card.result ? `处理结果：${card.result}` : answer ? `回答：${answer}` : card.kind === "ask" ? "尚未回答" : "通知", "note")); return item;
    }));
    holder.append(disclosure("触发资料", thing.events, event => {
      const item = element("div"); item.append(element("h4", event.summary || event.type), element("p", `${event.source} · ${event.type}${event.subject ? ` · ${event.subject}` : ""}`, "note"), element("p", event.detail || "没有补充资料", "prose")); return item;
    }));
    holder.append(links(thing.links));
    if (thing.related?.length) {
      const related = element("section", undefined, "related"); related.append(element("h3", "同一对象的其他处理"));
      for (const other of thing.related) {
        const button = element("button", `${time(other.openedAt, true)} · ${other.title}`);
        button.addEventListener("click", () => { selected = other.id; detailKey = ""; renderLists(false); address(); }); related.append(button);
      }
      holder.append(related);
    }
    holder.querySelectorAll("details").forEach(node => { node.open = open.has(node.dataset.section); });
    holder.dataset.thing = id; holder.scrollTop = scroll;
    if (scrollToDetail) { scrollToDetail = false; holder.scrollIntoView({ block: "start" }); holder.setAttribute("tabindex", "-1"); holder.focus({ preventScroll: true }); }
  } catch (error) {
    if (ticket !== detailGeneration) return;
    detailKey = ""; holder.replaceChildren(element("p", `${error.message}。点击“刷新记录”重试。`, "empty"));
  } finally { if (ticket === detailGeneration) holder.setAttribute("aria-busy", "false"); }
}
function changeDay(day) {
  $("date").value = day; selected = null; detailKey = ""; limits = { activities: 100, pending: 100 }; load(true);
}
function offsetDay(offset) {
  if (!$("date").value) return;
  const day = new Date(`${$("date").value}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + offset); changeDay(day.toISOString().slice(0, 10));
}
$("previous").addEventListener("click", () => offsetDay(-1));
$("next").addEventListener("click", () => offsetDay(1));
$("today").addEventListener("click", () => changeDay(data?.today || ""));
$("date").addEventListener("change", () => changeDay($("date").value));
$("refresh").addEventListener("click", () => { detailKey = ""; load(true); });
for (const id of ["rule", "state", "search"]) $(id).addEventListener(id === "search" ? "input" : "change", () => { renderLists(); address(); });
$("clear").addEventListener("click", () => { for (const id of ["rule", "state", "search"]) $(id).value = ""; renderLists(); address(); });
setInterval(() => { if (!document.hidden && (!data || !data.historical || !data.sync.covered)) load(); }, 5000);
load();
