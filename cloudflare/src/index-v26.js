import app from "./index-v25.js";

const VERSION = "v2.6-task-control-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}
function now() { return new Date().toISOString(); }
function clip(s, n = 3900) { return String(s || "").slice(0, n); }
function compact(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}
async function kvPut(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}
async function getTasks(env) {
  return (await kvGet(env, "tasks", { tasks: [] })).tasks || [];
}
async function saveTasks(env, tasks) {
  await kvPut(env, "tasks", { tasks: tasks.slice(-100) });
}
async function getBrain(env) {
  const b = await kvGet(env, "brain", {});
  return { alive_enabled: false, stats: { cycles_total: 0, daily: {} }, ...b, stats: { cycles_total: 0, daily: {}, ...(b.stats || {}) } };
}
async function getMemories(env) {
  return (await kvGet(env, "memories", { memories: [] })).memories || [];
}
async function getProjectState(env) {
  const state = await kvGet(env, "projects:state", { projects: [], active: null });
  return { projects: state.projects || [], active: state.active || null };
}
function activeProject(state) {
  const key = compact(state.active);
  return (state.projects || []).find(p => compact(p.name) === key || compact(p.id) === key) || (state.projects || [])[0] || null;
}

async function loadConfig(env) {
  const cfg = {
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || "",
    TELEGRAM_ALLOWED_USER_ID: env.TELEGRAM_ALLOWED_USER_ID || ""
  };
  if (env.MINISKYNET_KV) {
    for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]) {
      if (!cfg[k]) cfg[k] = String(await env.MINISKYNET_KV.get("config:" + k) || "").trim();
    }
  }
  return cfg;
}
function isOwner(cfg, userId) {
  const owner = String(cfg.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}
async function tg(cfg, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await res.json().catch(() => ({}));
}
async function send(cfg, chatId, text) {
  if (cfg.TELEGRAM_BOT_TOKEN && chatId) return await tg(cfg, "sendMessage", { chat_id: chatId, text: clip(text) });
}
function parseUpdate(update) {
  const msg = update?.message || update?.edited_message || null;
  if (!msg) return null;
  const text = String(msg.text || "").trim();
  let command = null, args = "";
  if (text.startsWith("/")) {
    const i = text.indexOf(" ");
    command = (i === -1 ? text : text.slice(0, i)).replace(/@\w+$/, "").toLowerCase();
    args = i === -1 ? "" : text.slice(i + 1).trim();
  }
  return { chatId: msg.chat?.id, userId: msg.from?.id, text, command, args };
}

const ACTIVE_TASK_STATUSES = new Set(["todo", "retry_wait", "doing", "pending", "active"]);
const STALE_PATTERNS = [
  "growth_hygiene", "growth-задача", "очередь роста", "worker-inspector", "worker-agents",
  "вывод нужно провер", "проверить практикой", "следующий маленький безопасный шаг",
  "улучшения функциональности", "саморазвитие", "анализ логов", "сбор метрик",
  "использования памяти", "мониторинг памяти", "фокус на полезной информации", "определить шаги"
];
function taskStatus(t) { return String(t?.status || "todo").toLowerCase(); }
function taskText(t) { return compact(`${t?.title || ""} ${t?.description || ""} ${t?.action || ""}`); }
function isVisibleTask(t) {
  const text = taskText(t);
  return ACTIVE_TASK_STATUSES.has(taskStatus(t)) && text && !STALE_PATTERNS.some(p => text.includes(p));
}
function visibleTasks(tasks) { return tasks.filter(isVisibleTask); }
function formatTask(t, i = null) {
  const prefix = i === null ? "-" : `${i + 1}.`;
  return `${prefix} ${t.id} [${t.status || "todo"}] p${t.priority || 4}: ${t.title}`;
}
function resolveTask(tasks, ref) {
  const r = String(ref || "").trim();
  const n = parseInt(r, 10);
  const vis = visibleTasks(tasks);
  if (n && n >= 1 && n <= vis.length) return vis[n - 1];
  return tasks.find(t => String(t.id || "") === r || String(t.id || "").startsWith(r)) || null;
}
function parseEditArgs(args) {
  const raw = String(args || "").trim();
  const colon = raw.indexOf(":");
  if (colon > 0) return { ref: raw.slice(0, colon).trim(), title: raw.slice(colon + 1).trim() };
  const parts = raw.split(/\s+/);
  return { ref: parts.shift() || "", title: parts.join(" ").trim() };
}
async function taskListText(env) {
  const tasks = await getTasks(env);
  const vis = visibleTasks(tasks);
  return [
    "📋 Активные задачи:",
    ...(vis.length ? vis.slice(-20).map((t, i) => formatTask(t, i)) : ["пусто"]),
    "",
    "Управление: /task_done номер | /task_edit номер: текст | /task_del номер"
  ].join("\n");
}
async function taskStatsText(env) {
  const tasks = await getTasks(env);
  const done = tasks.filter(t => ["done", "archived", "cancelled"].includes(taskStatus(t))).length;
  return [
    "🧩 Task Control v2.6:",
    `- всего задач в KV: ${tasks.length}`,
    `- активных видимых: ${visibleTasks(tasks).length}`,
    `- закрытых/архивных: ${done}`,
    "",
    "Команды:",
    "/tasks — список активных",
    "/task_done номер|id",
    "/task_edit номер|id: новый текст",
    "/task_del номер|id",
    "/task_clear_done"
  ].join("\n");
}
async function statusText(env) {
  const [tasks, brain, memories, projectState] = await Promise.all([getTasks(env), getBrain(env), getMemories(env), getProjectState(env)]);
  const project = activeProject(projectState);
  const done = tasks.filter(t => ["done", "archived", "cancelled"].includes(taskStatus(t))).length;
  return [
    "📡 MiniSkynet v2.6 status",
    `- version: ${VERSION}`,
    `- active project: ${project?.name || "—"}`,
    `- alive: ${brain.alive_enabled}`,
    `- циклов всего: ${brain.stats?.cycles_total || 0}`,
    `- задачи: active=${visibleTasks(tasks).length}, done=${done}, total=${tasks.length}`,
    `- память всего: ${memories.length}`,
    "- base: v2.5 project knowledge"
  ].join("\n");
}
async function handleTaskCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  if (command === "/task_help") return await send(cfg, chatId, await taskStatsText(env));
  if (command === "/tasks") return await send(cfg, chatId, await taskListText(env));
  if (command === "/status") return await send(cfg, chatId, await statusText(env));
  if (command === "/help") {
    return await send(cfg, chatId, [
      "/start /help /status",
      "/self /goals /plan /next",
      "/projects /project_status /project_add Name: desc /project_focus Name",
      "/tasks /task_help",
      "/task_done номер|id",
      "/task_edit номер|id: новый текст",
      "/task_del номер|id",
      "/task_clear_done",
      "/think текст /memory_score /cost /alive_off"
    ].join("\n"));
  }

  const tasks = await getTasks(env);

  if (command === "/task_done") {
    const task = resolveTask(tasks, args);
    if (!task) return await send(cfg, chatId, "Не нашёл задачу. Посмотри /tasks и укажи номер или id.");
    task.status = "done";
    task.done_at = now();
    await saveTasks(env, tasks);
    return await send(cfg, chatId, `✅ Закрыл задачу:\n${task.title}\n\nДальше: /next`);
  }

  if (command === "/task_del") {
    const task = resolveTask(tasks, args);
    if (!task) return await send(cfg, chatId, "Не нашёл задачу. Посмотри /tasks и укажи номер или id.");
    const next = tasks.filter(t => t !== task);
    await saveTasks(env, next);
    return await send(cfg, chatId, `🗑 Удалил задачу:\n${task.title}`);
  }

  if (command === "/task_edit") {
    const parsed = parseEditArgs(args);
    if (!parsed.ref || !parsed.title) return await send(cfg, chatId, "Формат: /task_edit 1: новый текст задачи");
    const task = resolveTask(tasks, parsed.ref);
    if (!task) return await send(cfg, chatId, "Не нашёл задачу. Посмотри /tasks и укажи номер или id.");
    const old = task.title;
    task.title = clip(parsed.title, 300);
    task.updated_at = now();
    await saveTasks(env, tasks);
    return await send(cfg, chatId, `✏️ Задача обновлена:\nбыло: ${old}\nстало: ${task.title}`);
  }

  if (command === "/task_clear_done") {
    const before = tasks.length;
    const next = tasks.filter(t => !["done", "archived", "cancelled"].includes(taskStatus(t)));
    await saveTasks(env, next);
    return await send(cfg, chatId, `🧹 Убрал закрытые задачи: ${before - next.length}. Осталось: ${next.length}.`);
  }
}

const TASK_COMMANDS = new Set(["/task_help", "/tasks", "/status", "/help", "/task_done", "/task_del", "/task_edit", "/task_clear_done"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v2.5-project-knowledge" });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && TASK_COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleTaskCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ Task Control error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, task_control: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  }
};
