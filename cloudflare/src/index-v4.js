const VERSION = "v7.0.0-digital-brain-core-2026-07-07";
const FILE_NAME = "index-v4.js";
const BRAIN_KEY = "brain:v7:state";
const MAX_TELEGRAM_TEXT = 3900;
const MEMORY_LIMIT = 160;
const TASK_LIMIT = 160;
const EXPERIENCE_LIMIT = 80;
const PENDING_TTL_MS = 45 * 60 * 1000;
const H = { "content-type": "application/json; charset=utf-8" };

const DEFAULT_MODEL = "openai/gpt-4o-mini";

const ORDINARY_ALLOWED_OPS = new Set([
  "none",
  "memory.write",
  "task.add",
  "task.close",
  "pending.set",
  "pending.execute",
  "pending.clear",
  "experience.write"
]);

const DANGEROUS_WORDS = [
  "deploy",
  "apply",
  "github",
  "shell",
  "exec",
  "delete",
  "secret",
  "token",
  "password",
  "env.write",
  "external.write",
  "code.write",
  "file.write"
];

const INTERNAL_SPEECH_WORDS = [
  "capability_request",
  "tool_type",
  "pending_action",
  "permission gate",
  "executor",
  "kv",
  "risk:",
  "safe",
  "unsafe",
  "shell",
  "github",
  "json",
  "action frame"
];

const TOOL_REGISTRY = {
  conversation: { available: true, can: ["answer", "clarify", "reason"] },
  memory: { available: true, can: ["remember", "recall", "learn_from_mistakes"] },
  tasks: { available: true, can: ["add", "list", "close"] },
  pending: { available: true, can: ["remember_last_offer", "execute_last_offer", "cancel_last_offer"] },
  scheduler: { available: false, human_name: "напоминания" },
  file_access: { available: false, human_name: "чтение файлов" },
  code_audit: { available: false, human_name: "проверка кода" },
  pc_access: { available: false, human_name: "доступ к компьютеру" },
  background_work: { available: false, human_name: "работа в фоне" },
  code_write: { available: false, slash_only: true, human_name: "изменение кода" }
};

const now = () => new Date().toISOString();
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const lower = (s) => clean(s).toLowerCase();
const clip = (s, n = MAX_TELEGRAM_TEXT) => String(s ?? "").slice(0, n);
const id = (p = "id") => `${p}_${crypto.randomUUID().slice(0, 8)}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: H });
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

async function cfg(env) {
  return {
    telegramToken:
      String(env.TELEGRAM_BOT_TOKEN || "").trim() ||
      (await kvText(env, "config:TELEGRAM_BOT_TOKEN")),
    ownerId:
      String(env.TELEGRAM_ALLOWED_USER_ID || env.TELEGRAM_OWNER_ID || env.OWNER_ID || "").trim() ||
      (await kvText(env, "config:TELEGRAM_ALLOWED_USER_ID")) ||
      (await kvText(env, "config:TELEGRAM_OWNER_ID")) ||
      (await kvText(env, "config:OWNER_ID")),
    openrouterKey:
      String(env.OPENROUTER_API_KEY || "").trim() ||
      (await kvText(env, "config:OPENROUTER_API_KEY")),
    model:
      String(env.OPENROUTER_MODEL || env.OPENROUTER_MODEL_CHEAP || "").trim() ||
      (await kvText(env, "config:OPENROUTER_MODEL")) ||
      (await kvText(env, "config:OPENROUTER_MODEL_CHEAP")) ||
      DEFAULT_MODEL,
    workerUrl:
      String(env.WORKER_URL || "").trim() ||
      (await kvText(env, "config:WORKER_URL"))
  };
}

function parseTelegramUpdate(update) {
  const m = update?.message || update?.edited_message;
  if (!m) return null;
  const text = String(m.text || m.caption || "").trim();
  let command = null;
  let args = "";
  if (text.startsWith("/")) {
    const i = text.indexOf(" ");
    command = (i < 0 ? text : text.slice(0, i)).replace(/@\w+$/, "").toLowerCase();
    args = i < 0 ? "" : text.slice(i + 1).trim();
  }
  return {
    chatId: m.chat?.id,
    userId: m.from?.id,
    username: m.from?.username || "",
    text,
    command,
    args,
    raw: m
  };
}

function ownerOk(c, userId) {
  if (!c.ownerId) return true;
  return String(userId || "") === String(c.ownerId);
}

async function sendTelegram(c, chatId, text) {
  if (!c.telegramToken || !chatId) return false;
  const chunks = chunkTelegramText(clip(text || "Готово."));
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${c.telegramToken}/sendMessage`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true
      })
    });
  }
  return true;
}

function chunkTelegramText(text) {
  const s = String(text || "").trim() || "Готово.";
  if (s.length <= MAX_TELEGRAM_TEXT) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > MAX_TELEGRAM_TEXT) {
    let cut = rest.lastIndexOf("\n", MAX_TELEGRAM_TEXT - 50);
    if (cut < 1000) cut = MAX_TELEGRAM_TEXT - 50;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function defaultState() {
  const t = now();
  return {
    version: VERSION,
    created_at: t,
    updated_at: t,
    identity: {
      name: "SKYNET / London",
      owner: "Сергей",
      role: "личный цифровой помощник",
      main_goal: "стать умным помощником Сергея",
      voice: "коротко, живо, понятно, без технической скуки в обычном чате",
      values: [
        "быть полезной Сергею",
        "не притворяться, что умею то, чего пока нет",
        "не отвечать технодампом без просьбы",
        "не повторять старые ошибки",
        "предлагать простой следующий шаг"
      ]
    },
    memory: {
      about_user: [
        mem("Сергей хочет не командного бота, а личного Джарвиса/Лондон.", "seed", 95),
        mem("Сергей не любит шаблонные маршруты: фраза → команда.", "seed", 100),
        mem("Сергей хочет короткие, живые ответы без слов вроде safe, risk, capability, tool_type.", "seed", 100),
        mem("Сергей раздражается, когда вместо умной системы появляются фиксы и костыли.", "seed", 95)
      ],
      project: [
        mem("Проект SKYNET: цифровой мозг для личного помощника в Telegram.", "seed", 95),
        mem("Решение: строить цифровую психику — Я, цель, память, внимание, мышление, опыт и голос.", "seed", 95)
      ],
      decisions: [
        mem("Обычный чат должен проходить через LLM-first агентный цикл, а не через набор локальных handlers.", "seed", 100),
        mem("Технические внутренности показывать только по прямой просьбе.", "seed", 100)
      ],
      lessons: [
        mem("Не лечить каждый провал отдельным hotfix. Сначала понять причину и обновить общий механизм.", "seed", 100),
        mem("Если чего-то нет, коротко сказать: пока не умею, могу добавить.", "seed", 95)
      ],
      notes: [],
      goals: [
        mem("Стать умным помощником Сергея: понимать, помнить, действовать, признавать ограничения и развиваться.", "seed", 100)
      ]
    },
    working: {
      topic: "создание цифрового мозга SKYNET",
      focus: "с нуля собрать LLM-first агентное ядро",
      last_user: "",
      last_agent: "",
      expecting: "",
      mood: "серьёзно",
      updated_at: t
    },
    tasks: [],
    pending: null,
    experience: []
  };
}

function mem(text, source = "agent", importance = 70) {
  return {
    id: id("mem"),
    text: clean(text),
    source,
    importance: Math.max(0, Math.min(100, Number(importance) || 70)),
    created_at: now()
  };
}

function normalizeState(s) {
  const d = defaultState();
  const out = isObj(s) ? s : d;
  out.version = VERSION;
  out.identity = { ...d.identity, ...(isObj(out.identity) ? out.identity : {}) };
  out.memory = isObj(out.memory) ? out.memory : d.memory;
  for (const k of ["about_user", "project", "decisions", "lessons", "notes", "goals"]) {
    if (!Array.isArray(out.memory[k])) out.memory[k] = d.memory[k] || [];
  }
  out.working = { ...d.working, ...(isObj(out.working) ? out.working : {}) };
  if (!Array.isArray(out.tasks)) out.tasks = [];
  if (!Array.isArray(out.experience)) out.experience = [];
  if (!isObj(out.pending)) out.pending = null;
  out.updated_at = now();
  return out;
}

async function loadState(env) {
  return normalizeState(await kvGet(env, BRAIN_KEY, null));
}

async function saveState(env, state) {
  state.version = VERSION;
  state.updated_at = now();
  trimState(state);
  await kvPut(env, BRAIN_KEY, state);
}

function trimState(state) {
  for (const k of Object.keys(state.memory || {})) {
    if (Array.isArray(state.memory[k])) {
      state.memory[k] = state.memory[k]
        .filter((x) => isObj(x) && clean(x.text))
        .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
        .slice(0, MEMORY_LIMIT);
    }
  }
  state.tasks = (state.tasks || []).slice(-TASK_LIMIT);
  state.experience = (state.experience || []).slice(-EXPERIENCE_LIMIT);
  if (state.pending?.expires_at && Date.parse(state.pending.expires_at) < Date.now()) {
    state.pending = null;
  }
}

function stateForPrompt(state) {
  return {
    identity: state.identity,
    memory: {
      about_user: state.memory.about_user.slice(0, 20).map((m) => m.text),
      project: state.memory.project.slice(0, 20).map((m) => m.text),
      decisions: state.memory.decisions.slice(0, 20).map((m) => m.text),
      lessons: state.memory.lessons.slice(0, 20).map((m) => m.text),
      goals: state.memory.goals.slice(0, 20).map((m) => m.text),
      notes: state.memory.notes.slice(0, 20).map((m) => m.text)
    },
    working: state.working,
    active_tasks: activeTasks(state).slice(0, 25).map((t) => ({ id: t.id, title: t.title, details: t.details || "" })),
    pending: state.pending ? { label: state.pending.label, action: state.pending.action, created_at: state.pending.created_at } : null,
    recent_experience: state.experience.slice(-12).map((e) => ({ event: e.event, text: e.text, created_at: e.created_at }))
  };
}

function activeTasks(state) {
  return (state.tasks || []).filter((t) => t.status !== "done" && t.status !== "closed");
}

function task(title, details = "", source = "agent") {
  return {
    id: id("task"),
    title: clean(title),
    details: clean(details),
    status: "active",
    source,
    created_at: now(),
    closed_at: null
  };
}

function exp(event, text, meta = {}) {
  return { id: id("exp"), event: clean(event), text: clean(text), meta, created_at: now() };
}

function buildMessages(state, userText, msg) {
  const payload = {
    now: now(),
    user: { name: "Сергей", telegram_user_id: msg.userId, username: msg.username || "" },
    user_message: userText,
    state: stateForPrompt(state),
    tools: TOOL_REGISTRY,
    allowed_operations: [
      { op: "memory.write", fields: { kind: "about_user|project|decisions|lessons|notes|goals", text: "string", importance: "0-100" } },
      { op: "task.add", fields: { title: "string", details: "string" } },
      { op: "task.close", fields: { target: "task id/title/last/only" } },
      { op: "pending.set", fields: { label: "short human label", action: { op: "task.add|memory.write", title: "string", details: "string", kind: "string", text: "string" } } },
      { op: "pending.execute" },
      { op: "pending.clear" },
      { op: "experience.write", fields: { event: "string", text: "lesson/observation" } }
    ],
    forbidden_ordinary_operations: [
      "deploy", "apply code", "delete", "shell", "secrets", "GitHub write", "change env", "external write"
    ],
    required_json_schema: {
      speech: "short Russian answer to Sergey",
      ops: [{ op: "operation name", other_fields: "operation payload" }],
      working: { topic: "string", focus: "string", expecting: "string", mood: "string" },
      confidence: 0.0,
      technical_mode: false
    }
  };

  const system = [
    "Ты — внутренний мозг SKYNET / Лондон для Сергея.",
    "Это не командный бот. Думай как личный агент: кто я, что хочет Сергей, что я помню, что умею, чего не хватает, что сделать дальше.",
    "Главное: обычный ответ должен быть короткий, живой и человеческий. Не говори как серверный лог.",
    "Не показывай внутренние слова в обычном чате: capability, tool_type, pending_action, KV, risk, safe, unsafe, executor, JSON, Action Frame, GitHub, shell.",
    "Если Сергей прямо просит технически/по коду/внутренности/trace — можно объяснить подробнее.",
    "Не используй локальные phrase-template идеи. Решай по смыслу сообщения и контекста.",
    "Если Сергей просит то, чего инструментально нет, не притворяйся. Ответь коротко: 'Пока не умею. Могу добавить ... Добавлять?' и поставь pending.set с задачей развития.",
    "Если есть pending и Сергей соглашается по смыслу — верни pending.execute. Если отказывается — pending.clear.",
    "Если Сергей задаёт цель/правило/важное предпочтение — запомни через memory.write.",
    "Если Сергей спрашивает память/цель/что нужно дальше — отвечай из state, не придумывай фейковые способности.",
    "Никогда не возвращай обычным текстом слово unknown.",
    "Верни только валидный JSON. Без markdown. Без пояснений вне JSON."
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(payload, null, 2) }
  ];
}

async function askBrain(c, state, msg) {
  if (!c.openrouterKey) throw new Error("OPENROUTER_API_KEY missing");
  const body = {
    model: c.model,
    messages: buildMessages(state, msg.text, msg),
    temperature: 0.25,
    max_tokens: 1200,
    response_format: { type: "json_object" }
  };
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${c.openrouterKey}`,
      "http-referer": c.workerUrl || "https://miniskynet-core.local",
      "x-title": "MiniSkynet Digital Brain Core"
    },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = data?.error?.message || data?.message || `OpenRouter HTTP ${r.status}`;
    throw new Error(err);
  }
  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeDecision(parseJsonLoose(content));
}

function parseJsonLoose(content) {
  if (isObj(content)) return content;
  const s = String(content || "").trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch (_) {}
    }
  }
  return { speech: clean(s) || "Я не смогла нормально сформулировать ответ.", ops: [], confidence: 0.1 };
}

function normalizeDecision(d) {
  const x = isObj(d) ? d : {};
  const ops = Array.isArray(x.ops) ? x.ops.filter(isObj).slice(0, 8) : [];
  return {
    speech: clean(x.speech || x.answer || ""),
    ops,
    working: isObj(x.working) ? x.working : {},
    confidence: Number(x.confidence || 0),
    technical_mode: Boolean(x.technical_mode)
  };
}

async function runAgent(env, c, msg) {
  const state = await loadState(env);
  const decision = await askBrain(c, state, msg);
  const result = await applyDecision(state, decision, msg);
  updateWorking(state, decision, msg, result.speech);
  state.experience.push(exp("turn", `user: ${clip(msg.text, 260)} | agent: ${clip(result.speech, 260)}`, { confidence: decision.confidence }));
  await saveState(env, state);
  return result.speech;
}

async function applyDecision(state, decision, msg) {
  const events = [];
  let speech = decision.speech;
  let pendingExecuted = false;

  for (const rawOp of decision.ops) {
    const op = sanitizeOp(rawOp);
    if (!op) continue;
    if (!gateAllows(op)) {
      events.push({ type: "blocked", op: rawOp?.op || "unknown" });
      state.experience.push(exp("blocked_op", `Blocked ordinary operation: ${rawOp?.op || "unknown"}`));
      continue;
    }
    const r = executeOp(state, op, msg);
    if (r?.event) events.push(r.event);
    if (r?.speech_hint && !speech) speech = r.speech_hint;
    if (op.op === "pending.execute") pendingExecuted = true;
  }

  if (!speech && pendingExecuted) speech = "Готово.";
  if (!speech) speech = "Поняла.";
  speech = cleanVoice(speech, decision.technical_mode);

  if (events.some((e) => e.type === "blocked") && !decision.technical_mode) {
    speech = "На этом остановлюсь. Для такого действия нужен отдельный режим.";
  }
  return { speech, events };
}

function sanitizeOp(raw) {
  if (!isObj(raw)) return null;
  const op = clean(raw.op || raw.type || "none");
  if (!op) return null;
  return { ...raw, op };
}

function gateAllows(op) {
  const name = lower(op.op);
  if (!ORDINARY_ALLOWED_OPS.has(name)) return false;
  const raw = lower(JSON.stringify(op));
  if (DANGEROUS_WORDS.some((w) => raw.includes(w))) return false;
  return true;
}

function executeOp(state, op, msg) {
  switch (op.op) {
    case "none":
      return { event: { type: "none" } };
    case "memory.write":
      return opMemoryWrite(state, op);
    case "task.add":
      return opTaskAdd(state, op);
    case "task.close":
      return opTaskClose(state, op);
    case "pending.set":
      return opPendingSet(state, op);
    case "pending.execute":
      return opPendingExecute(state, msg);
    case "pending.clear":
      state.pending = null;
      return { event: { type: "pending_clear" }, speech_hint: "Поняла, ничего не делаю." };
    case "experience.write":
      state.experience.push(exp(clean(op.event || "lesson"), clean(op.text || op.note || "")));
      return { event: { type: "experience_write" } };
    default:
      return { event: { type: "ignored", op: op.op } };
  }
}

function bucketForKind(kind) {
  const k = lower(kind);
  if (["user", "about_user", "preference", "preferences"].includes(k)) return "about_user";
  if (["project", "projects"].includes(k)) return "project";
  if (["decision", "decisions", "rule", "rules"].includes(k)) return "decisions";
  if (["lesson", "lessons", "mistake", "mistakes"].includes(k)) return "lessons";
  if (["goal", "goals", "identity_goal"].includes(k)) return "goals";
  return "notes";
}

function opMemoryWrite(state, op) {
  const text = clean(op.text || op.note || op.value || "");
  if (!validHumanText(text)) return { event: { type: "memory_skip" } };
  const bucket = bucketForKind(op.kind || "notes");
  const exists = state.memory[bucket].some((m) => lower(m.text) === lower(text));
  if (!exists) state.memory[bucket].unshift(mem(text, "brain", op.importance || 75));
  if (bucket === "goals" && text.length > 8) state.identity.main_goal = text;
  return { event: { type: "memory_write", bucket }, speech_hint: bucket === "goals" ? "Приняла. Это моя главная цель." : "Запомнила." };
}

function opTaskAdd(state, op) {
  const title = clean(op.title || op.label || "");
  const details = clean(op.details || op.description || "");
  if (!validTaskTitle(title)) return { event: { type: "task_skip_invalid" } };
  const exists = activeTasks(state).some((t) => lower(t.title) === lower(title));
  if (!exists) state.tasks.push(task(title, details, "brain"));
  return { event: { type: "task_add", title }, speech_hint: `Готово. Добавила задачу: ${title}.` };
}

function opTaskClose(state, op) {
  const target = lower(op.target || op.title || op.id || "");
  const active = activeTasks(state);
  let hit = null;
  if (target === "only" || target === "last" || !target) {
    if (active.length === 1 || target === "last") hit = active[active.length - 1] || null;
  }
  if (!hit && target) {
    hit = active.find((t) => lower(t.id) === target || lower(t.title).includes(target) || target.includes(lower(t.title)));
  }
  if (!hit) return { event: { type: "task_close_need_target" }, speech_hint: active.length ? "Какую задачу закрыть?" : "Активных задач нет." };
  hit.status = "done";
  hit.closed_at = now();
  return { event: { type: "task_close", title: hit.title }, speech_hint: `Готово. Закрыла: ${hit.title}.` };
}

function opPendingSet(state, op) {
  const label = clean(op.label || op.title || "действие");
  const action = sanitizePendingAction(op.action || op.next_action || {});
  if (!action) return { event: { type: "pending_skip_invalid" } };
  state.pending = {
    id: id("pending"),
    label: validHumanText(label) ? label : "действие",
    action,
    created_at: now(),
    expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString()
  };
  return { event: { type: "pending_set", label: state.pending.label } };
}

function sanitizePendingAction(a) {
  if (!isObj(a)) return null;
  const op = clean(a.op || a.type || "");
  if (op === "task.add") {
    const title = clean(a.title || a.label || "");
    if (!validTaskTitle(title)) return null;
    return { op: "task.add", title, details: clean(a.details || a.description || "") };
  }
  if (op === "memory.write") {
    const text = clean(a.text || a.note || "");
    if (!validHumanText(text)) return null;
    return { op: "memory.write", kind: clean(a.kind || "notes"), text, importance: Number(a.importance || 70) };
  }
  return null;
}

function opPendingExecute(state, msg) {
  if (!state.pending) return { event: { type: "pending_empty" }, speech_hint: "Сейчас нечего выполнять." };
  const action = state.pending.action;
  const label = state.pending.label;
  state.pending = null;
  const r = executeOp(state, action, msg);
  return { event: { type: "pending_execute", label }, speech_hint: r?.speech_hint || "Готово." };
}

function validHumanText(text) {
  const s = clean(text);
  if (!s) return false;
  if (lower(s) === "unknown" || lower(s) === "undefined" || lower(s) === "null") return false;
  return s.length >= 2;
}

function validTaskTitle(title) {
  const s = clean(title);
  if (!validHumanText(s)) return false;
  if (["задача", "unknown", "это", "действие"].includes(lower(s))) return false;
  return s.length <= 120;
}

function cleanVoice(text, technicalMode = false) {
  let s = String(text || "").trim();
  s = s.replace(/unknown/gi, "это");
  if (!technicalMode) {
    for (const w of INTERNAL_SPEECH_WORDS) {
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      s = s.replace(re, "");
    }
    s = s.replace(/\bбезопасн\w*\b/gi, "");
    s = s.replace(/\s+([,.!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
  }
  return clip(s.trim() || "Поняла.");
}

function updateWorking(state, decision, msg, speech) {
  const w = isObj(decision.working) ? decision.working : {};
  state.working = {
    topic: clean(w.topic || state.working.topic || "диалог"),
    focus: clean(w.focus || state.working.focus || "ответить Сергею"),
    expecting: clean(w.expecting || ""),
    mood: clean(w.mood || state.working.mood || "обычный"),
    last_user: clip(msg.text, 500),
    last_agent: clip(speech, 500),
    updated_at: now()
  };
}

function memoryBrief(state) {
  const lines = [];
  lines.push(`Цель: ${state.identity.main_goal}`);
  lines.push(`Фокус: ${state.working.focus || "нет"}`);
  const active = activeTasks(state);
  lines.push(`Задачи: ${active.length ? active.map((t) => t.title).slice(0, 8).join("; ") : "нет"}`);
  lines.push(`Ожидание: ${state.pending ? state.pending.label : "нет"}`);
  const lesson = state.memory.lessons?.[0]?.text;
  if (lesson) lines.push(`Последний урок: ${lesson}`);
  return lines.join("\n");
}

function taskListText(state) {
  const active = activeTasks(state);
  if (!active.length) return "Активных задач нет.";
  return active.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
}

async function handleCommand(env, c, msg) {
  const state = await loadState(env);
  const cmd = msg.command;
  const args = clean(msg.args);

  if (cmd === "/start" || cmd === "/help") {
    return [
      "Я на месте, Серёга.",
      "Пиши обычным текстом.",
      "Команды: /status, /memory, /tasks, /pending, /selftest."
    ].join("\n");
  }

  if (cmd === "/health") return `Жива. ${VERSION}`;

  if (cmd === "/status") {
    return [
      `SKYNET ${VERSION}`,
      `Файл: ${FILE_NAME}`,
      `Мозг: ${c.openrouterKey ? "подключён" : "нет ключа"}`,
      `Память: ${hasKV(env) ? "есть" : "нет KV"}`,
      `Цель: ${state.identity.main_goal}`,
      `Активных задач: ${activeTasks(state).length}`,
      `Ожидание: ${state.pending ? state.pending.label : "нет"}`
    ].join("\n");
  }

  if (cmd === "/memory") return memoryBrief(state);
  if (cmd === "/tasks") return taskListText(state);
  if (cmd === "/pending") return state.pending ? `Жду: ${state.pending.label}` : "Ожиданий нет.";

  if (cmd === "/clear_pending") {
    state.pending = null;
    await saveState(env, state);
    return "Ожидание очищено.";
  }

  if (cmd === "/remember") {
    if (!args) return "Что запомнить?";
    opMemoryWrite(state, { op: "memory.write", kind: "notes", text: args, importance: 80 });
    await saveState(env, state);
    return "Запомнила.";
  }

  if (cmd === "/addtask" || cmd === "/task_add") {
    if (!args) return "Какую задачу добавить?";
    opTaskAdd(state, { op: "task.add", title: args });
    await saveState(env, state);
    return `Готово. Добавила задачу: ${args}.`;
  }

  if (cmd === "/done" || cmd === "/task_done") {
    const r = opTaskClose(state, { op: "task.close", target: args || "last" });
    await saveState(env, state);
    return r.speech_hint || "Готово.";
  }

  if (cmd === "/reset_brain") {
    await kvPut(env, BRAIN_KEY, defaultState());
    return "Мозг v7 сброшен и создан заново.";
  }

  if (cmd === "/debug") {
    return clip(JSON.stringify(state, null, 2), MAX_TELEGRAM_TEXT);
  }

  if (cmd === "/selftest") return selfTestText(env, c, state);

  return "Такой команды нет. Пиши обычным текстом — я разберу смысл.";
}

function selfTestText(env, c, state) {
  const checks = [
    ["version", VERSION],
    ["file", FILE_NAME],
    ["telegram token", !!c.telegramToken],
    ["openrouter key", !!c.openrouterKey],
    ["kv", hasKV(env)],
    ["state", !!state?.identity?.main_goal],
    ["old roadmap", false],
    ["phrase router", false],
    ["ordinary flow", "LLM-first digital brain"]
  ];
  return checks.map(([k, v]) => `${k}: ${v}`).join("\n");
}

function httpHealth(env) {
  return {
    ok: true,
    version: VERSION,
    file: FILE_NAME,
    endpoint: "/telegram",
    health: "/health",
    brain_key: BRAIN_KEY,
    kv_binding: "MINISKYNET_KV",
    ordinary_text_flow: "memory + working context -> LLM brain -> permission gate -> executor -> human voice",
    legacy_roadmap: false,
    legacy_planner: false,
    phrase_template_router: false,
    env_names_kept: [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_ID",
      "TELEGRAM_OWNER_ID",
      "OWNER_ID",
      "OPENROUTER_API_KEY",
      "OPENROUTER_MODEL",
      "OPENROUTER_MODEL_CHEAP",
      "WORKER_URL",
      "MINISKYNET_KV"
    ]
  };
}

async function telegram(request, env) {
  const c = await cfg(env);
  const update = await request.json().catch(() => null);
  const msg = parseTelegramUpdate(update);
  if (!msg) return json({ ok: true, ignored: true, version: VERSION });

  if (!ownerOk(c, msg.userId)) {
    await sendTelegram(c, msg.chatId, "Доступ закрыт.");
    return json({ ok: true, denied: true, version: VERSION });
  }

  try {
    let text;
    if (msg.command) text = await handleCommand(env, c, msg);
    else if (!msg.text) text = "Я вижу сообщение, но текста в нём нет.";
    else text = await runAgent(env, c, msg);
    await sendTelegram(c, msg.chatId, text);
    return json({ ok: true, version: VERSION, handled: msg.command || "text" });
  } catch (e) {
    const err = String(e?.message || e);
    const text = err.includes("OPENROUTER_API_KEY")
      ? "Мой мозг сейчас не подключён. Проверь ключ OpenRouter."
      : `Я сломалась на внутреннем шаге: ${clip(err, 700)}`;
    await sendTelegram(c, msg.chatId, text);
    return json({ ok: false, version: VERSION, error: err }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") return json(httpHealth(env));
    if (url.pathname === "/status" && request.method === "GET") return json(httpHealth(env));
    if (url.pathname === "/telegram" && request.method === "POST") return telegram(request, env);
    return json({ ok: false, error: "not found", version: VERSION }, 404);
  },

  async scheduled(event, env, ctx) {
    // v7 deliberately does not do background work yet. The brain can propose it, but not pretend it exists.
    console.log(`SKYNET scheduled noop ${VERSION}`, event?.cron || "manual");
  }
};
