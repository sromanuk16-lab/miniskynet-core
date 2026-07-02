import baseWorker from "./worker-level-sync.js";

const VERSION = "version-chain-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
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

function getMsg(update) { return update?.message || update?.edited_message || null; }

function chainText() {
  return [
    "MiniSkynet Version Chain:",
    "core → selfcheck → memory hygiene → agents → codemap → inspector",
    "→ queue mission → file operation → repo operation",
    "→ github ready → github commit → proof stage → level sync → version chain",
    "",
    "Status: active proof command works.",
    "Version: " + VERSION
  ].join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.version_chain_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/version_chain"])]
      }
      return json(d || { ok: true, version_chain_layer: VERSION }, r.status);
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();
      if (m && (text === "/version_chain" || text === "version chain" || text === "цепочка версий")) {
        await send(env, m.chat.id, chainText());
        return json({ ok: true, handled_by: VERSION, version_chain: true });
      }
    }
    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
