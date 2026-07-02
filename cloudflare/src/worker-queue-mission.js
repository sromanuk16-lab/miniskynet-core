import inspectorWorker from "./worker-inspector.js";

const VERSION = "queue-mission-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN"]) {
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

function filesOk() {
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

function commandOk(x) {
  const c = String(x || "").match(/\/[a-zA-Z_]+/g)?.[0] || "";
  return new Set([
    "/level", "/inspect_self", "/next_module", "/code_map", "/agents",
    "/self_audit", "/memory_hygiene", "/tasks_hygiene", "/growth_queue",
    "/growth_hygiene", "/growth_done", "/mission_status", "/mission_log", "/mission_run"
  ]).has(c);
}

function isQueueItem(t) {
  const src = String(t?.source || "");
  const goodSource = src === "manual_audit" || src === "alive_tick" || src === "inspector_auto_scan" || src === "growth_queue" || src === "inspector_structured_audit";
  return goodSource && t?.status !== "archived" && t?.status !== "done" && filesOk().includes(String(t.file || "")) && String(t.title || t.new_logic || t.action || "").trim() && commandOk(t.check || "");
}

function event(type, text, extra = {}) {
  return { time: new Date().toISOString(), type, status: "done", text, ...extra };
}

function missionFromTask(task) {
  const now = new Date().toISOString();
  const id = "mission_" + Date.now();
  return {
    id,
    version: VERSION,
    goal: `Queue task: ${task.title || task.new_logic || task.file}`,
    status: "active",
    source: "queue_task",
    source_task_id: task.id,
    source_task_key: task.key,
    current_step: "planning_ready",
    files: [task.file],
    agents: ["planner", "coder", "tester", "security"],
    events: [
      event("mission_started", "Задача из очереди превращена в миссию."),
      event("queue_task_linked", `Источник: growth_queue. Задача: ${task.title || task.file}`),
      event("scope_selected", `Рабочий файл: ${task.file}`, { files: [task.file] }),
      event("planning_ready", "Следующий шаг: /mission_run запустит planner/coder/tester/security pipeline.")
    ],
    created_at: now,
    updated_at: now,
    next_command: "/mission_run"
  };
}

async function queueToMission(env, chatId) {
  const existing = await kvGet(env, "active_mission", null);
  if (existing?.status === "active" || existing?.status === "waiting_approve") {
    await send(env, chatId, "Queue → Mission: уже есть активная миссия. Сначала /mission_log или /cancel_mission.");
    return;
  }

  const taskData = await kvGet(env, "tasks", { tasks: [] });
  const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
  const valid = tasks.filter(isQueueItem);
  if (!valid.length) {
    await send(env, chatId, "Queue → Mission: нет валидной задачи. Команда: /self_audit затем /growth_queue");
    return;
  }

  const task = valid.slice(-1)[0];
  const mission = missionFromTask(task);
  const now = new Date().toISOString();
  const updatedTasks = tasks.map(t => t.id === task.id ? { ...t, status: "done", done_reason: "moved_to_mission", mission_id: mission.id, done_at: now, updated_at: now } : t);
  await kvPut(env, "tasks", { ...taskData, tasks: updatedTasks, updated_at: now });
  await kvPut(env, "active_mission", mission);
  await kvPut(env, "mission:" + mission.id, mission);

  const growth = await kvGet(env, "growth_state", {});
  await kvPut(env, "growth_state", { ...growth, stage: "queue_to_mission", last_queue_mission_id: mission.id, updated_at: now });

  await send(env, chatId, [
    "Queue → Mission готово.",
    "✅ Задача превращена в миссию.",
    `Цель: ${mission.goal}`,
    `Файл: ${mission.files.join(", ")}`,
    "Следующий шаг: /mission_run"
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await inspectorWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.queue_mission_wrapper = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/growth_to_mission"])]
      }
      return json(d || { ok: true, queue_mission_wrapper: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();
      if (m && (low === "/growth_to_mission" || low === "задачу роста в миссию")) {
        await queueToMission(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, growth_to_mission: true });
      }
    }

    return await inspectorWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await inspectorWorker.scheduled(event, env, ctx);
  }
};
