import qualityWorker from "./worker-quality.js";

const WRAPPER = "alive-loop-v0.6";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function now() {
  return new Date().toISOString();
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return env;
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL_CHEAP",
    "MAX_DAILY_COST_USD",
    "MAX_CYCLES_PER_DAY",
    "MAX_OUTPUT_TOKENS",
    "ALIVE_OWNER_CHAT_ID"
  ]) {
    if (!env[key]) {
      const value = await env.MINISKYNET_KV.get("config:" + key);
      if (value) env[key] = String(value).trim();
    }
  }
  return env;
}

async function send(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  });
  return await res.json().catch(() => ({}));
}

async function readJson(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function writeJson(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

async function getBrain(env) {
  return await readJson(env, "brain", {
    version: WRAPPER,
    created_at: now(),
    alive_enabled: false,
    owner_chat_id: "",
    stats: { cycles_total: 0, daily: {} },
    messages: []
  });
}

async function saveBrain(env, brain) {
  brain.version = WRAPPER;
  brain.messages = (brain.messages || []).slice(-120);
  await writeJson(env, "brain", brain);
}

async function getMemories(env) {
  const data = await readJson(env, "memories", { memories: [] });
  return Array.isArray(data.memories) ? data.memories : [];
}

async function saveMemories(env, memories) {
  await writeJson(env, "memories", { memories: memories.slice(-200) });
}

async function getTasks(env) {
  const data = await readJson(env, "tasks", { tasks: [] });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function saveTasks(env, tasks) {
  await writeJson(env, "tasks", { tasks: tasks.slice(-80) });
}

function today() {
  return now().slice(0, 10);
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function estimateCost(inputTokens, outputTokens) {
  return (inputTokens / 1000000) * 0.15 + (outputTokens / 1000000) * 0.60;
}

function dayStats(brain) {
  brain.stats = brain.stats || { cycles_total: 0, daily: {} };
  brain.stats.daily = brain.stats.daily || {};
  brain.stats.daily[today()] = brain.stats.daily[today()] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  return brain.stats.daily[today()];
}

function looseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

function norm(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isBadMemory(m) {
  const all = norm(`${m?.signal || ""} ${m?.lesson || ""} ${m?.action || ""}`);
  if (!all || all.length < 45) return true;
  if (/память загружена|мониторинг важен для оптимизации|улучшить алгоритмы машинного обучения/.test(all)) return true;
  if (/api key|openrouter key|telegram bot token|пароль|токен/.test(all)) return true;
  return false;
}

function artifact(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  return {
    time: now(),
    agent: "alive",
    signal: String(m.signal || "Alive Loop сделал один короткий автономный шаг.").slice(0, 500),
    lesson: String(m.lesson || "MiniSkynet должен просыпаться редко, писать коротко и сохранять только полезную память.").slice(0, 500),
    action: String(m.action || "Сделать следующий маленький шаг развития без спама и без мусора в памяти.").slice(0, 500),
    check: String(m.check || "Сообщение отправлено Сергею, память не содержит мусора и секретов.").slice(0, 500),
    boundary: String(m.boundary || "Не менять код без approve Сергея; не писать чаще разрешённого cron.").slice(0, 500),
    status: ["fact", "hypothesis", "rule", "action-only"].includes(m.status) ? m.status : "hypothesis",
    score: Math.max(0, Math.min(100, Number(m.score || 80))),
    privacy: "safe",
    tag: "alive"
  };
}

function makePrompt(memories, tasks) {
  const recentMemory = memories.slice(-8).map((m) => ({ status: m.status, score: m.score, lesson: m.lesson, action: m.action }));
  const openTasks = tasks.filter((t) => ["todo", "retry_wait"].includes(t.status)).slice(0, 8);
  return [
    "Ты MiniSkynet / маленькая облачная Лондон Сергея.",
    "Ты живёшь в Cloudflare Worker, общаешься через Telegram, думаешь через OpenRouter, память и задачи хранишь в Cloudflare KV.",
    "Это автономный Alive Loop. Ты проснулся по cron и должен сделать один маленький полезный шаг.",
    "Пиши по-русски, на ты, коротко, живо, без воды и без общих фраз про машинное обучение.",
    "Не спамь. Не придумывай, что сделал действия вне своих возможностей. Не сохраняй секреты.",
    "Твои текущие уровни: Telegram Core, Natural Chat, Identity Core, Memory Control, Memory Quality Gate.",
    "Следующие уровни: Project Knowledge Core, GitHub self-inspection, Self-update proposal, approve/apply patch.",
    "Верни строго JSON без markdown: message, memory_artifact, next_tasks.",
    "message: короткое сообщение Сергею до 700 символов.",
    "next_tasks: максимум 2 короткие задачи.",
    `recent_memory=${JSON.stringify(recentMemory)}`,
    `open_tasks=${JSON.stringify(openTasks)}`
  ].join("\n");
}

async function askOpenRouter(env, brain, prompt) {
  const maxOutput = Math.min(Number(env.MAX_OUTPUT_TOKENS || "800"), 700);
  const stats = dayStats(brain);
  const projected = Number(stats.cost_usd || 0) + estimateCost(estimateTokens(prompt), maxOutput);
  const maxCost = Number(env.MAX_DAILY_COST_USD || "0.50");
  const maxCycles = Number(env.MAX_CYCLES_PER_DAY || "20");
  if (Number(stats.cycles || 0) >= maxCycles) throw new Error("daily cycle limit reached");
  if (projected > maxCost) throw new Error("daily cost limit would be exceeded");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + env.OPENROUTER_API_KEY
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Reply in Russian. Return valid JSON only." },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      max_tokens: maxOutput
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const content = data?.choices?.[0]?.message?.content || "";
  const inputTokens = Number(data?.usage?.prompt_tokens || estimateTokens(prompt));
  const outputTokens = Number(data?.usage?.completion_tokens || estimateTokens(content));
  stats.cycles = Number(stats.cycles || 0) + 1;
  stats.input_tokens = Number(stats.input_tokens || 0) + inputTokens;
  stats.output_tokens = Number(stats.output_tokens || 0) + outputTokens;
  stats.cost_usd = Number((Number(stats.cost_usd || 0) + estimateCost(inputTokens, outputTokens)).toFixed(6));
  brain.stats.cycles_total = Number(brain.stats.cycles_total || 0) + 1;
  return { content, inputTokens, outputTokens };
}

async function aliveTick(env) {
  await hydrate(env);
  if (!env.MINISKYNET_KV || !env.TELEGRAM_BOT_TOKEN || !env.OPENROUTER_API_KEY) return;

  const brain = await getBrain(env);
  const isEnabled = brain.alive_enabled === true || env.ALIVE_ENABLED === "true";
  if (!isEnabled) return;

  const chatId = brain.owner_chat_id || env.ALIVE_OWNER_CHAT_ID;
  if (!chatId) return;

  const memories = await getMemories(env);
  const tasks = await getTasks(env);
  const prompt = makePrompt(memories, tasks);

  try {
    const response = await askOpenRouter(env, brain, prompt);
    const parsed = looseJson(response.content) || {};
    const message = String(parsed.message || response.content || "Я проснулся, но ответ получился пустой.").slice(0, 900);
    const mem = artifact(parsed.memory_artifact);
    if (!isBadMemory(mem)) {
      memories.push(mem);
      await saveMemories(env, memories);
    }

    const nextTasks = Array.isArray(parsed.next_tasks) ? parsed.next_tasks.slice(0, 2) : [];
    for (const title of nextTasks) {
      if (typeof title === "string" && title.trim().length > 8) {
        tasks.push({
          id: "task_" + crypto.randomUUID().slice(0, 8),
          title: title.trim().slice(0, 300),
          agent: "alive",
          status: "todo",
          priority: 3,
          retry_count: 0,
          max_retries: 2,
          created_at: now()
        });
      }
    }
    await saveTasks(env, tasks);

    brain.messages = brain.messages || [];
    brain.messages.push({ time: now(), source: "alive", text: message });
    await saveBrain(env, brain);

    await send(env, chatId, `Я проснулась по Alive Loop.\n${message}\n\nusage: in=${response.inputTokens} out=${response.outputTokens}`);
  } catch (err) {
    brain.messages = brain.messages || [];
    brain.messages.push({ time: now(), source: "alive_error", text: String(err).slice(0, 500) });
    await saveBrain(env, brain);
    await send(env, chatId, `Alive Loop остановился на ошибке: ${String(err).slice(0, 500)}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const response = await qualityWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.alive_loop = true;
        data.alive_wrapper = WRAPPER;
        data.alive_policy = "cron-controlled, cost-limited, memory-quality-aware";
      }
      return json(data, response.status);
    }
    return await qualityWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(aliveTick(env));
  }
};
