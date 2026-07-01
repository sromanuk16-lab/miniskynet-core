import memoryWorker from "./worker-memory.js";

const WRAPPER = "quality-gate-v0.5";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return env;
  for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]) {
    if (!env[key]) {
      const value = await env.MINISKYNET_KV.get("config:" + key);
      if (value) env[key] = String(value).trim();
    }
  }
  return env;
}

function allowed(env, userId) {
  const owner = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}

async function send(env, chatId, text) {
  await hydrate(env);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  });
  return await res.json().catch(() => ({}));
}

async function readMem(env) {
  const raw = await env.MINISKYNET_KV.get("memories");
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data.memories) ? data.memories : [];
  } catch (_) {
    return [];
  }
}

async function writeMem(env, list) {
  await env.MINISKYNET_KV.put("memories", JSON.stringify({ memories: list.slice(-200) }, null, 2));
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[.,!?;:]/g, "").trim();
}

function keyOf(m) {
  return norm((m.lesson || "") + " " + (m.action || "")).slice(0, 180);
}

function junkReason(m) {
  if (!m || typeof m !== "object") return "not object";
  if (m.tag === "identity_seed") return "";
  const lesson = norm(m.lesson || "");
  const action = norm(m.action || "");
  const signal = norm(m.signal || "");
  const all = `${signal} ${lesson} ${action}`;
  if ((lesson + action).length < 28) return "too short";
  if (/память загружена|memory loaded/.test(all)) return "fake memory action";
  if (/мониторинг важен для оптимизации/.test(all)) return "generic monitoring phrase";
  if (/улучшить алгоритмы машинного обучения|machine learning algorithms/.test(all)) return "generic ML phrase";
  if (/сделать один полезный шаг|следующий маленький шаг/.test(all) && all.length < 140) return "generic next-step phrase";
  if (/api key|openrouter key|telegram bot token|парол|токен/.test(all)) return "secret-like memory";
  return "";
}

function qualityStats(list) {
  const byStatus = {};
  const seen = new Set();
  let junk = 0;
  let duplicates = 0;
  let scoreSum = 0;

  for (const m of list) {
    byStatus[m.status || "unknown"] = (byStatus[m.status || "unknown"] || 0) + 1;
    scoreSum += Number(m.score || 0);
    if (junkReason(m)) junk += 1;
    const k = keyOf(m);
    if (k && seen.has(k)) duplicates += 1;
    if (k) seen.add(k);
  }

  return {
    total: list.length,
    avg_score: list.length ? Math.round(scoreSum / list.length) : 0,
    junk,
    duplicates,
    byStatus
  };
}

function compact(list) {
  const kept = [];
  const seen = new Map();
  const removed = [];

  for (const m of list) {
    const reason = junkReason(m);
    if (reason) {
      removed.push({ reason, memory: m });
      continue;
    }

    const k = keyOf(m);
    if (!k) {
      removed.push({ reason: "empty key", memory: m });
      continue;
    }

    if (seen.has(k)) {
      const oldIndex = seen.get(k);
      const old = kept[oldIndex];
      const oldScore = Number(old.score || 0);
      const newScore = Number(m.score || 0);
      if (newScore >= oldScore) {
        removed.push({ reason: "duplicate older", memory: old });
        kept[oldIndex] = m;
      } else {
        removed.push({ reason: "duplicate weaker", memory: m });
      }
      continue;
    }

    seen.set(k, kept.length);
    kept.push(m);
  }

  return { kept, removed };
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function detect(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["/memory_stats"].includes(t) || /^(статистика памяти|память статистика)/i.test(t)) return "stats";
  if (["/memory_audit"].includes(t) || /^(проверь качество памяти|аудит памяти|проверь память)$/i.test(t)) return "audit";
  if (["/memory_compact"].includes(t) || /^(сожми память|почисти память|уплотни память)/i.test(t)) return "compact";
  return "";
}

async function handle(env, msg, action) {
  await hydrate(env);
  if (!env.MINISKYNET_KV || !env.TELEGRAM_BOT_TOKEN) return false;
  if (!allowed(env, msg.from?.id)) {
    await send(env, msg.chat.id, "Доступ закрыт. Этот MiniSkynet привязан к владельцу.");
    return true;
  }

  const list = await readMem(env);
  const stats = qualityStats(list);

  if (action === "stats") {
    await send(env, msg.chat.id, `Memory stats\nВсего: ${stats.total}\nСредний score: ${stats.avg_score}\nМусорных: ${stats.junk}\nДублей: ${stats.duplicates}\nСтатусы: ${JSON.stringify(stats.byStatus)}`);
    return true;
  }

  if (action === "audit") {
    const bad = list.map((m, i) => ({ i: i + 1, reason: junkReason(m), m })).filter(x => x.reason).slice(0, 8);
    const text = bad.length
      ? bad.map(x => `${x.i}. ${x.reason}: ${(x.m.lesson || x.m.signal || "без описания").slice(0, 120)}`).join("\n")
      : "Память выглядит чисто: явного мусора и секретов не вижу.";
    await send(env, msg.chat.id, `Memory audit\nВсего: ${stats.total}\nМусорных: ${stats.junk}\nДублей: ${stats.duplicates}\n\n${text}`);
    return true;
  }

  if (action === "compact") {
    const result = compact(list);
    await writeMem(env, result.kept);
    await send(env, msg.chat.id, `Память сжата. Было: ${list.length}, стало: ${result.kept.length}, удалено: ${result.removed.length}.`);
    return true;
  }

  return false;
}

async function autoClean(env) {
  if (!env.MINISKYNET_KV) return;
  const list = await readMem(env);
  const result = compact(list);
  if (result.removed.length) await writeMem(env, result.kept);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const response = await memoryWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.quality_gate = true;
        data.quality_wrapper = WRAPPER;
        data.quality_commands = ["/memory_stats", "/memory_audit", "/memory_compact"];
      }
      return json(data, response.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const msg = getMsg(update);
      const action = detect(msg?.text || "");
      if (msg && action) {
        const done = await handle(env, msg, action);
        if (done) return json({ ok: true, handled_by: WRAPPER, action });
      }
      const response = await memoryWorker.fetch(request, env, ctx);
      ctx.waitUntil(autoClean(env));
      return response;
    }

    return await memoryWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(memoryWorker.scheduled(event, env, ctx));
    ctx.waitUntil(autoClean(env));
  }
};
