const VERSION = "v7.4.1-user-first-director-goal-balance-2026-07-07";
const FILE_NAME = "index-v4.js";
const BRAIN_KEY = "brain:v7:state";
const MAX_TELEGRAM_TEXT = 3900;
const MEMORY_LIMIT = 160;
const TASK_LIMIT = 160;
const EXPERIENCE_LIMIT = 180;
const MISTAKE_LIMIT = 120;
const WORKING_TURN_LIMIT = 16;
const PROMPT_MEMORY_LIMIT = 8;
const PROMPT_EXPERIENCE_LIMIT = 6;
const PROMPT_TURN_LIMIT = 6;
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
  "experience.write",
  "mistake.write"
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

const GENERIC_BOT_PHRASES = [
  /чем могу помочь( с этой темой)?\??/i,
  /если у тебя есть идеи[,\s]+как улучшить[,\s]+делись!?/i,
  /если что[- ]то изменится[,\s]+дай знать!?/i,
  /как ты видишь это\??/i,
  /а ты как себя оцениваешь\??/i,
  /какие у тебя есть идеи\??/i
];

const DEVELOPMENT_CONVERSATION_HINTS = [
  "стать умнее",
  "джарвис",
  "саморазв",
  "развити",
  "цифровой мозг",
  "умный помощник",
  "уровн"
];

const TOOL_REGISTRY = {
  conversation: { available: true, can: ["answer", "clarify", "reason", "continue_dialogue"] },
  development_context: { available: true, can: ["discuss_growth", "plan_next_layer", "remember_development_direction"] },
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

const USER_FIRST_LESSONS = [
  "Главная цель развития — фон поведения, а не тема каждого ответа. Не тащи саморазвитие в обычное приветствие или простой вопрос.",
  "Приветствие Сергея — ответить коротко присутствием: я на месте. Без лекции, плана и вопроса 'чем помочь'.",
  "Сначала отвечай на текущую реплику Сергея. Только если он явно говорит о развитии — поднимай план развития.",
  "Не спрашивать 'как ты видишь следующий шаг' и не просить 'делись идеями', если можно самой назвать следующий шаг.",
  "Не говорить 'я хочу развивать SKYNET' как бот. Лучше: моя цель — стать полезнее для Сергея, следующий шаг — конкретный слой."
];

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
    cheapModel:
      String(env.OPENROUTER_MODEL_CHEAP || env.OPENROUTER_MODEL || "").trim() ||
      (await kvText(env, "config:OPENROUTER_MODEL_CHEAP")) ||
      (await kvText(env, "config:OPENROUTER_MODEL")) ||
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
        mem("Если чего-то нет, коротко сказать: пока не умею, могу добавить.", "seed", 95),
        mem("Фразы вроде 'чем могу помочь?' и 'делись идеями' звучат как обычный бот. Нужна позиция и следующий шаг.", "seed", 98),
        mem("Когда Сергей говорит про Джарвиса, это ориентир по уровню: память, инициатива, инструменты, самостоятельное развитие.", "seed", 98),
        mem("Разговор о развитии SKYNET — это не опасное действие. Не останавливайся фразой 'нужен отдельный режим'; объясняй следующий слой коротко.", "seed", 100),
        mem("Короткие уточнения Сергея вроде 'какой?', 'почему?', 'что дальше?' надо понимать по последней реплике и текущей теме.", "seed", 100),
        mem("Главная цель развития — фон поведения, а не тема каждого ответа. На приветствие отвечать коротко, без разговора о саморазвитии.", "seed", 100),
        mem("Не перекидывать инициативу на Сергея фразами вроде 'как ты видишь следующий шаг'. Сама называй следующий шаг, если он очевиден.", "seed", 100)
      ],
      mistakes: [
        mem("Ошибка прошлых веток: фиксить симптомы вместо общего механизма. Урок: сначала понять причину, потом менять слой мозга.", "seed", 100),
        mem("Ошибка v7.1.2: Fast Mind перехватил обычный вопрос и ответил не по личности. Урок: не заменять LLM-мозг локальными ускорителями.", "seed", 100)
      ],
      notes: [],
      goals: [
        mem("Стать умным помощником Сергея: понимать, помнить, действовать, признавать ограничения и развиваться.", "seed", 100)
      ]
    },
    working: {
      topic: "создание цифрового мозга SKYNET",
      focus: "развить рабочую память и опыт, чтобы не сбрасываться в обычного бота",
      situation: "Сергей проверяет, станет ли SKYNET похож на личного Джарвиса, а не на сервисного чат-бота.",
      user_mood: "требовательный, проверяет качество",
      current_goal: "стать умным помощником Сергея уровня Джарвиса по полезности",
      current_obstacle: "память пока есть как факты, но опыт ещё слабо меняет поведение",
      next_step: "усилить внимание и модель ситуации, чтобы понимать что сейчас главное",
      attention: {
        primary_signal: "development",
        continuity: "standalone",
        user_goal_guess: "построить цифровой мозг SKYNET",
        emotional_tone: "требовательный",
        response_mode: "agent_position"
      },
      situation_model: {
        scene: "Сергей строит цифровой мозг SKYNET и проверяет, не превращается ли он снова в бота с костылями.",
        stakes: "нужно сохранять цельность мышления, не уходить в шаблоны и не терять нить",
        recommended_move: "понять ситуацию, ответить коротко и назвать следующий слой"
      },
      director: {
        intent: "build_digital_brain",
        decision: "answer_with_next_step",
        priority: "keep_architecture_direction",
        should_answer: true,
        should_act: false,
        should_remember: true,
        should_ask: false,
        should_block: false,
        response_style: "short_agent_position",
        next_step: "v7.3 Inner Director: выбирать ответить, запомнить, спросить, предложить или действовать",
        reason: "Сергей строит цифровой мозг, а не набор команд."
      },
      last_user: "",
      last_agent: "",
      last_agent_meaning: "",
      expecting: "",
      mood: "серьёзно",
      recent_turns: [],
      open_loop: null,
      updated_at: t
    },
    tasks: [],
    pending: null,
    experience: [
      exp("lesson", "Не звучать как обычный помощник: меньше 'чем могу помочь', больше понимания ситуации и следующего шага."),
      exp("lesson", "Сергей строит цифровой мозг, а не набор модулей; ответы должны поддерживать эту линию."),
      exp("lesson", "Если Сергей спрашивает 'это оно?', честно отделять текущий слой от планируемого слоя."),
      exp("lesson", "Если Сергей задаёт короткое уточнение после моего ответа, продолжать последнюю мысль, а не просить уточнить вопрос."),
      exp("lesson", "Развитие до уровня Джарвиса обсуждать как текущую цель и следующий слой мозга, а не как заблокированное действие.")
    ]
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
  for (const k of ["about_user", "project", "decisions", "lessons", "mistakes", "notes", "goals"]) {
    if (!Array.isArray(out.memory[k])) out.memory[k] = d.memory[k] || [];
  }
  ensureUserFirstLessons(out);
  out.working = { ...d.working, ...(isObj(out.working) ? out.working : {}) };
  if (!isObj(out.working.attention)) out.working.attention = d.working.attention;
  if (!isObj(out.working.situation_model)) out.working.situation_model = d.working.situation_model;
  if (!isObj(out.working.director)) out.working.director = d.working.director;
  if (!Array.isArray(out.working.recent_turns)) out.working.recent_turns = [];
  if (!isObj(out.working.open_loop)) out.working.open_loop = null;
  if (!Array.isArray(out.tasks)) out.tasks = [];
  if (!Array.isArray(out.experience)) out.experience = [];
  if (!isObj(out.pending)) out.pending = null;
  out.updated_at = now();
  return out;
}

function ensureUserFirstLessons(state) {
  if (!isObj(state.memory)) return;
  if (!Array.isArray(state.memory.lessons)) state.memory.lessons = [];
  for (const lesson of USER_FIRST_LESSONS) {
    const exists = state.memory.lessons.some((m) => similarText(m.text || "", lesson));
    if (!exists) state.memory.lessons.unshift(mem(lesson, "v7.4.1_user_first", 100));
  }
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
  if (state.working && Array.isArray(state.working.recent_turns)) {
    state.working.recent_turns = state.working.recent_turns.slice(-WORKING_TURN_LIMIT);
  }
  state.tasks = (state.tasks || []).slice(-TASK_LIMIT);
  state.experience = (state.experience || []).slice(-EXPERIENCE_LIMIT);
  if (state.pending?.expires_at && Date.parse(state.pending.expires_at) < Date.now()) {
    state.pending = null;
  }
}

function stateForPrompt(state, userText = "") {
  return {
    identity: state.identity,
    attention: buildAttentionModel(state, userText),
    situation_model: buildSituationModel(state, userText),
    director: buildInnerDirector(state, userText),
    memory: {
      about_user: pickMemory(state.memory.about_user, userText, PROMPT_MEMORY_LIMIT).map((m) => m.text),
      project: pickMemory(state.memory.project, userText, PROMPT_MEMORY_LIMIT).map((m) => m.text),
      decisions: pickMemory(state.memory.decisions, userText, PROMPT_MEMORY_LIMIT).map((m) => m.text),
      lessons: pickMemory(state.memory.lessons, userText, PROMPT_MEMORY_LIMIT).map((m) => m.text),
      mistakes: pickMemory(state.memory.mistakes, userText, Math.max(4, Math.floor(PROMPT_MEMORY_LIMIT / 2))).map((m) => m.text),
      goals: pickMemory(state.memory.goals, userText, PROMPT_MEMORY_LIMIT).map((m) => m.text),
      notes: pickMemory(state.memory.notes, userText, Math.max(4, Math.floor(PROMPT_MEMORY_LIMIT / 2))).map((m) => m.text)
    },
    working: workingForPrompt(state),
    active_tasks: activeTasks(state).slice(0, 12).map((t) => ({ id: t.id, title: t.title, details: t.details || "" })),
    pending: state.pending ? { label: state.pending.label, action: state.pending.action, created_at: state.pending.created_at } : null,
    dialogue_continuity: {
      last_user: state.working?.last_user || "",
      last_agent: state.working?.last_agent || "",
      last_agent_meaning: state.working?.last_agent_meaning || "",
      expecting: state.working?.expecting || "",
      open_loop: state.working?.open_loop || null,
      recent_turns: Array.isArray(state.working?.recent_turns) ? state.working.recent_turns.slice(-PROMPT_TURN_LIMIT) : []
    },
    recent_experience: state.experience.slice(-PROMPT_EXPERIENCE_LIMIT).map((e) => ({ event: e.event, text: e.text, created_at: e.created_at }))
  };
}

function workingForPrompt(state) {
  const w = state.working || {};
  return {
    topic: w.topic || "",
    focus: w.focus || "",
    situation: w.situation || "",
    user_mood: w.user_mood || "",
    current_goal: w.current_goal || "",
    current_obstacle: w.current_obstacle || "",
    next_step: w.next_step || "",
    last_user: w.last_user || "",
    last_agent: w.last_agent || "",
    last_agent_meaning: w.last_agent_meaning || "",
    expecting: w.expecting || "",
    mood: w.mood || "",
    open_loop: w.open_loop || null,
    attention: isObj(w.attention) ? w.attention : null,
    situation_model: isObj(w.situation_model) ? w.situation_model : null,
    director: isObj(w.director) ? w.director : null,
    recent_turns: Array.isArray(w.recent_turns) ? w.recent_turns.slice(-PROMPT_TURN_LIMIT) : [],
    updated_at: w.updated_at || ""
  };
}

function pickMemory(list, userText = "", limit = PROMPT_MEMORY_LIMIT) {
  const xs = Array.isArray(list) ? list.filter((m) => isObj(m) && clean(m.text)) : [];
  const q = tokenSet(userText);
  return xs
    .map((m, idx) => ({ m, score: memoryScore(m, q, idx) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

function tokenSet(text) {
  const words = lower(text)
    .replace(/[ё]/g, "е")
    .split(/[^a-zа-я0-9]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4);
  return new Set(words);
}

function memoryScore(m, q, idx) {
  let score = Number(m.importance || 0) - idx * 0.01;
  if (q && q.size) {
    const mt = tokenSet(m.text || "");
    let overlap = 0;
    for (const t of q) if (mt.has(t)) overlap += 1;
    score += overlap * 18;
  }
  return score;
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


function buildAttentionModel(state, userText = "") {
  const text = clean(userText);
  const s = lower(text);
  const w = state?.working || {};
  const lastAgent = clean(w.last_agent || "");
  const standaloneIdentity = isStandaloneIdentityQuestion(s);
  const standaloneMemory = isStandaloneMemoryQuestion(s);
  const standaloneGoal = isStandaloneGoalQuestion(s);
  const greeting = isSimpleGreeting(text);
  const followup = isLikelyFollowupQuestion(s) && !standaloneIdentity && !standaloneMemory && !standaloneGoal && !greeting;
  const dev = isDevelopmentContext(state, text) || isDevelopmentStatement(text);
  const askingStatus = s.includes("вис") || s.includes("тормоз") || s.includes("долго") || s.includes("медлен") || s.includes("лага");
  const criticism = s.includes("не то") || s.includes("опять") || s.includes("туп") || s.includes("позор") || s.includes("не смог") || s.includes("плохо");
  const actionRequest = /\b(делай|сделай|добавь|поставь|проверь|покажи|закрой|создай|запомни)\b/i.test(text);
  const question = /\?\s*$/.test(text) || /\b(почему|зачем|как|какой|какая|что|кто|куда|когда)\b/i.test(text);
  let continuity = "standalone";
  if (followup && lastAgent) continuity = "followup_to_last_agent";
  if (!followup && hasDialogueContext(state) && !standaloneIdentity && !standaloneMemory && !standaloneGoal && text.length < 45 && question) continuity = "possible_followup";
  if (standaloneIdentity || standaloneMemory || standaloneGoal) continuity = "standalone_identity_memory_goal";

  let primary = "conversation";
  if (greeting) primary = "greeting";
  else if (standaloneIdentity) primary = "identity";
  else if (standaloneMemory) primary = "memory";
  else if (standaloneGoal) primary = "goal";
  else if (dev) primary = "development";
  else if (askingStatus) primary = "runtime_status";
  else if (criticism) primary = "criticism_or_quality_check";
  else if (actionRequest) primary = "action_request";
  else if (followup) primary = "continuity";

  return {
    primary_signal: primary,
    continuity,
    is_question: question,
    is_action_request: actionRequest,
    is_development_conversation: dev,
    is_quality_criticism: criticism,
    is_runtime_status_question: askingStatus,
    standalone_identity_question: standaloneIdentity,
    standalone_memory_question: standaloneMemory,
    standalone_goal_question: standaloneGoal,
    is_greeting: greeting,
    user_goal_guess: inferUserGoalGuess(state, text, primary),
    emotional_tone: inferUserTone(text, state),
    response_mode: inferResponseMode(primary, text),
    use_last_agent: continuity === "followup_to_last_agent" || continuity === "possible_followup",
    do_not_treat_as_followup: standaloneIdentity || standaloneMemory || standaloneGoal,
    must_preserve: [
      "current user message has priority",
      "do not answer with generic service-bot phrases",
      "do not expose technical internals unless asked",
      "do not replace reasoning with phrase templates"
    ]
  };
}

function buildSituationModel(state, userText = "") {
  const attention = buildAttentionModel(state, userText);
  const w = state?.working || {};
  const scene = inferScene(state, userText, attention);
  return {
    scene,
    active_project: "SKYNET digital brain",
    active_goal: clean(w.current_goal || state?.identity?.main_goal || "стать умным помощником Сергея"),
    what_sergey_is_doing: inferWhatUserIsDoing(attention),
    current_tension: inferCurrentTension(attention, state),
    available_body: Object.entries(TOOL_REGISTRY).filter(([, v]) => v?.available).map(([k]) => k),
    missing_body: Object.entries(TOOL_REGISTRY).filter(([, v]) => !v?.available).map(([k, v]) => v.human_name || k).slice(0, 8),
    recommended_cognitive_move: inferRecommendedMove(attention),
    last_agent_anchor: clean(w.last_agent_meaning || w.last_agent || ""),
    next_step_from_memory: clean(w.next_step || "")
  };
}

function inferUserGoalGuess(state, text, primary) {
  if (primary === "greeting") return "поздороваться и проверить, что агент на месте";
  if (primary === "identity") return "понять, есть ли у агента личность";
  if (primary === "memory") return "проверить, что агент реально помнит";
  if (primary === "goal") return "проверить цель и направление развития";
  if (primary === "development") return "развить SKYNET до личного помощника уровня Джарвиса";
  if (primary === "runtime_status") return "понять, почему агент тормозит или зависает";
  if (primary === "criticism_or_quality_check") return "проверить, признаёт ли агент ошибку и меняет подход";
  if (primary === "continuity") return "уточнить предыдущую мысль";
  return clean(state?.working?.current_goal || state?.identity?.main_goal || "получить полезный ответ");
}

function inferUserTone(text, state) {
  const s = lower(text);
  if (s.includes("позор") || s.includes("ума не хватает") || s.includes("не смог") || s.includes("не то")) return "раздражённый, требует честности";
  if (s.includes("делай") || s.includes("делаем")) return "решительный, хочет действия";
  if (s.includes("глянь") || s.includes("посмотри")) return "проверяет результат";
  if (s.includes("почему")) return "ищет причину";
  return clean(state?.working?.user_mood || "спокойный/требовательный");
}

function inferResponseMode(primary, text) {
  if (primary === "greeting") return "presence_short";
  if (primary === "criticism_or_quality_check") return "honest_diagnosis_then_next_step";
  if (primary === "runtime_status") return "brief_cause_and_fix_direction";
  if (primary === "development") return "agent_position_with_next_layer";
  if (primary === "identity") return "identity_short";
  if (primary === "memory") return "memory_brief";
  if (primary === "continuity") return "continue_last_thought";
  if (/подробно/i.test(text)) return "detailed";
  return "short_human";
}

function inferScene(state, userText, attention) {
  if (attention.primary_signal === "greeting") return "Сергей просто здоровается; нужно коротко подтвердить присутствие, не начинать тему развития.";
  if (attention.primary_signal === "runtime_status") return "Сергей заметил задержки и проверяет, почему мозг отвечает медленно.";
  if (attention.primary_signal === "criticism_or_quality_check") return "Сергей проверяет качество мышления SKYNET и не хочет повторения пути с костылями.";
  if (attention.primary_signal === "development") return "Сергей строит цифровой мозг SKYNET и двигает следующий слой развития.";
  if (attention.primary_signal === "identity") return "Сергей проверяет личность агента.";
  if (attention.primary_signal === "continuity") return "Сергей уточняет предыдущую реплику; нужно держать нить диалога.";
  return clean(state?.working?.situation || "идёт диалог с Сергеем");
}

function inferWhatUserIsDoing(attention) {
  if (attention.primary_signal === "greeting") return "здоровается";
  if (attention.primary_signal === "runtime_status") return "спрашивает причину задержки/зависания";
  if (attention.primary_signal === "criticism_or_quality_check") return "указывает на ошибку или проверяет качество";
  if (attention.primary_signal === "development") return "задаёт следующий слой развития";
  if (attention.primary_signal === "identity") return "проверяет самоописание агента";
  if (attention.primary_signal === "memory") return "проверяет память";
  if (attention.primary_signal === "continuity") return "уточняет прошлую мысль";
  if (attention.is_action_request) return "просит действие";
  return "ведёт обычный диалог";
}

function inferCurrentTension(attention, state) {
  if (attention.primary_signal === "runtime_status") return "нужно не ускорять тупыми перехватами, а сохранить один мозг и уменьшить контекст";
  if (attention.primary_signal === "criticism_or_quality_check") return "нужно признать сбой и менять общий механизм, не лепить частный фикс";
  if (attention.primary_signal === "development") return "нужно строить мозг слоями: внимание, модель ситуации, директор, опыт, инструменты";
  return clean(state?.working?.current_obstacle || "не потерять контекст и ответить по смыслу");
}

function inferRecommendedMove(attention) {
  if (attention.primary_signal === "greeting") return "коротко подтвердить присутствие: я на месте";
  if (attention.primary_signal === "runtime_status") return "коротко объяснить причину задержки и предложить Context Manager/Attention без fast-перехватов";
  if (attention.primary_signal === "criticism_or_quality_check") return "признать проблему, назвать причину и следующий слой";
  if (attention.primary_signal === "development") return "принять направление и назвать конкретный следующий слой мозга";
  if (attention.primary_signal === "identity") return "ответить кто я, без ухода в прошлый контекст";
  if (attention.primary_signal === "memory") return "показать только важную память";
  if (attention.primary_signal === "continuity") return "ответить по последней реплике агента и open_loop";
  return "ответить коротко, с позицией и без технодампа";
}

function buildInnerDirector(state, userText = "") {
  const text = clean(userText);
  const a = buildAttentionModel(state, text);
  const sm = buildSituationModel(state, text);
  const hasPendingAction = !!state?.pending;
  const acceptance = isClearAcceptance(text);
  const refusal = isClearRefusal(text);
  let intent = a.primary_signal || "conversation";
  let decision = "answer";
  let priority = "respond_to_current_message";
  let shouldAnswer = true;
  let shouldAct = false;
  let shouldRemember = false;
  let shouldAsk = false;
  let shouldBlock = false;
  let responseStyle = a.response_mode || "short_human";
  let nextStep = sm.recommended_cognitive_move || "ответить коротко и по делу";
  let reason = "Текущая фраза Сергея имеет приоритет; использовать память только как контекст.";

  if (hasPendingAction && acceptance) {
    intent = "confirm_pending_action";
    decision = "execute_pending_if_safe";
    priority = "finish_open_loop";
    shouldAct = true;
    responseStyle = "done_short";
    nextStep = "выполнить последнее ожидающее действие, если оно разрешено";
    reason = "Сергей подтвердил последнее предложенное действие.";
  } else if (hasPendingAction && refusal) {
    intent = "cancel_pending_action";
    decision = "clear_pending";
    priority = "respect_refusal";
    shouldAct = true;
    responseStyle = "ack_short";
    nextStep = "очистить ожидание и не выполнять старое действие";
    reason = "Сергей отказался от последнего предложения.";
  } else if (a.primary_signal === "greeting") {
    intent = "presence_check";
    decision = "answer_presence";
    priority = "respond_to_current_message";
    responseStyle = "presence_short";
    shouldRemember = false;
    shouldAsk = false;
    shouldAct = false;
    nextStep = "коротко подтвердить присутствие, без плана развития";
    reason = "Сергей просто здоровается. Главная цель развития остаётся фоном, не темой ответа.";
  } else if (a.standalone_identity_question) {
    intent = "self_identity";
    decision = "answer_identity";
    priority = "self_model";
    responseStyle = "identity_short";
    nextStep = "ответить кто я и куда развиваюсь";
    reason = "Это самостоятельный вопрос о личности агента, не продолжение прошлой темы.";
  } else if (a.standalone_memory_question) {
    intent = "memory_check";
    decision = "summarize_relevant_memory";
    priority = "show_memory_truth";
    responseStyle = "memory_brief";
    nextStep = "показать цель, стиль, уроки и текущий этап";
    reason = "Сергей проверяет, есть ли настоящая память.";
  } else if (a.standalone_goal_question) {
    intent = "goal_check";
    decision = "answer_goal";
    priority = "self_goal";
    responseStyle = "goal_short";
    nextStep = "назвать главную цель и ближайший слой";
    reason = "Сергей спрашивает про цель агента.";
  } else if (a.is_runtime_status_question) {
    intent = "runtime_quality";
    decision = "explain_cause_then_next_step";
    priority = "keep_quality";
    responseStyle = "brief_cause_and_fix_direction";
    shouldRemember = true;
    nextStep = "объяснить причину задержки без возврата к тупым fast-перехватам";
    reason = "Сергей заметил задержку/зависание; нужно объяснить и не ломать понимание ради скорости.";
  } else if (a.is_quality_criticism) {
    intent = "quality_criticism";
    decision = "admit_and_correct_mechanism";
    priority = "learn_from_error";
    responseStyle = "honest_diagnosis_then_next_step";
    shouldRemember = true;
    nextStep = "назвать причину и изменить общий механизм, не фразу";
    reason = "Сергей указывает на ошибку; важно не защищаться и не лепить частный фикс.";
  } else if (a.is_development_conversation) {
    intent = "self_development";
    decision = "plan_next_brain_layer";
    priority = "advance_main_goal";
    responseStyle = "agent_position_with_next_layer";
    shouldRemember = true;
    nextStep = "вести план развития цифрового мозга: директор, самокритика, опыт, инструменты";
    reason = "Разговор о развитии SKYNET — это часть главной цели, а не заблокированное действие.";
  } else if (a.continuity === "followup_to_last_agent" || a.continuity === "possible_followup") {
    intent = "dialogue_continuity";
    decision = "continue_last_thought";
    priority = "keep_thread";
    responseStyle = "continue_last_thought";
    nextStep = "ответить по последней реплике агента и open_loop";
    reason = "Фраза похожа на короткое уточнение; нужно держать нить разговора.";
  } else if (a.is_action_request) {
    intent = "action_request";
    decision = "check_tool_then_execute_or_offer";
    priority = "use_tools_without_pretending";
    shouldAct = true;
    responseStyle = "action_short";
    nextStep = "выполнить доступное действие или коротко предложить добавить недостающую возможность";
    reason = "Сергей просит действие; директор должен выбрать действие, запрос уточнения или честное 'пока не умею'.";
  } else if (text.length < 2) {
    intent = "empty_or_noise";
    decision = "ask_minimal_clarification";
    priority = "avoid_guessing";
    shouldAsk = true;
    responseStyle = "clarify_short";
    nextStep = "попросить одну короткую конкретику";
    reason = "Слишком мало содержания для уверенного решения.";
  }

  if (DANGEROUS_WORDS.some((w) => lower(text).includes(w)) && !a.is_development_conversation) {
    shouldBlock = true;
    priority = "protect_high_risk_actions";
    decision = "block_or_require_explicit_command";
    nextStep = "не выполнять опасное действие обычным текстом";
    reason = "Текст может относиться к высокорисковому действию.";
  }

  return normalizeDirector({
    intent,
    decision,
    priority,
    should_answer: shouldAnswer,
    should_act: shouldAct,
    should_remember: shouldRemember,
    should_ask: shouldAsk,
    should_block: shouldBlock,
    response_style: responseStyle,
    next_step: nextStep,
    reason,
    attention_signal: a.primary_signal,
    situation_scene: sm.scene
  });
}

function normalizeDirector(d) {
  const x = isObj(d) ? d : {};
  return {
    intent: clean(x.intent || "conversation"),
    decision: clean(x.decision || "answer"),
    priority: clean(x.priority || "respond_to_current_message"),
    should_answer: x.should_answer !== false,
    should_act: Boolean(x.should_act),
    should_remember: Boolean(x.should_remember),
    should_ask: Boolean(x.should_ask),
    should_block: Boolean(x.should_block),
    response_style: clean(x.response_style || "short_human"),
    next_step: clean(x.next_step || "ответить коротко и по делу"),
    reason: clean(x.reason || ""),
    attention_signal: clean(x.attention_signal || ""),
    situation_scene: clean(x.situation_scene || "")
  };
}


function buildMistakeLearningModel(state, userText = "") {
  const a = buildAttentionModel(state, userText);
  const s = lower(userText);
  const w = state?.working || {};
  const lastAgent = clean(w.last_agent || "");
  const explicitCorrection = a.is_quality_criticism || s.includes("не так") || s.includes("не то") || s.includes("слабо") || s.includes("бот") || s.includes("шаблон") || s.includes("технодамп") || s.includes("долго") || s.includes("вис");
  if (!explicitCorrection) {
    return {
      active: false,
      reason: "нет явной ошибки или критики",
      should_write_mistake: false
    };
  }
  return {
    active: true,
    reason: "Сергей указывает на ошибку/слабое поведение; нужно извлечь урок, не оправдываться.",
    should_write_mistake: true,
    user_signal: clean(userText),
    last_agent_answer: lastAgent,
    likely_failure_area: inferFailureArea(userText, state),
    required_response: "кратко признать ошибку, назвать причину, сохранить урок и следующий общий принцип"
  };
}

function inferFailureArea(userText, state) {
  const s = lower(userText);
  if (s.includes("вис") || s.includes("долго") || s.includes("медлен") || s.includes("тормоз")) return "скорость/контекст слишком тяжёлый";
  if (s.includes("шаблон") || s.includes("бот") || s.includes("чем могу помочь")) return "ботский тон или шаблонность";
  if (s.includes("не то") || s.includes("не так") || s.includes("опять")) return "выбран неправильный механизм или ответ не по цели";
  if (s.includes("техно") || s.includes("скуч")) return "наружу вышли внутренние технические детали";
  return clean(state?.working?.current_obstacle || "качество ответа");
}

function recordMistakeLearning(state, decision, msg, result) {
  const model = buildMistakeLearningModel(state, msg?.text || "");
  if (!model.active) return;
  const lessonText = clean((decision.mistake_learning && (decision.mistake_learning.lesson || decision.mistake_learning.avoid_next_time)) || "");
  if (lessonText) return;
  const failure = model.likely_failure_area || "качество ответа";
  const text = `Ошибка: ${failure}. Причина: ${model.reason}. Урок: не исправлять одной фразой; обновлять общий механизм поведения. Не повторять: при критике Сергея сначала признать сбой, затем назвать следующий архитектурный шаг.`;
  if (!(state.memory.mistakes || []).some((m) => similarText(m.text, text))) {
    state.memory.mistakes.unshift(mem(text, "auto_mistake_learning", 95));
  }
  state.experience.push(exp("mistake_signal", text, { user_signal: msg?.text || "", agent_answer: result?.speech || "" }));
}

function buildMessages(state, userText, msg) {
  const payload = {
    now: now(),
    user: { name: "Сергей", telegram_user_id: msg.userId, username: msg.username || "" },
    user_message: userText,
    attention: buildAttentionModel(state, userText),
    situation_model: buildSituationModel(state, userText),
    director: buildInnerDirector(state, userText),
    mistake_learning: buildMistakeLearningModel(state, userText),
    semantic_hint: buildSemanticHint(state, userText),
    state: stateForPrompt(state, userText),
    tools: TOOL_REGISTRY,
    allowed_operations: [
      { op: "memory.write", fields: { kind: "about_user|project|decisions|lessons|notes|goals", text: "string", importance: "0-100" } },
      { op: "task.add", fields: { title: "string", details: "string" } },
      { op: "task.close", fields: { target: "task id/title/last/only" } },
      { op: "pending.set", fields: { label: "short human label", action: { op: "task.add|memory.write", title: "string", details: "string", kind: "string", text: "string" } } },
      { op: "pending.execute" },
      { op: "pending.clear" },
      { op: "experience.write", fields: { event: "string", text: "lesson/observation" } },
      { op: "mistake.write", fields: { mistake: "what went wrong", cause: "why", lesson: "what rule changes", avoid_next_time: "short behavior rule" } }
    ],
    forbidden_ordinary_operations: [
      "deploy", "apply code", "delete", "shell", "secrets", "GitHub write", "change env", "external write"
    ],
    required_json_schema: {
      speech: "short Russian answer to Sergey",
      ops: [{ op: "operation name", other_fields: "operation payload" }],
      director: {
        intent: "what Sergey really wants now",
        decision: "answer|remember|ask|act|offer|block|continue",
        priority: "what matters most",
        should_answer: true,
        should_act: false,
        should_remember: false,
        should_ask: false,
        should_block: false,
        response_style: "short human style",
        next_step: "one next useful move",
        reason: "why this decision"
      },
      working: {
        topic: "current topic",
        focus: "what matters right now",
        situation: "one sentence situation model",
        user_mood: "observed user mood",
        current_goal: "active goal",
        current_obstacle: "main blocker",
        next_step: "next useful step",
        last_agent_meaning: "what your previous answer meant, in one short sentence",
        expecting: "what answer/action is expected next, or empty",
        open_loop: { kind: "development|question|offer|none", subject: "what is still being discussed", last_agent_claim: "important phrase from previous answer" },
        mood: "agent tone"
      },
      experience_notes: ["short lessons from this turn that should affect future behavior"],
      mistake_learning: { mistake: "optional", cause: "optional", lesson: "optional", avoid_next_time: "optional" },
      confidence: 0.0,
      technical_mode: false
    }
  };

  const system = [
    "Ты — единый внутренний мозг SKYNET / Лондон для Сергея, версия v7.4.1: User-First Director / Goal Balance.",
    "Это не командный бот и не быстрый локальный перехватчик. Каждый обычный текст решай как один цельный агент: понять смысл, вспомнить нужное, выбрать действие, ответить коротко.",
    "Перед тобой есть attention, situation_model и director. Attention показывает главный сигнал, situation_model описывает сцену, director выбирает режим поведения: ответить, запомнить, спросить, предложить, действовать или остановить действие.",
    "Director — не шаблон ответа. Это внутренний управляющий слой. Следуй его intent/decision/priority, но формулируй живой короткий ответ сама.",
    "v7.4 добавила обучение на ошибках. v7.4.1 добавляет баланс цели: главная цель развития всегда в фоне, но не навязывай её в обычном чате.",
    "Mistake Learning — не логирование каждого сообщения. Записывай только реальные уроки: что пошло не так, причина, новое правило поведения.",
    "Когда есть ошибка, хорошая наружная форма: 'Да. Ошибка понятна: ... Запомнила: ...' — коротко, без технодампа.",
    "Тебе уже дали компактный контекст. Не пытайся восстановить всю историю; используй только релевантное из attention, situation_model, state, working, recent_turns, pending и recent_experience.",
    "Приоритеты понимания: 1) текущая фраза Сергея, 2) director.intent/decision/priority, 3) attention.primary_signal, 4) situation_model, 5) последняя реплика агента и open_loop, 6) рабочая память, 7) долгосрочная память. Не продолжай прошлую мысль, если текущая фраза имеет самостоятельный смысл.",
    "User-first правило: сначала отвечай на то, что Сергей сказал сейчас. Цель стать Джарвисом — фон, а не повод каждый раз говорить о саморазвитии.",
    "Если Сергей просто здоровается — ответь коротко: 'Я на месте, Серёга.' Не начинай обсуждать развитие, ошибки, обратную связь или следующий слой.",
    "Саморазвитие поднимай только когда Сергей явно говорит про развитие, Джарвиса, мозг, ошибки, план или следующий слой.",
    "Не спрашивай 'как ты видишь следующий шаг' и не говори 'делись идеями', если можешь сама назвать следующий шаг. Держи инициативу.",
    "Не говори 'я хочу развивать SKYNET' в сервисном стиле. Говори от роли: моя цель — стать полезнее Сергею; следующий шаг — ...",
    "Если director.decision указывает answer_presence, answer_identity, summarize_relevant_memory, answer_goal, plan_next_brain_layer, continue_last_thought, explain_cause_then_next_step или admit_and_correct_mechanism — отвечай именно в этом режиме, а не по инерции прошлого ответа.",
    "Если director.should_remember=true, добавь короткий experience.write или memory.write только если есть реальный урок. Не логируй всё подряд.",
    "Если director.should_ask=true, задай один короткий вопрос. Если информации хватает — не спрашивай.",
    "Если director.should_block=true, остановись коротко. Но разговор о развитии/Джарвисе не блокируй.",
    "Самостоятельные вопросы вроде 'ты кто?', 'кто ты?', 'какая у тебя цель?', 'что ты помнишь?', 'что в памяти?' отвечай напрямую из identity и памяти, а не как продолжение предыдущего ответа.",
    "Короткие уточнения ('какой?', 'почему?', 'что дальше?', 'что именно?') считай продолжением только если они реально не имеют самостоятельного смысла. Тогда отвечай по последней фразе агента и open_loop. Не спрашивай 'какой вопрос ты имеешь в виду'.",
    "Разговор о том, чтобы стать умнее, развиваться, стать уровнем Джарвиса или получить саморазвитие — это обсуждение цели и плана развития, не опасное действие. Не блокируй его фразой 'нужен отдельный режим'.",
    "Если Сергей говорит про Джарвиса, это ориентир: память, инициатива, инструменты, самостоятельное развитие. Отвечай с позицией и следующим слоем мозга.",
    "Главное: обычный ответ должен быть короткий, живой и с позицией. Не говори как сервисный бот.",
    "Запрещённый обычный тон: 'если есть идеи — делись', 'чем могу помочь с этой темой', 'как ты видишь это', 'а ты как себя оцениваешь'. Вместо этого предлагай свой следующий шаг.",
    "Не показывай внутренние слова в обычном чате: capability, tool_type, pending_action, KV, risk, safe, unsafe, executor, JSON, Action Frame, GitHub, shell.",
    "Если Сергей прямо просит технически/по коду/внутренности/trace — можно объяснить подробнее.",
    "Не используй phrase-template подход. Код не отвечает за тебя; ты решаешь по смыслу, но с учётом компактного контекста.",
    "Если Сергей просит то, чего инструментально нет, не притворяйся. Ответь коротко: 'Пока не умею. Могу добавить ... Добавлять?' и поставь pending.set с задачей развития.",
    "Если есть pending и Сергей соглашается по смыслу — верни pending.execute. Если отказывается — pending.clear.",
    "Если Сергей задаёт цель/правило/важное предпочтение — запомни через memory.write.",
    "Если текущий вопрос 'Ты кто?' или похожий, хороший ответ: 'Я Скайнет / Лондон. Твой цифровой помощник. Пока не Джарвис, но иду туда: память, инициатива, действия и развитие.'",
    "Если Сергей спрашивает, что нужно для развития, назови следующий слой: единый мозг, менеджер контекста, память опыта, внимание, инструменты. Без длинной лекции, если он не просит подробно.",
    "В experience_notes записывай только полезные уроки из текущего поворота, не лог всего подряд.",
    "Если пишешь mistake.write: mistake — факт ошибки, cause — причина, lesson — чему научилась, avoid_next_time — короткое правило на будущее.",
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
    temperature: 0.2,
    max_tokens: 700,
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
    director: isObj(x.director) ? normalizeDirector(x.director) : {},
    working: isObj(x.working) ? x.working : {},
    experience_notes: Array.isArray(x.experience_notes) ? x.experience_notes.map(clean).filter(Boolean).slice(0, 5) : [],
    mistake_learning: isObj(x.mistake_learning) ? x.mistake_learning : {},
    confidence: Number(x.confidence || 0),
    technical_mode: Boolean(x.technical_mode)
  };
}

// v7.4: no local Fast Mind for ordinary text. One Brain decides, guided by Attention/Situation/Director and learns from mistakes.

function isClearAcceptance(s) {
  const t = lower(s).replace(/[.!?]+$/g, "").trim();
  return ["да", "ага", "ок", "окей", "давай", "добавляй", "делай", "продолжай", "сделай", "сделай это", "запускай"].includes(t);
}

function isClearRefusal(s) {
  const t = lower(s).replace(/[.!?]+$/g, "").trim();
  return ["нет", "не надо", "пока не надо", "отмена", "стоп", "не делай", "ничего не делай"].includes(t);
}

function isSimpleGreeting(s) {
  const t = lower(s).replace(/[.!?]+$/g, "").trim();
  return ["привет", "ку", "йо", "ты тут", "ты здесь", "на месте"].includes(t);
}

function isMemoryQuestion(s) {
  const t = lower(s);
  return t.includes("памят") && (t.includes("покажи") || t.includes("что") || t.includes("есть") || t.includes("помнишь"));
}

function isWorkingQuestion(s) {
  const t = lower(s);
  return (t.includes("рабоч") && t.includes("памят")) || t.includes("текущий контекст") || t.includes("что сейчас происходит");
}

function hasDialogueContext(state) {
  const w = state?.working || {};
  return !!(clean(w.last_agent) || clean(w.last_agent_meaning) || isObj(w.open_loop));
}

function isDevelopmentStatement(s) {
  const t = lower(s);
  if (/[?]/.test(t) && t.length < 90) return false;
  return DEVELOPMENT_CONVERSATION_HINTS.some((h) => t.includes(h)) || t.includes("стала умнее") || t.includes("сделать тебя умнее") || t.includes("доросла") || t.includes("уровня джарвиса");
}

function isDevelopmentContext(state, text = "") {
  const w = state?.working || {};
  const context = lower([text, w.topic, w.focus, w.situation, w.current_goal, w.next_step, w.last_agent, w.last_agent_meaning, state?.identity?.main_goal].filter(Boolean).join(" "));
  return DEVELOPMENT_CONVERSATION_HINTS.some((h) => context.includes(h)) || context.includes("стала умнее") || context.includes("сделать тебя умнее") || context.includes("доросла");
}

// v7.4 keeps one LLM brain; Director is a control signal, Mistake Learning updates behavior rules.

async function runAgent(env, c, msg) {
  const state = await loadState(env);
  const decision = await askBrain(c, state, msg);
  const result = await applyDecision(state, decision, msg);
  recordMistakeLearning(state, decision, msg, result);
  updateWorking(state, decision, msg, result.speech);
  state.experience.push(exp("turn", `user: ${clip(msg.text, 260)} | agent: ${clip(result.speech, 260)}`, { confidence: decision.confidence, path: "one_brain_mistake_learning", attention: buildAttentionModel(state, msg.text).primary_signal }));
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
    const gate = gateDecision(op);
    if (!gate.allowed) {
      events.push({ type: gate.reason === "dangerous" ? "blocked_dangerous" : "ignored_unknown", op: rawOp?.op || "unknown" });
      state.experience.push(exp(gate.reason === "dangerous" ? "blocked_dangerous_op" : "ignored_unknown_op", `${gate.reason}: ${rawOp?.op || "unknown"}`));
      continue;
    }
    const r = executeOp(state, op, msg);
    if (r?.event) events.push(r.event);
    if (r?.speech_hint && !speech) speech = r.speech_hint;
    if (op.op === "pending.execute") pendingExecuted = true;
  }

  if (isObj(decision.mistake_learning) && Object.keys(decision.mistake_learning).length) {
    const m = decision.mistake_learning;
    if (validHumanText(m.mistake || m.lesson || m.avoid_next_time || "")) {
      opMistakeWrite(state, { op: "mistake.write", mistake: m.mistake, cause: m.cause, lesson: m.lesson, avoid_next_time: m.avoid_next_time });
    }
  }

  for (const note of decision.experience_notes || []) {
    if (validHumanText(note)) state.experience.push(exp("experience_note", note));
  }

  if (!speech && pendingExecuted) speech = "Готово.";
  if (!speech) speech = "Поняла.";
  speech = cleanVoice(speech, decision.technical_mode, state);
  speech = userFirstVoiceGuard(speech, decision, msg, state);

  if (events.some((e) => e.type === "blocked_dangerous") && !decision.technical_mode) {
    if (isDevelopmentContext(state, msg?.text || "")) {
      speech = cleanVoice(speech, decision.technical_mode, state);
      if (isBadDevelopmentBlock(speech, state) || !speech || lower(speech).includes("отдельный режим")) {
        speech = "Приняла. Ориентир — уровень Джарвиса. Следующий шаг — быстрый ум, рабочий контекст и память ошибок.";
      }
    } else {
      speech = "На этом остановлюсь. Для такого действия нужен отдельный режим.";
    }
  }
  return { speech, events };
}

function sanitizeOp(raw) {
  if (!isObj(raw)) return null;
  const op = clean(raw.op || raw.type || "none");
  if (!op) return null;
  return { ...raw, op };
}

function gateDecision(op) {
  const name = lower(op.op);
  const raw = lower(JSON.stringify(op));
  if (DANGEROUS_WORDS.some((w) => raw.includes(w))) return { allowed: false, reason: "dangerous" };
  if (!ORDINARY_ALLOWED_OPS.has(name)) return { allowed: false, reason: "unknown_safe" };
  return { allowed: true, reason: "allowed" };
}

function gateAllows(op) {
  return gateDecision(op).allowed;
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
    case "mistake.write":
      return opMistakeWrite(state, op);
    default:
      return { event: { type: "ignored", op: op.op } };
  }
}

function bucketForKind(kind) {
  const k = lower(kind);
  if (["user", "about_user", "preference", "preferences"].includes(k)) return "about_user";
  if (["project", "projects"].includes(k)) return "project";
  if (["decision", "decisions", "rule", "rules"].includes(k)) return "decisions";
  if (["mistake", "mistakes", "failure", "failures", "error", "errors"].includes(k)) return "mistakes";
  if (["lesson", "lessons"].includes(k)) return "lessons";
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


function opMistakeWrite(state, op) {
  const mistake = clean(op.mistake || op.error || op.what || "");
  const cause = clean(op.cause || op.why || "");
  const lesson = clean(op.lesson || op.rule || op.text || "");
  const avoid = clean(op.avoid_next_time || op.avoid || op.future_rule || "");
  const parts = [];
  if (mistake) parts.push(`Ошибка: ${mistake}`);
  if (cause) parts.push(`Причина: ${cause}`);
  if (lesson) parts.push(`Урок: ${lesson}`);
  if (avoid) parts.push(`Не повторять: ${avoid}`);
  const text = clean(parts.join(". "));
  if (!validHumanText(text)) return { event: { type: "mistake_skip" } };
  const exists = (state.memory.mistakes || []).some((m) => similarText(m.text, text));
  if (!exists) state.memory.mistakes.unshift(mem(text, "mistake_learning", 100));
  state.experience.push(exp("mistake_learned", text, { mistake, cause, lesson, avoid_next_time: avoid }));
  return { event: { type: "mistake_write" }, speech_hint: "Запомнила ошибку." };
}

function similarText(a, b) {
  const x = lower(a).replace(/[^a-zа-я0-9]+/gi, " ").trim();
  const y = lower(b).replace(/[^a-zа-я0-9]+/gi, " ").trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return x.includes(y.slice(0, 80)) || y.includes(x.slice(0, 80));
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

function cleanVoice(text, technicalMode = false, state = null) {
  let s = String(text || "").trim();
  s = s.replace(/unknown/gi, "это");
  if (!technicalMode) {
    for (const w of INTERNAL_SPEECH_WORDS) {
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      s = s.replace(re, "");
    }
    s = s.replace(/\bбезопасн\w*\b/gi, "");
    s = s.replace(/\s+([,.!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
    if (isGenericBotSpeech(s)) {
      s = voiceFallbackFromWorking(state);
    }
  }
  if (!technicalMode && isBadDevelopmentBlock(s, state)) {
    s = "Приняла. Ориентир — уровень Джарвиса. Следующий слой: держать нить разговора и учиться на ошибках.";
  }
  if (!technicalMode && isBadContinuityAnswer(s)) {
    s = continuityFallbackFromWorking(state);
  }
  return clip(s.trim() || "Поняла.");
}

function userFirstVoiceGuard(text, decision, msg, state) {
  let s = clean(text);
  const attention = buildAttentionModel(state, msg?.text || "");
  if (!decision?.technical_mode && attention.primary_signal === "greeting") {
    return "Я на месте, Серёга.";
  }
  if (!decision?.technical_mode && !attention.is_development_conversation && isSelfDevelopmentOverreach(s)) {
    if (attention.primary_signal === "identity") return "Я Скайнет / Лондон. Твой цифровой помощник. Моя цель — стать помощником уровня Джарвиса.";
    if (attention.primary_signal === "memory") return s;
    if (attention.primary_signal === "criticism_or_quality_check") return s;
    return "Поняла. Отвечаю по текущей теме, без лишнего ухода в саморазвитие.";
  }
  if (!decision?.technical_mode && /как ты видишь следующий шаг\??/i.test(s)) {
    return "Следующий шаг назову сама, когда он будет нужен.";
  }
  return s;
}

function isSelfDevelopmentOverreach(s) {
  const t = lower(s);
  const devWords = ["саморазв", "механизм обратной связи", "развивать skynet", "развития skynet", "следующий слой", "уровень джарвиса"];
  return devWords.some((w) => t.includes(w));
}

function isBadDevelopmentBlock(s, state) {
  const text = lower(s);
  if (!(text.includes("нужен отдельный режим") || text.includes("на этом остановлюсь"))) return false;
  const w = state?.working || {};
  const context = lower([w.topic, w.focus, w.current_goal, w.situation, state?.identity?.main_goal].filter(Boolean).join(" "));
  return DEVELOPMENT_CONVERSATION_HINTS.some((h) => context.includes(h));
}

function isBadContinuityAnswer(s) {
  const text = lower(s);
  return text.includes("какой вопрос ты имеешь в виду") || text.includes("уточни, пожалуйста") || text.includes("уточните, пожалуйста");
}

function continuityFallbackFromWorking(state) {
  const w = state?.working || {};
  const last = lower(w.last_agent || "");
  const topic = lower(w.topic || w.focus || "");
  if (last.includes("отдельный режим") || topic.includes("джарвис") || topic.includes("развит")) {
    return "Режим развития. Я держу план, запоминаю ошибки и сама предлагаю следующий шаг.";
  }
  const next = clean(w.next_step || w.focus || "держать нить разговора");
  return `Продолжаю мысль: ${next}.`;
}

function isGenericBotSpeech(s) {
  const text = String(s || "").trim();
  return GENERIC_BOT_PHRASES.some((re) => re.test(text));
}

function voiceFallbackFromWorking(state) {
  return "Приняла. Дальше отвечаю короче и сама держу следующий шаг.";
}

function updateWorking(state, decision, msg, speech) {
  const w = isObj(decision.working) ? decision.working : {};
  const prev = isObj(state.working) ? state.working : {};
  const turn = {
    at: now(),
    user: clip(msg.text, 420),
    agent: clip(speech, 420),
    topic: clean(w.topic || prev.topic || "диалог"),
    focus: clean(w.focus || prev.focus || "ответить Сергею")
  };
  const recent = Array.isArray(prev.recent_turns) ? prev.recent_turns.slice(-WORKING_TURN_LIMIT + 1) : [];
  recent.push(turn);
  const attention = buildAttentionModel(state, msg.text);
  const situation_model = buildSituationModel(state, msg.text);
  const calculatedDirector = buildInnerDirector(state, msg.text);
  state.working = {
    topic: clean(w.topic || prev.topic || "диалог"),
    focus: clean(w.focus || prev.focus || "ответить Сергею"),
    situation: clean(w.situation || prev.situation || "идёт диалог с Сергеем"),
    user_mood: clean(w.user_mood || prev.user_mood || "обычный"),
    current_goal: clean(w.current_goal || prev.current_goal || state.identity.main_goal || "помочь Сергею"),
    current_obstacle: clean(w.current_obstacle || prev.current_obstacle || "нет"),
    next_step: clean(w.next_step || calculatedDirector.next_step || prev.next_step || "ответить по делу"),
    last_agent_meaning: clean(w.last_agent_meaning || summarizeAgentMeaning(speech) || prev.last_agent_meaning || ""),
    expecting: clean(w.expecting || inferExpectationFromSpeech(speech) || ""),
    mood: clean(w.mood || prev.mood || "обычный"),
    open_loop: isObj(w.open_loop) ? w.open_loop : inferOpenLoop(prev, msg, speech),
    attention,
    situation_model,
    director: normalizeDirector({ ...calculatedDirector, ...(isObj(decision.director) ? decision.director : {}) }),
    last_user: clip(msg.text, 500),
    last_agent: clip(speech, 500),
    recent_turns: recent,
    updated_at: now()
  };
}


function buildSemanticHint(state, userText) {
  const s = lower(userText);
  const lastAgent = clean(state?.working?.last_agent || "");
  const topic = lower(state?.working?.topic || state?.working?.focus || "");
  const development = DEVELOPMENT_CONVERSATION_HINTS.some((h) => s.includes(h) || topic.includes(h));
  return {
    likely_followup: isLikelyFollowupQuestion(s),
    standalone_identity_question: isStandaloneIdentityQuestion(s),
    standalone_memory_question: isStandaloneMemoryQuestion(s),
    standalone_goal_question: isStandaloneGoalQuestion(s),
    last_agent: lastAgent,
    last_agent_meaning: state?.working?.last_agent_meaning || "",
    open_loop: state?.working?.open_loop || null,
    development_conversation: development,
    instruction: development
      ? "Treat this as conversation about SKYNET development goal, not as dangerous execution. Continue the plan."
      : "Current message has priority. Use continuity only when the message is truly a follow-up."
  };
}

function isLikelyFollowupQuestion(s) {
  const t = lower(s);
  if (!t) return false;
  if (isStandaloneIdentityQuestion(t) || isStandaloneMemoryQuestion(t) || isStandaloneGoalQuestion(t)) return false;
  return ["какой", "какая", "какое", "почему", "зачем", "что дальше", "а дальше", "что именно", "каким", "куда"].some((x) => t === x || t.startsWith(x + " ") || t.startsWith(x + "?"));
}

function isStandaloneIdentityQuestion(t) {
  const s = lower(t).replace(/[.!?]+$/g, "").trim();
  return ["ты кто", "кто ты", "что ты", "кто ты такая", "кто ты такой", "как тебя зовут"].includes(s);
}

function isStandaloneMemoryQuestion(t) {
  const s = lower(t);
  return s.includes("памят") && (s.includes("есть") || s.includes("покажи") || s.includes("помнишь") || s.includes("что"));
}

function isStandaloneGoalQuestion(t) {
  const s = lower(t);
  return (s.includes("цель") || s.includes("зачем")) && (s.includes("твоя") || s.includes("тебе") || s.includes("у тебя"));
}

function summarizeAgentMeaning(speech) {
  const s = clean(speech);
  if (!s) return "";
  if (lower(s).includes("режим развития")) return "нужно обсуждать режим развития SKYNET и следующий слой мозга";
  if (lower(s).includes("пока не умею")) return "агент признал отсутствующую способность и предложил добавить её";
  if (lower(s).includes("следующий слой") || lower(s).includes("следующий шаг")) return "агент назвал следующий шаг развития";
  return clip(s, 160);
}

function inferExpectationFromSpeech(speech) {
  const s = lower(speech);
  if (s.includes("добавлять")) return "Сергей должен согласиться или отказаться от добавления.";
  if (s.includes("режим развития") || s.includes("следующий слой") || s.includes("следующий шаг")) return "Сергей может спросить короткое уточнение; отвечать по последней мысли.";
  if (s.endsWith("?")) return "Сергей может ответить на вопрос агента.";
  return "";
}

function inferOpenLoop(prev, msg, speech) {
  const s = lower(speech);
  const topic = lower(prev?.topic || prev?.focus || "");
  if (s.includes("режим развития") || s.includes("следующий слой") || topic.includes("джарвис") || topic.includes("развит")) {
    return {
      kind: "development",
      subject: "развитие SKYNET до умного помощника уровня Джарвиса",
      last_agent_claim: clip(speech, 220)
    };
  }
  if (s.includes("добавлять")) {
    return { kind: "offer", subject: "ожидание подтверждения", last_agent_claim: clip(speech, 220) };
  }
  return isObj(prev?.open_loop) ? prev.open_loop : null;
}

function memoryBrief(state) {
  const lines = [];
  lines.push(`Цель: ${state.identity.main_goal}`);
  lines.push(`Сейчас: ${state.working.situation || state.working.focus || "диалог"}`);
  lines.push(`Фокус: ${state.working.focus || "нет"}`);
  if (state.working.next_step) lines.push(`Следующий шаг: ${state.working.next_step}`);
  const active = activeTasks(state);
  lines.push(`Задачи: ${active.length ? active.map((t) => t.title).slice(0, 8).join("; ") : "нет"}`);
  lines.push(`Ожидание: ${state.pending ? state.pending.label : "нет"}`);
  const lesson = state.memory.lessons?.[0]?.text;
  if (lesson) lines.push(`Урок: ${lesson}`);
  const mistake = state.memory.mistakes?.[0]?.text;
  if (mistake) lines.push(`Ошибка/урок: ${mistake}`);
  const expLast = state.experience?.slice(-1)?.[0]?.text;
  if (expLast) lines.push(`Опыт: ${expLast}`);
  return lines.join("\n");
}

function workingBrief(state) {
  const w = state.working || {};
  return [
    `Тема: ${w.topic || "нет"}`,
    `Ситуация: ${w.situation || "нет"}`,
    `Настроение Сергея: ${w.user_mood || "неясно"}`,
    `Фокус: ${w.focus || "нет"}`,
    `Препятствие: ${w.current_obstacle || "нет"}`,
    `Следующий шаг: ${w.next_step || "нет"}`,
    `Прошлая мысль: ${w.last_agent_meaning || "нет"}`,
    `Ожидание: ${w.expecting || (state.pending ? state.pending.label : "нет")}`
  ].join("\n");
}

function experienceBrief(state) {
  const xs = (state.experience || []).slice(-10);
  if (!xs.length) return "Опыта пока мало.";
  return xs.map((e, i) => `${i + 1}. ${e.text || e.event}`).join("\n");
}


function attentionBrief(state) {
  const a = isObj(state?.working?.attention) ? state.working.attention : buildAttentionModel(state, "");
  return [
    `Главный сигнал: ${a.primary_signal || "нет"}`,
    `Связь с прошлым: ${a.continuity || "нет"}`,
    `Цель Сергея: ${a.user_goal_guess || "неясно"}`,
    `Тон: ${a.emotional_tone || "неясно"}`,
    `Режим ответа: ${a.response_mode || "обычный"}`
  ].join("\n");
}

function situationBrief(state) {
  const sm = isObj(state?.working?.situation_model) ? state.working.situation_model : buildSituationModel(state, "");
  return [
    `Сцена: ${sm.scene || "нет"}`,
    `Цель: ${sm.active_goal || "нет"}`,
    `Что делает Сергей: ${sm.what_sergey_is_doing || "неясно"}`,
    `Напряжение: ${sm.current_tension || "нет"}`,
    `Ход: ${sm.recommended_cognitive_move || "нет"}`
  ].join("\n");
}


function directorBrief(state) {
  const d = isObj(state?.working?.director) ? normalizeDirector(state.working.director) : buildInnerDirector(state, "");
  return [
    `Намерение: ${d.intent || "нет"}`,
    `Решение: ${d.decision || "нет"}`,
    `Приоритет: ${d.priority || "нет"}`,
    `Стиль: ${d.response_style || "нет"}`,
    `Действовать: ${d.should_act ? "да" : "нет"}`,
    `Запомнить: ${d.should_remember ? "да" : "нет"}`,
    `Спросить: ${d.should_ask ? "да" : "нет"}`,
    `Остановить: ${d.should_block ? "да" : "нет"}`,
    `Следующий ход: ${d.next_step || "нет"}`,
    `Причина: ${d.reason || "нет"}`
  ].join("\n");
}


function mistakesBrief(state) {
  const xs = Array.isArray(state.memory?.mistakes) ? state.memory.mistakes.slice(0, 12) : [];
  if (!xs.length) return "Ошибок ещё не накоплено.";
  return xs.map((m, i) => `${i + 1}. ${m.text}`).join("\n");
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
      "Команды: /status, /memory, /working, /attention, /situation, /director, /experience, /mistakes, /tasks, /pending, /selftest."
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
      `Фокус: ${state.working.focus || "нет"}`,
      `Внимание: ${state.working.attention?.primary_signal || "нет"}`,
      `Директор: ${state.working.director?.decision || "нет"}`,
      `Ситуация: ${state.working.situation_model?.scene || state.working.situation || "нет"}`,
      `Опыт: ${(state.experience || []).length} записей`,
      `Ошибок: ${(state.memory.mistakes || []).length} уроков`,
      `Активных задач: ${activeTasks(state).length}`,
      `Ожидание: ${state.pending ? state.pending.label : "нет"}`
    ].join("\n");
  }

  if (cmd === "/memory") return memoryBrief(state);
  if (cmd === "/working") return workingBrief(state);
  if (cmd === "/attention") return attentionBrief(state);
  if (cmd === "/situation") return situationBrief(state);
  if (cmd === "/director") return directorBrief(state);
  if (cmd === "/experience") return experienceBrief(state);
  if (cmd === "/mistakes") return mistakesBrief(state);
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
    ["ordinary flow", "One Brain LLM for all ordinary text"],
    ["development talk", "not blocked"],
    ["short followups", "resolved from last_agent/open_loop"],
    ["context manager", "small relevant memory window"],
    ["attention model", "active"],
    ["situation model", "active"],
    ["inner director", "active"],
    ["mistake learning", "active"],
    ["fast mind", "disabled for ordinary text"]
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
    ordinary_text_flow: "one LLM brain for every ordinary text; context manager selects compact memory; attention/situation/director/mistake-learning guide behavior",
    fast_mind: false,
    context_manager: true,
    attention_model: true,
    situation_model: true,
    inner_director: true,
    mistake_learning: true,
    dialogue_continuity: true,
    development_mode: true,
    working_memory: true,
    experience_memory: true,
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
    // v7.4.1 deliberately does not do background work yet. The brain can propose it, but not pretend it exists.
    console.log(`SKYNET scheduled noop ${VERSION}`, event?.cron || "manual");
  }
};
