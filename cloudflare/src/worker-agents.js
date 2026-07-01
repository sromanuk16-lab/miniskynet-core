import memoryWorker from "./worker-memory-hygiene.js";

const VERSION = "agents-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  if (!env.TELEGRAM_BOT_TOKEN) {
    const v = await env.MINISKYNET_KV.get("config:TELEGRAM_BOT_TOKEN");
    if (v) env.TELEGRAM_BOT_TOKEN = String(v).trim();
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
    {
      id: "critic",
      name: "Critic Agent",
      purpose: "Ищет слабые места, риски, повторы и самообман.",
      allowed: ["analyze", "warn", "propose_next_step"],
      output: ["finding", "risk", "next_step"]
    },
    {
      id: "planner",
      name: "Planner Agent",
      purpose: "Разбивает рост MiniSkynet на маленькие проверяемые шаги.",
      allowed: ["plan", "prioritize", "define_check"],
      output: ["plan", "priority", "check"]
    },
    {
      id: "memory",
      name: "Memory Agent",
      purpose: "Следит за чистотой памяти и отличает уроки от мусора.",
      allowed: ["inspect_memory", "suggest_cleanup"],
      output: ["keep", "archive", "reason"]
    },
    {
      id: "tester",
      name: "Tester Agent",
      purpose: "Определяет, какой командой проверить результат.",
      allowed: ["define_test", "check_expected_result"],
      output: ["command", "expected", "failure_signal"]
    },
    {
      id: "security",
      name: "Security Agent",
      purpose: "Следит за запретами: секреты, токены, опасные действия, лишняя автономность.",
      allowed: ["detect_risk", "block_bad_step"],
      output: ["risk", "block", "safe_alternative"]
    },
    {
      id: "coder",
      name: "Coder Agent",
      purpose: "Описывает возможное изменение в существующих файлах, но сам ничего не применяет.",
      allowed: ["describe_change", "name_file", "define_check"],
      output: ["file", "change", "check"]
    }
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
    "Agent Registry v1:",
    ...agents.map(a => `${a.id} — ${a.purpose}`),
    "",
    "Команда: /agent critic <задача>",
    "Пока агенты только анализируют и предлагают следующий шаг."
  ].join("\n");
}

function runAgent(agent, task) {
  const t = String(task || "").trim() || "текущий рост MiniSkynet";
  if (agent.id === "critic") {
    return [
      "Critic Agent:",
      `Задача: ${t}`,
      "Finding: главный риск — слишком быстро усложнить ядро и снова получить хаос.",
      "Risk: рост через новые слои без чистки памяти и задач ухудшит поведение.",
      "Next step: сначала /memory_hygiene и /level, потом маленький следующий слой."
    ].join("\n");
  }
  if (agent.id === "planner") {
    return [
      "Planner Agent:",
      `Цель: ${t}`,
      "Plan: 1) очистить память 2) проверить уровень 3) закрепить self-audit 4) добавить следующий маленький режим.",
      "Priority: stability first.",
      "Check: /level показывает меньше блокеров."
    ].join("\n");
  }
  if (agent.id === "memory") {
    return [
      "Memory Agent:",
      `Объект: ${t}`,
      "Keep: правила, ошибки, реальные файлы, проверки.",
      "Archive: общие фразы, дубли, фантазии о несуществующих файлах.",
      "Next step: /memory_hygiene."
    ].join("\n");
  }
  if (agent.id === "tester") {
    return [
      "Tester Agent:",
      `Что проверяем: ${t}`,
      "Command: /level",
      "Expected: alive/status/memory/tasks отображаются без ошибок.",
      "Failure signal: снова появляются выдуманные файлы или [object Object]."
    ].join("\n");
  }
  if (agent.id === "security") {
    return [
      "Security Agent:",
      `Проверка: ${t}`,
      "Risk: нельзя давать автономные изменения без отдельного подтверждения Сергея.",
      "Block: секреты, токены, бесконечные циклы, auto-action.",
      "Safe alternative: read-only agents + approve gate позже."
    ].join("\n");
  }
  if (agent.id === "coder") {
    return [
      "Coder Agent:",
      `Идея: ${t}`,
      "File: только существующие worker-файлы или новый отдельный wrapper.",
      "Change: описать минимальное изменение и критерий проверки.",
      "Check: команда после деплоя должна показать ожидаемый признак."
    ].join("\n");
  }
  return `${agent.name}: задача принята, но режим ещё простой.`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await memoryWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.agent_registry = VERSION;
        d.agent_commands = ["/agents", "/agent <id> <task>"];
      }
      return json(d || { ok: true, agent_registry: VERSION }, r.status);
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
        await send(env, m.chat.id, agent ? runAgent(agent, task) : "Не знаю такого агента. Напиши /agents.");
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await memoryWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await memoryWorker.scheduled(event, env, ctx);
  }
};
