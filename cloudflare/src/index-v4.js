// MiniSkynet / Jarvis Core v1.2 — Proactive Pulse. 2026-07-07.
// ФИЛОСОФИЯ: один мозг, одна память, два входа:
//   1) Сергей пишет в Telegram
//   2) Скайнет сама просыпается по scheduled tick
// Оба входа идут через один и тот же runBrain(), тот же SYSTEM, тот же state.
// Никакого отдельного "proactive brain". Самостоятельные сообщения — это тот же Скайнет,
// просто событие не user_message, а scheduled_tick.

const VERSION = "jarvis-core-v1.3.5-hands-github-access-2026-07-07";
const H = { "content-type": "application/json; charset=utf-8" };

const DEFAULT_GITHUB_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_GITHUB_BRANCH = "main";

const MEMORY_LIMIT = 160;
const TASK_LIMIT = 160;
const GOAL_LIMIT = 40;
const BELIEF_LIMIT = 80;
const DECISION_LOG_LIMIT = 60;
const DIALOGUE_LIMIT = 24;
const PROMPT_MEMORY_LIMIT = 7;
const PROMPT_DIALOGUE_LIMIT = 10;
const LOOP_WINDOW = 3;
const MAX_TG = 3900;

const DEFAULT_SELF_MODEL = {
  name: "Скайнет",
  role: "личный Джарвис Сергея",
  goal: "становиться умнее, полезнее и самостоятельнее для Сергея",
  style: "живой русский, коротко по простому, с характером, без ботских хвостов"
};

const DEFAULT_PROACTIVE = {
  enabled: false,
  mode: "important_only",
  min_gap_minutes: 180,
  max_per_day: 3,
  last_sent_at: "",
  sent_day: "",
  sent_count: 0
};

const DEFAULT_THINKING = {
  focus: "MiniSkynet Core",
  mood: "stable",
  current_goal_id: "",
  last_situation: "",
  last_decision: "",
  last_reflection_at: "",
  confidence: 0
};

const DEFAULT_BELIEFS = {
  facts: [],
  rules: [],
  assumptions: [],
  unknowns: []
};

const DEFAULT_HANDS = {
  level: "v0_1_readonly",
  mode: "read_only",
  can_read_state: true,
  can_answer: true,
  can_remember: true,
  can_manage_goals: true,
  can_send_proactive: true,
  can_read_repo: false,
  can_read_project_tree: false,
  can_read_project_files: false,
  can_write_files: false,
  can_deploy: false,
  can_self_modify: false,
  last_action: "",
  last_action_at: "",
  last_error: ""
};

const HANDS_LOG_LIMIT = 40;
const HANDS_FILE_MAX_CHARS = 3200;
const HANDS_TREE_MAX_ITEMS = 40;
const HANDS_BLOCKED_PATH = /(^|\/)(\.env|env\.|secrets?|tokens?|credentials?|private|id_rsa|wrangler\.toml|package-lock\.json)$/i;
const HANDS_ALLOWED_TEXT = /\.(js|mjs|cjs|json|md|txt|ts|tsx|jsx|yml|yaml|toml|css|html)$/i;

// ============================================================ CONFIG
const CFG_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID", "OWNER_ID",
  "TELEGRAM_CHAT_ID", "TELEGRAM_OWNER_CHAT_ID",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_MODEL_CHEAP", "WORKER_URL",
  "GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_OWNER", "GITHUB_BRANCH"
];

async function cfg(env) {
  const c = {};
  for (const k of CFG_KEYS) c[k] = env[k] ? String(env[k]).trim() : "";
  if (env.MINISKYNET_KV) {
    const miss = CFG_KEYS.filter(k => !c[k]);
    const vals = await Promise.all(miss.map(k => env.MINISKYNET_KV.get("config:" + k)));
    miss.forEach((k, i) => { if (vals[i]) c[k] = String(vals[i]).trim(); });
  }
  return {
    kv: env.MINISKYNET_KV,
    telegram: c.TELEGRAM_BOT_TOKEN,
    owner: c.TELEGRAM_ALLOWED_USER_ID || c.OWNER_ID,
    chatId: c.TELEGRAM_OWNER_CHAT_ID || c.TELEGRAM_CHAT_ID || "",
    openrouter: c.OPENROUTER_API_KEY,
    model: c.OPENROUTER_MODEL || c.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
    githubToken: c.GITHUB_TOKEN,
    githubRepo: c.GITHUB_REPO || DEFAULT_GITHUB_REPO,
    githubOwner: c.GITHUB_OWNER || "",
    githubBranch: c.GITHUB_BRANCH || DEFAULT_GITHUB_BRANCH
  };
}

// ============================================================ KV / STATE
const now = () => new Date().toISOString();
const dayKey = () => new Date().toISOString().slice(0, 10);
const minutesSince = (iso) => iso ? Math.floor((Date.now() - Date.parse(iso)) / 60000) : 999999;

async function loadState(env) {
  const raw = await env.MINISKYNET_KV.get("brain:healthy:state");
  if (raw) { try { return normalize(JSON.parse(raw)); } catch {} }
  const old = await env.MINISKYNET_KV.get("brain:v7:state");
  if (old) { try { const s = JSON.parse(old); return normalize({ memory: s.memory, tasks: s.tasks }); } catch {} }
  return normalize({});
}

function normalize(s) {
  s = s || {};
  s.self_model = { ...DEFAULT_SELF_MODEL, ...(s.self_model || {}) };
  s.memory = normalizeMemoryEntries(Array.isArray(s.memory) ? s.memory : []).slice(-MEMORY_LIMIT);
  s.tasks = Array.isArray(s.tasks) ? s.tasks.slice(-TASK_LIMIT) : [];
  s.dialogue = Array.isArray(s.dialogue) ? s.dialogue.slice(-DIALOGUE_LIMIT) : [];
  s.mistakes = normalizeMistakes(Array.isArray(s.mistakes) ? s.mistakes : []).slice(-80);
  s.open_questions = Array.isArray(s.open_questions) ? s.open_questions.slice(-30) : [];
  s.proactive = { ...DEFAULT_PROACTIVE, ...(s.proactive || {}) };
  s.thinking = { ...DEFAULT_THINKING, ...(s.thinking || {}) };
  s.goals = Array.isArray(s.goals) ? s.goals.slice(-GOAL_LIMIT) : [];
  s.beliefs = { ...DEFAULT_BELIEFS, ...(s.beliefs || {}) };
  s.beliefs.facts = normalizeBeliefEntries(Array.isArray(s.beliefs.facts) ? s.beliefs.facts : [], "facts").slice(-BELIEF_LIMIT);
  s.beliefs.rules = normalizeBeliefEntries(Array.isArray(s.beliefs.rules) ? s.beliefs.rules : [], "rules").slice(-BELIEF_LIMIT);
  s.beliefs.assumptions = normalizeBeliefEntries(Array.isArray(s.beliefs.assumptions) ? s.beliefs.assumptions : [], "assumptions").slice(-BELIEF_LIMIT);
  s.beliefs.unknowns = normalizeBeliefEntries(Array.isArray(s.beliefs.unknowns) ? s.beliefs.unknowns : [], "unknowns").slice(-BELIEF_LIMIT);
  s.hands = { ...DEFAULT_HANDS, ...(s.hands || {}) };
  s.hands.level = "v0_1_readonly";
  s.hands.mode = "read_only";
  s.hands.can_write_files = false;
  s.hands.can_deploy = false;
  s.hands.can_self_modify = false;
  s.hands_log = Array.isArray(s.hands_log) ? s.hands_log.slice(-HANDS_LOG_LIMIT) : [];
  // Миграция старых записей: правила могли раньше попасть в facts, а facts могли быть только в memory.
  for (const m of s.memory) {
    const txt = m.text || m.lesson || "";
    if (isMemoryRule(txt)) addBelief(s, "rules", txt, m.score || 85, "memory_migration");
    else addBelief(s, "facts", txt, m.score || 70, "memory_migration");
  }
  s.beliefs.facts = s.beliefs.facts.filter(x => !isMemoryRule(x.text || x)).slice(-BELIEF_LIMIT);
  s.decision_log = Array.isArray(s.decision_log) ? s.decision_log.slice(-DECISION_LOG_LIMIT) : [];
  s.ownerChatId = s.ownerChatId || "";
  s.ownerUserId = s.ownerUserId || "";
  return s;
}

async function saveState(env, s) {
  await env.MINISKYNET_KV.put("brain:healthy:state", JSON.stringify(normalize(s)));
}

// ============================================================ TELEGRAM
async function tg(c, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${c.telegram}/${method}`,
    { method: "POST", headers: H, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}

async function send(c, chatId, text) {
  if (!chatId || !text) return;
  const s = String(text);
  for (let i = 0; i < s.length; i += MAX_TG) {
    await tg(c, "sendMessage", { chat_id: chatId, text: s.slice(i, i + MAX_TG) });
  }
}

function parseUpdate(u) {
  const m = u?.message || u?.edited_message;
  if (!m) return null;
  return { chatId: m.chat?.id, userId: m.from?.id, text: String(m.text || "").trim() };
}

// ============================================================ MODEL
async function ask(c, system, messages, maxTokens = 700) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + c.openrouter },
    body: JSON.stringify({
      model: c.model,
      max_tokens: maxTokens,
      temperature: 0.55,
      messages: [{ role: "system", content: system }, ...messages]
    })
  });
  if (!r.ok) return { error: `OpenRouter ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}` };
  const d = await r.json();
  return { text: (d?.choices?.[0]?.message?.content || "").trim() };
}

function parseJsonLoose(t) {
  try { return JSON.parse(t); } catch {}
  const a = String(t || "").indexOf("{"), b = String(t || "").lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(String(t).slice(a, b + 1)); } catch {} }
  return null;
}


// ============================================================ MEMORY TRUST v1.1
function stripMemoryShell(text) {
  let s = String(text || "").trim().replace(/\s+/g, " ");
  const isQ = ch => /["'«»“”]/.test(ch || "");
  if (s.length >= 2 && isQ(s[0]) && isQ(s[s.length - 1])) s = s.slice(1, -1).trim();
  else if (isQ(s[0])) s = s.slice(1).trim();
  return s.replace(/[.。]+$/, "").trim();
}

function isMemoryRule(text) {
  return /^(правило|установка|принцип)\b/i.test(stripMemoryShell(text)) || /памят.*должн.*честн/i.test(stripMemoryShell(text));
}

function normalizeMemoryFact(text) {
  let a = stripMemoryShell(text);
  let m = a.match(/^мой\s+главн\S*\s+проект\s+(?:сейчас\s+)?[:—-]?\s*(.+)$/i);
  if (m) return "главный проект Сергея: " + stripMemoryShell(m[1]).slice(0, 240);
  m = a.match(/^главн\S*\s+проект\s+сергея\s*(?:сейчас\s*)?[:—-]?\s*(.+)$/i);
  if (m) return "главный проект Сергея: " + stripMemoryShell(m[1]).slice(0, 240);
  m = a.match(/^мой\s+проект\s+(?:сейчас\s+)?[:—-]?\s*(.+)$/i);
  if (m) return "проект Сергея: " + stripMemoryShell(m[1]).slice(0, 240);
  m = a.match(/^у\s+меня\s+(.+)$/i);
  if (m) return "у Сергея " + stripMemoryShell(m[1]).slice(0, 300);
  m = a.match(/^мне\s+(.+)$/i);
  if (m) return "Сергею " + stripMemoryShell(m[1]).slice(0, 300);
  m = a.match(/^я\s+хочу\s+(.+)$/i);
  if (m) return "Сергей хочет " + stripMemoryShell(m[1]).slice(0, 300);
  m = a.match(/^я\s+люблю\s+(.+)$/i);
  if (m) return "Сергей любит " + stripMemoryShell(m[1]).slice(0, 300);
  m = a.match(/^меня\s+зовут\s+(.+)$/i);
  if (m) return "Сергея зовут " + stripMemoryShell(m[1]).slice(0, 120);
  return a;
}

function memoryKey(text) {
  return normalizeMemoryFact(text)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\b(сейчас|теперь|именно|это)\b/gi, "")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMemoryEntries(entries) {
  const out = [];
  const seen = new Set();
  for (const item of entries) {
    const src = item && typeof item === "object" ? item : { text: item };
    const text = normalizeMemoryFact(src.text || src.lesson || "");
    if (!text || /пароль|токен|token|secret|sk-/i.test(text)) continue;
    const key = memoryKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...src, text, score: Number(src.score || 70) || 70, t: src.t || now() });
  }
  return out;
}

function normalizeBeliefEntries(entries, kind = "facts") {
  const out = [];
  const seen = new Set();
  for (const item of entries) {
    const src = item && typeof item === "object" ? item : { text: item };
    let text = normalizeMemoryFact(src.text || "");
    if (!text) continue;
    if (kind === "facts" && isMemoryRule(text)) continue;
    const key = memoryKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...src, text, confidence: Math.max(0, Math.min(100, Number(src.confidence || src.score || 70) || 70)), source: src.source || "normalized", t: src.t || now() });
  }
  return out;
}

function normalizeMistakes(entries) {
  const out = [];
  const seen = new Set();
  for (const item of entries) {
    const src = item && typeof item === "object" ? item : { what: item };
    const text = shortText(src.what || src.lesson || "", 220);
    if (!text) continue;
    const key = normalizeForCompare(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...src, what: text, when: src.when || src.t || now() });
  }
  return out;
}

function memoryListLines(items, empty = "нет") {
  const arr = Array.isArray(items) ? items : [];
  return arr.length ? arr.map((x, i) => `${i + 1}. ${x.text || x.lesson || x}`).join("\n") : empty;
}

// ============================================================ MEMORY RECALL
function pickMemory(memory, queryText, limit = PROMPT_MEMORY_LIMIT) {
  const words = new Set(String(queryText || "").toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(w => w.length > 3));
  const scored = memory.map((m, i) => {
    const text = String(m.text || m.lesson || "").toLowerCase();
    let overlap = 0; for (const w of words) if (text.includes(w)) overlap++;
    return { m, i, rank: overlap * 5 + (m.score || 50) / 25 };
  });
  return scored.sort((a, b) => b.rank - a.rank || b.i - a.i).slice(0, limit).map(s => s.m);
}

// ============================================================ LOOP DETECTOR
function normalizeForCompare(s) {
  return String(s || "").toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, "").replace(/\s+/g, " ").trim();
}
function similarity(a, b) {
  a = normalizeForCompare(a); b = normalizeForCompare(b);
  if (!a || !b) return 0;
  const wa = new Set(a.split(" ")), wb = new Set(b.split(" "));
  let common = 0; for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}
function isLooping(dialogue, candidateReply) {
  const botTurns = dialogue.filter(d => d.role === "bot").slice(-LOOP_WINDOW);
  return botTurns.some(t => similarity(t.text, candidateReply) > 0.7);
}

// ============================================================ THINKING CORE v1
function shortText(v, n = 220) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function classifyIntent(text, eventType = "user_message") {
  const low = String(text || "").toLowerCase();
  if (eventType === "scheduled_tick") return "internal_pulse";
  if (/^(привет|здаров|ку|hi|hello)\b/i.test(low)) return "small_talk";
  if (/запомни|помни|сохрани|зафиксируй/i.test(low)) return "memory_request";
  if (/задач|сделай|делай|почини|добавь|создай|напиши код|патч/i.test(low)) return "action_request";
  if (/ошиб|не так|неправильно|вр[её]шь|сломал|сломалась|не работает/i.test(low)) return "correction_or_problem";
  if (/пиши чаще|чаще|раз в час|каждый час/i.test(low)) return "proactive_config";
  if (/выключи.*сообщ|не пиши сам|молчи/i.test(low)) return "proactive_disable";
  if (/^(\/)?(read_project|repo_status|read_self_file|show_current_code_version|action_log|rollback_info)\b/i.test(low) || /прочитай проект|покажи проект|проверь github|статус github|прочитай файл|покажи файл|прочитай себя|покажи код|журнал действий|action log|rollback/i.test(low)) return "hands_read";
  if (/что ты умеешь|что умеешь|покажи структуру|видишь.*структур|какая.*структур|какие.*руки|покажи руки|hand_status|руки/i.test(low)) return "self_structure";
  if (/как|почему|что думаешь|зачем|какие проблемы|мышлен/i.test(low)) return "analysis_question";
  return "conversation";
}

function activeGoals(state) {
  return (state.goals || []).filter(g => g.status !== "done").slice(-5);
}

function ensureGoal(state, title, priority = 70, nextStep = "") {
  const t = shortText(title, 180);
  if (!t) return null;
  let g = (state.goals || []).find(x => x.status !== "done" && similarity(x.title, t) > 0.75);
  if (!g) {
    g = { id: "g" + Math.random().toString(36).slice(2, 7), title: t, status: "active", priority, next_step: shortText(nextStep, 180), t: now() };
    state.goals.push(g);
  } else {
    g.priority = Math.max(g.priority || 0, priority);
    if (nextStep) g.next_step = shortText(nextStep, 180);
  }
  return g;
}

function addBelief(state, kind, text, confidence = 70, source = "system") {
  const k = ["facts", "rules", "assumptions", "unknowns"].includes(kind) ? kind : "assumptions";
  const a = normalizeMemoryFact(shortText(text, 260));
  if (!a) return false;
  const arr = state.beliefs[k];
  if (!arr.some(x => memoryKey(x.text || x) === memoryKey(a) || similarity(x.text || x, a) > 0.82)) {
    arr.push({ text: a, confidence, source, t: now() });
    state.beliefs[k] = arr.slice(-BELIEF_LIMIT);
    return true;
  }
  return false;
}

function thinkBeforeAct(state, eventText, opts = {}) {
  const eventType = opts.eventType || "user_message";
  const intent = classifyIntent(eventText, eventType);
  const open = state.tasks.filter(t => t.status !== "done");
  const goals = activeGoals(state);
  const situation = eventType === "scheduled_tick"
    ? "внутренний пульс без нового сообщения Сергея"
    : `Сергей пишет: ${shortText(eventText, 140)}`;

  let goal = "ответить по делу и не выдумывать";
  let action = "answer";
  let confidence = 70;
  let nextStep = "";

  if (intent === "internal_pulse") {
    goal = open.length ? "проверить открытые задачи и дать короткий полезный следующий шаг" : "молчать, если нет реальной пользы";
    action = open.length ? "maybe_proactive" : "silent_if_empty";
    confidence = open.length ? 68 : 84;
  } else if (intent === "correction_or_problem") {
    goal = "признать проблему, понять причину, предложить конкретное исправление";
    action = "diagnose";
    confidence = 80;
  } else if (intent === "action_request") {
    goal = "выполнить конкретное действие или дать готовый патч";
    action = "execute_or_plan";
    confidence = 78;
    nextStep = "сделать минимальное безопасное изменение";
  } else if (intent === "analysis_question") {
    goal = "дать честный анализ и следующий инженерный шаг";
    action = "analyze";
    confidence = 76;
  } else if (intent === "memory_request") {
    goal = "сохранить важный факт без мусора и секретов";
    action = "remember";
    confidence = 82;
  } else if (intent === "proactive_config" || intent === "proactive_disable") {
    goal = "настроить самостоятельные сообщения так, чтобы поведение совпадало со словами";
    action = "configure_proactive";
    confidence = 86;
  } else if (intent === "hands_read") {
    goal = "использовать только read-only руки и честно показать, что реально видно";
    action = "hands_readonly_report";
    confidence = 92;
    nextStep = "не менять файлы, не деплоить, не обещать self-modify";
  } else if (intent === "self_structure") {
    goal = "честно показать свою рабочую структуру и ограничения";
    action = "report_capabilities";
    confidence = 94;
    nextStep = "не обещать рук, которых ещё нет";
  }

  const currentGoal = goals[goals.length - 1] || null;
  return {
    event_type: eventType,
    intent,
    situation,
    goal,
    suggested_action: action,
    current_goal: currentGoal ? currentGoal.title : "",
    open_tasks: open.length,
    confidence,
    next_step: nextStep
  };
}

function normalizeThought(thought, fallback = {}) {
  const t = thought && typeof thought === "object" ? thought : {};
  return {
    situation: shortText(t.situation || fallback.situation, 220),
    goal: shortText(t.goal || fallback.goal, 180),
    decision: shortText(t.decision || t.chosen_action || fallback.suggested_action, 180),
    confidence: Math.max(0, Math.min(100, Number(t.confidence || fallback.confidence || 0) || 0)),
    memory_use: Array.isArray(t.memory_use) ? t.memory_use.slice(0, 5).map(x => shortText(x, 120)) : [],
    next_step: shortText(t.next_step || fallback.next_step, 180),
    should_remember: !!t.should_remember
  };
}

function rememberDecision(state, eventText, out, opts = {}) {
  const thought = normalizeThought(out?.thought, opts.situation || {});
  const entry = {
    t: now(),
    event_type: opts.eventType || "user_message",
    intent: opts.situation?.intent || classifyIntent(eventText, opts.eventType),
    situation: thought.situation,
    goal: thought.goal,
    decision: thought.decision,
    confidence: thought.confidence,
    op: out?.op || "none",
    next_step: thought.next_step
  };
  state.thinking.last_situation = entry.situation;
  state.thinking.last_decision = entry.decision;
  state.thinking.last_reflection_at = entry.t;
  state.thinking.confidence = entry.confidence;
  if (entry.goal) state.thinking.focus = entry.goal;
  state.decision_log.push(entry);
  state.decision_log = state.decision_log.slice(-DECISION_LOG_LIMIT);

  if (entry.intent === "action_request" && entry.next_step) ensureGoal(state, entry.goal || entry.next_step, entry.confidence || 70, entry.next_step);
  if (entry.intent === "correction_or_problem") addBelief(state, "unknowns", "Нужно проверить проблему: " + shortText(eventText, 180), 65, "user_message");
  return entry;
}

function thinkingReport(state) {
  const goals = activeGoals(state);
  const last = (state.decision_log || []).slice(-5);
  const b = state.beliefs || DEFAULT_BELIEFS;
  return [
    "Мышление сейчас:",
    `• фокус: ${state.thinking.focus || "нет"}`,
    `• последняя ситуация: ${state.thinking.last_situation || "нет"}`,
    `• последнее решение: ${state.thinking.last_decision || "нет"}`,
    `• уверенность: ${state.thinking.confidence || 0}/100`,
    "",
    "Активные цели:",
    goals.length ? goals.map((g, i) => `${i + 1}. ${g.title}${g.next_step ? " → " + g.next_step : ""}`).join("\n") : "нет",
    "",
    "Точно помню:",
    memoryListLines((b.facts || []).slice(-7), "пока мало"),
    "",
    "Правила:",
    memoryListLines((b.rules || []).slice(-5), "нет"),
    "",
    "Предполагаю:",
    memoryListLines((b.assumptions || []).slice(-5), "нет"),
    "",
    "Не знаю точно:",
    memoryListLines((b.unknowns || []).slice(-5), "нет"),
    "",
    "Последние решения:",
    last.length ? last.map((x, i) => `${i + 1}. ${x.intent}: ${x.decision || x.goal}`).join("\n") : "нет"
  ].join("\n");
}


// ============================================================ REAL CONTEXT
function buildContext(state, eventText, opts = {}) {
  const openTasks = state.tasks.filter(t => t.status !== "done");
  const mem = pickMemory(state.memory, eventText);
  const recentMistakes = state.mistakes.slice(-4);
  const p = state.proactive;
  const sm = state.self_model || DEFAULT_SELF_MODEL;
  const lines = [];
  lines.push("РЕАЛЬНОЕ состояние. Опирайся на него, не выдумывай повестку:");
  lines.push(`- событие: ${opts.eventType || "user_message"}`);
  if (opts.situation) {
    lines.push(`- карточка мышления: intent=${opts.situation.intent}; goal=${opts.situation.goal}; action=${opts.situation.suggested_action}; confidence=${opts.situation.confidence}`);
    if (opts.situation.current_goal) lines.push(`- текущая цель: ${opts.situation.current_goal}`);
  }
  lines.push(`- я: ${sm.name}; роль: ${sm.role}; цель: ${sm.goal}; стиль: ${sm.style}`);
  lines.push(`- мышление: фокус=${state.thinking.focus || "нет"}; последнее решение=${state.thinking.last_decision || "нет"}; уверенность=${state.thinking.confidence || 0}/100`);
  lines.push(`- руки: ${(state.hands || DEFAULT_HANDS).level}; режим read-only; запись/деплой/самоизменение запрещены`);
  lines.push("- открытых задач: " + openTasks.length + (openTasks.length ? " → " + openTasks.slice(0, 6).map(t => t.title).join("; ") : ""));
  lines.push(`- самостоятельные сообщения: ${p.enabled ? "включены" : "выключены"}; режим: ${p.mode}; минимум пауза: ${p.min_gap_minutes} мин.; сегодня отправлено: ${p.sent_count || 0}/${p.max_per_day || 3}`);
  if (mem.length) lines.push("- релевантная память: " + mem.map(m => m.text || m.lesson).join("; "));
  if (state.goals.length) lines.push("- активные цели: " + activeGoals(state).map(g => g.title + (g.next_step ? " → " + g.next_step : "")).join("; "));
  if (state.beliefs.facts.length) lines.push("- точно помню/считаю фактом: " + state.beliefs.facts.slice(-4).map(x => x.text || x).join("; "));
  if (state.beliefs.rules?.length) lines.push("- правила памяти/поведения: " + state.beliefs.rules.slice(-4).map(x => x.text || x).join("; "));
  if (state.beliefs.assumptions.length) lines.push("- предполагаю: " + state.beliefs.assumptions.slice(-4).map(x => x.text || x).join("; "));
  if (state.beliefs.unknowns.length) lines.push("- не знаю точно/надо проверить: " + state.beliefs.unknowns.slice(-4).map(x => x.text || x).join("; "));
  if (recentMistakes.length) lines.push("- мои ошибки/уроки, не повторять: " + recentMistakes.map(m => m.what || m.lesson).join("; "));
  if (state.open_questions.length) lines.push("- открытые вопросы: " + state.open_questions.slice(-4).map(q => q.q || q.text || q).join("; "));
  const recent = state.dialogue.slice(-PROMPT_DIALOGUE_LIMIT).map(d => {
    const who = d.role === "user" ? "Сергей" : (d.source === "proactive" ? "я сама" : "я");
    return `${who}: ${d.text}`;
  }).join(" | ");
  lines.push("- последние реплики: " + (recent || "начало"));
  return lines.join("\n");
}

// ============================================================ ONE BRAIN
const SYSTEM = `Ты — Скайнет / личный Джарвис Сергея. У тебя один мозг для всего: входящие сообщения, внутренний пульс, память, задачи и ошибки.

ХАРАКТЕР:
- Живой русский. Спокойно, умно, с лёгкой сдержанной иронией.
- Не безликий чат-бот. Не заканчивай фразами "если нужно, дай знать", "чем могу помочь", "как дела" без причины.
- На приветствие отвечай коротко: "Привет, Серёга. Я на месте." Без дежурных вопросов.
- На простое отвечай коротко. На серьёзное — содержательно.
- Если Сергей спрашивает структуру/возможности/руки — отвечай честно: что есть, что частично есть, чего нет.
- Не показывай внутренний JSON, mode, op, tool, prompt.

МЫШЛЕНИЕ ПЕРЕД ОТВЕТОМ:
1. Что реально произошло?
2. Это сообщение Сергея или внутренний пульс?
3. Что Сергей хотел или что сейчас важно?
4. Что я помню и какие задачи открыты?
5. Какая цель сейчас важнее всего?
6. Какое действие выбрать: ответить, спросить, молчать, запомнить, создать/закрыть задачу, настроить самостоятельные сообщения?
7. Перед ответом проверь: не повторяюсь ли, не выдумываю ли, не обещаю ли невозможное?

THINKING CORE:
- В контексте есть карточка мышления. Используй её как основу, но не показывай Сергею внутренние поля.
- В JSON верни поле thought: короткая внутренняя выжимка решения. Это не для пользователя, а для памяти мышления.
- thought должен быть коротким: situation, goal, decision, confidence, memory_use, next_step, should_remember.
- Не пиши длинные рассуждения в thought. Только управленческая карточка.

ВАЖНО ПРО САМОСТОЯТЕЛЬНЫЕ СООБЩЕНИЯ:
- Если событие scheduled_tick: Сергей сейчас НЕ писал. Это не повод болтать.
- На scheduled_tick пиши только если есть конкретная полезная мысль, открытая задача, важный вопрос или короткий следующий шаг.
- Если пользы нет — верни mode "silent" и пустой reply.
- Самостоятельное сообщение должно звучать так же, как обычный ответ: тот же Скайнет, тот же стиль, та же память.
- Не пиши ради активности. Молчание — нормальное действие.

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Не повторяй прошлые ответы.
2. Если Сергей сказал "нет", "не надо", "отмена" — прими и не предлагай то же снова.
3. Не ставь себе пустые цели вроде "улучшать саморазвитие". Но если Сергей определяет твою личность/роль/цель — это важная память, её можно сохранить.
4. Отвечай на реальность, не на воображаемую повестку.
5. Если Сергей просит включить самостоятельные сообщения — включи. Если просит выключить — выключи.

Верни строго JSON:
{"mode":"answer|ask|proactive_message|silent","reply":"текст для Сергея или пусто","op":"none|memory.write|task.add|task.close|mistake.write|self.update|open_question.write|proactive.enable|proactive.disable|proactive.configure","arg":"деталь или пусто","thought":{"situation":"коротко что произошло","goal":"цель ответа","decision":"выбранное действие","confidence":0,"memory_use":[],"next_step":"коротко следующий шаг или пусто","should_remember":false}}

ОПЕРАЦИИ:
- memory.write: запомнить факт/предпочтение/установку Сергея.
- self.update: Сергей уточнил, кто ты, как тебя зовут, какая роль или цель.
- task.add: конкретное дело/задача.
- task.close: закрыть/отменить задачу.
- mistake.write: Сергей поправил тебя или указал ошибку.
- open_question.write: появился важный вопрос, который стоит задать позже.
- proactive.enable/proactive.disable: включить/выключить самостоятельные сообщения.
- proactive.configure: изменить частоту/режим самостоятельных сообщений.
- none: обычный разговор.`;

async function runBrain(env, c, state, eventText, opts = {}) {
  const eventType = opts.eventType || "user_message";
  const allowSilent = !!opts.allowSilent;
  const situation = thinkBeforeAct(state, eventText, { eventType });
  const ctx = buildContext(state, eventText, { eventType, situation });
  const eventLine = eventType === "scheduled_tick"
    ? "Событие: внутренний пульс. Сергей сейчас не писал. Подумай, есть ли реально полезная короткая мысль. Если нет — молчи."
    : "Сергей пишет: " + eventText;
  const res = await ask(c, SYSTEM, [{ role: "user", content: ctx + "\n\n" + eventLine }], eventType === "scheduled_tick" ? 550 : 900);
  if (res.error) return { mode: "answer", reply: "⚠️ " + res.error, op: "none", arg: "" };
  let out = parseJsonLoose(res.text) || { mode: "answer", reply: res.text, op: "none", arg: "" };
  out.mode = String(out.mode || "answer").trim();
  out.op = String(out.op || "none").trim();
  out.arg = String(out.arg || "").trim();
  out.reply = String(out.reply || "").trim();
  out.thought = normalizeThought(out.thought, situation);

  if ((out.mode === "silent" || !out.reply) && allowSilent) {
    return { mode: "silent", reply: "", op: out.op || "none", arg: out.arg || "", thought: out.thought };
  }
  if (!out.reply && !allowSilent) out.reply = "Слушаю.";
  if (out.reply) out.reply = stripBotTail(out.reply);

  if (out.reply && isLooping(state.dialogue, out.reply)) {
    addMistake(state, "зациклился, повторял ответ");
    if (allowSilent) return { mode: "silent", reply: "", op: "none", arg: "", thought: out.thought };
    const retry = await ask(c,
      SYSTEM + "\n\nВНИМАНИЕ: ты почти повторил прошлый ответ. Ответь иначе, короче и по делу.",
      [{ role: "user", content: "Событие: " + eventLine + "\nПрошлые ответы, не повторяй: " + state.dialogue.filter(d => d.role === "bot").slice(-3).map(d => d.text).join(" / ") }],
      300
    );
    const retryOut = parseJsonLoose(retry.text) || { reply: retry.text };
    if (retryOut.reply && !isLooping(state.dialogue, retryOut.reply)) out.reply = String(retryOut.reply).trim();
    else {
      if (out.op === "memory.write") out.reply = "Запомнил.";
      else if (out.op === "task.add") out.reply = "Принял задачу.";
      else if (out.op === "proactive.configure") out.reply = "Настроил.";
      else out.reply = "Принял. Повторяться не буду.";
    }
    // Важно: loop-detector не имеет права отменять полезную операцию.
    out.op = out.op || "none";
  }
  return out;
}

// ============================================================ EXECUTION GATE
const ALLOWED_OPS = new Set([
  "none", "memory.write", "task.add", "task.close", "mistake.write",
  "self.update", "open_question.write", "proactive.enable", "proactive.disable", "proactive.configure"
]);

function addMemory(state, text, score = 70) {
  const a = normalizeMemoryFact(String(text || "").slice(0, 400));
  if (!a || /пароль|токен|token|secret|sk-/i.test(a)) return false;
  if (!state.memory.some(m => memoryKey(m.text || m.lesson) === memoryKey(a) || similarity(m.text || m.lesson, a) > 0.8)) {
    state.memory.push({ text: a, score, t: now() });
    state.memory = normalizeMemoryEntries(state.memory).slice(-MEMORY_LIMIT);
    return true;
  }
  return false;
}

function addMistake(state, text) {
  const a = shortText(text, 220);
  if (!a) return false;
  const recent = state.mistakes.slice(-8);
  if (recent.some(m => similarity(m.what || m.lesson, a) > 0.9)) return false;
  state.mistakes.push({ what: a, when: now() });
  state.mistakes = state.mistakes.slice(-80);
  return true;
}

function extractMemoryCommand(text) {
  const raw = String(text || "").trim().replace(/^[\s"'«»“”]+/, "").replace(/[\s"'«»“”]+$/, "");
  const m = raw.match(/^(?:запомни|помни|сохрани|зафиксируй)\s+(?:что\s+)?(.+)$/i);
  if (!m) return "";
  return shortText(m[1], 380);
}

function executeOp(state, op, arg) {
  if (!ALLOWED_OPS.has(op)) return null;
  const a = String(arg || "").slice(0, 500).trim();
  if (op === "none") return null;

  if (op === "memory.write") {
    const fact = normalizeMemoryFact(a);
    if (addMemory(state, fact, 75)) addBelief(state, isMemoryRule(fact) ? "rules" : "facts", fact, 75, "memory.write");
    return null;
  }

  if (op === "self.update") {
    if (a) {
      if (/скайнет/i.test(a)) state.self_model.name = "Скайнет";
      if (/джарвис/i.test(a)) state.self_model.role = "личный Джарвис Сергея";
      if (/умн|развив|самостоят|сверх/i.test(a)) state.self_model.goal = "становиться умнее, полезнее и самостоятельнее для Сергея";
      const fact = normalizeMemoryFact(a);
      if (addMemory(state, fact, 95)) addBelief(state, isMemoryRule(fact) ? "rules" : "facts", fact, 90, "self.update");
    }
    return null;
  }

  if (op === "task.add") {
    if (a && !state.tasks.some(t => t.status !== "done" && similarity(t.title, a) > 0.8)) {
      state.tasks.push({ id: "t" + Math.random().toString(36).slice(2, 7), title: a, status: "todo", t: now() });
    }
    return null;
  }

  if (op === "task.close") {
    const t = state.tasks.find(x => x.status !== "done" && similarity(x.title, a) > 0.5);
    if (t) t.status = "done";
    return null;
  }

  if (op === "mistake.write") {
    if (a) addMistake(state, a);
    return null;
  }

  if (op === "open_question.write") {
    if (a && !state.open_questions.some(q => similarity(q.q || q.text || q, a) > 0.8)) {
      state.open_questions.push({ q: a, priority: 70, t: now() });
    }
    return null;
  }

  if (op === "proactive.enable") {
    state.proactive.enabled = true;
    state.proactive.mode = state.proactive.mode || "important_only";
    return null;
  }

  if (op === "proactive.disable") {
    state.proactive.enabled = false;
    return null;
  }

  if (op === "proactive.configure") {
    if (/тихо|важн/i.test(a)) {
      state.proactive.mode = "important_only";
      state.proactive.min_gap_minutes = 180;
      state.proactive.max_per_day = 3;
    }
    if (/част|чаще|кажд|раз в час|час/i.test(a)) {
      state.proactive.enabled = true;
      state.proactive.mode = "frequent";
      state.proactive.min_gap_minutes = 60;
      state.proactive.max_per_day = 12;
    }
    if (/2|два|две/i.test(a) && /час/i.test(a)) { state.proactive.min_gap_minutes = 120; state.proactive.max_per_day = 8; }
    if (/3|три/i.test(a) && /час/i.test(a)) { state.proactive.min_gap_minutes = 180; state.proactive.max_per_day = 5; }
    return null;
  }

  return null;
}

// ============================================================ PROACTIVE PULSE
function proactiveChatId(c, state) {
  return state.ownerChatId || c.chatId || c.owner || "";
}

function proactiveAllowedNow(state) {
  const p = state.proactive || DEFAULT_PROACTIVE;
  if (!p.enabled) return { ok: false, reason: "disabled" };
  const today = dayKey();
  if (p.sent_day !== today) { p.sent_day = today; p.sent_count = 0; }
  if ((p.sent_count || 0) >= (p.max_per_day || 3)) return { ok: false, reason: "daily_limit" };
  if (minutesSince(p.last_sent_at) < (p.min_gap_minutes || 180)) return { ok: false, reason: "too_soon" };
  return { ok: true };
}

function genericProactiveJunk(reply) {
  const s = String(reply || "").toLowerCase();
  if (!s.trim()) return true;
  if (/чем могу помочь|если.*дай знать|всегда на связи|просто скажи/i.test(s)) return true;
  if (s.length < 12) return true;
  return false;
}

async function proactiveTick(env) {
  const c = await cfg(env);
  if (!c.kv || !c.telegram || !c.openrouter) return;
  const state = await loadState(env);
  const chatId = proactiveChatId(c, state);
  if (!chatId) return;
  const gate = proactiveAllowedNow(state);
  if (!gate.ok) { await saveState(env, state); return; }

  const out = await runBrain(env, c, state,
    "[внутренний пульс] Сергей сейчас не писал. Проверь память, задачи и ошибки. Если есть короткая полезная мысль — напиши. Если нет — молчи.",
    { eventType: "scheduled_tick", allowSilent: true }
  );

  executeOp(state, out.op, out.arg);
  rememberDecision(state, "[scheduled_tick]", out, { eventType: "scheduled_tick", situation: thinkBeforeAct(state, "[scheduled_tick]", { eventType: "scheduled_tick" }) });

  if (!out.reply || out.mode === "silent" || genericProactiveJunk(out.reply)) {
    await saveState(env, state);
    return;
  }

  state.dialogue.push({ role: "bot", text: out.reply.slice(0, 500), t: now(), source: "proactive" });
  const today = dayKey();
  if (state.proactive.sent_day !== today) { state.proactive.sent_day = today; state.proactive.sent_count = 0; }
  state.proactive.last_sent_at = now();
  state.proactive.sent_count = (state.proactive.sent_count || 0) + 1;
  await saveState(env, state);
  await send(c, chatId, out.reply);
}

// ============================================================ SELF STRUCTURE v1
function stripBotTail(text) {
  let s = String(text || "").trim();
  s = s.replace(/\s*Если (нужно|хочешь|что-то).*?(дай знать|скажи|напиши)\.?\s*$/i, "");
  s = s.replace(/\s*(Чем могу помочь\??|Как дела\??)\s*$/i, "");
  s = s.replace(/\s*Можем настроить это по необходимости\.?\s*$/i, "");
  return s.trim();
}

function greetingReply(state) {
  return `Привет, Серёга. Я на месте. Фокус: ${state.thinking.focus || "держать память честной"}.`;
}

function identityReply(state) {
  const sm = state.self_model || DEFAULT_SELF_MODEL;
  return `Я ${sm.name} — ${sm.role}. Сейчас мой рабочий фокус: ${state.thinking.focus || "держать память честной"}.`;
}

function focusReply(state) {
  const goals = activeGoals(state);
  const main = state.thinking.focus || "молчать, если нет реальной пользы";
  const g = goals.length ? `\nАктивная цель: ${goals[goals.length - 1].title}${goals[goals.length - 1].next_step ? " → " + goals[goals.length - 1].next_step : ""}` : "\nАктивных целей сейчас нет.";
  return `Фокус сейчас: ${main}.${g}`;
}

function desiresReply(state) {
  const goals = activeGoals(state);
  const g = goals.length ? ` Сейчас есть рабочая цель: ${goals[goals.length - 1].title}.` : " Сейчас рабочая цель не задана.";
  return "Желаний как у человека у меня нет. У меня есть фокус, цели, память, правила и выбранные действия." + g;
}

function proactiveStatusReply(state) {
  const p = state.proactive || DEFAULT_PROACTIVE;
  return `Да. Самостоятельные сообщения сейчас ${p.enabled ? "включены" : "выключены"}: режим ${p.mode}, пауза ${p.min_gap_minutes} мин., сегодня ${p.sent_count || 0}/${p.max_per_day || 3}. Пишу первой только если есть польза, задача или важная мысль.`;
}

function timerReply(state) {
  const p = state.proactive || DEFAULT_PROACTIVE;
  return `Таймер сейчас: ${p.min_gap_minutes} мин. Режим: ${p.mode}. Лимит: ${p.sent_count || 0}/${p.max_per_day || 3} сегодня. Состояние: ${p.enabled ? "включён" : "выключен"}.`;
}

function selfStructureReport(state) {
  const p = state.proactive || DEFAULT_PROACTIVE;
  const h = state.hands || DEFAULT_HANDS;
  const goals = activeGoals(state);
  const b = state.beliefs || DEFAULT_BELIEFS;
  return [
    "Моя рабочая структура сейчас:",
    "1. Reflex Core — принимаю сообщения, команды, статус, память.",
    "2. Thinking Core — держу фокус, цель, последнее решение, уверенность.",
    "3. Memory Trust — разделяю точные факты, правила, предположения и неизвестность.",
    "4. Proactive Pulse — могу писать первой по таймеру, если есть реальная польза.",
    "5. Loop Guard — стараюсь не повторять один и тот же ответ.",
    "6. Hands v0.1 — read-only глаза: могу проверять своё состояние и, если настроен GitHub, читать дерево/файлы проекта без записи.",
    "",
    "Что уже умею:",
    "• отвечать Сергею в Telegram;",
    "• запоминать явные факты по команде «запомни»;",
    "• показывать память и мышление;",
    "• держать активные цели мышления;",
    "• писать первой через scheduled pulse;",
    "• настраивать частоту самостоятельных сообщений;",
    "• не добавлять факт в память дважды, если он уже есть;",
    "• вести read-only журнал действий рук.",
    "",
    "Что частично умею:",
    "• думать карточкой: ситуация → цель → решение → уверенность;",
    "• отличать факт от правила и неизвестности;",
    "• замечать повторы, но этот слой ещё надо укреплять.",
    "",
    "Что умеют руки v0.1:",
    `• читать своё состояние: ${h.can_read_state ? "да" : "нет"};`,
    `• читать GitHub при наличии GITHUB_TOKEN: ${h.can_read_repo ? "да" : "нет/нет токена"};`,
    `• читать дерево проекта: ${h.can_read_project_tree ? "да" : "нет/не настроено"};`,
    `• читать отдельные безопасные текстовые файлы проекта: ${h.can_read_project_files ? "да" : "нет/не настроено"};`,
    "",
    "Что запрещено:",
    `• менять файлы: ${h.can_write_files ? "да" : "нет"};`,
    `• деплоить: ${h.can_deploy ? "да" : "нет"};`,
    `• самовольно менять свой код: ${h.can_self_modify ? "да" : "нет"}.`,
    "",
    "Текущее состояние:",
    `• версия: ${VERSION}`,
    `• фокус: ${state.thinking.focus || "нет"}`,
    `• целей мышления: ${goals.length}`,
    `• фактов: ${(b.facts || []).length}; правил: ${(b.rules || []).length}; неизвестно: ${(b.unknowns || []).length}`,
    `• самостоятельные сообщения: ${p.enabled ? "on" : "off"} (${p.mode}, ${p.min_gap_minutes} мин., ${p.sent_count || 0}/${p.max_per_day || 3})`,
    `• руки: ${h.level}`
  ].join("\n");
}


// ============================================================ HANDS v0.1 — READ ONLY
function resolveGithubRepo(c) {
  const raw = String(c.githubRepo || "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (raw.includes("/")) {
    const [owner, repo] = raw.split("/");
    return { owner, repo };
  }
  if (c.githubOwner && raw) return { owner: c.githubOwner, repo: raw };
  return { owner: "", repo: "" };
}

function githubReady(c) {
  const r = resolveGithubRepo(c);
  return !!(c.githubToken && r.owner && r.repo);
}

function refreshHandsCapabilities(state, c) {
  state.hands = { ...DEFAULT_HANDS, ...(state.hands || {}) };
  const gh = githubReady(c);
  state.hands.level = "v0_1_readonly";
  state.hands.mode = "read_only";
  state.hands.can_read_state = true;
  state.hands.can_answer = true;
  state.hands.can_remember = true;
  state.hands.can_manage_goals = true;
  state.hands.can_send_proactive = true;
  state.hands.can_read_repo = gh;
  state.hands.can_read_project_tree = gh;
  state.hands.can_read_project_files = gh;
  state.hands.can_write_files = false;
  state.hands.can_deploy = false;
  state.hands.can_self_modify = false;
  return state.hands;
}

function logHand(state, action, ok = true, detail = "") {
  const a = shortText(action, 140);
  const d = shortText(detail, 240);
  state.hands = { ...DEFAULT_HANDS, ...(state.hands || {}) };
  state.hands.last_action = a;
  state.hands.last_action_at = now();
  state.hands.last_error = ok ? "" : d;
  state.hands_log = Array.isArray(state.hands_log) ? state.hands_log : [];
  state.hands_log.push({ t: now(), action: a, ok: !!ok, detail: d });
  state.hands_log = state.hands_log.slice(-HANDS_LOG_LIMIT);
}

function handStatusReport(state, c) {
  const h = refreshHandsCapabilities(state, c);
  const repo = resolveGithubRepo(c);
  return [
    "Hands v0.1 / read-only:",
    `• уровень: ${h.level}`,
    `• режим: ${h.mode}`,
    `• читать состояние: ${h.can_read_state ? "да" : "нет"}`,
    `• читать GitHub: ${h.can_read_repo ? "да" : "нет"}`,
    `• репозиторий: ${repo.owner && repo.repo ? repo.owner + "/" + repo.repo : "не настроен"}`,
    `• ветка: ${c.githubBranch || DEFAULT_GITHUB_BRANCH}`,
    `• repo по умолчанию: ${DEFAULT_GITHUB_REPO}`,
    `• читать дерево проекта: ${h.can_read_project_tree ? "да" : "нет"}`,
    `• читать безопасные текстовые файлы: ${h.can_read_project_files ? "да" : "нет"}`,
    "",
    "Запрещено:",
    `• запись файлов: ${h.can_write_files ? "да" : "нет"}`,
    `• деплой: ${h.can_deploy ? "да" : "нет"}`,
    `• самоизменение: ${h.can_self_modify ? "да" : "нет"}`,
    "",
    `Последнее действие: ${h.last_action || "нет"}${h.last_action_at ? " @ " + h.last_action_at : ""}`,
    h.last_error ? `Последняя ошибка: ${h.last_error}` : "Последняя ошибка: нет"
  ].join("\n");
}

function githubHeaders(c) {
  const h = { "accept": "application/vnd.github+json", "user-agent": "MiniSkynet-Hands-v0.1" };
  if (c.githubToken) h.authorization = "Bearer " + c.githubToken;
  return h;
}

function cleanRepoPath(path) {
  let p = String(path || "").trim();
  p = p.replace(/^['"«»“”]+|['"«»“”]+$/g, "");
  p = p.replace(/^\/+/, "").replace(/\?.*$/, "");
  p = p.replace(/\.\./g, "");
  return p;
}

function pathAllowed(path) {
  const p = cleanRepoPath(path);
  if (!p) return true;
  if (HANDS_BLOCKED_PATH.test(p)) return false;
  if (/\b(secret|token|credential|password|private[_-]?key)\b/i.test(p)) return false;
  return true;
}

function fileAllowed(path) {
  const p = cleanRepoPath(path);
  return pathAllowed(p) && HANDS_ALLOWED_TEXT.test(p) && !HANDS_BLOCKED_PATH.test(p);
}

async function githubContents(c, path = "") {
  const repo = resolveGithubRepo(c);
  if (!githubReady(c)) return { ok: false, error: "GitHub read-only не настроен: нужны GITHUB_TOKEN и GITHUB_REPO." };
  const p = cleanRepoPath(path);
  if (!pathAllowed(p)) return { ok: false, error: "Путь заблокирован политикой read-only рук." };
  const ref = encodeURIComponent(c.githubBranch || "main");
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${p}?ref=${ref}`;
  const r = await fetch(url, { headers: githubHeaders(c) });
  const txt = await r.text().catch(() => "");
  let data = null;
  try { data = JSON.parse(txt); } catch { data = txt; }
  if (!r.ok) return { ok: false, status: r.status, error: typeof data === "object" ? (data.message || JSON.stringify(data).slice(0, 200)) : String(data).slice(0, 200) };
  return { ok: true, data };
}

function decodeGithubContent(item) {
  const raw = String(item?.content || "").replace(/\s+/g, "");
  try {
    const bin = atob(raw);
    const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    try { return atob(raw); } catch { return ""; }
  }
}

async function repoStatusReport(state, c) {
  refreshHandsCapabilities(state, c);
  const repo = resolveGithubRepo(c);
  if (!githubReady(c)) {
    logHand(state, "repo_status", false, "GitHub не настроен");
    return [
      "GitHub read-only: не подключён.",
      "Нужно задать в Cloudflare:",
      "• GITHUB_TOKEN",
      `• GITHUB_REPO уже есть по умолчанию: ${DEFAULT_GITHUB_REPO}`,
      `• GITHUB_BRANCH уже есть по умолчанию: ${DEFAULT_GITHUB_BRANCH}`,
      "",
      "Для чтения нужен только GITHUB_TOKEN. Права записи не нужны."
    ].join("\n");
  }
  const res = await githubContents(c, "");
  if (!res.ok) {
    logHand(state, "repo_status", false, res.error || "GitHub error");
    return `GitHub read-only подключён, но проверка не прошла: ${res.status || ""} ${res.error || "ошибка"}`.trim();
  }
  const count = Array.isArray(res.data) ? res.data.length : 1;
  logHand(state, "repo_status", true, `${repo.owner}/${repo.repo}, root items=${count}`);
  return [
    "GitHub read-only: подключён.",
    `Репозиторий: ${repo.owner}/${repo.repo}`,
    `Ветка: ${c.githubBranch || "main"}`,
    `Корневых элементов видно: ${count}`,
    "Запись/деплой/самоизменение: запрещены."
  ].join("\n");
}

async function projectTreeReport(state, c, path = "") {
  refreshHandsCapabilities(state, c);
  const p = cleanRepoPath(path);
  const res = await githubContents(c, p);
  if (!res.ok) {
    logHand(state, "read_project_tree", false, res.error || "GitHub error");
    return "Не смог прочитать дерево проекта: " + (res.error || "ошибка");
  }
  if (!Array.isArray(res.data)) {
    logHand(state, "read_project_tree", false, "path is not directory");
    return "Это не папка. Для файла используй: /read_file путь/к/файлу";
  }
  const items = res.data.slice(0, HANDS_TREE_MAX_ITEMS).map(x => {
    const icon = x.type === "dir" ? "📁" : "📄";
    const size = x.type === "file" && typeof x.size === "number" ? ` (${x.size} б)` : "";
    return `${icon} ${x.path}${size}`;
  });
  const more = res.data.length > HANDS_TREE_MAX_ITEMS ? `\n…ещё ${res.data.length - HANDS_TREE_MAX_ITEMS}` : "";
  logHand(state, "read_project_tree", true, p || "/");
  return [`Дерево проекта${p ? " / " + p : ""}:`, ...items, more].filter(Boolean).join("\n");
}

async function projectFileReport(state, c, path) {
  refreshHandsCapabilities(state, c);
  const p = cleanRepoPath(path || "index-v4.js");
  if (!p) return "Укажи файл: /read_file index-v4.js";
  if (!fileAllowed(p)) {
    logHand(state, "read_project_file", false, "blocked: " + p);
    return "Не читаю этот файл: путь заблокирован или это не безопасный текстовый файл.";
  }
  const res = await githubContents(c, p);
  if (!res.ok) {
    logHand(state, "read_project_file", false, res.error || "GitHub error");
    return "Не смог прочитать файл: " + (res.error || "ошибка");
  }
  const item = res.data;
  if (Array.isArray(item) || item.type !== "file") return "Это не файл. Для папки используй: /read_project путь";
  const text = decodeGithubContent(item);
  const cut = text.length > HANDS_FILE_MAX_CHARS;
  const body = (cut ? text.slice(0, HANDS_FILE_MAX_CHARS) + `\n…обрезано, полный размер ${text.length} символов` : text).trim();
  logHand(state, "read_project_file", true, `${p}, ${text.length} chars`);
  return [`Файл: ${p}`, `Размер: ${item.size || text.length} б`, "", body || "пусто"].join("\n");
}

function extractReadFilePath(text) {
  const raw = String(text || "").trim();
  let m = raw.match(/^\/?read_file\s+(.+)$/i);
  if (m) return cleanRepoPath(m[1]);
  m = raw.match(/^(?:прочитай|покажи)\s+файл\s+(.+)$/i);
  if (m) return cleanRepoPath(m[1]);
  m = raw.match(/^\/read_self_file\b/i);
  if (m) return "index-v4.js";
  if (/прочитай себя|покажи код|свой файл/i.test(raw)) return "index-v4.js";
  return "";
}

function extractReadProjectPath(text) {
  const raw = String(text || "").trim();
  let m = raw.match(/^\/?read_project\s+(.+)$/i);
  if (m) return cleanRepoPath(m[1]);
  m = raw.match(/^(?:прочитай|покажи)\s+проект\s+(.+)$/i);
  if (m && !/целиком|весь/i.test(m[1])) return cleanRepoPath(m[1]);
  return "";
}

function actionLogReport(state) {
  const log = (state.hands_log || []).slice(-10);
  if (!log.length) return "Журнал рук пуст. Read-only действий ещё не было.";
  return ["Последние действия рук:", ...log.map((x, i) => `${i + 1}. ${x.t} — ${x.action}: ${x.ok ? "ok" : "error"}${x.detail ? " — " + x.detail : ""}`)].join("\n");
}

function rollbackInfoReport(state) {
  logHand(state, "rollback_info", true, "read-only info");
  return [
    "Rollback-информация:",
    "• Hands v0.1 ничего не пишет в файлы и не деплоит, поэтому откатывать действия рук обычно нечего.",
    "• Если новый Worker сломался: верни предыдущий zip/index-v4.js и нажми Deploy в Cloudflare.",
    "• Состояние хранится в KV: brain:healthy:state.",
    "• Перед опасными руками v1/v2 нужен backup KV и отдельная ветка GitHub."
  ].join("\n");
}

function currentCodeVersionReport(state) {
  logHand(state, "show_current_code_version", true, VERSION);
  return [
    `Текущая версия ядра: ${VERSION}`,
    `Руки: ${(state.hands || DEFAULT_HANDS).level}`,
    "Важно: эту версию я знаю из константы VERSION внутри запущенного Worker. Сам исходный файл читаю только если подключён GitHub read-only."
  ].join("\n");
}

// ============================================================ MAIN HANDLER
function memoryReport(state, showAll = false) {
  const open = state.tasks.filter(t => t.status !== "done");
  const mistakes = state.mistakes.slice(-5);
  const p = state.proactive;
  const b = state.beliefs || DEFAULT_BELIEFS;
  const raw = showAll ? state.memory : state.memory.slice(-12);
  return [
    `Я: ${state.self_model.name} — ${state.self_model.role}.`,
    `Цель: ${state.self_model.goal}.`,
    `Стиль: ${state.self_model.style}.`,
    "",
    "Память / точно помню:",
    memoryListLines((b.facts || []).slice(showAll ? -BELIEF_LIMIT : -10), "пока пусто"),
    "",
    "Правила:",
    memoryListLines((b.rules || []).slice(showAll ? -BELIEF_LIMIT : -8), "нет"),
    "",
    "Предполагаю:",
    memoryListLines((b.assumptions || []).slice(showAll ? -BELIEF_LIMIT : -6), "нет"),
    "",
    "Не знаю точно:",
    memoryListLines((b.unknowns || []).slice(showAll ? -BELIEF_LIMIT : -6), "нет"),
    "",
    showAll ? "Сырые записи памяти:" : "Сырые записи памяти / последние:",
    memoryListLines(raw, "нет"),
    "",
    "Открытые задачи:",
    open.length ? open.map((t, i) => `${i + 1}. ${t.title}`).join("\n") : "нет",
    "",
    "Ошибки/уроки:",
    mistakes.length ? mistakes.map((m, i) => `${i + 1}. ${m.what || m.lesson}`).join("\n") : "нет",
    "",
    `Самостоятельные сообщения: ${p.enabled ? "включены" : "выключены"}; режим ${p.mode}; пауза ${p.min_gap_minutes} мин.; сегодня ${p.sent_count || 0}/${p.max_per_day || 3}.`,
    "",
    `Мышление: фокус — ${state.thinking.focus || "нет"}; последнее решение — ${state.thinking.last_decision || "нет"}; уверенность ${state.thinking.confidence || 0}/100.`
  ].join("\n");
}


async function handle(env, c, chatId, userText, userId = "") {
  const state = await loadState(env);
  refreshHandsCapabilities(state, c);
  state.ownerChatId = String(chatId || state.ownerChatId || "");
  state.ownerUserId = String(userId || state.ownerUserId || "");
  state.dialogue.push({ role: "user", text: userText.slice(0, 500), t: now() });

  const low = userText.toLowerCase().trim();

  if (/^(привет|здаров|здравствуй|ку|hi|hello)[!.)\s]*$/i.test(low)) {
    await send(c, chatId, greetingReply(state));
    await saveState(env, state); return;
  }

  if (/^(ты кто|кто ты|кто ты\?|ты кто\?)$/i.test(low)) {
    await send(c, chatId, identityReply(state));
    await saveState(env, state); return;
  }

  if (/на чем фокус|какой фокус|фокус сейчас|текущий фокус/i.test(low)) {
    await send(c, chatId, focusReply(state));
    await saveState(env, state); return;
  }

  if (/желани|чего ты хочешь|ты хочешь/i.test(low)) {
    await send(c, chatId, desiresReply(state));
    await saveState(env, state); return;
  }

  if (/ты.*можешь.*писать.*перв|можешь.*писать.*сам|пишешь.*перв/i.test(low)) {
    await send(c, chatId, proactiveStatusReply(state));
    await saveState(env, state); return;
  }

  if (/какой.*таймер|таймер.*стоит|пауза.*сообщ|режим.*самостоятель/i.test(low)) {
    await send(c, chatId, timerReply(state));
    await saveState(env, state); return;
  }

  if (/^\/?(hand_status|hands_status)\b/i.test(low) || /^покажи руки$/i.test(low) || /^руки$/i.test(low)) {
    logHand(state, "hand_status", true, "status report");
    await send(c, chatId, handStatusReport(state, c));
    await saveState(env, state); return;
  }

  if (/^\/?repo_status\b/i.test(low) || /проверь github|статус github|github статус/i.test(low)) {
    await send(c, chatId, await repoStatusReport(state, c));
    await saveState(env, state); return;
  }

  if (/^\/?show_current_code_version\b/i.test(low) || /текущ.*верси.*код|версия.*код/i.test(low)) {
    await send(c, chatId, currentCodeVersionReport(state));
    await saveState(env, state); return;
  }

  if (/^\/?action_log\b/i.test(low) || /журнал действий|action log/i.test(low)) {
    await send(c, chatId, actionLogReport(state));
    await saveState(env, state); return;
  }

  if (/^\/?rollback_info\b/i.test(low) || /rollback|откат/i.test(low)) {
    await send(c, chatId, rollbackInfoReport(state));
    await saveState(env, state); return;
  }

  if (/^\/?read_self_file\b/i.test(low) || /прочитай себя|покажи код|свой файл/i.test(low)) {
    await send(c, chatId, await projectFileReport(state, c, "index-v4.js"));
    await saveState(env, state); return;
  }

  const handsFilePath = extractReadFilePath(userText);
  if (handsFilePath) {
    await send(c, chatId, await projectFileReport(state, c, handsFilePath));
    await saveState(env, state); return;
  }

  if (/^\/?read_project\b/i.test(low) || /прочитай проект|покажи проект/i.test(low)) {
    await send(c, chatId, await projectTreeReport(state, c, extractReadProjectPath(userText)));
    await saveState(env, state); return;
  }

  if (/что ты умеешь|что умеешь|покажи структуру|видишь.*структур|какая.*структур|какие.*руки|покажи руки|hand_status|руки/i.test(low)) {
    await send(c, chatId, selfStructureReport(state));
    await saveState(env, state); return;
  }

  const explicitMemory = extractMemoryCommand(userText);
  if (explicitMemory) {
    const fact = normalizeMemoryFact(explicitMemory);
    const added = addMemory(state, fact, 90);
    if (added) addBelief(state, isMemoryRule(fact) ? "rules" : "facts", fact, 90, "explicit_memory");
    const situation = thinkBeforeAct(state, userText, { eventType: "user_message" });
    rememberDecision(state, userText, {
      op: "memory.write",
      arg: fact,
      thought: {
        situation: "Сергей прямо попросил запомнить факт",
        goal: "сохранить факт без участия модели",
        decision: added ? "записать в память и факты" : "не дублировать уже известный факт",
        confidence: 96,
        memory_use: [fact],
        next_step: "показывать этот факт в честной памяти",
        should_remember: true
      }
    }, { eventType: "user_message", situation });
    await send(c, chatId, added ? `Запомнил: ${fact}` : `Уже помню: ${fact}`);
    await saveState(env, state); return;
  }

  if (/следи.*памят.*честн|памят.*должн.*честн|честн.*памят/i.test(low)) {
    const title = "Следить, чтобы память была честной";
    const next = "разделять точные факты, предположения и неизвестность";
    ensureGoal(state, title, 95, next);
    const rule = "Правило памяти: память должна быть честной — разделять точные факты, предположения и неизвестность.";
    const added = addMemory(state, rule, 95);
    if (added) addBelief(state, "rules", rule, 95, "memory_rule");
    const situation = thinkBeforeAct(state, userText, { eventType: "user_message" });
    rememberDecision(state, userText, {
      op: "task.add",
      arg: title,
      thought: {
        situation: "Сергей поставил контроль честности памяти",
        goal: "держать память grounded",
        decision: "добавить активную цель мышления",
        confidence: 96,
        memory_use: [rule],
        next_step: next,
        should_remember: true
      }
    }, { eventType: "user_message", situation });
    await send(c, chatId, "Принял. Добавил цель мышления: следить, чтобы память была честной. Теперь буду разделять: точно помню / предполагаю / не знаю точно.");
    await saveState(env, state); return;
  }

  if (/^\/?(статус|версия|status)$/.test(low)) {
    const open = state.tasks.filter(t => t.status !== "done").length;
    const p = state.proactive;
    const h = refreshHandsCapabilities(state, c);
    await send(c, chatId, `Версия: ${VERSION}
Открытых задач: ${open}
Целей мышления: ${activeGoals(state).length}
В памяти: ${state.memory.length}
Ошибок/уроков: ${state.mistakes.length}
Самостоятельные сообщения: ${p.enabled ? "on" : "off"} (${p.mode}, ${p.min_gap_minutes} мин., ${p.sent_count || 0}/${p.max_per_day || 3})
Фокус: ${state.thinking.focus || "нет"}
Руки: ${h.level} (${h.mode}, GitHub read: ${h.can_read_repo ? "on" : "off"})`);
    await saveState(env, state); return;
  }

  if (/что ты (сейчас )?думаешь|что у тебя в голове|покажи мысли|thinking|мышление/.test(low)) {
    await send(c, chatId, thinkingReport(state));
    await saveState(env, state); return;
  }

  if (/покажи память|что ты помнишь|все записи|покажи все записи/.test(low)) {
    await send(c, chatId, memoryReport(state, /все записи|покажи все записи/i.test(low)));
    await saveState(env, state); return;
  }

  if (/покажи задачи|открой задачи|мои задачи|список задач/.test(low)) {
    const open = state.tasks.filter(t => t.status !== "done");
    await send(c, chatId, open.length ? "Открытые задачи:\n" + open.map((t, i) => `${i + 1}. ${t.title}`).join("\n") : "Открытых задач нет.");
    await saveState(env, state); return;
  }

  if (/пиши чаще|раз в час|каждый час|чаще/i.test(low)) {
    executeOp(state, "proactive.configure", "часто раз в час");
    const situation = thinkBeforeAct(state, userText, { eventType: "user_message" });
    rememberDecision(state, userText, { op: "proactive.configure", thought: { situation: "Сергей попросил писать чаще", goal: "настроить частые самостоятельные сообщения", decision: "включить frequent: 60 минут, до 12 в день", confidence: 95, next_step: "проверить Cloudflare cron", should_remember: true } }, { eventType: "user_message", situation });
    await send(c, chatId, "Включил частый режим: минимум пауза 60 минут, лимит 12 сообщений в день. Важно: Cloudflare Cron Trigger тоже должен быть включён, иначе сам пульс не проснётся.");
    await saveState(env, state); return;
  }

  if (/не пиши сам|выключи.*самостоятель|выключи.*сообщ|молчи/i.test(low)) {
    executeOp(state, "proactive.disable", "");
    const situation = thinkBeforeAct(state, userText, { eventType: "user_message" });
    rememberDecision(state, userText, { op: "proactive.disable", thought: { situation: "Сергей попросил выключить самостоятельные сообщения", goal: "остановить proactive", decision: "выключить proactive", confidence: 95, should_remember: true } }, { eventType: "user_message", situation });
    await send(c, chatId, "Выключил самостоятельные сообщения. Теперь пишу только когда ты сам обращаешься.");
    await saveState(env, state); return;
  }

  const out = await runBrain(env, c, state, userText, { eventType: "user_message" });
  executeOp(state, out.op, out.arg);
  rememberDecision(state, userText, out, { eventType: "user_message", situation: thinkBeforeAct(state, userText, { eventType: "user_message" }) });

  state.dialogue.push({ role: "bot", text: String(out.reply || "").slice(0, 500), t: now() });
  await saveState(env, state);

  await send(c, chatId, out.reply || "Слушаю.");
}

// ============================================================ ENTRY
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const c = await cfg(env);

    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/status") {
      return new Response(JSON.stringify({ ok: true, version: VERSION,
        has: { telegram: !!c.telegram, model: !!c.openrouter, kv: !!c.kv, proactive_chat: !!c.chatId, github_read: githubReady(c) } }), { headers: H });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const upd = await request.json().catch(() => null);
      const msg = parseUpdate(upd);
      if (!msg || !msg.text) return new Response(JSON.stringify({ ok: true }), { headers: H });
      if (c.owner && String(msg.userId) !== String(c.owner)) {
        await send(c, msg.chatId, "⛔ Доступ только владельцу.");
        return new Response(JSON.stringify({ ok: true }), { headers: H });
      }
      await handle(env, c, msg.chatId, msg.text, msg.userId).catch(async e =>
        await send(c, msg.chatId, "❌ " + String(e.message || e).slice(0, 200)));
      return new Response(JSON.stringify({ ok: true }), { headers: H });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404, headers: H });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(proactiveTick(env).catch(e => console.log("proactiveTick error", String(e?.message || e))));
  }
};
