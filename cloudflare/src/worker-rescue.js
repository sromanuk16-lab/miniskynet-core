const VERSION = "rescue-core-v1";

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
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  }).catch(() => null);
}

async function readJson(env, key, fallback) {
  if (!env.MINISKYNET_KV) return fallback;
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function writeJson(env, key, value) {
  if (!env.MINISKYNET_KV) return;
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

function msgOf(update) {
  return update?.message || update?.edited_message || null;
}

async function memories(env) {
  const data = await readJson(env, "memories", { memories: [] });
  return Array.isArray(data.memories) ? data.memories : [];
}

async function tasks(env) {
  const data = await readJson(env, "tasks", { tasks: [] });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function brain(env) {
  return await readJson(env, "brain", { alive_enabled: false, stats: { cycles_total: 0, daily: {} } });
}

async function handle(env, msg) {
  await hydrate(env);
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = String(msg.text || "").trim();

  if (!allowed(env, userId)) {
    await send(env, chatId, "Доступ закрыт.");
    return;
  }

  if (text === "/start" || text.toLowerCase() === "старт") {
    const b = await brain(env);
    b.alive_enabled = false;
    b.owner_chat_id = String(chatId);
    await writeJson(env, "brain", b);
    await send(env, chatId, "Я в аварийном безопасном режиме. Жива, но временно не думаю через модель, чтобы не зацикливаться. Команды: /status /memory /tasks /cost /alive_off");
    return;
  }

  if (text === "/alive_off" || /^(стоп|stop|выключи alive|выключи авто)/i.test(text)) {
    const b = await brain(env);
    b.alive_enabled = false;
    await writeJson(env, "brain", b);
    await send(env, chatId, "Alive выключен. Автопросыпание остановлено.");
    return;
  }

  if (text === "/status" || /^(статус|ты тут|жива|живой|ping|пинг)/i.test(text)) {
    const b = await brain(env);
    const m = await memories(env);
    const t = await tasks(env);
    await send(env, chatId, `Status\nversion: ${VERSION}\nsafe_mode: true\nalive: ${b.alive_enabled === true}\ncycles: ${b.stats?.cycles_total || 0}\ntasks: ${t.length}\nmemories: ${m.length}\nmodel_calls: paused`);
    return;
  }

  if (text === "/memory" || /^(память|глянь память|покажи память)/i.test(text)) {
    const m = (await memories(env)).slice(-8).reverse();
    const out = m.length ? m.map((x, i) => `${i + 1}. [${x.status || "?"}/${x.score || "?"}] ${(x.lesson || x.signal || "без описания").slice(0, 220)} -> ${(x.action || "").slice(0, 160)}`).join("\n") : "Память пустая.";
    await send(env, chatId, out);
    return;
  }

  if (text === "/tasks" || /^(задачи|очередь)/i.test(text)) {
    const t = (await tasks(env)).slice(-20);
    const out = t.length ? t.map((x, i) => `${i + 1}. ${x.status || "?"} | p${x.priority || 0} | ${(x.title || "без названия").slice(0, 180)}`).join("\n") : "Очередь пустая.";
    await send(env, chatId, out);
    return;
  }

  if (text === "/cost" || /^(расход|токены|cost)/i.test(text)) {
    const b = await brain(env);
    const key = new Date().toISOString().slice(0, 10);
    const st = b.stats?.daily?.[key] || {};
    await send(env, chatId, `Сегодня\ncycles: ${st.cycles || 0}\ninput: ${st.input_tokens || 0}\noutput: ${st.output_tokens || 0}\ncost: $${Number(st.cost_usd || 0).toFixed(6)}`);
    return;
  }

  await send(env, chatId, "Серёга, я сейчас в safe mode. Не запускаю модель, чтобы не повторить зависание. Сначала почистим архитектуру: task hygiene и один execution gate.");
}

export default {
  async fetch(request, env) {
    await hydrate(env);
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return json({ ok: true, service: "MiniSkynet", version: VERSION, safe_mode: true, scheduled_alive: "off", model_calls: "paused" });
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      const msg = msgOf(update);
      if (msg) await handle(env, msg);
      return json({ ok: true, version: VERSION });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    return;
  }
};
