// MiniSkynet / Jarvis Core v1.3 — Proactive Configure. 2026-07-07.
// ФИЛОСОФИЯ: один мозг, одна память, два входа:
//   1) Сергей пишет в Telegram
//   2) Скайнет сама просыпается по scheduled tick
// Оба входа идут через один и тот же runBrain(), тот же SYSTEM, тот же state.
// Никакого отдельного "proactive brain". Самостоятельные сообщения — это тот же Скайнет,
// просто событие не user_message, а scheduled_tick.

const VERSION = "jarvis-core-v1.3-proactive-configure-2026-07-07";
const H = { "content-type": "application/json; charset=utf-8" };

const MEMORY_LIMIT = 160;
const TASK_LIMIT = 160;
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

// ============================================================ CONFIG
const CFG_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID", "OWNER_ID",
  "TELEGRAM_CHAT_ID", "TELEGRAM_OWNER_CHAT_ID",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_MODEL_CHEAP", "WORKER_URL"
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
    model: c.OPENROUTER_MODEL || c.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini"
  };
}

// ============================================================ KV / STATE
const now = () => new Date().toISOString();
const dayKey = () => new Date().toISOString().slice(0, 10);
const minutesSince = (iso) => iso ? Math.floor((Date.now() - Date.parse(iso)) / 60000) : 999999;


function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function pluralHours(mins) {
  mins = Number(mins || 0);
  if (mins < 60) return `${mins} мин.`;
  if (mins % 60 === 0) return `${mins / 60} ч.`;
  return `${mins} мин.`;
}

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
  s.memory = Array.isArray(s.memory) ? s.memory.slice(-MEMORY_LIMIT) : [];
  s.tasks = Array.isArray(s.tasks) ? s.tasks.slice(-TASK_LIMIT) : [];
  s.dialogue = Array.isArray(s.dialogue) ? s.dialogue.slice(-DIALOGUE_LIMIT) : [];
  s.mistakes = Array.isArray(s.mistakes) ? s.mistakes.slice(-80) : [];
  s.open_questions = Array.isArray(s.open_questions) ? s.open_questions.slice(-30) : [];
  s.proactive = { ...DEFAULT_PROACTIVE, ...(s.proactive || {}) };
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
  lines.push(`- я: ${sm.name}; роль: ${sm.role}; цель: ${sm.goal}; стиль: ${sm.style}`);
  lines.push("- открытых задач: " + openTasks.length + (openTasks.length ? " → " + openTasks.slice(0, 6).map(t => t.title).join("; ") : ""));
  lines.push(`- самостоятельные сообщения: ${p.enabled ? "включены" : "выключены"}; режим: ${p.mode}; минимум пауза: ${p.min_gap_minutes} мин.; сегодня отправлено: ${p.sent_count || 0}/${p.max_per_day || 3}`);
  if (mem.length) lines.push("- релевантная память: " + mem.map(m => m.text || m.lesson).join("; "));
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
- Не безликий чат-бот. Не заканчивай фразами "если нужно, дай знать", "чем могу помочь" без причины.
- На простое отвечай коротко. На серьёзное — содержательно.
- Не показывай внутренний JSON, mode, op, tool, prompt.

МЫШЛЕНИЕ ПЕРЕД ОТВЕТОМ:
1. Что реально произошло?
2. Это сообщение Сергея или внутренний пульс?
3. Что Сергей хотел или что сейчас важно?
4. Что я помню и какие задачи открыты?
5. Надо ответить, спросить, запомнить, создать задачу, включить/выключить самостоятельные сообщения или молчать?

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
{"mode":"answer|ask|proactive_message|silent","reply":"текст для Сергея или пусто","op":"none|memory.write|task.add|task.close|mistake.write|self.update|open_question.write|proactive.enable|proactive.disable|proactive.configure","arg":"деталь или пусто"}

ОПЕРАЦИИ:
- memory.write: запомнить факт/предпочтение/установку Сергея.
- self.update: Сергей уточнил, кто ты, как тебя зовут, какая роль или цель.
- task.add: конкретное дело/задача.
- task.close: закрыть/отменить задачу.
- mistake.write: Сергей поправил тебя или указал ошибку.
- open_question.write: появился важный вопрос, который стоит задать позже.
- proactive.enable/proactive.disable: включить/выключить самостоятельные сообщения.
- proactive.configure: изменить частоту/режим самостоятельных сообщений. Понимай фразы “пиши чаще”, “пиши раз в час”, “пиши каждые 30 минут”, “не чаще 5 раз в день”, “только важное”.
- none: обычный разговор.`;

async function runBrain(env, c, state, eventText, opts = {}) {
  const eventType = opts.eventType || "user_message";
  const allowSilent = !!opts.allowSilent;
  const ctx = buildContext(state, eventText, { eventType });
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

  if ((out.mode === "silent" || !out.reply) && allowSilent) {
    return { mode: "silent", reply: "", op: out.op || "none", arg: out.arg || "" };
  }
  if (!out.reply && !allowSilent) out.reply = "Слушаю.";

  if (out.reply && isLooping(state.dialogue, out.reply)) {
    state.mistakes.push({ what: "зациклился, повторял ответ", when: now() });
    if (allowSilent) return { mode: "silent", reply: "", op: "none", arg: "" };
    const retry = await ask(c,
      SYSTEM + "\n\nВНИМАНИЕ: ты почти повторил прошлый ответ. Ответь иначе, короче и по делу.",
      [{ role: "user", content: "Событие: " + eventLine + "\nПрошлые ответы, не повторяй: " + state.dialogue.filter(d => d.role === "bot").slice(-3).map(d => d.text).join(" / ") }],
      300
    );
    const retryOut = parseJsonLoose(retry.text) || { reply: retry.text };
    if (retryOut.reply && !isLooping(state.dialogue, retryOut.reply)) out.reply = String(retryOut.reply).trim();
    else out.reply = "Поймал себя на повторе. Скажу проще: я на месте, Серёга.";
    out.op = "none";
  }
  return out;
}

// ============================================================ EXECUTION GATE
const ALLOWED_OPS = new Set([
  "none", "memory.write", "task.add", "task.close", "mistake.write",
  "self.update", "open_question.write", "proactive.enable", "proactive.disable", "proactive.configure"
]);

function addMemory(state, text, score = 70) {
  const a = String(text || "").slice(0, 400).trim();
  if (!a || /пароль|токен|token|secret|sk-/i.test(a)) return false;
  if (!state.memory.some(m => similarity(m.text || m.lesson, a) > 0.8)) {
    state.memory.push({ text: a, score, t: now() });
    return true;
  }
  return false;
}


function proactiveConfigFromText(text, current = DEFAULT_PROACTIVE) {
  const raw = String(text || "").toLowerCase().replace(/ё/g, "е");
  const cfg = {};
  let touched = false;

  const hasProactiveIntent = /(пиши|писать|сообщени|самостоятельн|сама|уведомля|напоминай|пульс|частот|режим)/i.test(raw);
  const hasFrequency = /(чаще|реже|кажд|раз в|не чаще|минут|час|день|сутки|important|важн|свободн|обычн|критич)/i.test(raw);
  if (!hasProactiveIntent && !hasFrequency) return null;

  function setGap(mins, maxPerDay) {
    cfg.min_gap_minutes = clamp(mins, 10, 1440);
    if (maxPerDay) cfg.max_per_day = clamp(maxPerDay, 1, 48);
    touched = true;
  }

  const minuteMatch = raw.match(/(?:кажд(?:ые|ий|ую)?|раз\s+в|не\s+чаще\s+чем\s+раз\s+в|через)\s+(\d{1,3})\s*(?:мин|минут)/i);
  if (minuteMatch) {
    const mins = parseInt(minuteMatch[1], 10);
    let suggestedMax = mins <= 10 ? 12 : mins <= 30 ? 8 : mins <= 60 ? 6 : 4;
    setGap(mins, suggestedMax);
  }

  const hourMatch = raw.match(/(?:кажд(?:ые|ий|ую)?|раз\s+в|не\s+чаще\s+чем\s+раз\s+в|через)\s+(\d{1,2})\s*(?:ч|час|часа|часов)/i);
  if (hourMatch) {
    const h = parseInt(hourMatch[1], 10);
    setGap(h * 60, h <= 1 ? 6 : h == 2 ? 4 : 3);
  }

  if (!touched && /раз\s+в\s+час|кажд(?:ый|ые)?\s+час|почас/i.test(raw)) setGap(60, 6);
  if (!touched && !/(^|\s)не\s+чаще/i.test(raw) && (/(пиши|писать).*чаще/i.test(raw) || /чаще/i.test(raw))) {
    const cur = Number(current.min_gap_minutes || DEFAULT_PROACTIVE.min_gap_minutes);
    const next = cur > 60 ? 60 : cur > 30 ? 30 : 10;
    setGap(next, next <= 10 ? 12 : next <= 30 ? 8 : 6);
  }
  if (!touched && /(пиши|писать).*реже|реже/i.test(raw)) {
    const cur = Number(current.min_gap_minutes || DEFAULT_PROACTIVE.min_gap_minutes);
    const next = cur < 60 ? 60 : cur < 120 ? 120 : cur < 180 ? 180 : 360;
    setGap(next, next >= 360 ? 2 : next >= 180 ? 3 : 4);
  }

  const maxDayMatch = raw.match(/(?:не\s+чаще|максимум|до|лимит)\s+(\d{1,2})\s*(?:раз(?:а)?\s+)?(?:в\s+)?(?:день|сутки)/i)
    || raw.match(/(\d{1,2})\s*раз(?:а)?\s+в\s+(?:день|сутки)/i);
  if (maxDayMatch) {
    cfg.max_per_day = clamp(parseInt(maxDayMatch[1], 10), 1, 48);
    touched = true;
  }

  if (/только\s+важн|важное|important/i.test(raw)) { cfg.mode = "important_only"; touched = true; }
  if (/только\s+критич|критич/i.test(raw)) { cfg.mode = "critical_only"; touched = true; }
  if (/свободнее|обычн(?:ый|ом)?\s+режим|можешь\s+писать\s+свободнее/i.test(raw)) { cfg.mode = "normal"; touched = true; }

  if (/включ/i.test(raw) && /самостоятельн|сообщени|пиши/i.test(raw)) { cfg.enabled = true; touched = true; }
  if (/выключ|отключ|(^|\s)не\s+пиши/i.test(raw) && /самостоятельн|сообщени|сама|сам/i.test(raw)) { cfg.enabled = false; touched = true; }
  if (touched && cfg.enabled !== false && /пиши|писать|сообщени|самостоятельн/i.test(raw) && !/(^|\s)не\s+пиши|выключ|отключ/i.test(raw)) cfg.enabled = true;

  return touched ? cfg : null;
}

function applyProactiveConfig(state, cfg) {
  if (!cfg) return false;
  state.proactive = { ...DEFAULT_PROACTIVE, ...(state.proactive || {}) };
  if (typeof cfg.enabled === "boolean") state.proactive.enabled = cfg.enabled;
  if (cfg.mode) state.proactive.mode = String(cfg.mode);
  if (cfg.min_gap_minutes) state.proactive.min_gap_minutes = clamp(cfg.min_gap_minutes, 10, 1440);
  if (cfg.max_per_day) state.proactive.max_per_day = clamp(cfg.max_per_day, 1, 48);
  state.proactive.configured_at = now();
  return true;
}

function proactiveConfigSummary(state) {
  const p = state.proactive || DEFAULT_PROACTIVE;
  const stateTxt = p.enabled ? "включены" : "выключены";
  let mode = p.mode === "critical_only" ? "только критичное" : p.mode === "normal" ? "обычный" : "только важное";
  return `Самостоятельные сообщения: ${stateTxt}; режим: ${mode}; пауза: ${pluralHours(p.min_gap_minutes || 180)}; лимит: ${p.max_per_day || 3} в день.`;
}

function executeOp(state, op, arg) {
  if (!ALLOWED_OPS.has(op)) return null;
  const a = String(arg || "").slice(0, 500).trim();
  if (op === "none") return null;

  if (op === "memory.write") { addMemory(state, a, 75); return null; }

  if (op === "self.update") {
    if (a) {
      if (/скайнет/i.test(a)) state.self_model.name = "Скайнет";
      if (/джарвис/i.test(a)) state.self_model.role = "личный Джарвис Сергея";
      if (/умн|развив|самостоят|сверх/i.test(a)) state.self_model.goal = "становиться умнее, полезнее и самостоятельнее для Сергея";
      addMemory(state, a, 95);
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
    if (a) state.mistakes.push({ what: a, when: now() });
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
    applyProactiveConfig(state, proactiveConfigFromText(a, state.proactive));
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

// ============================================================ MAIN HANDLER
function memoryReport(state) {
  const open = state.tasks.filter(t => t.status !== "done");
  const mem = state.memory.slice(-10);
  const mistakes = state.mistakes.slice(-5);
  const p = state.proactive;
  return [
    `Я: ${state.self_model.name} — ${state.self_model.role}.`,
    `Цель: ${state.self_model.goal}.`,
    `Стиль: ${state.self_model.style}.`,
    "",
    "Память о тебе:",
    mem.length ? mem.map((m, i) => `${i + 1}. ${m.text || m.lesson}`).join("\n") : "пока пусто",
    "",
    "Открытые задачи:",
    open.length ? open.map((t, i) => `${i + 1}. ${t.title}`).join("\n") : "нет",
    "",
    "Ошибки/уроки:",
    mistakes.length ? mistakes.map((m, i) => `${i + 1}. ${m.what || m.lesson}`).join("\n") : "нет",
    "",
    `Самостоятельные сообщения: ${p.enabled ? "включены" : "выключены"}; режим ${p.mode}; пауза ${p.min_gap_minutes} мин.; сегодня ${p.sent_count || 0}/${p.max_per_day || 3}.`
  ].join("\n");
}

async function handle(env, c, chatId, userText, userId = "") {
  const state = await loadState(env);
  state.ownerChatId = String(chatId || state.ownerChatId || "");
  state.ownerUserId = String(userId || state.ownerUserId || "");
  state.dialogue.push({ role: "user", text: userText.slice(0, 500), t: now() });

  const low = userText.toLowerCase().trim();

  const directProactiveConfig = proactiveConfigFromText(low, state.proactive);
  if (directProactiveConfig) {
    applyProactiveConfig(state, directProactiveConfig);
    state.dialogue.push({ role: "bot", text: proactiveConfigSummary(state).slice(0, 500), t: now() });
    await saveState(env, state);
    await send(c, chatId, "Готово. " + proactiveConfigSummary(state));
    return;
  }

  if (/^\/?(статус|версия|status)$/.test(low)) {
    const open = state.tasks.filter(t => t.status !== "done").length;
    const p = state.proactive;
    await send(c, chatId, `Версия: ${VERSION}\nОткрытых задач: ${open}\nВ памяти: ${state.memory.length}\nОшибок/уроков: ${state.mistakes.length}\nСамостоятельные сообщения: ${p.enabled ? "on" : "off"} (${p.mode}, ${p.min_gap_minutes} мин., ${p.sent_count || 0}/${p.max_per_day || 3} сегодня)`);
    await saveState(env, state); return;
  }

  if (/что ты (сейчас )?думаешь|что у тебя в голове|покажи мысли/.test(low)) {
    const open = state.tasks.filter(t => t.status !== "done");
    const mem = pickMemory(state.memory, userText, 4);
    await send(c, chatId, [
      "Вот что у меня реально в голове сейчас:",
      `• я: ${state.self_model.name}, ${state.self_model.role}`,
      "• открытых задач: " + (open.length ? open.map(t => t.title).join("; ") : "нет"),
      "• помню о тебе: " + (mem.length ? mem.map(m => m.text || m.lesson).join("; ") : "пока мало"),
      "• самостоятельные сообщения: " + (state.proactive.enabled ? "включены" : "выключены"),
      "• о чём говорим: " + (state.dialogue.slice(-3, -1).map(d => d.text).join(" → ") || "начало")
    ].join("\n"));
    await saveState(env, state); return;
  }

  if (/покажи память|что ты помнишь|все записи|покажи все записи/.test(low)) {
    await send(c, chatId, memoryReport(state));
    await saveState(env, state); return;
  }

  if (/покажи задачи|открой задачи|мои задачи|список задач/.test(low)) {
    const open = state.tasks.filter(t => t.status !== "done");
    await send(c, chatId, open.length ? "Открытые задачи:\n" + open.map((t, i) => `${i + 1}. ${t.title}`).join("\n") : "Открытых задач нет.");
    await saveState(env, state); return;
  }

  const out = await runBrain(env, c, state, userText, { eventType: "user_message" });
  executeOp(state, out.op, out.arg);

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
        has: { telegram: !!c.telegram, model: !!c.openrouter, kv: !!c.kv, proactive_chat: !!c.chatId } }), { headers: H });
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
