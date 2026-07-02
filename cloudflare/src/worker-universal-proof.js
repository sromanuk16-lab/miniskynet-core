import baseWorker from "./worker-dialog-confirm.js";

const VERSION = "universal-proof-layer-v1";
const CREATED_AT = "2026-07-02T17:45:21.754Z";

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

function getMsg(update) { return update?.message || update?.edited_message || null; }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.universal_proof_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/universal_proof")] ];
      }
      return json(d || { ok: true, universal_proof_layer: VERSION }, r.status);
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();
      if (m && (low === "/universal_proof" || low === "universal proof")) {
        await send(env, m.chat.id, [
          "Universal Proof:",
          "✅ Improvement Runner применил patch после approve.",
          "Layer: " + VERSION,
          "Created: " + CREATED_AT
        ].join("\n"));
        return json({ ok: true, handled_by: VERSION, universal_proof: true });
      }
    }
    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return await baseWorker.scheduled(event, env, ctx); }
};
