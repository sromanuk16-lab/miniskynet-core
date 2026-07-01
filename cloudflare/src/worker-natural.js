import baseWorker from "./worker.js";

function asNaturalThinkUpdate(update) {
  const message = update.message || update.edited_message;
  const text = String(message?.text || "").trim();

  if (!message || !text || text.startsWith("/")) {
    return null;
  }

  const patchedMessage = {
    ...message,
    text: "/think " + text
  };

  if (update.message) {
    return { ...update, message: patchedMessage };
  }
  return { ...update, edited_message: patchedMessage };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const response = await baseWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.wrapper = "natural-chat-v0.1";
        data.natural_chat = true;
      }
      return new Response(JSON.stringify(data, null, 2), {
        status: response.status,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const patched = update ? asNaturalThinkUpdate(update) : null;

      if (patched) {
        const patchedRequest = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(patched)
        });
        return await baseWorker.fetch(patchedRequest, env, ctx);
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
