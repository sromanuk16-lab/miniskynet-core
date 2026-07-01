import codeMapWorker from "./worker-codemap.js";

const VERSION = "inspector-v1";

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

async function snapshot(env) {
  const brain = await kvGet(env, "brain", {});
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  const codeMap = await kvGet(env, "code_map", { files: {} });
  const agents = await kvGet(env, "agent_registry", { agents: [] });
  const tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
  const memories = Array.isArray(memData.memories) ? memData.memories : [];
  const activeTasks = tasks.filter(t => t.status !== "archived" && t.status !== "done");
  return {
    active_layer: "cloudflare/src/worker-inspector.js",
    alive: brain.alive_enabled === true,
    cycles_total: brain.stats?.cycles_total || 0,
    memories_total: memories.length,
    tasks_total: tasks.length,
    active_tasks: activeTasks.length,
    agents_total: Array.isArray(agents.agents) ? agents.agents.length : 0,
    files_total: Object.keys(codeMap.files || {}).length,
    code_files: Object.keys(codeMap.files || {})
  };
}

function inspectText(s) {
  const body = s.code_files.length ? s.code_files : [
    "cloudflare/src/worker-v1.js",
    "cloudflare/src/worker-selfcheck.js",
    "cloudflare/src/worker-memory-hygiene.js",
    "cloudflare/src/worker-agents.js",
    "cloudflare/src/worker-codemap.js",
    "cloudflare/src/worker-inspector.js",
    "cloudflare/wrangler.toml"
  ];

  const weak = [];
  if (!s.alive) weak.push("alive выключен");
  if (s.memories_total > 20) weak.push("память может быть шумной");
  if (s.active_tasks > 20) weak.push("активных задач много");
  if (s.files_total < 5) weak.push("code_map ещё не сохранён в KV");
  weak.push("ещё нет patch plan / approve gate");

  return [
    "Self Inspection v1:",
    `Активный слой: ${s.active_layer}`,
    "Текущее тело:",
    ...body.map(x => "- " + x),
    "Что умею: level, alive, memory hygiene, agent runner, code map, file role, self inspection.",
    `Состояние: alive=${s.alive}, cycles=${s.cycles_total}, memories=${s.memories_total}, tasks=${s.tasks_total}, active_tasks=${s.active_tasks}, agents=${s.agents_total}`,
    `Главная слабость: ${weak.join("; ")}`,
    "Следующий безопасный модуль: patch plan без применения кода.",
    "Проверка следующего модуля: должна появиться команда /patch_plan."
  ].join("\n");
}

async function inspect(env, chatId) {
  const s = await snapshot(env);
  await kvPut(env, "self_inspection", { version: VERSION, snapshot: s, updated_at: new Date().toISOString() });
  await send(env, chatId, inspectText(s));
}

async function nextModule(env, chatId) {
  await send(env, chatId, [
    "Next module:",
    "Название: Patch Plan v1",
    "Цель: научить MiniSkynet формировать план изменения без изменения кода.",
    "Команда: /patch_plan",
    "Формат: файл, проблема, изменение, риск, проверка, approve_needed=yes.",
    "Ограничение: только план. Никакого применения кода."
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await codeMapWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.self_inspector = VERSION;
        d.inspector_commands = ["/inspect_self", "/next_module"];
      }
      return json(d || { ok: true, self_inspector: VERSION }, r.status);
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
