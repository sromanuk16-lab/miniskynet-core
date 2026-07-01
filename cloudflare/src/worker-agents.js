import memoryWorker from "./worker-memory-hygiene.js";

const VERSION = "agents-v2-runner";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "OPENROUTER_MODEL_CHEAP"]) {
    if (!env[k]) {
      const v = await env.MINISKYNET_KV.get("config:" + k);
      if (v) env[k] = String(v).trim();
    }
  }
}

async function send(env, chatId, text) {
  await hydrate(env);
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  }).catch(() => null);
}

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function kvPut(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function defaultAgents() {
  return [
    { id: "critic", name: "Critic Agent", purpose: "Ищет слабые места, риски, повторы и самообман.", allowed: ["analyze", "warn", "propose_next_step"], output: ["finding", "risk", "next_step"] },
    { id: "planner", name: "Planner Agent", purpose: "Разбивает рост MiniSkynet на маленькие проверяемые шаги.", allowed: ["plan", "prioritize", "define_check"], output: ["plan", "priority", "check"] },
    { id: "memory", name: "Memory Agent", purpose: "Следит за чистотой памяти и отличает уроки от мусора.", allowed: ["inspect_memory", "suggest_cleanup"], output: ["keep", "archive", "reason"] },
    { id: "tester", name: "Tester Agent", purpose: "Определяет, какой командой проверить результат.", allowed: ["define_test", "check_expected_result"], output: ["command", "expected", "failure_signal"] },
    { id: "security", name: "Security Agent", purpose: "Следит за запретами: секреты, токены, опасные действия, лишняя автономность.", allowed: ["detect_risk", "block_bad_step"], output: ["risk", "block", "safe_alternative"] },
    { id: "coder", name: "Coder Agent", purpose: "Описывает возможное изменение в существующих файлах, но сам ничего не применяет.", allowed: ["describe_change", "name_file", "define_check"], output: ["file", "change", "check"] }
  ];
}

async function ensureAgents(env) {
  const data = await kvGet(env, "agent_registry", null);
  if (data && Array.isArray(data.agents)) return data.agents;
  const agents = defaultAgents();
  await kvPut(env, "agent_registry", { version: VERSION, agents, updated_at: new Date().toISOString() });
  return agents;
}

function renderAgents(agents) {
  return [
    "Agent Registry v2:",
    ...agents.map(a => `${a.id} — ${a.purpose}`),
    "",
    "Команда: /agent critic <задача>",
    "Теперь агенты вызывают модель со своей ролью, но остаются read-only."
  ].join("\n");
}

async function contextForAgent(env) {
  const brain = await kvGet(env, "brain", {});
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  const growth = await kvGet(env, "growth_state", {});
  const tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
  const mem = Array.isArray(memData.memories) ? memData.memories : [];
  return {
    version: VERSION,
    alive: brain.alive_enabled === true,
    cycles_total: brain.stats?.cycles_total || 0,
    tasks_total: tasks.length,
    active_tasks: tasks.filter(t => t.status !== "archived" && t.status !== "done").slice(-8).map(t => ({ type: t.type, status: t.status, title: t.title })),
    memories_total: mem.length,
    recent_memory: mem.slice(-5).map(m => ({ status: m.status, lesson: m.lesson, action: m.action })),
    growth_stage: growth.stage || "unknown"
  };
}

function agentPrompt(agent, task, context) {
  return [
    `Ты внутренний агент MiniSkynet: ${agent.name}.`,
    `Роль: ${agent.purpose}`,
    `Разрешённые действия: ${agent.allowed.join(", ")}`,
    "Строгие правила:",
    "- только анализ и предложение; не утверждай, что изменил код или состояние",
    "- не выдумывай файлы; рабочие файлы: cloudflare/src/worker-v1.js, cloudflare/src/worker-selfcheck.js, cloudflare/src/worker-memory-hygiene.js, cloudflare/src/worker-agents.js, cloudflare/wrangler.toml",
    "- не предлагай внешние проекты Сергея",
    "- ответ короткий, по-русски, без общих фраз",
    `Ожидаемые поля: ${agent.output.join(", ")}`,
    `Состояние MiniSkynet: ${JSON.stringify(context)}`,
    `Задача от Сергея: ${String(task || "текущий рост MiniSkynet").slice(0, 1200)}`,
    "Верни простой текст в 3-5 строках."
  ].join("\n");
}

async function askAgentModel(env, agent, task) {
  await hydrate(env);
  if (!env.OPENROUTER_API_KEY) return null;
  const context = await contextForAgent(env);
  const prompt = agentPrompt(agent, task, context);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.OPENROUTER_API_KEY },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Russian language. Be concrete. Do not claim you changed files." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 500
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const out = String(data?.choices?.[0]?.message?.content || "").trim();
  const usage = `usage: in=${data?.usage?.prompt_tokens || "?"} out=${data?.usage?.completion_tokens || "?"}`;
  return out ? `${agent.name}:\n${out}\n\n${usage}` : null;
}

function fallbackAgent(agent, task) {
  const t = String(task || "").trim() || "текущий рост MiniSkynet";
  if (agent.id === "critic") return [`Critic Agent:`, `Finding: риск — слишком быстро усложнить ядро по задаче: ${t}.`, "Risk: память/задачи снова станут шумными.", "Next step: /level затем один маленький патч."].join("\n");
  if (agent.id === "planner") return [`Planner Agent:`, `Goal: ${t}`, "Plan: 1) проверить /level 2) выбрать один блокер 3) сделать один маленький слой 4) проверить командой.", "Check: /level показывает меньше слабостей."].join("\n");
  if (agent.id === "memory") return [`Memory Agent:`, `Object: ${t}`, "Keep: реальные уроки, файлы, проверки.", "Archive: общие фразы, дубли, фантазии.", "Next step: /memory_hygiene."].join("\n");
  if (agent.id === "tester") return [`Tester Agent:`, `Check target: ${t}`, "Command: /level", "Expected: команды отвечают без [object Object] и без выдуманных файлов."].join("\n");
  if (agent.id === "security") return [`Security Agent:`, `Review: ${t}`, "Risk: нельзя давать автономные действия без подтверждения.", "Safe path: read-only analysis, approve gate позже."].join("\n");
  if (agent.id === "coder") return [`Coder Agent:`, `Idea: ${t}`, "File: существующий worker или отдельный wrapper.", "Change: минимальный, проверяемый, без auto-action.", "Check: команда после деплоя показывает ожидаемый признак."].join("\n");
  return `${agent.name}: задача принята, но режим ещё простой.`;
}

async function runAgent(env, agent, task) {
  const modelAnswer = await askAgentModel(env, agent, task);
  return modelAnswer || fallbackAgent(agent, task);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await memoryWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.agent_registry = VERSION;
        d.agent_runner = "model_read_only";
        d.agent_commands = ["/agents", "/agent <id> <task>"];
      }
      return json(d || { ok: true, agent_registry: VERSION, agent_runner: "model_read_only" }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const raw = String(m?.text || "").trim();
      const low = raw.toLowerCase();

      if (m && (low === "/agents" || low === "агенты" || low === "реестр агентов")) {
        const agents = await ensureAgents(env);
        await send(env, m.chat.id, renderAgents(agents));
        return json({ ok: true, handled_by: VERSION });
      }

      if (m && low.startsWith("/agent ")) {
        const parts = raw.split(/\s+/);
        const id = (parts[1] || "").toLowerCase();
        const task = parts.slice(2).join(" ");
        const agents = await ensureAgents(env);
        const agent = agents.find(a => a.id === id);
        await send(env, m.chat.id, "Думаю как " + (agent?.name || id) + "...");
        await send(env, m.chat.id, agent ? await runAgent(env, agent, task) : "Не знаю такого агента. Напиши /agents.");
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await memoryWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await memoryWorker.scheduled(event, env, ctx);
  }
};
