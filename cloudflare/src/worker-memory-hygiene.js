import selfcheckWorker from "./worker-selfcheck.js";

const VERSION = "memory-hygiene-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  if (!env.TELEGRAM_BOT_TOKEN) {
    const v = await env.MINISKYNET_KV.get("config:TELEGRAM_BOT_TOKEN");
    if (v) env.TELEGRAM_BOT_TOKEN = String(v).trim();
  }
}

async function send(env, chatId, text) {
  await hydrate(env);
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  }).catch(() => null);
}

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function kvPut(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function textOfMemory(m) {
  return [m?.signal, m?.lesson, m?.action, m?.check, m?.boundary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function memoryKey(m) {
  return textOfMemory(m).replace(/[.!?,:;()\[\]{}]/g, "").slice(0, 220);
}

function isImportantMemory(m) {
  const t = textOfMemory(m);
  if (!t) return false;
  if (m?.tag === "identity_seed") return true;
  if ((m?.status === "rule" || m?.status === "fact") && t.length >= 45) return true;
  if (/не менять код без подтверждения|approve|alive|self-audit|task hygiene|memory hygiene|formatanswer|\[object object\]|worker-selfcheck|worker-v1|agent registry|не выдумывать файлы|grounded/.test(t)) return true;
  return false;
}

function isJunkMemory(m) {
  const t = textOfMemory(m);
  if (t.length < 45) return true;
  if (/память загружена|мониторинг важен|улучшить алгоритмы машинного обучения|недостаток практического опыта|собрать информацию|оптимизировать процессы|улучшить функциональность|адаптироваться к новым задачам/.test(t)) return true;
  if (/api key|openrouter key|telegram bot token|пароль|секрет|токен/.test(t)) return true;
  return false;
}

function cleanMemories(list) {
  const kept = [];
  const archived = [];
  const seen = new Set();

  for (const m of list) {
    const k = memoryKey(m);
    const duplicate = k && seen.has(k);
    const junk = isJunkMemory(m);
    const important = isImportantMemory(m);

    if (duplicate || (junk && !important)) {
      archived.push({
        ...m,
        archived_at: new Date().toISOString(),
        archived_reason: duplicate ? "duplicate" : "junk_or_generic"
      });
      continue;
    }

    if (k) seen.add(k);
    kept.push({
      ...m,
      hygiene_checked_at: new Date().toISOString()
    });
  }

  return {
    kept: kept.slice(-80),
    archived,
    removed: archived.length
  };
}

async function runMemoryHygiene(env, chatId) {
  const data = await kvGet(env, "memories", { memories: [] });
  const list = Array.isArray(data.memories) ? data.memories : [];
  const result = cleanMemories(list);

  await kvPut(env, "memories", { memories: result.kept });

  const oldArchive = await kvGet(env, "memory_archive", { memories: [] });
  const archiveList = Array.isArray(oldArchive.memories) ? oldArchive.memories : [];
  await kvPut(env, "memory_archive", { memories: archiveList.concat(result.archived).slice(-300) });

  await send(env, chatId, [
    "Memory hygiene готова.",
    `Было: ${list.length}`,
    `Осталось: ${result.kept.length}`,
    `Архивировано: ${result.removed}`,
    "Правило: оставляю только полезные правила, факты, ошибки и уроки про реальное ядро. Красивые общие фразы отправляю в архив."
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await selfcheckWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.memory_hygiene = VERSION;
        d.memory_hygiene_command = "/memory_hygiene";
      }
      return json(d || { ok: true, memory_hygiene: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();

      if (m && (text === "/memory_hygiene" || text === "почисти память" || text === "гигиена памяти")) {
        await runMemoryHygiene(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await selfcheckWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await selfcheckWorker.scheduled(event, env, ctx);
  }
};
