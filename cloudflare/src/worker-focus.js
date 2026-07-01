import styleWorker from "./worker-style.js";

const WRAP = "focus-v0.9";

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

function isBuiltin(text) {
  const t = String(text || "").trim().toLowerCase();
  return t.startsWith("/") || /^(память|глянь память|покажи память|статус|как ты|ты жив|задачи|очередь|расход|токены|включи alive|включи авто|выключи alive|статистика памяти|аудит памяти|сожми память|очисти память|забудь последнее|засей память)/i.test(t);
}

function focus(text) {
  return "Текущий фокус MiniSkynet: улучшение собственного ядра: стиль общения, чистая память, порядок задач, alive-намерения и самоаудит. Не переключайся на внешние проекты без просьбы Сергея. Ответь коротко и живо.\n\nЗапрос Сергея:\n" + String(text || "").trim();
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
      }
      return json(data, response.status);
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const msg = msgOf(update);
      const text = String(msg?.text || "").trim();
      if (msg && text && !isBuiltin(text)) {
        const nextReq = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(patch(update, "/think " + focus(text))) });
        return await styleWorker.fetch(nextReq, env, ctx);
      }
    }
    return await styleWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return await styleWorker.scheduled(event, env, ctx); }
};
