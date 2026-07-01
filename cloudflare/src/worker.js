const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function nowIso() {
  return new Date().toISOString();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function requireEnv(env) {
  const missing = [];
  if (!env.MINISKYNET_KV) missing.push("MINISKYNET_KV binding");
  if (!env.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.OPENROUTER_API_KEY) missing.push("OPENROUTER_API_KEY");
  return missing;
}

async function getJSON(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    await env.MINISKYNET_KV.put(`${key}:broken:${Date.now()}`, raw);
    return fallback;
  }
}

async function putJSON(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

async function getBrain(env) {
  return await getJSON(env, "brain", {
    version: "cf-0.1.0",
    created_at: nowIso(),
    alive_enabled: false,
    owner_chat_id: env.ALIVE_OWNER_CHAT_ID || "",
    stats: { cycles_total: 0, daily: {} },
    messages: []
  });
}

async function saveBrain(env, brain) {
  brain.messages = (brain.messages || []).slice(-120);
  await putJSON(env, "brain", brain);
}

async function getMemories(env) {
  const data = await getJSON(env, "memories", { memories: [] });
  return Array.isArray(data.memories) ? data.memories : [];
}

async function saveMemories(env, memories) {
  await putJSON(env, "memories", { memories: memories.slice(-200) });
}

async function getTasks(env) {
  const data = await getJSON(env, "tasks", { tasks: [] });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function saveTasks(env, tasks) {
  await putJSON(env, "tasks", { tasks: tasks.slice(-80) });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function dailyStats(brain) {
  const key = todayKey();
  brain.stats = brain.stats || { cycles_total: 0, daily: {} };
  brain.stats.daily = brain.stats.daily || {};
  brain.stats.daily[key] = brain.stats.daily[key] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  return brain.stats.daily[key];
}

function estimateCost(inputTokens, outputTokens) {
  return (inputTokens / 1000000) * 0.15 + (outputTokens / 1000000) * 0.60;
}

function canSpend(env, brain, prompt, maxOutputTokens) {
  const stats = dailyStats(brain);
  const inputTokens = estimateTokens(prompt);
  const projected = Number(stats.cost_usd || 0) + estimateCost(inputTokens, maxOutputTokens);
  const maxCost = Number(env.MAX_DAILY_COST_USD || "0.50");
  const maxCycles = Number(env.MAX_CYCLES_PER_DAY || "20");
  if (Number(stats.cycles || 0) >= maxCycles) return [false, "daily cycle limit reached"];
  if (projected > maxCost) return [false, `daily cost limit would be exceeded: $${projected.toFixed(4)}`];
  return [true, "ok"];
}

function recordUsage(brain, inputTokens, outputTokens) {
  const stats = dailyStats(brain);
  stats.cycles = Number(stats.cycles || 0) + 1;
  stats.input_tokens = Number(stats.input_tokens || 0) + inputTokens;
  stats.output_tokens = Number(stats.output_tokens || 0) + outputTokens;
  stats.cost_usd = Number((Number(stats.cost_usd || 0) + estimateCost(inputTokens, outputTokens)).toFixed(6));
  brain.stats.cycles_total = Number(brain.stats.cycles_total || 0) + 1;
}

function isAllowed(env, userId) {
  const allowed = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  if (!allowed) return true;
  return String(userId || "") === allowed;
}

async function telegram(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data;
}

async function sendMessage(env, chatId, text) {
  return await telegram(env, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 3900) });
}

function normalizeArtifact(raw, agent) {
  const mem = raw && typeof raw === "object" ? { ...raw } : {};
  mem.time = mem.time || nowIso();
  mem.agent = mem.agent || agent || "core";
  mem.signal = mem.signal || "Получен ответ MiniSkynet.";
  mem.lesson = mem.lesson || "Вывод нужно проверить практикой.";
  mem.action = mem.action || "Сохранить короткий следующий шаг.";
  mem.check = mem.check || "Есть понятный результат проверки.";
  mem.boundary = mem.boundary || "Если вывод не проверен, считать hypothesis.";
  mem.status = ["fact", "hypothesis", "rule", "action-only"].includes(mem.status) ? mem.status : "hypothesis";
  mem.score = Math.max(0, Math.min(100, Number(mem.score || 70)));
  mem.privacy = mem.privacy || "safe";
  return mem;
}

function parseJSONLoose(text) {
  try { return JSON.parse(text); } catch (_) {}
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

async function askOpenRouter(env, brain, prompt) {
  const maxTokens = Number(env.MAX_OUTPUT_TOKENS || "800");
  const [ok, reason] = canSpend(env, brain, prompt, maxTokens);
  if (!ok) throw new Error(`CostGuard: ${reason}`);

  const headers = { "content-type": "application/json" };
  headers.Authorization = "Bearer " + env.OPENROUTER_API_KEY;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "You are MiniSkynet Core. Reply in Russian. Return JSON when asked." },
        { role: "user", content: prompt.slice(0, 12000) }
      ],
      temperature: 0.35,
      max_tokens: maxTokens
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  const content = data?.choices?.[0]?.message?.content || "";
  const inputTokens = Number(data?.usage?.prompt_tokens || estimateTokens(prompt));
  const outputTokens = Number(data?.usage?.completion_tokens || estimateTokens(content));
  recordUsage(brain, inputTokens, outputTokens);
  return { content, inputTokens, outputTokens };
}

async function think(env, text, agent = "core") {
  const brain = await getBrain(env);
  const memories = (await getMemories(env)).slice(-6);
  const prompt = [
    "Ты MiniSkynet Cloudflare Core v0.1.",
    "Пиши по-русски, коротко, инженерно.",
    "Верни JSON с полями answer, message, memory_artifact, next_tasks.",
    `agent=${agent}`,
    `task=${text}`,
    `memory=${JSON.stringify(memories)}`,
    "memory_artifact: agent, signal, lesson, action, check, boundary, status, score, privacy."
  ].join("\n");

  const response = await askOpenRouter(env, brain, prompt);
  const parsed = parseJSONLoose(response.content) || {};
  const answer = String(parsed.answer || response.content || "").trim();
  const message = String(parsed.message || answer || "").trim();
  const artifact = normalizeArtifact(parsed.memory_artifact, agent);

  const allMemories = await getMemories(env);
  allMemories.push(artifact);
  await saveMemories(env, allMemories);

  const tasks = await getTasks(env);
  for (const next of parsed.next_tasks || []) {
    if (typeof next === "string" && next.trim()) tasks.push(makeTask(next.trim(), agent, 4));
  }
  await saveTasks(env, tasks);

  brain.messages = brain.messages || [];
  brain.messages.push({ time: nowIso(), source: agent, text: message.slice(0, 1000) });
  await saveBrain(env, brain);

  return { answer, message, artifact, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
}

function makeTask(title, agent = "core", priority = 5) {
  return {
    id: "task_" + crypto.randomUUID().slice(0, 8),
    title: String(title).slice(0, 500),
    agent,
    status: "todo",
    priority,
    retry_count: 0,
    max_retries: 2,
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    result: null,
    blocked_reason: null
  };
}

async function runNextTask(env) {
  const tasks = await getTasks(env);
  let index = -1;
  let selected = null;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (["todo", "retry_wait"].includes(t.status) && (!selected || Number(t.priority) > Number(selected.priority))) {
      selected = t;
      index = i;
    }
  }
  if (!selected) return { status: "idle", message: "Нет задач." };

  selected.status = "running";
  selected.started_at = nowIso();
  tasks[index] = selected;
  await saveTasks(env, tasks);

  try {
    const result = await think(env, selected.title, selected.agent || "core");
    selected.status = "done";
    selected.finished_at = nowIso();
    selected.result = { summary: result.message, memory_saved: true };
    tasks[index] = selected;
    await saveTasks(env, tasks);
    return { status: "done", task: selected, result };
  } catch (err) {
    selected.retry_count = Number(selected.retry_count || 0) + 1;
    selected.blocked_reason = String(err).slice(0, 1000);
    selected.status = selected.retry_count <= Number(selected.max_retries || 2) ? "retry_wait" : "failed";
    tasks[index] = selected;
    await saveTasks(env, tasks);
    return { status: selected.status, task: selected, error: String(err) };
  }
}

async function handleCommand(env, chatId, userId, text) {
  if (!isAllowed(env, userId)) {
    await sendMessage(env, chatId, "Доступ закрыт. Этот MiniSkynet привязан к владельцу.");
    return;
  }

  const [cmd, ...args] = String(text || "").trim().split(/\s+/);
  const rest = args.join(" ").trim();

  if (cmd === "/start") {
    const brain = await getBrain(env);
    brain.owner_chat_id = String(chatId);
    await saveBrain(env, brain);
    await sendMessage(env, chatId, `MiniSkynet Cloudflare Core v0.1 проснулся.\nTelegram user id: ${userId}\nChat id: ${chatId}\nКоманды: /status /think /tasks /memory /alive_on /alive_off /cost`);
    return;
  }

  if (cmd === "/status") {
    const brain = await getBrain(env);
    const tasks = await getTasks(env);
    const memories = await getMemories(env);
    await sendMessage(env, chatId, `Status\nalive: ${brain.alive_enabled}\ncycles: ${brain.stats?.cycles_total || 0}\ntasks: ${tasks.length}\nmemories: ${memories.length}\nmodel: ${env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini"}`);
    return;
  }

  if (cmd === "/think") {
    await sendMessage(env, chatId, "Думаю...");
    const result = await think(env, rest || "Сделай один маленький полезный шаг для развития MiniSkynet.");
    await sendMessage(env, chatId, `${result.answer}\n\nusage: in=${result.inputTokens} out=${result.outputTokens}`);
    return;
  }

  if (cmd === "/addtask") {
    const tasks = await getTasks(env);
    const task = makeTask(rest || "Сделать один полезный шаг.");
    tasks.push(task);
    await saveTasks(env, tasks);
    await sendMessage(env, chatId, `Добавил задачу ${task.id}: ${task.title}`);
    return;
  }

  if (cmd === "/tasks") {
    const tasks = (await getTasks(env)).slice(-15);
    const lines = tasks.length ? tasks.map(t => `${t.status} | p${t.priority} | ${t.title}`).join("\n") : "Очередь пустая.";
    await sendMessage(env, chatId, lines);
    return;
  }

  if (cmd === "/memory") {
    const memories = (await getMemories(env)).slice(-8).reverse();
    const lines = memories.length ? memories.map((m, i) => `${i + 1}. [${m.status}/${m.score}] ${m.lesson} -> ${m.action}`).join("\n") : "Память пустая.";
    await sendMessage(env, chatId, lines);
    return;
  }

  if (cmd === "/cost") {
    const brain = await getBrain(env);
    const stats = dailyStats(brain);
    await sendMessage(env, chatId, `Сегодня\ncycles: ${stats.cycles || 0}\ninput: ${stats.input_tokens || 0}\noutput: ${stats.output_tokens || 0}\ncost: $${Number(stats.cost_usd || 0).toFixed(6)}`);
    return;
  }

  if (cmd === "/alive_on" || cmd === "/alive_off") {
    const brain = await getBrain(env);
    brain.alive_enabled = cmd === "/alive_on";
    brain.owner_chat_id = String(chatId);
    await saveBrain(env, brain);
    await sendMessage(env, chatId, brain.alive_enabled ? "Alive включён. Cron будет будить меня." : "Alive выключен.");
    return;
  }

  await sendMessage(env, chatId, "Не понял команду. Используй /status, /think, /tasks, /memory, /alive_on.");
}

async function handleTelegram(env, request) {
  const update = await request.json();
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return jsonResponse({ ok: true, ignored: true });
  await handleCommand(env, msg.chat.id, msg.from?.id, msg.text || "");
  return jsonResponse({ ok: true });
}

async function setupWebhook(env, request) {
  const url = new URL(request.url);
  if (!env.SETUP_SECRET || url.searchParams.get("secret") !== env.SETUP_SECRET) {
    return jsonResponse({ ok: false, error: "bad secret" }, 403);
  }
  const webhookUrl = `${url.origin}/telegram`;
  const result = await telegram(env, "setWebhook", { url: webhookUrl, drop_pending_updates: true });
  return jsonResponse({ ok: true, webhookUrl, result });
}

async function scheduledTick(env) {
  const missing = requireEnv(env);
  if (missing.length) return;
  const brain = await getBrain(env);
  if (!brain.alive_enabled && env.ALIVE_ENABLED !== "true") return;
  const chatId = brain.owner_chat_id || env.ALIVE_OWNER_CHAT_ID;
  if (!chatId) return;

  let tasks = await getTasks(env);
  if (!tasks.some(t => ["todo", "retry_wait"].includes(t.status))) {
    tasks.push(makeTask("Сформулировать один маленький следующий шаг развития MiniSkynet.", "goal", 3));
    await saveTasks(env, tasks);
  }
  const result = await runNextTask(env);
  if (result.status === "done") {
    await sendMessage(env, chatId, `MiniSkynet сам сделал шаг:\n${(result.result?.message || result.task?.result?.summary || "Готово.").slice(0, 3000)}`);
  } else if (["failed", "retry_wait"].includes(result.status)) {
    await sendMessage(env, chatId, `Alive task ${result.status}: ${result.error}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const missing = requireEnv(env);

    if (url.pathname === "/") {
      return jsonResponse({ ok: true, service: "MiniSkynet Cloudflare Core", version: "cf-0.1.0", missing });
    }
    if (url.pathname === "/setup-webhook") return await setupWebhook(env, request);
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (missing.length) return jsonResponse({ ok: false, missing }, 500);
      return await handleTelegram(env, request);
    }
    return jsonResponse({ ok: false, error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTick(env));
  }
};
