import codeMapWorker from "./worker-codemap.js";

const VERSION = "inspector-v7-queue-filter";

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

function mentionsMemoryStep(x) {
  const t = String(x || "").toLowerCase();
  return t.includes("memory hygiene") || t.includes("memory-hygiene") || t.includes("/memory_hygiene") || t.includes("гигиен") || t.includes("памят");
}

function allowedCommand(command) {
  const c = String(command || "").trim();
  if (!c.startsWith("/")) return false;
  if (c.includes("cloudflare/") || c.includes(".js")) return false;
  if (c.startsWith("/agent ")) return true;
  const exact = new Set([
    "/start", "/status", "/level", "/memory", "/tasks", "/cost",
    "/inspect_self", "/next_module", "/code_map", "/agents",
    "/self_audit", "/grow_one", "/memory_hygiene", "/tasks_hygiene",
    "/alive_on", "/alive_off", "/last_auto_audit", "/growth_queue", "/growth_hygiene"
  ]);
  if (exact.has(c)) return true;
  if (c.startsWith("/file_role ")) return true;
  return false;
}

function firstCommand(text) {
  const m = String(text || "").match(/\/[a-zA-Z_]+(?:\s+[^\n]+)?/);
  return m ? m[0].trim() : "";
}

function commandIsAllowedInside(text) {
  const c = firstCommand(text);
  if (!c) return false;
  if (c.startsWith("/agent ") || c.startsWith("/file_role ")) return true;
  return allowedCommand(c.split(/\s+/)[0]);
}

function taskIsValid(t) {
  if (!t || typeof t !== "object") return false;
  if (!safeFiles().includes(String(t.file || ""))) return false;
  if (!String(t.title || t.new_logic || t.action || "").trim()) return false;
  if (!commandIsAllowedInside(t.check || "")) return false;
  return true;
}

function taskIsGrowth(t) {
  const s = String(t?.source || "");
  return s === "manual_audit" || s === "alive_tick" || s === "inspector_auto_scan" || s === "growth_queue";
}

async function snapshot(env) {
  const brain = await kvGet(env, "brain", {});
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  const archiveData = await kvGet(env, "memory_archive", { memories: [] });
  const codeMap = await kvGet(env, "code_map", { files: {} });
  const agents = await kvGet(env, "agent_registry", { agents: [] });
  const growth = await kvGet(env, "growth_state", {});
  const lastAudit = await kvGet(env, "last_audit_structured", null);
  const tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
  const memories = Array.isArray(memData.memories) ? memData.memories : [];
  const archivedMemories = Array.isArray(archiveData.memories) ? archiveData.memories : [];
  const activeTasks = tasks.filter(t => t.status !== "archived" && t.status !== "done");
  const growthTasksAll = activeTasks.filter(taskIsGrowth);
  const validGrowthTasks = growthTasksAll.filter(taskIsValid);
  const invalidGrowthTasks = growthTasksAll.filter(t => !taskIsValid(t));
  const files = Object.keys(codeMap.files || {});
  return {
    active_layer: "cloudflare/src/worker-inspector.js",
    alive: brain.alive_enabled === true,
    cycles_total: brain.stats?.cycles_total || 0,
    memories_total: memories.length,
    memory_archive_total: archivedMemories.length,
    memory_cleanup_seen: archivedMemories.length > 0,
    tasks_total: tasks.length,
    active_tasks: activeTasks.length,
    growth_tasks: validGrowthTasks.length,
    invalid_growth_tasks: invalidGrowthTasks.length,
    latest_growth_task: validGrowthTasks.slice(-1)[0] || null,
    agents_total: Array.isArray(agents.agents) ? agents.agents.length : 0,
    files_total: files.length,
    code_files: files,
    growth_stage: growth.stage || "unknown",
    last_audit_useful: lastAudit?.useful === true
  };
}

function weaknesses(s) {
  const weak = [];
  if (!s.alive) weak.push("alive выключен");
  if (s.files_total < 7) weak.push("code_map неполный или устарел");
  if (s.agents_total < 6) weak.push("agent registry неполный");
  if (s.invalid_growth_tasks > 0) weak.push(`growth queue содержит мусорных задач: ${s.invalid_growth_tasks}`);
  if (s.memories_total > 35) weak.push("память шумная, нужна гигиена");
  if (s.active_tasks > 80) weak.push("очередь задач раздута");
  if (!s.last_audit_useful && s.growth_tasks === 0) weak.push("последний audit ещё не закреплён как полезная задача");
  weak.push("код пока не применяется автоматически");
  return weak;
}

function inspectText(s) {
  const body = s.code_files.length ? s.code_files : safeFiles();
  return [
    "Self Inspection v7:",
    `Активный слой: ${s.active_layer}`,
    "Текущее тело:",
    ...body.map(x => "- " + x),
    "Что умею: level, last_auto_audit, growth_queue, growth_hygiene, code map, agent runner, self inspection, dynamic next module.",
    `Состояние: alive=${s.alive}, cycles=${s.cycles_total}, memories=${s.memories_total}, archived_memories=${s.memory_archive_total}, tasks=${s.tasks_total}, active_tasks=${s.active_tasks}, growth_tasks=${s.growth_tasks}, invalid_growth_tasks=${s.invalid_growth_tasks}, agents=${s.agents_total}`,
    `Главная слабость: ${weaknesses(s).join("; ")}`,
    "Control: inspector фильтрует очередь роста и скрывает задачи без файла или реальной команды проверки."
  ].join("\n");
}

async function inspect(env, chatId) {
  const s = await snapshot(env);
  await kvPut(env, "self_inspection", { version: VERSION, snapshot: s, updated_at: new Date().toISOString() });
  await send(env, chatId, inspectText(s));
}

function renderLevel(s) {
  const score = s.growth_stage === "audit_to_task_bridge" || s.growth_tasks > 0 ? 3.0 : 2.6;
  return [
    `Уровень: ${score}/10`,
    `Стадия: ${score >= 3 ? "Level 3 — Audit → Memory → Task Queue" : "Level 2 — Auto Audit + Code Map"}`,
    "Думает: по запросу, /self_audit или alive tick; inspector перехватывает /level выше старого selfcheck.",
    "Обучается: памятью, задачами, картой кода и инженерными спецификациями.",
    `Alive: ${s.alive}`,
    `Циклы: всего ${s.cycles_total}`,
    `Память: ${s.memories_total}, архив памяти ${s.memory_archive_total}`,
    `Задачи: всего ${s.tasks_total}, активных ${s.active_tasks}, growth_tasks ${s.growth_tasks}, invalid_growth_tasks ${s.invalid_growth_tasks}`,
    `Growth stage: ${s.growth_stage}`,
    `Сломано/слабо: ${weaknesses(s).join("; ")}`,
    `Следующий шаг: ${s.invalid_growth_tasks > 0 ? "/growth_hygiene" : "/growth_queue → /agent tester проверить последнюю задачу"}`
  ].join("\n");
}

async function showLastAutoAudit(env, chatId) {
  const last = await kvGet(env, "last_audit_structured", null);
  if (!last?.audit) {
    await send(env, chatId, "Last Audit пока пуст или старый selfcheck ещё не записал структуру. Запусти /self_audit и потом /growth_queue.");
    return;
  }
  const a = last.audit;
  await send(env, chatId, [
    "Last Audit:",
    `Источник: ${last.source || "unknown"}`,
    `Файл: ${a.file || "?"}`,
    `Слабость: ${a.weakness || "?"}`,
    `Цель: ${a.target || "?"}`,
    `Новая логика: ${a.new_logic || "?"}`,
    `Риск: ${a.risk || "?"}`,
    `Проверка: ${a.check || "?"}`,
    `Useful: ${last.useful ? "yes" : "no"}`
  ].join("\n"));
}

async function showGrowthQueue(env, chatId) {
  const taskData = await kvGet(env, "tasks", { tasks: [] });
  const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
  const active = tasks.filter(t => t.status !== "archived" && t.status !== "done");
  const valid = active.filter(taskIsValid).slice(-8).reverse();
  const invalid = active.filter(t => !taskIsValid(t)).length;
  if (!valid.length) {
    await send(env, chatId, [`Growth Queue: полезных задач нет.`, `Мусорных задач: ${invalid}`, invalid ? "Команда: /growth_hygiene" : "Запусти /self_audit или дождись alive tick."].join("\n"));
    return;
  }
  await send(env, chatId, [
    "Growth Queue:",
    invalid ? `Скрыто мусорных задач: ${invalid}. Очистка: /growth_hygiene` : "Мусорных задач: 0",
    "",
    ...valid.map((t, i) => `${i + 1}. ${t.title || t.file || "task"}\nФайл: ${t.file}\nНовая логика: ${t.new_logic || t.action || "?"}\nПроверка: ${t.check}`)
  ].join("\n\n"));
}

async function cleanGrowthQueue(env, chatId) {
  const taskData = await kvGet(env, "tasks", { tasks: [] });
  const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
  const now = new Date().toISOString();
  let archived = 0;
  const cleaned = tasks.map(t => {
    if (t.status !== "archived" && t.status !== "done" && !taskIsValid(t)) {
      archived += 1;
      return { ...t, status: "archived", archive_reason: "invalid_growth_task", updated_at: now };
    }
    return t;
  });
  await kvPut(env, "tasks", { ...taskData, tasks: cleaned, updated_at: now });
  await send(env, chatId, [`Growth Hygiene готова.`, `Архивировано мусорных задач: ${archived}`, `Проверка: /growth_queue`].join("\n"));
}

function nextModulePlan(s) {
  if (s.invalid_growth_tasks > 0) return { title: "Growth Queue Hygiene", command: "/growth_hygiene", reason: "очередь роста содержит задачи без файла или с несуществующими командами проверки.", risk: "можно скрыть слабую, но потенциально полезную идею", check: "/growth_hygiene затем /growth_queue" };
  if (s.files_total < 7) return { title: "Refresh Code Map", command: "/code_map", reason: "code_map неполный или устарел.", risk: "следующие решения будут строиться на неполной карте", check: "/code_map затем /inspect_self" };
  if (s.active_tasks > 80) return { title: "Task Hygiene", command: "/tasks_hygiene", reason: "активных задач слишком много.", risk: "может уйти в архив полезная задача", check: "/tasks_hygiene затем /level" };
  if (s.latest_growth_task?.file) return { title: "Work Latest Growth Task", command: `/agent coder дай change spec для ${s.latest_growth_task.file}: ${s.latest_growth_task.title || s.latest_growth_task.new_logic || "growth task"}`, reason: "есть валидная задача роста из аудита.", risk: "агент может дать слишком общий spec", check: "/agent tester проверить этот change spec" };
  return { title: "Run Structured Audit", command: "/self_audit", reason: "нужен свежий audit, который попадёт в память и задачи, когда selfcheck v7 доедет.", risk: "модель может дать слабый audit", check: "/last_auto_audit затем /growth_queue" };
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
    "Ограничение: это выбор следующего шага, код не меняется."
  ].join("\n");
}

async function nextModule(env, chatId) {
  const s = await snapshot(env);
  const plan = nextModulePlan(s);
  await kvPut(env, "next_module", { version: VERSION, source: "deterministic+snapshot", plan, snapshot: s, updated_at: new Date().toISOString() });
  await send(env, chatId, renderNext(plan, "deterministic+snapshot"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await codeMapWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.self_inspector = VERSION;
        d.control_layer = true;
        d.queue_filter = true;
        d.commands = ["/level", "/inspect_self", "/next_module", "/last_auto_audit", "/growth_queue", "/growth_hygiene"];
      }
      return json(d || { ok: true, self_inspector: VERSION, control_layer: true, queue_filter: true }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();

      if (m && (low === "/level" || low === "уровень" || low === "какой уровень" || low === "на каком уровне")) {
        await send(env, m.chat.id, renderLevel(await snapshot(env)));
        return json({ ok: true, handled_by: VERSION, level: true });
      }

      if (m && (low === "/inspect_self" || low === "inspect self" || low === "проверь тело")) {
        await inspect(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION });
      }

      if (m && (low === "/next_module" || low === "следующий модуль")) {
        await nextModule(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION });
      }

      if (m && (low === "/last_auto_audit" || low === "последний аудит")) {
        await showLastAutoAudit(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, last_auto_audit: true });
      }

      if (m && (low === "/growth_queue" || low === "очередь роста")) {
        await showGrowthQueue(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, growth_queue: true });
      }

      if (m && (low === "/growth_hygiene" || low === "почисти очередь роста")) {
        await cleanGrowthQueue(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, growth_hygiene: true });
      }
    }

    return await codeMapWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await codeMapWorker.scheduled(event, env, ctx);
  }
};
