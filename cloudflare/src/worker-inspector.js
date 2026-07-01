import codeMapWorker from "./worker-codemap.js";

const VERSION = "inspector-v2-dynamic-next";

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

function safeFiles() {
  return [
    "cloudflare/src/worker-v1.js",
    "cloudflare/src/worker-selfcheck.js",
    "cloudflare/src/worker-memory-hygiene.js",
    "cloudflare/src/worker-agents.js",
    "cloudflare/src/worker-codemap.js",
    "cloudflare/src/worker-inspector.js",
    "cloudflare/wrangler.toml"
  ];
}

async function snapshot(env) {
  const brain = await kvGet(env, "brain", {});
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  const codeMap = await kvGet(env, "code_map", { files: {} });
  const agents = await kvGet(env, "agent_registry", { agents: [] });
  const growth = await kvGet(env, "growth_state", {});
  const tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
  const memories = Array.isArray(memData.memories) ? memData.memories : [];
  const activeTasks = tasks.filter(t => t.status !== "archived" && t.status !== "done");
  const files = Object.keys(codeMap.files || {});
  return {
    active_layer: "cloudflare/src/worker-inspector.js",
    alive: brain.alive_enabled === true,
    cycles_total: brain.stats?.cycles_total || 0,
    memories_total: memories.length,
    tasks_total: tasks.length,
    active_tasks: activeTasks.length,
    agents_total: Array.isArray(agents.agents) ? agents.agents.length : 0,
    files_total: files.length,
    code_files: files,
    growth_stage: growth.stage || "unknown"
  };
}

function weaknesses(s) {
  const weak = [];
  if (!s.alive) weak.push("alive выключен");
  if (s.memories_total > 20) weak.push("память может быть шумной");
  if (s.active_tasks > 20) weak.push("активных задач много");
  if (s.files_total < 5) weak.push("code_map ещё не сохранён в KV");
  if (s.agents_total < 6) weak.push("agent registry неполный");
  weak.push("ещё нет patch plan / approve gate");
  return weak;
}

function inspectText(s) {
  const body = s.code_files.length ? s.code_files : safeFiles();
  return [
    "Self Inspection v2:",
    `Активный слой: ${s.active_layer}`,
    "Текущее тело:",
    ...body.map(x => "- " + x),
    "Что умею: level, alive, memory hygiene, agent runner, code map, file role, self inspection, dynamic next module.",
    `Состояние: alive=${s.alive}, cycles=${s.cycles_total}, memories=${s.memories_total}, tasks=${s.tasks_total}, active_tasks=${s.active_tasks}, agents=${s.agents_total}`,
    `Главная слабость: ${weaknesses(s).join("; ")}`,
    "Следующий безопасный шаг теперь выбирается динамически через /next_module."
  ].join("\n");
}

async function inspect(env, chatId) {
  const s = await snapshot(env);
  await kvPut(env, "self_inspection", { version: VERSION, snapshot: s, updated_at: new Date().toISOString() });
  await send(env, chatId, inspectText(s));
}

function fallbackNextModule(s) {
  if (s.files_total < 5) {
    return {
      title: "Refresh Code Map",
      command: "/code_map",
      reason: "code_map ещё не сохранён в KV, self-inspection не видит всё тело.",
      risk: "следующие решения будут строиться на неполной карте",
      check: "/code_map затем /inspect_self"
    };
  }
  if (s.memories_total > 20) {
    return {
      title: "Memory Hygiene повторно",
      command: "/memory_hygiene",
      reason: "память выше безопасного порога, следующий рост может закрепить мусор.",
      risk: "можно архивировать полезный урок, если фильтр слишком грубый",
      check: "/memory_hygiene затем /level"
    };
  }
  if (s.active_tasks > 20) {
    return {
      title: "Task Hygiene повторно",
      command: "/tasks_hygiene",
      reason: "активных задач слишком много для стабильного роста.",
      risk: "важная задача может уйти в архив",
      check: "/tasks_hygiene затем /level"
    };
  }
  return {
    title: "Patch Plan v1",
    command: "/patch_plan",
    reason: "ядро уже имеет self-inspection и code map; следующий безопасный шаг — план изменения без изменения кода.",
    risk: "если дать применение кода слишком рано, можно сломать Worker",
    check: "после нового модуля должна появиться команда /patch_plan"
  };
}

function renderNext(p, source) {
  return [
    "Dynamic Next Module:",
    `Источник: ${source}`,
    `Название: ${p.title}`,
    `Команда: ${p.command}`,
    `Причина: ${p.reason}`,
    `Риск: ${p.risk}`,
    `Проверка: ${p.check}`,
    "Ограничение: это только выбор следующего шага, без применения кода."
  ].join("\n");
}

function parseJsonish(text) {
  try { return JSON.parse(text); } catch (_) {}
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

async function askDynamicNext(env, s) {
  await hydrate(env);
  if (!env.OPENROUTER_API_KEY) return null;
  const prompt = [
    "Ты выбираешь следующий безопасный модуль роста MiniSkynet.",
    "Опирайся только на состояние системы, code map и текущие ограничения.",
    "Не предлагай auto-apply, не утверждай что код изменён, не выдумывай внешние проекты.",
    "Разрешённые направления: refresh code_map, memory hygiene, task hygiene, patch plan, tests plan, agent registry improvement.",
    "Рабочие файлы:",
    ...safeFiles().map(x => "- " + x),
    `Состояние: ${JSON.stringify(s)}`,
    "Верни JSON только с полями: title, command, reason, risk, check."
  ].join("\n");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.OPENROUTER_API_KEY },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Return valid JSON only. Russian language. Be concrete." },
        { role: "user", content: prompt }
      ],
      temperature: 0.15,
      max_tokens: 450
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const raw = data?.choices?.[0]?.message?.content || "";
  const p = parseJsonish(raw);
  if (!p || !p.title || !p.command) return null;
  return {
    title: String(p.title).slice(0, 120),
    command: String(p.command).slice(0, 80),
    reason: String(p.reason || "").slice(0, 500),
    risk: String(p.risk || "").slice(0, 300),
    check: String(p.check || "").slice(0, 300)
  };
}

async function nextModule(env, chatId) {
  const s = await snapshot(env);
  const modelPlan = await askDynamicNext(env, s);
  const plan = modelPlan || fallbackNextModule(s);
  await kvPut(env, "next_module", { version: VERSION, source: modelPlan ? "model+snapshot" : "fallback+snapshot", plan, snapshot: s, updated_at: new Date().toISOString() });
  await send(env, chatId, renderNext(plan, modelPlan ? "model+snapshot" : "fallback+snapshot"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await codeMapWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.self_inspector = VERSION;
        d.dynamic_next_module = true;
        d.inspector_commands = ["/inspect_self", "/next_module"];
      }
      return json(d || { ok: true, self_inspector: VERSION, dynamic_next_module: true }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();

      if (m && (low === "/inspect_self" || low === "inspect self" || low === "проверь тело")) {
        await inspect(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION });
      }

      if (m && (low === "/next_module" || low === "следующий модуль")) {
        await send(env, m.chat.id, "Выбираю следующий модуль по текущему состоянию...");
        await nextModule(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await codeMapWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await codeMapWorker.scheduled(event, env, ctx);
  }
};
