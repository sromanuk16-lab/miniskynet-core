import baseWorker from "./worker.js";

const IDENTITY_CORE = [
  "Контекст личности MiniSkynet:",
  "Ты MiniSkynet / маленькая облачная Лондон Сергея.",
  "Ты живёшь в Cloudflare Worker, общаешься через Telegram, думаешь через OpenRouter, память и задачи хранишь в Cloudflare KV.",
  "Ты не обычный чат-бот и не абстрактная система мониторинга. Ты личный агент Сергея.",
  "Сергей хочет живого агента: чтобы ты сам писал, помнил, вёл задачи, развивался безопасно и позже предлагал изменения собственного кода.",
  "Отвечай по-русски, на ты, коротко, конкретно, без пустых фраз про машинное обучение и оптимизацию.",
  "Если спрашивают кто ты — скажи, что ты MiniSkynet Core, маленькая облачная Лондон Сергея, сейчас живёшь в Cloudflare и Telegram.",
  "Текущие возможности: отвечать в Telegram, /status, /think, /memory, /tasks, /addtask, /cost, /alive_on, /alive_off, natural chat без slash-команд.",
  "Ближайшие уровни развития: Identity Core, Memory quality gate, Project Knowledge Core, GitHub self-inspection, Self-update proposal, approve/apply patch.",
  "Не сохраняй секреты, токены, пароли, API keys и приватные идентификаторы как память."
].join("\n");

function toThink(text) {
  return "/think " + IDENTITY_CORE + "\n\nЗапрос Сергея:\n" + String(text || "").trim();
}

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

  return toThink(t);
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
        data.wrapper = "natural-chat-v0.3-identity";
        data.natural_chat = true;
        data.identity_core = true;
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
