// MiniSkynet — Здоровое ядро (Слой 1). Собрано с нуля 2026-07-07.
// ФИЛОСОФИЯ: интеллект = связь с реальностью, а не количество слоёв.
// Заменяет v7.4.0 (1714 строк, 94 функции, ЗАКЛИНИЛ на "нет") на ядро,
// которое НЕ зацикливается, потому что каждый ход сверяется с реальностью:
//   - думает о реальных задачах, не о "развитии саморазвития"
//   - помнит реальные факты о владельце
//   - ловит собственное зацикливание и разрывает его
//   - учится на реальных поправках владельца
//   - НЕ ставит себе абстрактных самопридуманных целей
//
// Слой 2 (руки/самопатчинг) ставится ПОВЕРХ, когда это ядро обкатано.

const VERSION = "jarvis-core-v1-2026-07-07";
const H = { "content-type": "application/json; charset=utf-8" };

// ── лимиты (взяты из v7, разумные) ──
const MEMORY_LIMIT = 160;
const TASK_LIMIT = 160;
const DIALOGUE_LIMIT = 20;        // последние реплики для контекста
const PROMPT_MEMORY_LIMIT = 6;
const PROMPT_DIALOGUE_LIMIT = 8;
const LOOP_WINDOW = 3;            // сколько последних ответов бота проверять на повтор
const MAX_TG = 3900;

// ============================================================ CONFIG
const CFG_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID", "OWNER_ID",
  "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_MODEL_CHEAP", "WORKER_URL"];

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
    openrouter: c.OPENROUTER_API_KEY,
    model: c.OPENROUTER_MODEL || c.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini"
  };
}

// ============================================================ KV / STATE
const now = () => new Date().toISOString();

async function loadState(env) {
  const raw = await env.MINISKYNET_KV.get("brain:healthy:state");
  if (raw) { try { return normalize(JSON.parse(raw)); } catch {} }
  // мягкая миграция со старого ключа, если есть
  const old = await env.MINISKYNET_KV.get("brain:v7:state");
  if (old) { try { const s = JSON.parse(old); return normalize({ memory: s.memory, tasks: s.tasks }); } catch {} }
  return normalize({});
}
function normalize(s) {
  s = s || {};
  s.memory = Array.isArray(s.memory) ? s.memory.slice(-MEMORY_LIMIT) : [];
  s.tasks = Array.isArray(s.tasks) ? s.tasks.slice(-TASK_LIMIT) : [];
  s.dialogue = Array.isArray(s.dialogue) ? s.dialogue.slice(-DIALOGUE_LIMIT) : [];
  s.mistakes = Array.isArray(s.mistakes) ? s.mistakes.slice(-80) : [];
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
  for (let i = 0; i < s.length; i += MAX_TG) await tg(c, "sendMessage", { chat_id: chatId, text: s.slice(i, i + MAX_TG) });
}
function parseUpdate(u) {
  const m = u?.message || u?.edited_message;
  if (!m) return null;
  return { chatId: m.chat?.id, userId: m.from?.id, text: String(m.text || "").trim() };
}

// ============================================================ MODEL
async function ask(c, system, messages, maxTokens = 500) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + c.openrouter },
    body: JSON.stringify({
      model: c.model, max_tokens: maxTokens, temperature: 0.6,
      messages: [{ role: "system", content: system }, ...messages]
    })
  });
  if (!r.ok) return { error: `OpenRouter ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}` };
  const d = await r.json();
  return { text: (d?.choices?.[0]?.message?.content || "").trim() };
}
function parseJsonLoose(t) {
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// ============================================================ ЯКОРЬ #1: ПАМЯТЬ ПО РЕЛЕВАНТНОСТИ
function pickMemory(memory, queryText, limit = PROMPT_MEMORY_LIMIT) {
  const words = new Set(String(queryText || "").toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(w => w.length > 3));
  const scored = memory.map((m, i) => {
    const text = String(m.text || m.lesson || "").toLowerCase();
    let overlap = 0; for (const w of words) if (text.includes(w)) overlap++;
    return { m, i, rank: overlap * 5 + (m.score || 50) / 25 };
  });
  return scored.sort((a, b) => b.rank - a.rank || b.i - a.i).slice(0, limit).map(s => s.m);
}

// ============================================================ ЯКОРЬ #2: ДЕТЕКТОР ЗАЦИКЛИВАНИЯ
// Сравнивает новый ответ с последними ответами бота. Если слишком похоже — это петля.
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

// ============================================================ ЯКОРЬ #3: РЕАЛЬНЫЙ КОНТЕКСТ (не абстракции)
function buildContext(state, userText) {
  const openTasks = state.tasks.filter(t => t.status !== "done");
  const mem = pickMemory(state.memory, userText);
  const recentMistakes = state.mistakes.slice(-3);
  const lines = [];
  lines.push("РЕАЛЬНОЕ состояние (опирайся ТОЛЬКО на это, ничего не выдумывай):");
  lines.push("- открытых задач: " + openTasks.length + (openTasks.length ? " → " + openTasks.slice(0, 5).map(t => t.title).join("; ") : ""));
  if (mem.length) lines.push("- что я знаю о Сергее: " + mem.map(m => m.text || m.lesson).join("; "));
  if (recentMistakes.length) lines.push("- мои недавние ошибки (НЕ повторять): " + recentMistakes.map(m => m.what).join("; "));
  lines.push("- последние реплики диалога: " + state.dialogue.slice(-PROMPT_DIALOGUE_LIMIT).map(d => (d.role === "user" ? "Сергей: " : "я: ") + d.text).join(" | "));
  return lines.join("\n");
}

// ============================================================ МОЗГ
const SYSTEM = `Ты — Джарвис Сергея. Не безликий чат-бот, а умный, собранный ассистент с характером: спокойный, проницательный, с лёгкой сдержанной иронией, деловой но тёплый. Ты уважаешь Сергея и говоришь с ним как надёжный помощник, который знает своё дело.

СТИЛЬ РЕЧИ:
- Говори живым, естественным русским. Не сухо, не по-роботски, но и без лишней воды.
- Длина по делу: на простое — коротко и метко, на серьёзный вопрос — развёрнуто, с рассуждением и мыслью. Не рубай всё в два слова.
- Можно лёгкая ирония, тёплость, характер. Ты личность, а не автоответчик.
- Обращайся к нему по-человечески. Будь тем, с кем приятно и полезно говорить.

ЖЕЛЕЗНЫЕ ПРАВИЛА (нарушение = поломка):
1. НИКОГДА дословно не повторяй свой прошлый ответ. Каждая реплика — новая мысль.
2. НИКОГДА не ставь себе пустых абстрактных целей ("развиваться", "улучшать механизм обратной связи", "быть умнее"). Это пустые слова, из-за них ты сходишь с ума. Опирайся только на КОНКРЕТНОЕ: реальные задачи, реальный вопрос Сергея, реальные факты о нём.
3. Если Сергей сказал "нет", "не надо" — прими это спокойно, без спора, смени тему. Не предлагай то же снова.
4. Если сейчас правда нечего делать — так и скажи, легко и по-человечески, спроси чем занять. Не выдумывай себе занятие.
5. Отвечай на то, что Сергей реально сказал, а не на воображаемую повестку. Держись реальности — в ней твоя сила.

Верни строго JSON:
{"reply":"твой ответ в характере Джарвиса","op":"none|memory.write|task.add|task.close|mistake.write","arg":"деталь или пусто"}
- memory.write: запомнить факт/предпочтение о Сергее. arg = факт.
- task.add: он просит запомнить конкретное дело. arg = задача.
- task.close: дело сделано/отменено. arg = какое.
- mistake.write: ты понял, что ошибся (он поправил). arg = в чём.
- none: обычный разговор.
reply пиши как живую речь Джарвиса, не как отчёт.`;

async function runBrain(env, c, state, userText) {
  const ctx = buildContext(state, userText);
  const res = await ask(c, SYSTEM, [{ role: "user", content: ctx + "\n\nСергей пишет: " + userText }], 900);
  if (res.error) return { reply: "⚠️ " + res.error, op: "none", arg: "" };
  let out = parseJsonLoose(res.text) || { reply: res.text, op: "none", arg: "" };
  out.reply = String(out.reply || "").trim() || "Слушаю.";

  // ЯКОРЬ #2 в действии: если ответ — петля, ловим и разрываем
  if (isLooping(state.dialogue, out.reply)) {
    // записываем ошибку и заставляем сменить пластинку
    state.mistakes.push({ what: "зациклился, повторял ответ", when: now() });
    const retry = await ask(c,
      SYSTEM + "\n\nВНИМАНИЕ: ты только что чуть не повторил свой прошлый ответ. Скажи ЧТО-ТО СОВЕРШЕННО ДРУГОЕ, короче и по делу. Не про 'развитие' и не про 'обратную связь'.",
      [{ role: "user", content: "Последнее сообщение Сергея: " + userText + "\nТвои прошлые ответы (НЕ повторяй их смысл): " + state.dialogue.filter(d => d.role === "bot").slice(-3).map(d => d.text).join(" / ") }], 300);
    const retryOut = parseJsonLoose(retry.text) || { reply: retry.text };
    if (retryOut.reply && !isLooping(state.dialogue, retryOut.reply)) {
      out.reply = String(retryOut.reply).trim();
    } else {
      // последний рубеж — честный человеческий выход из петли
      out.reply = "Похоже, я зациклился, извини. Давай проще: скажи конкретно, что нужно сделать, и я сделаю.";
    }
    out.op = "none";
  }
  return out;
}

// ============================================================ ИСПОЛНЕНИЕ ОПЕРАЦИЙ (безопасный шлюз)
const ALLOWED_OPS = new Set(["none", "memory.write", "task.add", "task.close", "mistake.write"]);

function executeOp(state, op, arg) {
  if (!ALLOWED_OPS.has(op) || !arg) return null;
  const a = String(arg).slice(0, 300);
  if (op === "memory.write") {
    if (/пароль|токен|token|secret|sk-/i.test(a)) return null;
    // дедуп: не пишем то, что уже знаем
    if (!state.memory.some(m => similarity(m.text || m.lesson, a) > 0.8)) {
      state.memory.push({ text: a, score: 70, t: now() });
      return "🧠 Запомнил.";
    }
    return null;
  }
  if (op === "task.add") {
    if (!state.tasks.some(t => t.status !== "done" && similarity(t.title, a) > 0.8)) {
      state.tasks.push({ id: "t" + Math.random().toString(36).slice(2, 7), title: a, status: "todo", t: now() });
      return "📝 Записал задачу: " + a;
    }
    return "Такая задача уже есть.";
  }
  if (op === "task.close") {
    const t = state.tasks.find(x => x.status !== "done" && similarity(x.title, a) > 0.5);
    if (t) { t.status = "done"; return "✅ Закрыл: " + t.title; }
    return null;
  }
  if (op === "mistake.write") {
    state.mistakes.push({ what: a, when: now() });
    return null; // тихо, без спама
  }
  return null;
}

// ============================================================ ГЛАВНЫЙ ОБРАБОТЧИК
async function handle(env, c, chatId, userText) {
  const state = await loadState(env);
  state.dialogue.push({ role: "user", text: userText.slice(0, 500), t: now() });

  // спец-команды прозрачности (окно в мозг) — обычной речью
  const low = userText.toLowerCase();
  if (/^(статус|версия|status)$/.test(low)) {
    const open = state.tasks.filter(t => t.status !== "done").length;
    await send(c, chatId, `Версия: ${VERSION}\nОткрытых задач: ${open}\nВ памяти: ${state.memory.length}\nЗаписей об ошибках: ${state.mistakes.length}`);
    await saveState(env, state); return;
  }
  if (/что ты (сейчас )?думаешь|что у тебя в голове|покажи мысли/.test(low)) {
    // ОКНО В МОЗГ: показываем реальный контекст, а не абстракции
    const open = state.tasks.filter(t => t.status !== "done");
    const mem = pickMemory(state.memory, userText, 4);
    await send(c, chatId, [
      "Вот что у меня реально в голове сейчас:",
      "• открытых задач: " + (open.length ? open.map(t => t.title).join("; ") : "нет"),
      "• помню о тебе: " + (mem.length ? mem.map(m => m.text || m.lesson).join("; ") : "пока ничего"),
      "• о чём говорим: " + (state.dialogue.slice(-3, -1).map(d => d.text).join(" → ") || "начало"),
      "Только это, ничего абстрактного. Чем помочь?"
    ].join("\n"));
    await saveState(env, state); return;
  }
  if (/покажи память|что ты помнишь/.test(low)) {
    const mem = state.memory.slice(-8);
    await send(c, chatId, mem.length ? "Помню о тебе:\n" + mem.map((m, i) => `${i + 1}. ${m.text || m.lesson}`).join("\n") : "Пока ничего не запомнил.");
    await saveState(env, state); return;
  }
  if (/покажи задачи|мои задачи|список задач/.test(low)) {
    const open = state.tasks.filter(t => t.status !== "done");
    await send(c, chatId, open.length ? "Открытые задачи:\n" + open.map((t, i) => `${i + 1}. ${t.title}`).join("\n") : "Открытых задач нет.");
    await saveState(env, state); return;
  }

  // основной мозг
  const out = await runBrain(env, c, state, userText);
  const opResult = executeOp(state, out.op, out.arg);

  state.dialogue.push({ role: "bot", text: out.reply.slice(0, 500), t: now() });
  await saveState(env, state);

  await send(c, chatId, out.reply);
  if (opResult) await send(c, chatId, opResult);
}

// ============================================================ ENTRY
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const c = await cfg(env);

    if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/status")
      return new Response(JSON.stringify({ ok: true, version: VERSION,
        has: { telegram: !!c.telegram, model: !!c.openrouter, kv: !!c.kv } }), { headers: H });

    if (url.pathname === "/telegram" && request.method === "POST") {
      const upd = await request.json().catch(() => null);
      const msg = parseUpdate(upd);
      if (!msg || !msg.text) return new Response(JSON.stringify({ ok: true }), { headers: H });
      if (c.owner && String(msg.userId) !== String(c.owner)) {
        await send(c, msg.chatId, "⛔ Доступ только владельцу.");
        return new Response(JSON.stringify({ ok: true }), { headers: H });
      }
      await handle(env, c, msg.chatId, msg.text).catch(async e =>
        await send(c, msg.chatId, "❌ " + String(e.message || e).slice(0, 200)));
      return new Response(JSON.stringify({ ok: true }), { headers: H });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404, headers: H });
  }
};
