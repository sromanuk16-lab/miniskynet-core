import coreWorker from "./worker-v1.js";

const VERSION = "selfcheck-v1";

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
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  }).catch(() => null);
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function selfCheckText() {
  return [
    "Уровень: Clean Core.",
    "Слабость: ответ модели может прийти объектом, а ядро выводит его как [object Object].",
    "Следующее изменение: в cloudflare/src/worker-v1.js добавить formatter для parsed.answer и строгий текстовый формат self-check.",
    "Риск: можно сломать обычные ответы, если неправильно обработать JSON.",
    "Проверка: команда /self_audit должна вернуть эти 5 строк нормальным текстом, без [object Object]."
  ].join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await coreWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") d.selfcheck_wrapper = VERSION;
      return json(d || { ok: true, selfcheck_wrapper: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();
      if (m && (text === "/self_audit" || text === "/grow_one" || text === "самоаудит" || text === "проверь себя")) {
        await send(env, m.chat.id, selfCheckText());
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await coreWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return;
  }
};
