import styleWorker from "./worker-style.js";

const WRAP = "focus-v0.9.1-safe";
const THINK_LOCK_MS = 90000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function msgOf(update) { return update?.message || update?.edited_message || null; }

function patch(update, text) {
  const msg = msgOf(update);
  const next = { ...msg, text };
  if (update.message) return { ...update, message: next };
  return { ...update, edited_message: next };
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return env;
  if (!env.TELEGRAM_BOT_TOKEN) {
    const token = await env.MINISKYNET_KV.get("config:TELEGRAM_BOT_TOKEN");
    if (token) env.TELEGRAM_BOT_TOKEN = String(token).trim();
  }
  return env;
}

async function send(env, chatId, text) {
  await hydrate(env);
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  }).catch(() => null);
}

function isBuiltin(text) {
  const t = String(text || "").trim().toLowerCase();
  return t.startsWith("/") || /^(память|глянь память|покажи память|статус|как ты|ты жив|состояние|задачи|очередь|расход|токены|включи alive|включи авто|выключи alive|статистика памяти|аудит памяти|сожми память|очисти память|забудь последнее|засей память)/i.test(t);
}

function emergencyRoute(text) {
  const t = String(text || "").trim().toLowerCase();
  if (/^(стоп|stop|хватит|остановись|не думай|выключи автообучение)$/i.test(t)) return "/alive_off";
  if (/^(ты тут|тут|ping|пинг|живой|жива)$/i.test(t)) return "/status";
  return "";
}

function focus(text) {
  return "Текущий фокус MiniSkynet: улучшение собственного ядра: стиль общения, чистая память, порядок задач, alive-намерения и самоаудит. Не переключайся на внешние проекты без просьбы Сергея. Ответь коротко и живо.\n\nЗапрос Сергея:\n" + String(text || "").trim();
}

async function isLocked(env) {
  if (!env.MINISKYNET_KV) return false;
  const raw = await env.MINISKYNET_KV.get("runtime:think_lock_ms");
  const ts = Number(raw || 0);
  return ts && Date.now() - ts < THINK_LOCK_MS;
}

async function lock(env) {
  if (env.MINISKYNET_KV) await env.MINISKYNET_KV.put("runtime:think_lock_ms", String(Date.now()), { expirationTtl: 120 });
}

async function unlock(env) {
  if (env.MINISKYNET_KV) await env.MINISKYNET_KV.delete("runtime:think_lock_ms").catch(() => null);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const response = await styleWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.focus_wrapper = WRAP;
        data.focus = "core_improvement";
        data.think_lock_ms = THINK_LOCK_MS;
        data.emergency_routes = ["стоп -> /alive_off", "ты тут -> /status"];
      }
      return json(data, response.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const msg = msgOf(update);
      const text = String(msg?.text || "").trim();
      if (msg && text) {
        const emergency = emergencyRoute(text);
        if (emergency) {
          const nextReq = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(patch(update, emergency)) });
          return await styleWorker.fetch(nextReq, env, ctx);
        }

        if (!isBuiltin(text)) {
          if (await isLocked(env)) {
            await send(env, msg.chat.id, "Серёга, я уже думаю над прошлым запросом. Второй параллельный запуск не делаю, чтобы не зависнуть и не жечь токены.");
            return json({ ok: true, handled_by: WRAP, skipped: "think_lock" });
          }
          await lock(env);
          try {
            const nextReq = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(patch(update, "/think " + focus(text))) });
            return await styleWorker.fetch(nextReq, env, ctx);
          } catch (err) {
            await send(env, msg.chat.id, "Я споткнулась на запросе. Зафиксировала сбой, дальше буду думать только по одному запросу за раз.");
            return json({ ok: false, handled_by: WRAP, error: String(err).slice(0, 500) }, 500);
          } finally {
            ctx.waitUntil(unlock(env));
          }
        }
      }
    }

    return await styleWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return await styleWorker.scheduled(event, env, ctx); }
};
