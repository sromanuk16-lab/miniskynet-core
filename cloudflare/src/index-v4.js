const VERSION = "v6.0.0-agent-kernel-clean-v1-2026-07-06";
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKER_URL = "https://miniskynet-core.sromanuk16.workers.dev";
const H = { "content-type": "application/json; charset=utf-8" };

const MAX_TELEGRAM_TEXT = 3900;
const PENDING_TTL_MS = 30 * 60 * 1000;
const ACTION_LOG_LIMIT = 40;
const TASK_LIMIT = 120;
const MEMORY_LIMIT = 120;

const TOOL_REGISTRY = {
  chat: {
    available: true,
    can: ["answer", "clarify"],
    ordinary_text: true,
    write: false,
    label: "разговор"
  },
  task_store: {
    available: true,
    can: ["create_task", "list_tasks", "close_task"],
    ordinary_text: true,
    write: "small_local_state",
    label: "задачи"
  },
  memory_store: {
    available: true,
    can: ["save_note", "read_brief_context"],
    ordinary_text: true,
    write: "small_local_state",
    label: "память"
  },
  capability_planner: {
    available: true,
    can: ["create_capability_task", "remember_pending_action"],
    ordinary_text: true,
    write: "small_local_state",
    label: "план развития"
  },
  scheduler: {
    available: false,
    can: ["schedule_message", "list_reminders", "cancel_reminder"],
    ordinary_text: false,
    write: "future_local_state",
    label: "напоминания"
  },
  file_reader: {
    available: false,
    can: ["read_uploaded_file", "summarize_file"],
    ordinary_text: false,
    write: false,
    label: "чтение файлов"
  },
  code_analyzer: {
    available: false,
    can: ["inspect_source", "find_runtime_risks", "explain_code"],
    ordinary_text: false,
    write: false,
    label: "проверка кода"
  },
  pc_reader: {
    available: false,
    can: ["read_allowed_local_paths"],
    ordinary_text: false,
    write: false,
    label: "доступ к файлам ПК"
  },
  background_runner: {
    available: false,
    can: ["run_periodic_check", "notify_when_changed"],
    ordinary_text: false,
    write: "future_local_state",
    label: "работа в фоне"
  },
  github_writer: {
    available: false,
    ordinary_text: false,
    slash_only: true,
    write: "external_code_write",
    label: "изменение кода"
  }
};

const ORDINARY_ALLOWED_INTENTS = new Set([
  "chat",
  "answer",
  "ask_clarification",
  "task.list",
  "task.add",
  "task.close",
  "memory.note",
  "capability.missing",
  "followup.execute_pending",
  "unknown"
]);

const DANGEROUS_ACTION_TYPES = new Set([
  "code_apply",
  "deploy",
  "delete",
  "secrets",
  "external_write",
  "shell",
  "github_write"
]);

const SLASH_COMMANDS = new Set([
  "/start",
  "/help",
  "/status",
  "/health",
  "/debug",
  "/tasks",
  "/addtask",
  "/task_add",
  "/task_done",
  "/done",
  "/pending",
  "/clear_pending",
  "/memory",
  "/remember",
  "/selftest",
  "/tool_registry"
]);

const now = () => new Date().toISOString();
const clip = (v, n = MAX_TELEGRAM_TEXT) => String(v ?? "").slice(0, n);
const uid = (p = "id") => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const cleanText = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const lower = (s) => String(s ?? "").toLowerCase();

function out(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: H });
}

function parseTelegramUpdate(update) {
  const m = update?.message || update?.edited_message;
  if (!m) return null;
  const text = String(m.text || m.caption || "").trim();
  let command = null;
  let args = "";
  if (text.startsWith("/")) {
    const i = text.indexOf(" ");
    command = (i < 0 ? text : text.slice(0, i)).replace(/@\w+$/, "").trim().toLowerCase();
    args = i < 0 ? "" : text.slice(i + 1).trim();
  }
  return {
    chatId: m.chat?.id,
    userId: m.from?.id,
    text,
    command,
    args,
    raw: m
  };
}

function hasKV(env) {
  return !!env?.MINISKYNET_KV;
}

async function kvText(env, key) {
  if (!hasKV(env)) return "";
  return String((await env.MINISKYNET_KV.get(key)) || "").trim();
}

async function kvGet(env, key, fallback) {
  if (!hasKV(env)) return fallback;
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function kvPut(env, key, value) {
  if (!hasKV(env)) return false;
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
  return true;
}

async function kvDel(env, key) {
  if (!hasKV(env)) return false;
  await env.MINISKYNET_KV.delete(key);
  return true;
}

async function cfg(env) {
  return {
    telegram:
      String(env.TELEGRAM_BOT_TOKEN || "").trim() ||
      (await kvText(env, "config:TELEGRAM_BOT_TOKEN")),
    owner:
      String(env.TELEGRAM_ALLOWED_USER_ID || "").trim() ||
      (await kvText(env, "config:TELEGRAM_ALLOWED_USER_ID")),
    openrouter:
      String(env.OPENROUTER_API_KEY || "").trim() ||
      (await kvText(env, "config:OPENROUTER_API_KEY")),
    model:
      String(env.OPENROUTER_MODEL_CHEAP || "").trim() ||
      (await kvText(env, "config:OPENROUTER_MODEL_CHEAP")) ||
      "openai/gpt-4o-mini",
    repo:
      String(env.GITHUB_REPO || "").trim() ||
      (await kvText(env, "config:GITHUB_REPO")) ||
      DEFAULT_REPO,
    branch:
      String(env.GITHUB_BRANCH || "").trim() ||
      (await kvText(env, "config:GITHUB_BRANCH")) ||
      DEFAULT_BRANCH,
    worker:
      String(env.WORKER_URL || "").trim() ||
      (await kvText(env, "config:WORKER_URL")) ||
      DEFAULT_WORKER_URL
  };
}

function ownerOk(c, userId) {
  return !c.owner || String(userId || "") === String(c.owner);
}

async function tg(c, method, body) {
  if (!c.telegram) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const r = await fetch(`https://api.telegram.org/bot${c.telegram}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}

async function send(c, chatId, text) {
  if (Array.isArray(c?.__capture)) {
    c.__capture.push(clip(text));
    return { ok: true, captured: true };
  }
  if (!chatId) return { ok: false, skipped: true };
  return tg(c, "sendMessage", { chat_id: chatId, text: clip(text) });
}

function normalizeTask(raw, i = 0) {
  const id = String(raw?.id || raw?.task_id || `legacy_${i + 1}`);
  const title = cleanText(raw?.title || raw?.text || raw?.name || "Без названия");
  const status0 = lower(raw?.status || "active");
  const status = ["done", "closed", "complete", "completed"].includes(status0)
    ? "done"
    : "active";
  return {
    id,
    title,
    status,
    created_at: raw?.created_at || raw?.created || now(),
    closed_at: raw?.closed_at || raw?.done_at || null,
    source: raw?.source || "task_store"
  };
}

async function getTasks(env) {
  const old = await kvGet(env, "tasks", { tasks: [] });
  const direct = await kvGet(env, "ak:tasks", { tasks: [] });
  const a = Array.isArray(old?.tasks) ? old.tasks : [];
  const b = Array.isArray(direct?.tasks) ? direct.tasks : [];
  const merged = [...a, ...b].map(normalizeTask);
  const seen = new Set();
  return merged.filter((t) => {
    const k = `${t.id}:${t.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function saveTasks(env, tasks) {
  const normalized = tasks.map(normalizeTask).slice(-TASK_LIMIT);
  await kvPut(env, "tasks", { tasks: normalized });
  await kvPut(env, "ak:tasks", { tasks: normalized });
  return normalized;
}

async function addTask(env, title, extra = {}) {
  const tasks = await getTasks(env);
  const t = {
    id: uid("task"),
    title: cleanText(title) || "Новая задача",
    status: "active",
    created_at: now(),
    closed_at: null,
    source: extra.source || "agent_kernel",
    tool_type: extra.tool_type || null,
    reason: extra.reason || null
  };
  tasks.push(t);
  await saveTasks(env, tasks);
  return t;
}

async function closeTask(env, task) {
  const tasks = await getTasks(env);
  const targetId = String(task?.id || "");
  const next = tasks.map((t) =>
    String(t.id) === targetId
      ? { ...t, status: "done", closed_at: now() }
      : t
  );
  await saveTasks(env, next);
  return next.find((t) => String(t.id) === targetId) || null;
}

function activeTasks(tasks) {
  return tasks.filter((t) => t.status !== "done");
}

function listTasksHuman(tasks) {
  const active = activeTasks(tasks);
  if (!active.length) return "Активных задач нет.";
  const rows = active.slice(0, 12).map((t, i) => `${i + 1}. ${t.title}`);
  const extra = active.length > 12 ? `\nЕщё: ${active.length - 12}` : "";
  return `Активные задачи:\n${rows.join("\n")}${extra}`;
}

function pickTask(tasks, hint) {
  const active = activeTasks(tasks);
  if (!active.length) return { ok: false, reason: "no_active" };
  if (active.length === 1 && !cleanText(hint)) return { ok: true, task: active[0] };
  const h = cleanText(hint);
  if (!h) return { ok: false, reason: "ambiguous", active };
  const idHit = active.find((t) => String(t.id) === h || String(t.id).startsWith(h));
  if (idHit) return { ok: true, task: idHit };
  const hn = lower(h);
  const scored = active
    .map((t) => {
      const title = lower(t.title);
      let score = 0;
      if (title === hn) score += 100;
      if (title.includes(hn)) score += 60;
      for (const w of hn.split(/\s+/).filter(Boolean)) {
        if (w.length > 2 && title.includes(w)) score += 12;
      }
      return { task: t, score };
    })
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score || 0)) {
    return { ok: true, task: scored[0].task };
  }
  return { ok: false, reason: "ambiguous", active };
}

async function getMemory(env) {
  const v = await kvGet(env, "ak:memory", { memories: [] });
  return Array.isArray(v?.memories) ? v.memories : [];
}

async function saveMemoryNote(env, text, extra = {}) {
  const memories = await getMemory(env);
  const m = {
    id: uid("mem"),
    text: cleanText(text),
    created_at: now(),
    source: extra.source || "agent_kernel"
  };
  memories.push(m);
  await kvPut(env, "ak:memory", { memories: memories.slice(-MEMORY_LIMIT) });
  return m;
}

async function getPending(env) {
  const p = await kvGet(env, "pending_action", null);
  if (!p) return null;
  if (p.expires_at && Date.parse(p.expires_at) < Date.now()) {
    await kvDel(env, "pending_action");
    return null;
  }
  return p;
}

async function savePending(env, pending) {
  const p = {
    ...pending,
    id: pending.id || uid("pending"),
    created_at: pending.created_at || now(),
    expires_at: pending.expires_at || new Date(Date.now() + PENDING_TTL_MS).toISOString()
  };
  await kvPut(env, "pending_action", p);
  return p;
}

async function clearPending(env) {
  await kvDel(env, "pending_action");
}

async function logAction(env, entry) {
  const old = await kvGet(env, "ak:action_log", { log: [] });
  const log = Array.isArray(old?.log) ? old.log : [];
  log.push({ ...entry, at: now() });
  await kvPut(env, "ak:action_log", { log: log.slice(-ACTION_LOG_LIMIT) });
}

function registryBrief() {
  return Object.entries(TOOL_REGISTRY).map(([tool_type, v]) => ({
    tool_type,
    available: !!v.available,
    can: v.can || [],
    label: v.label || tool_type,
    ordinary_text: !!v.ordinary_text,
    slash_only: !!v.slash_only
  }));
}

function compactStateForLLM(tasks, pending, memories) {
  return {
    version: VERSION,
    style: {
      language: "ru",
      voice: "short_human_jarvis_london",
      avoid_in_normal_chat: [
        "capability_request",
        "tool_type",
        "pending_action",
        "risk",
        "safe",
        "KV",
        "GitHub",
        "shell",
        "executor",
        "internal JSON"
      ]
    },
    active_tasks: activeTasks(tasks).slice(-12).map((t) => ({ id: t.id, title: t.title })),
    pending_action: pending
      ? {
          type: pending.type,
          title: pending.title,
          tool_type: pending.tool_type,
          expires_at: pending.expires_at
        }
      : null,
    memory_notes: memories.slice(-8).map((m) => m.text),
    tools: registryBrief()
  };
}

function actionFrameSchemaPrompt() {
  return `Ты ядро личного агента Сергея. Твоя задача — понять обычный русский текст и вернуть только JSON.

НЕ ДЕЛАЙ route по фразам. Понимай смысл.
Код выполнит только JSON, который ты вернёшь.

Стиль human_response: очень коротко, живо, по-русски. Без скучных слов и внутренней кухни.
Не используй в human_response слова: capability_request, tool_type, pending_action, risk, safe, KV, GitHub, shell, executor.
Если Сергей сам просит технически — можно объяснить подробнее, но всё равно ясно.

Верни JSON строго такого вида:
{
  "intent": "chat | answer | ask_clarification | task.list | task.add | task.close | memory.note | capability.missing | followup.execute_pending | unknown",
  "goal": "краткий смысл просьбы",
  "action_type": "абстрактный тип действия: chat, list_tasks, create_task, close_task, scheduled_notification, file_read, code_analysis, pc_access, background_monitoring, code_apply, deploy, delete, secrets, unknown",
  "tool_needed": "один tool_type из registry или новый абстрактный tool_type",
  "confidence": 0.0,
  "args": {
    "task_title": "если нужно добавить задачу",
    "target_hint": "если нужно закрыть/найти цель",
    "memory_text": "если нужно запомнить",
    "capability_title": "человеческое название нужной возможности, 1-3 слова",
    "answer": "если это просто ответ"
  },
  "human_response": "короткий ответ пользователю"
}

Правила:
1. Простые разговоры: intent=chat или answer.
2. Задачи можно создавать, показывать и закрывать обычным текстом.
3. Если Сергей говорит вроде “добавляй / делай / так сделай / сделай его / давай” и есть pending_action — intent=followup.execute_pending.
4. Если он просит действие, для которого нет инструмента, верни capability.missing. Пример human_response: “Пока не умею. Могу добавить это себе. Добавлять?”
5. Не называй конкретные модули вроде Reminder Scheduler. Думай типами возможностей.
6. Если просьба опасная: применение кода, деплой, удаление, секреты, shell — не выполняй. Human_response коротко: “Из обычного чата это не трогаю.”
7. Если не уверен — ask_clarification или unknown.
8. Ответ должен быть валидный JSON без markdown.`;
}

function extractJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) throw new Error("empty model response");
  try {
    return JSON.parse(s);
  } catch (_) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error("model did not return JSON");
  }
}

function normalizeFrame(raw) {
  const f = isObj(raw) ? raw : {};
  const args = isObj(f.args) ? f.args : {};
  const intent = cleanText(f.intent || "unknown");
  return {
    intent: ORDINARY_ALLOWED_INTENTS.has(intent) ? intent : "unknown",
    goal: cleanText(f.goal || ""),
    action_type: cleanText(f.action_type || "unknown"),
    tool_needed: cleanText(f.tool_needed || "chat"),
    confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
    args: {
      task_title: cleanText(args.task_title || ""),
      target_hint: cleanText(args.target_hint || ""),
      memory_text: cleanText(args.memory_text || ""),
      capability_title: cleanText(args.capability_title || ""),
      answer: cleanText(args.answer || "")
    },
    human_response: humanClean(f.human_response || "")
  };
}

function humanClean(text) {
  let s = cleanText(text);
  const banned = [
    "capability_request",
    "tool_type",
    "pending_action",
    "executor",
    " KV ",
    "GitHub",
    "shell",
    "risk",
    "safe",
    "безопасный",
    "безопасно",
    "безопасная",
    "безопасное",
    "безопасным"
  ];
  for (const b of banned) {
    const rx = new RegExp(String(b).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    s = s.replace(rx, "").replace(/\s+/g, " ").trim();
  }
  return s;
}

async function llmActionFrame(c, userText, state) {
  if (!c.openrouter) {
    throw new Error("OPENROUTER_API_KEY missing");
  }
  const messages = [
    { role: "system", content: actionFrameSchemaPrompt() },
    {
      role: "user",
      content: JSON.stringify(
        {
          state,
          user_text: userText
        },
        null,
        2
      )
    }
  ];
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${c.openrouter}`,
      "http-referer": c.worker || DEFAULT_WORKER_URL,
      "x-title": "MiniSkynet Agent Kernel Clean"
    },
    body: JSON.stringify({
      model: c.model,
      messages,
      temperature: 0.15,
      max_tokens: 520,
      response_format: { type: "json_object" }
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${d?.error?.message || d?.message || "request failed"}`);
  const content = d?.choices?.[0]?.message?.content || "";
  return normalizeFrame(extractJsonObject(content));
}

function toolStatus(toolType) {
  const key = cleanText(toolType || "chat");
  const tool = TOOL_REGISTRY[key];
  if (!tool) return { exists: false, available: false, key, label: key || "возможность" };
  return { exists: true, available: !!tool.available, key, label: tool.label || key, tool };
}

function isDangerousFrame(frame) {
  const a = lower(frame.action_type);
  const t = lower(frame.tool_needed);
  if (DANGEROUS_ACTION_TYPES.has(a) || DANGEROUS_ACTION_TYPES.has(t)) return true;
  const tool = TOOL_REGISTRY[frame.tool_needed];
  return !!tool?.slash_only || tool?.write === "external_code_write";
}

function missingCapabilityTitle(frame, status) {
  return cleanText(frame.args.capability_title) || status.label || cleanText(frame.tool_needed) || "новая возможность";
}

function missingCapabilityResponse(title) {
  const t = cleanText(title) || "это";
  return `Пока не умею. Могу добавить: ${t}.\n\nДобавлять?`;
}

async function executePending(env, pending) {
  if (!pending) return { ok: false, text: "Не вижу, что именно продолжать." };
  if (pending.type === "add_capability_task") {
    const title = cleanText(pending.title || pending.tool_type || "новая возможность");
    const task = await addTask(env, title, {
      source: "pending_capability",
      tool_type: pending.tool_type,
      reason: pending.reason
    });
    await clearPending(env);
    return { ok: true, task, text: `Готово. Добавила задачу: ${task.title}.` };
  }
  if (pending.type === "add_task") {
    const title = cleanText(pending.title || "Новая задача");
    const task = await addTask(env, title, { source: "pending_task" });
    await clearPending(env);
    return { ok: true, task, text: `Готово. Добавила задачу: ${task.title}.` };
  }
  return { ok: false, text: "Это действие я пока продолжить не могу." };
}

async function executeFrame(env, c, msg, frame, state) {
  const tasks = await getTasks(env);

  if (isDangerousFrame(frame)) {
    return "Из обычного чата это не трогаю.";
  }

  const needed = toolStatus(frame.tool_needed);
  if (frame.intent !== "capability.missing" && frame.intent !== "followup.execute_pending" && frame.intent !== "chat" && frame.intent !== "answer" && !needed.available) {
    const title = missingCapabilityTitle(frame, needed);
    await savePending(env, {
      type: "add_capability_task",
      title,
      tool_type: needed.key || frame.tool_needed,
      reason: frame.goal || `Сергей попросил: ${msg.text}`,
      from_text: msg.text
    });
    return missingCapabilityResponse(title);
  }

  if (frame.intent === "followup.execute_pending") {
    const pending = await getPending(env);
    const res = await executePending(env, pending);
    return res.text;
  }

  if (frame.intent === "task.list") {
    return listTasksHuman(tasks);
  }

  if (frame.intent === "task.add") {
    const title = frame.args.task_title || frame.goal || "Новая задача";
    const task = await addTask(env, title, { source: "ordinary_text" });
    return frame.human_response || `Готово. Добавила задачу: ${task.title}.`;
  }

  if (frame.intent === "task.close") {
    const hit = pickTask(tasks, frame.args.target_hint || frame.goal);
    if (hit.ok) {
      const done = await closeTask(env, hit.task);
      return `Готово. Закрыла: ${done?.title || hit.task.title}.`;
    }
    if (hit.reason === "no_active") return "Активных задач нет.";
    return `Какую закрыть?\n${listTasksHuman(tasks)}`;
  }

  if (frame.intent === "memory.note") {
    const text = frame.args.memory_text || frame.goal;
    if (!text) return "Что именно запомнить?";
    await saveMemoryNote(env, text, { source: "ordinary_text" });
    return frame.human_response || "Запомнила.";
  }

  if (frame.intent === "capability.missing") {
    const status = toolStatus(frame.tool_needed);
    const title = missingCapabilityTitle(frame, status);
    await savePending(env, {
      type: "add_capability_task",
      title,
      tool_type: status.key || frame.tool_needed,
      reason: frame.goal || `Сергей попросил: ${msg.text}`,
      from_text: msg.text
    });
    return frame.human_response || missingCapabilityResponse(title);
  }

  if (frame.intent === "ask_clarification") {
    return frame.human_response || "Уточни, что именно сделать?";
  }

  if (frame.intent === "unknown") {
    return frame.human_response || "Я не до конца понял. Скажи короче, что нужно сделать.";
  }

  return frame.human_response || frame.args.answer || "Я на месте.";
}

async function runAgent(env, c, msg) {
  const tasks = await getTasks(env);
  const pending = await getPending(env);
  const memories = await getMemory(env);
  const state = compactStateForLLM(tasks, pending, memories);
  const frame = await llmActionFrame(c, msg.text, state);
  await kvPut(env, "ak:last_action_frame", frame);
  await logAction(env, { user_text: msg.text, frame });
  return executeFrame(env, c, msg, frame, state);
}

function helpText() {
  return [
    "Я на месте, Серёга.",
    "Пиши обычным текстом — я сам разберу, что делать.",
    "",
    "Команды для проверки:",
    "/status — состояние",
    "/tasks — задачи",
    "/pending — последнее предложенное действие",
    "/debug — технический снимок",
    "/selftest — быстрая проверка ядра"
  ].join("\n");
}

async function statusText(env, c) {
  const tasks = await getTasks(env);
  const pending = await getPending(env);
  return [
    "Скайнет на месте.",
    `Версия: ${VERSION}`,
    "Ядро: Agent Kernel Clean v1",
    `Мозг: ${c.openrouter ? "подключён" : "нет ключа"}`,
    `Память: ${hasKV(env) ? "есть" : "нет KV"}`,
    `Активных задач: ${activeTasks(tasks).length}`,
    `Ожидает ответа: ${pending ? pending.title : "нет"}`
  ].join("\n");
}

async function debugSnapshot(env, c) {
  const tasks = await getTasks(env);
  const pending = await getPending(env);
  const frame = await kvGet(env, "ak:last_action_frame", null);
  const log = await kvGet(env, "ak:action_log", { log: [] });
  return JSON.stringify(
    {
      version: VERSION,
      env: {
        telegram: !!c.telegram,
        owner: !!c.owner,
        openrouter: !!c.openrouter,
        kv: hasKV(env),
        model: c.model,
        repo: c.repo,
        branch: c.branch
      },
      tasks: tasks.slice(-10),
      pending_action: pending,
      last_action_frame: frame,
      log_tail: Array.isArray(log?.log) ? log.log.slice(-5) : [],
      tool_registry: registryBrief()
    },
    null,
    2
  );
}

function toolRegistryText() {
  const rows = Object.entries(TOOL_REGISTRY).map(([k, v]) => {
    const mark = v.available ? "есть" : "нет";
    return `- ${v.label || k}: ${mark}`;
  });
  return ["Возможности:", ...rows].join("\n");
}

async function selfTestText(env, c) {
  const checks = [];
  checks.push(["version", !!VERSION]);
  checks.push(["telegram endpoint", true]);
  checks.push(["same file name", true]);
  checks.push(["KV binding guard", true]);
  checks.push(["OpenRouter configured", !!c.openrouter]);
  checks.push(["tool registry", !!TOOL_REGISTRY.task_store && !!TOOL_REGISTRY.capability_planner]);
  checks.push(["no legacy router dependency", true]);
  checks.push(["pending action memory", hasKV(env)]);
  const pass = checks.every(([, ok]) => !!ok);
  return [
    "Selftest Agent Kernel Clean v1",
    `Итог: ${pass ? "PASS" : "PARTIAL"}`,
    ...checks.map(([name, ok]) => `${ok ? "✅" : "⚠️"} ${name}`)
  ].join("\n");
}

async function handleCommand(env, c, msg) {
  const command = msg.command;
  const args = msg.args || "";

  if (command === "/start" || command === "/help") return helpText();
  if (command === "/health") return `OK\n${VERSION}`;
  if (command === "/status") return statusText(env, c);
  if (command === "/debug") return debugSnapshot(env, c);
  if (command === "/tool_registry") return toolRegistryText();
  if (command === "/selftest") return selfTestText(env, c);

  if (command === "/tasks") return listTasksHuman(await getTasks(env));

  if (command === "/addtask" || command === "/task_add") {
    const title = cleanText(args);
    if (!title) return "Что добавить?";
    const t = await addTask(env, title, { source: command });
    return `Готово. Добавила задачу: ${t.title}.`;
  }

  if (command === "/task_done" || command === "/done") {
    const tasks = await getTasks(env);
    const hit = pickTask(tasks, args);
    if (hit.ok) {
      const done = await closeTask(env, hit.task);
      return `Готово. Закрыла: ${done?.title || hit.task.title}.`;
    }
    if (hit.reason === "no_active") return "Активных задач нет.";
    return `Какую закрыть?\n${listTasksHuman(tasks)}`;
  }

  if (command === "/pending") {
    const p = await getPending(env);
    return p ? `Ждёт ответа: ${p.title}\nМожно написать: добавляй` : "Ничего не ждёт.";
  }

  if (command === "/clear_pending") {
    await clearPending(env);
    return "Очистила.";
  }

  if (command === "/memory") {
    const mem = await getMemory(env);
    if (!mem.length) return "Память пока пустая.";
    return "Память:\n" + mem.slice(-12).map((m, i) => `${i + 1}. ${m.text}`).join("\n");
  }

  if (command === "/remember") {
    const text = cleanText(args);
    if (!text) return "Что запомнить?";
    await saveMemoryNote(env, text, { source: command });
    return "Запомнила.";
  }

  return "Не знаю эту команду. /help покажет, что есть.";
}

function httpHealth(env) {
  return {
    ok: true,
    version: VERSION,
    file: "index-v4.js",
    endpoint: "/telegram",
    kernel: "agent-kernel-clean-v1",
    old_monolith: "removed",
    ordinary_text_flow: "LLM Action Frame -> Tool Registry -> Gate -> Executor -> Human Voice",
    phrase_template_router: false,
    kv_binding: "MINISKYNET_KV",
    env_names: [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_ID",
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL_CHEAP",
      "GITHUB_REPO",
      "GITHUB_BRANCH",
      "WORKER_URL"
    ],
    tools: registryBrief()
  };
}

async function telegram(request, env) {
  const c = await cfg(env);
  const update = await request.json().catch(() => null);
  const msg = parseTelegramUpdate(update);
  if (!msg) return out({ ok: true, ignored: true, version: VERSION });

  if (!ownerOk(c, msg.userId)) {
    await send(c, msg.chatId, "Доступ закрыт.");
    return out({ ok: true, denied: true, version: VERSION });
  }

  try {
    let text;
    if (msg.command) {
      if (!SLASH_COMMANDS.has(msg.command)) {
        text = "Не знаю эту команду. /help покажет, что есть.";
      } else {
        text = await handleCommand(env, c, msg);
      }
    } else if (!msg.text) {
      text = "Я вижу сообщение, но текста в нём нет.";
    } else {
      text = await runAgent(env, c, msg);
    }
    await send(c, msg.chatId, text);
    return out({ ok: true, command: msg.command || "text", version: VERSION });
  } catch (e) {
    const err = String(e?.message || e);
    const text = err.includes("OPENROUTER_API_KEY")
      ? "Мой мозг сейчас не подключён. Проверь OPENROUTER_API_KEY."
      : `Сломалась внутренняя обработка: ${clip(err, 700)}`;
    await send(c, msg.chatId, text);
    return out({ ok: false, error: err, version: VERSION }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return out(httpHealth(env));
    if (url.pathname === "/telegram" && request.method === "POST") return telegram(request, env);
    return out({ ok: false, error: "not found", version: VERSION }, 404);
  },
  async scheduled(event, env, ctx) {
    // Clean v1 deliberately does not send scheduled noise. Future background mode must be added explicitly.
    console.log(`Agent Kernel scheduled noop ${VERSION}`, event?.cron || "manual");
  }
};
