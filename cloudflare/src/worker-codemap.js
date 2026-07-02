import agentsWorker from "./worker-agents.js";

const VERSION = "codemap-v3-queue-mission";

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

function files() {
  return {
    "cloudflare/src/worker-v1.js": {
      role: "основное ядро Telegram/commands/model/KV",
      commands: ["/start", "/status", "/think", "/tasks", "/memory", "/cost", "/tasks_hygiene"],
      risks: ["не сломать базовый роутер", "не вернуть двойные model calls", "не трогать секреты"],
      check: "/status"
    },
    "cloudflare/src/worker-selfcheck.js": {
      role: "self-audit, alive growth, /level, grounded audit",
      commands: ["/self_audit", "/grow_one", "/level", "/alive_on", "/alive_off"],
      risks: ["не вернуть фантазии о несуществующих файлах", "не сделать cron слишком шумным"],
      check: "/self_audit и /level"
    },
    "cloudflare/src/worker-memory-hygiene.js": {
      role: "чистка памяти, архив мусора и дублей",
      commands: ["/memory_hygiene"],
      risks: ["не удалить важные правила", "не потерять уроки про реальные ошибки"],
      check: "/memory_hygiene затем /level"
    },
    "cloudflare/src/worker-agents.js": {
      role: "реестр агентов и read-only agent runner",
      commands: ["/agents", "/agent <id> <task>"],
      risks: ["не дать агентам права менять код", "не выдумывать файлы", "не усложнить роутер"],
      check: "/agents и /agent coder тест"
    },
    "cloudflare/src/worker-codemap.js": {
      role: "карта собственного кода, роли файлов, мост queue → mission",
      commands: ["/code_map", "/file_role <file>", "/growth_to_mission"],
      risks: ["карта может устареть после новых wrapper-файлов", "не создавать миссию из мусорной задачи"],
      check: "/code_map затем /growth_to_mission"
    },
    "cloudflare/src/worker-inspector.js": {
      role: "self-inspection, mission control, dynamic next module, фильтр команд и защита от повторов",
      commands: ["/inspect_self", "/next_module", "/mission", "/mission_run", "/mission_log", "/growth_queue"],
      risks: ["не позволять модели придумывать несуществующие команды", "не застревать на одном шаге", "не принимать путь .js как Telegram-команду"],
      check: "/inspect_self затем /next_module"
    },
    "cloudflare/wrangler.toml": {
      role: "точка входа Cloudflare Worker, KV binding, env vars, cron",
      commands: ["not telegram command"],
      risks: ["неверный main отключит новый слой", "ошибка KV binding сломает память"],
      check: "root URL показывает активные версии"
    }
  };
}

function safeFiles() {
  return Object.keys(files());
}

function shortName(s) {
  const x = String(s || "").trim();
  if (!x) return "";
  if (x.includes("/")) return x;
  const map = files();
  const key = Object.keys(map).find(k => k.endsWith("/" + x) || k === x);
  return key || x;
}

function renderMap() {
  const map = files();
  return [
    "Code Map v3:",
    ...Object.entries(map).map(([path, info]) => `${path} — ${info.role}`),
    "",
    "Команда: /file_role worker-inspector.js"
  ].join("\n");
}

function renderRole(name) {
  const path = shortName(name);
  const info = files()[path];
  if (!info) return "Файл не найден в code map. Напиши /code_map.";
  return [
    `Файл: ${path}`,
    `Роль: ${info.role}`,
    `Команды: ${info.commands.join(", ")}`,
    `Риски: ${info.risks.join("; ")}`,
    `Проверка: ${info.check}`
  ].join("\n");
}

async function saveCodeMap(env) {
  await kvPut(env, "code_map", { version: VERSION, files: files(), updated_at: new Date().toISOString() });
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
  return goodSource && t?.status !== "archived" && t?.status !== "done" && safeFiles().includes(String(t.file || "")) && String(t.title || t.new_logic || t.action || "").trim() && commandOk(t.check || "");
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
      const r = await agentsWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.code_map = VERSION;
        d.code_map_commands = ["/code_map", "/file_role <file>", "/growth_to_mission"];
      }
      return json(d || { ok: true, code_map: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const raw = String(m?.text || "").trim();
      const low = raw.toLowerCase();

      if (m && (low === "/growth_to_mission" || low === "задачу роста в миссию")) {
        await queueToMission(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, growth_to_mission: true });
      }

      if (m && (low === "/code_map" || low === "карта кода" || low === "code map")) {
        await saveCodeMap(env);
        await send(env, m.chat.id, renderMap());
        return json({ ok: true, handled_by: VERSION });
      }

      if (m && low.startsWith("/file_role")) {
        const arg = raw.split(/\s+/).slice(1).join(" ");
        await send(env, m.chat.id, renderRole(arg));
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await agentsWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await agentsWorker.scheduled(event, env, ctx);
  }
};
