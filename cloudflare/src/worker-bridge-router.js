import patchDialogWorker from "./worker-patch-dialog.js";
import improvementWorker from "./worker-improvement-runner.js";

const VERSION = "bridge-router-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function shouldRouteToImprovement(text) {
  const raw = String(text || "").trim();
  const low = raw.toLowerCase();
  if (low.startsWith("/improve_")) return true;
  if (["да", "yes", "y", "ок", "окей", "подтверждаю", "запускай", "делай", "нет", "no", "n", "не надо", "отмена", "cancel", "стоп"].includes(low)) return true;
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await patchDialogWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.bridge_router = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/improve_status", "/improve_review", "/improve_yes", "/improve_no", "/improve_clear", "/patch_dialog_status"])]
      }
      return json(d || { ok: true, bridge_router: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const m = getMsg(update);
      const raw = String(m?.text || "").trim();
      if (m && shouldRouteToImprovement(raw)) {
        return await improvementWorker.fetch(request, env, ctx);
      }
    }

    return await patchDialogWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await patchDialogWorker.scheduled(event, env, ctx);
  }
};
