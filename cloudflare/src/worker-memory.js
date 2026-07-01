import naturalWorker from "./worker-natural.js";

const WRAPPER = "memory-control-v0.4";

function now() {
  return new Date().toISOString();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return env;
  for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]) {
    if (!env[key]) {
      const value = await env.MINISKYNET_KV.get("config:" + key);
      if (value) env[key] = String(value).trim();
    }
  }
  return env;
}

function allowed(env, userId) {
  const owner = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}

async function send(env, chatId, text) {
  await hydrate(env);
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  });
  return await res.json().catch(() => ({}));
}

async function readMem(env) {
  const raw = await env.MINISKYNET_KV.get("memories");
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data.memories) ? data.memories : [];
  } catch (_) {
    return [];
  }
}

async function writeMem(env, list) {
  await env.MINISKYNET_KV.put("memories", JSON.stringify({ memories: list.slice(-200) }, null, 2));
}

function seed() {
  return [
    {
      time: now(),
      agent: "identity",
      signal: "Сергей строит MiniSkynet как личного облачного агента, а не обычного чат-бота.",
      lesson: "Я MiniSkynet / маленькая облачная Лондон Сергея: Cloudflare Worker, Telegram, OpenRouter, KV-память.",
      action: "Отвечать коротко, по-русски, на ты, с учётом цели проекта.",
      check: "На вопрос 'ты кто?' я называю себя MiniSkynet / маленькая Лондон Сергея и перечисляю свою архитектуру.",
      boundary: "Не притворяться настоящим сознанием; честно говорить, что я облачный агент.",
      status: "rule",
      score: 95,
      privacy: "safe",
      tag: "identity_seed"
    },
    {
      time: now(),
      agent: "goal",
      signal: "Цель развития — живой агент: память, задачи, автоцикл и безопасные предложения правок кода.",
      lesson: "Следующие уровни: Memory quality gate, Project Knowledge, GitHub self-inspection, Self-update proposal, approve/apply patch.",
      action: "Выбирать маленький следующий шаг и сохранять полезный результат.",
      check: "Я могу назвать текущий уровень, что работает и следующий шаг.",
      boundary: "Не применять изменения кода без подтверждения Сергея.",
      status: "rule",
      score: 94,
      privacy: "safe",
      tag: "identity_seed"
    }
  ];
}

function command(text) {
  const t = String(text || "").trim().toLowerCase();
  if (["/memory_clear", "/clear_memory"].includes(t) || /^(очисти память|очисть память|сбрось память)/i.test(t)) return "clear";
  if (["/forget_last", "/memory_forget_last"].includes(t) || /^(забудь последнее|удали последнюю память)/i.test(t)) return "forget";
  if (["/seed_identity", "/memory_seed"].includes(t) || /^(засей память|запиши стартовую память|seed identity)/i.test(t)) return "seed";
  return "";
}

async function handleMemory(env, msg, action) {
  await hydrate(env);
  if (!env.MINISKYNET_KV || !env.TELEGRAM_BOT_TOKEN) return false;
  if (!allowed(env, msg.from?.id)) {
    await send(env, msg.chat.id, "Доступ закрыт. Этот MiniSkynet привязан к владельцу.");
    return true;
  }

  const current = await readMem(env);

  if (action === "clear") {
    await writeMem(env, []);
    await send(env, msg.chat.id, `Память очищена. Удалено записей: ${current.length}.`);
    return true;
  }

  if (action === "forget") {
    if (!current.length) {
      await send(env, msg.chat.id, "Память уже пустая.");
      return true;
    }
    const removed = current[current.length - 1];
    const next = current.slice(0, -1);
    await writeMem(env, next);
    await send(env, msg.chat.id, `Забыл последнюю запись. Осталось: ${next.length}.\nУдалено: ${(removed.lesson || removed.signal || "без описания").slice(0, 350)}`);
    return true;
  }

  if (action === "seed") {
    const withoutOldSeed = current.filter((m) => m?.tag !== "identity_seed");
    const next = [...withoutOldSeed, ...seed()];
    await writeMem(env, next);
    await send(env, msg.chat.id, `Стартовая память записана. Было: ${current.length}, стало: ${next.length}.`);
    return true;
  }

  return false;
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const response = await naturalWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.memory_control = true;
        data.memory_wrapper = WRAPPER;
        data.memory_commands = ["/memory_clear", "/forget_last", "/seed_identity"];
      }
      return json(data, response.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const msg = getMsg(update);
      const action = command(msg?.text || "");
      if (msg && action) {
        const done = await handleMemory(env, msg, action);
        if (done) return json({ ok: true, handled_by: WRAPPER, action });
      }
    }

    return await naturalWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await naturalWorker.scheduled(event, env, ctx);
  }
};
