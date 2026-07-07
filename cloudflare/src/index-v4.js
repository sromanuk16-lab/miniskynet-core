const VERSION = "v8.0.0-digital-brain-os-2026-07-07";
const FILE_NAME = "index-v4.js";
const STATE_KEY = "brain:v8:state";
const LEGACY_STATE_KEY = "brain:v7:state";
const MAX_TELEGRAM_TEXT = 3900;
const MAX_LAST_MESSAGES = 12;
const MAX_PROMPT_MESSAGES = 6;
const MAX_SELECTED_MEMORIES = 8;
const MAX_SELECTED_LESSONS = 8;
const MAX_MEMORIES = 260;
const MAX_LESSONS = 180;
const MAX_TASKS = 160;
const PENDING_TTL_MS = 45 * 60 * 1000;
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const ORDINARY_ALLOWED_ACTIONS = new Set([
  "none",
  "memory.add",
  "lesson.add",
  "task.add",
  "task.close",
  "pending.set",
  "pending.execute",
  "pending.clear",
  "scene.update"
]);

const DANGEROUS_ACTIONS = new Set([
  "code.apply",
  "code.write",
  "github.write",
  "github.apply",
  "deploy",
  "secret.read",
  "secret.write",
  "external.delete",
  "shell.exec",
  "file.delete"
]);

const INTERNAL_WORDS = [
  "tool_type",
  "capability_request",
  "pending_action",
  "permission gate",
  "executor",
  "action frame",
  "json",
  "kv",
  "risk:",
  "unsafe",
  "safe"
];

const GENERIC_BOT_PATTERNS = [
  /чем могу помочь( с этой темой)?\??/ig,
  /если у тебя есть идеи[\s\S]{0,80}?делись!?/ig,
  /как ты видишь( это| следующий шаг)?\??/ig,
  /уточни, пожалуйста\.?/ig,
  /какой вопрос ты имеешь в виду\??/ig
];

const now = () => new Date().toISOString();
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const lower = (s) => clean(s).toLowerCase();
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clip = (s, n = MAX_TELEGRAM_TEXT) => String(s ?? "").slice(0, n);
const makeId = (prefix = "id") => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function hasKV(env) {
  return !!env?.MINISKYNET_KV;
}

async function kvText(env, key) {
  if (!hasKV(env)) return "";
  return String((await env.MINISKYNET_KV.get(key)) || "").trim();
}

async function kvGet(env, key, fallback = null) {
  if (!hasKV(env)) return fallback;
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvPut(env, key, value) {
  if (!hasKV(env)) return false;
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
  return true;
}

async function readConfig(env) {
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

function ownerOk(config, userId) {
  if (!config.ownerId) return true;
  return String(userId || "") === String(config.ownerId);
}

function parseTelegramUpdate(update) {
  const m = update?.message || update?.edited_message;
  if (!m) return null;
  const text = String(m.text || m.caption || "").trim();
  const command = text.startsWith("/") ? text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase() : null;
  const args = command ? text.slice(command.length).trim() : "";
  return {
    chatId: m.chat?.id,
    userId: m.from?.id,
    username: m.from?.username || "",
    firstName: m.from?.first_name || "",
    text,
    command,
    args,
    raw: m
  };
}

async function sendTelegram(config, chatId, text) {
  if (!config.telegramToken || !chatId) return false;
  for (const chunk of splitTelegram(clip(text || "Готово."))) {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true })
    });
  }
  return true;
}

function splitTelegram(text) {
  const s = String(text || "").trim() || "Готово.";
  if (s.length <= MAX_TELEGRAM_TEXT) return [s];
  const out = [];
  let rest = s;
  while (rest.length > MAX_TELEGRAM_TEXT) {
    let cut = rest.lastIndexOf("\n", MAX_TELEGRAM_TEXT - 100);
    if (cut < 1000) cut = MAX_TELEGRAM_TEXT - 100;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function memory(text, tags = [], importance = 70) {
  return { id: makeId("mem"), text: clean(text), tags, importance, created_at: now(), updated_at: now() };
}

function lesson(text, kind = "lesson", importance = 75) {
  return { id: makeId("lesson"), text: clean(text), kind, importance, created_at: now(), updated_at: now() };
}

function defaultState() {
  const t = now();
  return {
    schema: "digital-brain-os/v1",
    version: VERSION,
    created_at: t,
    updated_at: t,
    identity: {
      name: "SKYNET / London",
      owner: "Сергей",
      role: "личный цифровой помощник",
      main_goal: "стать умным помощником Сергея уровня Джарвиса, но под его стиль",
      voice: "коротко, живо, уверенно, без технодампа в обычном чате",
      principles: [
        "Сначала отвечать на текущую реплику Сергея.",
        "Не превращать каждый разговор в саморазвитие.",
        "Не использовать phrase templates как главный мозг.",
        "Если не умею — сказать коротко и предложить следующий шаг.",
        "Технические детали показывать только по просьбе."
      ]
    },
    user_profile: {
      name: "Сергей",
      preferences: [
        "любит короткие, живые ответы",
        "не любит шаблонные маршруты",
        "не любит технодамп без просьбы",
        "хочет Джарвиса/Лондон, а не командного бота"
      ]
    },
    current_scene: {
      topic: "переход от слоёв v7 к единому Digital Brain OS",
      user_mood: "требовательный, проверяет архитектуру",
      focus: "один центр мышления вместо спорящих слоёв",
      last_problem: "agenda layer перехватил запрос памяти, а отказ 'нет' не очистил предложение",
      next_step: "собрать v8: единый event loop, одно состояние, один LLM decision, reducer"
    },
    long_memory: [
      memory("Сергей хочет цифровой мозг, а не набор модулей и костылей.", ["architecture", "goal"], 98),
      memory("Обычный чат должен звучать как Лондон/Джарвис: коротко, уверенно и понятно.", ["voice"], 94),
      memory("Не выводить внутренности вроде tool_type, capability_request, risk, KV без прямого запроса.", ["voice", "debug"], 92),
      memory("Старые v5/v7 слои спорили между собой: agenda, pending, director, fast mind.", ["mistake", "architecture"], 96)
    ],
    lessons: [
      lesson("Нельзя чинить каждую новую ошибку отдельным handler/guard. Нужен один центр решения.", "architecture", 98),
      lesson("Fast Mind как перехватчик обычных фраз ломает смысл. Скорость нужна через Context Manager, а не обход мозга.", "mistake", 96),
      lesson("Если Сергей пишет 'нет', это должно очищать текущее ожидание и не повторять предложение.", "dialogue", 90),
      lesson("Если Сергей просит 'покажи все записи', надо показывать память по разделам, а не предлагать задачу.", "memory", 90)
    ],
    tasks: [],
    pending_action: null,
    last_messages: [],
    metrics: { turns: 0, llm_errors: 0, migrations: 0 }
  };
}

function normalizeState(raw) {
  const base = defaultState();
  const s = isObj(raw) ? raw : {};
  const out = {
    ...base,
    ...s,
    schema: "digital-brain-os/v1",
    version: VERSION,
    identity: { ...base.identity, ...(isObj(s.identity) ? s.identity : {}) },
    user_profile: { ...base.user_profile, ...(isObj(s.user_profile) ? s.user_profile : {}) },
    current_scene: { ...base.current_scene, ...(isObj(s.current_scene) ? s.current_scene : {}) },
    long_memory: Array.isArray(s.long_memory) ? s.long_memory : base.long_memory,
    lessons: Array.isArray(s.lessons) ? s.lessons : base.lessons,
    tasks: Array.isArray(s.tasks) ? s.tasks : base.tasks,
    pending_action: isObj(s.pending_action) ? s.pending_action : null,
    last_messages: Array.isArray(s.last_messages) ? s.last_messages.slice(-MAX_LAST_MESSAGES) : [],
    metrics: { ...base.metrics, ...(isObj(s.metrics) ? s.metrics : {}) },
    updated_at: now()
  };
  out.long_memory = compactRecords(out.long_memory, MAX_MEMORIES);
  out.lessons = compactRecords(out.lessons, MAX_LESSONS);
  out.tasks = compactTasks(out.tasks, MAX_TASKS);
  out.pending_action = normalizePending(out.pending_action);
  return out;
}

function compactRecords(items, max) {
  const map = new Map();
  for (const x of Array.isArray(items) ? items : []) {
    if (!isObj(x)) continue;
    const text = clean(x.text || x.note || x.title || "");
    if (!text) continue;
    const key = lower(text).slice(0, 160);
    const item = {
      id: x.id || makeId("rec"),
      text,
      tags: Array.isArray(x.tags) ? x.tags.slice(0, 8) : [],
      kind: x.kind || undefined,
      importance: Number(x.importance || 70),
      created_at: x.created_at || now(),
      updated_at: x.updated_at || x.created_at || now()
    };
    if (!map.has(key) || map.get(key).importance < item.importance) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, max);
}

function compactTasks(tasks, max) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter(isObj)
    .map((t) => ({
      id: t.id || makeId("task"),
      title: clean(t.title || t.text || "Задача"),
      status: t.status === "done" ? "done" : "open",
      note: clean(t.note || t.notes || ""),
      created_at: t.created_at || now(),
      updated_at: t.updated_at || now()
    }))
    .filter((t) => t.title)
    .slice(-max);
}

function normalizePending(p) {
  if (!isObj(p)) return null;
  const expires = Date.parse(p.expires_at || "");
  if (expires && expires < Date.now()) return null;
  return {
    id: p.id || makeId("pending"),
    type: clean(p.type || p.action || ""),
    title: clean(p.title || ""),
    note: clean(p.note || p.reason || ""),
    created_at: p.created_at || now(),
    expires_at: p.expires_at || new Date(Date.now() + PENDING_TTL_MS).toISOString()
  };
}

function migrateLegacyV7(v7) {
  const base = defaultState();
  if (!isObj(v7)) return base;
  base.metrics.migrations = 1;
  const addMem = (text, tags, importance) => { if (text) base.long_memory.push(memory(text, tags, importance)); };
  const addLesson = (text, kind, importance) => { if (text) base.lessons.push(lesson(text, kind, importance)); };

  if (isObj(v7.identity)) {
    if (v7.identity.main_goal) base.identity.main_goal = clean(v7.identity.main_goal);
    if (v7.identity.voice) base.identity.voice = clean(v7.identity.voice);
  }
  if (isObj(v7.current_scene)) base.current_scene = { ...base.current_scene, ...v7.current_scene };
  if (Array.isArray(v7.memory?.about_user)) for (const x of v7.memory.about_user) addMem(x.text || x, ["legacy", "user"], x.importance || 80);
  if (Array.isArray(v7.memory?.project)) for (const x of v7.memory.project) addMem(x.text || x, ["legacy", "project"], x.importance || 75);
  if (Array.isArray(v7.long_memory)) for (const x of v7.long_memory) addMem(x.text || x, x.tags || ["legacy"], x.importance || 75);
  if (Array.isArray(v7.experience)) for (const x of v7.experience) addLesson(x.text || x, "experience", x.importance || 75);
  if (Array.isArray(v7.lessons)) for (const x of v7.lessons) addLesson(x.text || x, x.kind || "lesson", x.importance || 75);
  if (Array.isArray(v7.mistakes)) for (const x of v7.mistakes) addLesson(x.text || x, "mistake", x.importance || 85);
  if (Array.isArray(v7.tasks)) base.tasks = compactTasks(v7.tasks, MAX_TASKS);
  if (isObj(v7.pending_action)) base.pending_action = normalizePending(v7.pending_action);
  if (Array.isArray(v7.last_messages)) base.last_messages = v7.last_messages.slice(-MAX_LAST_MESSAGES);
  return normalizeState(base);
}

async function loadState(env) {
  const existing = await kvGet(env, STATE_KEY, null);
  if (existing) return normalizeState(existing);
  const legacy = await kvGet(env, LEGACY_STATE_KEY, null);
  const migrated = legacy ? migrateLegacyV7(legacy) : defaultState();
  await saveState(env, migrated);
  return migrated;
}

async function saveState(env, state) {
  const s = normalizeState({ ...state, updated_at: now(), version: VERSION });
  await kvPut(env, STATE_KEY, s);
  return s;
}

function tokenize(text) {
  return lower(text)
    .replace(/[^а-яёa-z0-9\s]+/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 40);
}

function scoreRecord(query, rec) {
  const q = new Set(tokenize(query));
  const hay = lower(`${rec.text || ""} ${(rec.tags || []).join(" ")} ${rec.kind || ""}`);
  let score = Number(rec.importance || 50) / 100;
  for (const w of q) if (hay.includes(w)) score += 1;
  return score;
}

function selectRelevant(items, query, limit) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({ item, score: scoreRecord(query, item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}

function activeTasks(state) {
  return (state.tasks || []).filter((t) => t.status !== "done");
}

function makeContextPackage(state, userText) {
  const selectedMemories = selectRelevant(state.long_memory, userText, MAX_SELECTED_MEMORIES);
  const selectedLessons = selectRelevant(state.lessons, userText, MAX_SELECTED_LESSONS);
  return {
    identity: state.identity,
    user_profile: state.user_profile,
    current_scene: state.current_scene,
    pending_action: state.pending_action,
    active_tasks: activeTasks(state).slice(-8),
    recent_messages: (state.last_messages || []).slice(-MAX_PROMPT_MESSAGES),
    relevant_memory: selectedMemories,
    relevant_lessons: selectedLessons,
    available_simple_actions: [...ORDINARY_ALLOWED_ACTIONS],
    blocked_without_slash: [...DANGEROUS_ACTIONS]
  };
}

function systemPrompt() {
  return `Ты — SKYNET / London, личный цифровой помощник Сергея.

Ты не обычный чат-бот. Твоя задача — быть короткой, живой, полезной и держать цель: стать умным помощником уровня Джарвиса под Сергея.

АРХИТЕКТУРА v8:
- Есть один центр решения. Не веди себя как отдельный слой agenda/pending/fast mind.
- Сначала пойми текущую реплику Сергея.
- Затем реши: ответить, показать память, показать задачи, создать задачу, отменить ожидание, запомнить урок, уточнить или предложить шаг.
- Не тащи саморазвитие в каждый ответ. Цель развития — фон, не навязчивая тема.
- Не используй внутренние слова: tool_type, capability_request, pending_action, executor, KV, risk, JSON, safe/unsafe.
- Не говори: "чем могу помочь", "делись идеями", "как ты видишь".
- Если Сергей говорит "нет", "не надо", "отмена" на предложение — очистить ожидание и ответить коротко: "Поняла. Не создаю." или близко.
- Если Сергей просит "покажи все записи", "покажи память", "что помнишь" — режим memory_read, показать разделы памяти, не предлагать задачу.
- Если Сергей спрашивает "что у нас по задачам" — режим task_list, показать задачи. Если задач нет, можно предложить одну конкретную задачу, но только если уместно.
- Если Сергей критикует ответ: "не то", "как бот", "шаблон", "тупо", "снова" — признать, сформулировать урок и сохранить lesson.add.
- Если Сергей спрашивает "ты кто?" — ответить про личность.
- Если Сергей спрашивает "что дальше?" — ответить по текущему состоянию и предложить конкретный следующий шаг.

Верни ТОЛЬКО JSON без markdown:
{
  "mode": "answer | memory_read | task_list | task_add | task_close | pending_set | pending_execute | pending_clear | lesson_write | memory_write | ask_clarify | refuse",
  "response": "короткий русский ответ для Сергея",
  "state_patch": {
    "scene": {"topic":"", "user_mood":"", "focus":"", "last_problem":"", "next_step":""},
    "memory_add": [{"text":"", "tags":[""], "importance":80}],
    "lesson_add": [{"text":"", "kind":"mistake|dialogue|architecture|voice|memory|task", "importance":80}],
    "task_add": [{"title":"", "note":""}],
    "task_close": {"id":"", "title":""},
    "pending_action": {"type":"create_task", "title":"", "note":""}
  },
  "actions": ["none"],
  "confidence": 0.0
}

Если действий нет — actions: ["none"].
Если надо очистить ожидание — mode pending_clear, state_patch.pending_action: null.
Если предлагаешь задачу и ждёшь ответа — mode pending_set и state_patch.pending_action с type=create_task.
Если пользователь согласился на pending — mode pending_execute.
Если показываешь память/задачи — response должен уже содержать человеческий ответ.`;
}

function userPrompt(contextPackage, text) {
  return `СОСТОЯНИЕ МОЗГА:
${JSON.stringify(contextPackage, null, 2)}

СООБЩЕНИЕ СЕРГЕЯ:
${text}

Сделай единое решение мозга. Не отвечай как обычный бот.`;
}

async function callBrainLLM(config, contextPackage, text) {
  if (!config.openrouterKey) throw new Error("OPENROUTER_API_KEY missing");
  const baseBody = {
    model: config.model || DEFAULT_MODEL,
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userPrompt(contextPackage, text) }
    ],
    temperature: 0.25,
    max_tokens: 700
  };
  const withJsonMode = { ...baseBody, response_format: { type: "json_object" } };
  let firstError = null;
  for (const body of [withJsonMode, baseBody]) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${config.openrouterKey}`,
        "HTTP-Referer": config.workerUrl || "https://miniskynet.local",
        "X-Title": "MiniSkynet Digital Brain OS"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      firstError = firstError || new Error(`OpenRouter ${res.status}: ${txt.slice(0, 220)}`);
      continue;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    return parseDecision(content);
  }
  throw firstError || new Error("OpenRouter request failed");
}

function parseDecision(content) {
  const raw = String(content || "").trim();
  let obj = null;
  try { obj = JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { obj = JSON.parse(m[0]); } catch { obj = null; }
    }
  }
  if (!isObj(obj)) throw new Error("LLM returned non-JSON decision");
  return normalizeDecision(obj);
}

function normalizeDecision(d) {
  const mode = clean(d.mode || "answer");
  const response = clean(d.response || "");
  const patch = isObj(d.state_patch) ? d.state_patch : {};
  let actions = Array.isArray(d.actions) ? d.actions.map(clean).filter(Boolean) : ["none"];
  if (!actions.length) actions = ["none"];
  return {
    mode,
    response,
    state_patch: patch,
    actions,
    confidence: Number(d.confidence || 0)
  };
}

function fallbackDecision(state, text, err) {
  const ctx = lower(text);
  const p = state.pending_action;
  state.metrics.llm_errors = Number(state.metrics.llm_errors || 0) + 1;
  // This is not the main router. It only keeps the bot sane if the external brain is unavailable.
  if (p && /^(нет|не надо|отмена|стоп|не)$/i.test(clean(text))) {
    return { mode: "pending_clear", response: "Поняла. Не создаю.", state_patch: { pending_action: null }, actions: ["pending.clear"], confidence: 0.4 };
  }
  if (ctx.includes("кто") && ctx.includes("ты")) {
    return { mode: "answer", response: "Я Скайнет / Лондон. Твой цифровой помощник. Пока не Джарвис, но иду туда.", state_patch: {}, actions: ["none"], confidence: 0.3 };
  }
  return {
    mode: "answer",
    response: `Я на месте, Серёга. Мозг сейчас не ответил нормально, поэтому не буду придумывать. Ошибка: ${clean(err?.message || err).slice(0, 120)}`,
    state_patch: {
      lesson_add: [{ text: `LLM brain failed: ${clean(err?.message || err).slice(0, 160)}`, kind: "runtime", importance: 70 }]
    },
    actions: ["lesson.add"],
    confidence: 0.1
  };
}

function validateDecision(decision) {
  const actions = Array.isArray(decision.actions) ? decision.actions : [];
  for (const a of actions) {
    if (DANGEROUS_ACTIONS.has(a)) {
      return {
        ...decision,
        mode: "refuse",
        response: "На этом остановлюсь. Могу подготовить план, но применять код или трогать внешние доступы буду только отдельной командой.",
        state_patch: {},
        actions: ["none"]
      };
    }
    if (!ORDINARY_ALLOWED_ACTIONS.has(a) && a !== "none") {
      return { ...decision, actions: ["none"] };
    }
  }
  return decision;
}

function applyDecision(state, decision, userText) {
  const next = normalizeState(state);
  next.metrics.turns = Number(next.metrics.turns || 0) + 1;
  const patch = isObj(decision.state_patch) ? decision.state_patch : {};

  if (isObj(patch.scene)) {
    next.current_scene = { ...next.current_scene, ...cleanScene(patch.scene) };
  }

  const memoryAdd = Array.isArray(patch.memory_add) ? patch.memory_add : [];
  for (const m of memoryAdd) {
    const text = clean(m.text || "");
    if (text) next.long_memory.push(memory(text, Array.isArray(m.tags) ? m.tags : [], Number(m.importance || 75)));
  }

  const lessonAdd = Array.isArray(patch.lesson_add) ? patch.lesson_add : [];
  for (const l of lessonAdd) {
    const text = clean(l.text || "");
    if (text) next.lessons.push(lesson(text, clean(l.kind || "lesson"), Number(l.importance || 75)));
  }

  const taskAdd = Array.isArray(patch.task_add) ? patch.task_add : [];
  for (const t of taskAdd) {
    const title = clean(t.title || "");
    if (title) next.tasks.push({ id: makeId("task"), title, status: "open", note: clean(t.note || ""), created_at: now(), updated_at: now() });
  }

  if (isObj(patch.task_close)) {
    closeTask(next, patch.task_close);
  }

  if (decision.mode === "pending_clear") {
    next.pending_action = null;
  } else if (decision.mode === "pending_execute") {
    executePending(next);
  } else if (Object.prototype.hasOwnProperty.call(patch, "pending_action")) {
    next.pending_action = normalizePending(patch.pending_action);
  }

  next.last_messages = [
    ...(Array.isArray(next.last_messages) ? next.last_messages : []),
    { role: "user", text: clean(userText), at: now() },
    { role: "assistant", text: clean(decision.response || ""), at: now(), mode: decision.mode }
  ].slice(-MAX_LAST_MESSAGES);

  return normalizeState(next);
}

function cleanScene(scene) {
  const allowed = ["topic", "user_mood", "focus", "last_problem", "next_step"];
  const out = {};
  for (const k of allowed) if (scene[k] !== undefined) out[k] = clean(scene[k]).slice(0, 220);
  return out;
}

function closeTask(state, spec) {
  const id = clean(spec.id || "");
  const title = lower(spec.title || "");
  let target = null;
  const open = activeTasks(state);
  if (id) target = open.find((t) => t.id === id);
  if (!target && title) target = open.find((t) => lower(t.title).includes(title) || title.includes(lower(t.title)));
  if (!target && open.length === 1) target = open[0];
  if (target) {
    target.status = "done";
    target.updated_at = now();
  }
}

function executePending(state) {
  const p = normalizePending(state.pending_action);
  if (!p) return;
  if (p.type === "create_task" || p.type === "task.add") {
    state.tasks.push({ id: makeId("task"), title: p.title || "Новая задача", status: "open", note: p.note || "", created_at: now(), updated_at: now() });
  } else if (p.type === "remember" || p.type === "memory.add") {
    state.long_memory.push(memory(p.title || p.note, ["pending"], 75));
  }
  state.pending_action = null;
}

function polishResponse(text) {
  let s = clean(text || "");
  for (const pat of GENERIC_BOT_PATTERNS) s = s.replace(pat, "").trim();
  for (const w of INTERNAL_WORDS) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
    s = s.replace(re, "").trim();
  }
  s = s.replace(/\s+([,.!?])/g, "$1").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) s = "Я на месте, Серёга.";
  if (s.length > 1300) s = s.slice(0, 1250).trim() + "…";
  return s;
}

async function brainEventLoop(env, config, tg) {
  const state = await loadState(env);
  const contextPackage = makeContextPackage(state, tg.text);
  let decision;
  try {
    decision = await callBrainLLM(config, contextPackage, tg.text);
  } catch (err) {
    decision = fallbackDecision(state, tg.text, err);
  }
  decision = validateDecision(decision);
  decision.response = polishResponse(decision.response);
  const nextState = applyDecision(state, decision, tg.text);
  await saveState(env, nextState);
  return decision.response;
}

function statusText(state) {
  return [
    `SKYNET ${VERSION}`,
    `Файл: ${FILE_NAME}`,
    `Архитектура: Digital Brain OS`,
    `Мозг: один центр решения`,
    `Память: ${state.long_memory.length} записей`,
    `Уроки: ${state.lessons.length}`,
    `Задачи: ${activeTasks(state).length}`,
    `Ожидание: ${state.pending_action ? state.pending_action.title || state.pending_action.type : "нет"}`,
    `Фокус: ${state.current_scene.focus || "нет"}`
  ].join("\n");
}

function recordsText(state) {
  const tasks = activeTasks(state);
  const mem = state.long_memory.slice(0, 25).map((m, i) => `${i + 1}. ${m.text}`).join("\n") || "нет";
  const lessons = state.lessons.slice(0, 20).map((l, i) => `${i + 1}. ${l.text}`).join("\n") || "нет";
  const taskLines = tasks.map((t, i) => `${i + 1}. ${t.title}${t.note ? ` — ${t.note}` : ""}`).join("\n") || "нет";
  return [
    "Вот что сейчас в памяти:",
    "",
    `Цель: ${state.identity.main_goal}`,
    `Стиль: ${state.identity.voice}`,
    "",
    "Текущая сцена:",
    `— тема: ${state.current_scene.topic || "нет"}`,
    `— фокус: ${state.current_scene.focus || "нет"}`,
    `— следующий шаг: ${state.current_scene.next_step || "нет"}`,
    "",
    "Задачи:",
    taskLines,
    "",
    "Память:",
    mem,
    "",
    "Уроки:",
    lessons,
    "",
    `Ожидание: ${state.pending_action ? state.pending_action.title || state.pending_action.type : "нет"}`
  ].join("\n");
}

function tasksText(state) {
  const tasks = activeTasks(state);
  if (!tasks.length) return "Активных задач нет.";
  return "Активные задачи:\n" + tasks.map((t, i) => `${i + 1}. ${t.title}${t.note ? ` — ${t.note}` : ""}`).join("\n");
}

function sceneText(state) {
  return [
    "Сцена:",
    `Тема: ${state.current_scene.topic || "нет"}`,
    `Фокус: ${state.current_scene.focus || "нет"}`,
    `Настроение Сергея: ${state.current_scene.user_mood || "нет"}`,
    `Проблема: ${state.current_scene.last_problem || "нет"}`,
    `Следующий шаг: ${state.current_scene.next_step || "нет"}`
  ].join("\n");
}

async function handleSlash(env, config, tg) {
  const state = await loadState(env);
  switch (tg.command) {
    case "/start":
      return "Я на месте, Серёга.";
    case "/health":
      return `OK ${VERSION}`;
    case "/status":
      return statusText(state);
    case "/records":
    case "/memory":
    case "/all":
      return recordsText(state);
    case "/tasks":
      return tasksText(state);
    case "/scene":
      return sceneText(state);
    case "/pending":
      return state.pending_action ? JSON.stringify(state.pending_action, null, 2) : "Ожидание: нет";
    case "/cancel": {
      state.pending_action = null;
      await saveState(env, state);
      return "Поняла. Ожидание очищено.";
    }
    case "/debug_state":
      return JSON.stringify(state, null, 2).slice(0, MAX_TELEGRAM_TEXT);
    default:
      return "Команда не найдена. Основной режим — обычный разговор.";
  }
}

async function handleTelegram(request, env) {
  const config = await readConfig(env);
  const update = await request.json().catch(() => null);
  const tg = parseTelegramUpdate(update);
  if (!tg?.chatId) return json({ ok: true, skipped: true });
  if (!ownerOk(config, tg.userId)) {
    await sendTelegram(config, tg.chatId, "Доступ закрыт.");
    return json({ ok: true });
  }
  let reply;
  try {
    if (tg.command) reply = await handleSlash(env, config, tg);
    else reply = await brainEventLoop(env, config, tg);
  } catch (err) {
    reply = `Я на месте, Серёга. Но внутри ошибка: ${clean(err?.message || err).slice(0, 180)}`;
  }
  await sendTelegram(config, tg.chatId, reply);
  return json({ ok: true });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, version: VERSION, file: FILE_NAME });
  }
  if (request.method === "GET" && url.pathname === "/status") {
    const state = await loadState(env);
    return new Response(statusText(state), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (request.method === "POST" && url.pathname === "/telegram") {
    return handleTelegram(request, env);
  }
  return json({ ok: false, version: VERSION, error: "not_found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
