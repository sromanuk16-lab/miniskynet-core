import baseWorker from "./worker.js";

function routeNaturalText(text) {
  const t = String(text || "").trim();
  const low = t.toLowerCase();

  if (/^(память|memory|глянь память|покажи память|проверь память|что в памяти)/i.test(low)) {
    return "/memory";
  }
  if (/^(статус|status|как ты|ты жив|состояние)/i.test(low)) {
    return "/status";
  }
  if (/^(задачи|tasks|очередь|что в задачах)/i.test(low)) {
    return "/tasks";
  }
  if (/^(расход|cost|стоимость|токены|сколько потратил)/i.test(low)) {
    return "/cost";
  }
  if (/^(включи alive|включи авто|живой режим|alive on|автоцикл включи)/i.test(low)) {
    return "/alive_on";
  }
  if (/^(выключи alive|выключи авто|alive off|автоцикл выключи)/i.test(low)) {
    return "/alive_off";
  }

  return "/think " + t;
}

function patchText(update, nextText) {
  const message = update.message || update.edited_message;
  const patchedMessage = { ...message, text: nextText };
  if (update.message) return { ...update, message: patchedMessage };
  return { ...update, edited_message: patchedMessage };
}

function asNaturalUpdate(update) {
  const message = update.message || update.edited_message;
  const text = String(message?.text || "").trim();
  if (!message || !text || text.startsWith("/")) return null;
  return patchText(update, routeNaturalText(text));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const response = await baseWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.wrapper = "natural-chat-v0.2";
        data.natural_chat = true;
        data.natural_routes = ["memory", "status", "tasks", "cost", "alive_on", "alive_off", "think"];
      }
      return new Response(JSON.stringify(data, null, 2), {
        status: response.status,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const patched = update ? asNaturalUpdate(update) : null;
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
