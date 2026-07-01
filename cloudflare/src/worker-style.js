import intentWorker from "./worker-intent.js";

const WRAP = "style-feedback-v0.8";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function msgOf(update) {
  return update?.message || update?.edited_message || null;
}

function patch(update, text) {
  const msg = msgOf(update);
  const nextMsg = { ...msg, text };
  if (update.message) return { ...update, message: nextMsg };
  return { ...update, edited_message: nextMsg };
}

function isStyleFeedback(text) {
  return /сухо|живее|теплее|человечнее|короче|меньше воды|маленькая лондон|лондон/i.test(String(text || ""));
}

function styleTask(text) {
  return [
    "Это обратная связь Сергея по стилю общения MiniSkynet.",
    "Сохрани Memory Artifact со статусом rule.",
    "Новое правило: отвечать живее, теплее, короче, как маленькая облачная Лондон Сергея.",
    "В ответе не пересказывай архитектуру. Просто подтверди, что стиль обновлён, и покажи один пример нового тона.",
    "Текст обратной связи:",
    String(text || "")
  ].join("\n");
}

async function transformedRequest(request, update) {
  const next = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(update)
  });
  return next;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const response = await intentWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.style_feedback = true;
        data.style_wrapper = WRAP;
      }
      return json(data, response.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const msg = msgOf(update);
      const text = String(msg?.text || "").trim();
      if (msg && text && !text.startsWith("/") && isStyleFeedback(text)) {
        const patched = patch(update, "/think " + styleTask(text));
        return await intentWorker.fetch(await transformedRequest(request, patched), env, ctx);
      }
    }

    return await intentWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await intentWorker.scheduled(event, env, ctx);
  }
};
