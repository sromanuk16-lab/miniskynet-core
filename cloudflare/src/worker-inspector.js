import codeMapWorker from "./worker-codemap.js";

const VERSION = "inspector-v11-mission-pipeline";

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

function allowedCommand(command) {
  const c = String(command || "").trim();
  if (!c.startsWith("/")) return false;
  if (c.includes("cloudflare/") || c.includes(".js")) return false;
  if (c.startsWith("/agent ")) return true;
  if (c.startsWith("/file_role ")) return true;
  return new Set([
    "/start", "/status", "/level", "/memory", "/tasks", "/cost",
    "/inspect_self", "/next_module", "/code_map", "/agents",
    "/self_audit", "/grow_one", "/memory_hygiene", "/tasks_hygiene",
    "/alive_on", "/alive_off", "/last_auto_audit", "/growth_queue", "/growth_hygiene", "/growth_done",
    "/mission", "/mission_status", "/mission_log", "/mission_step", "/mission_run", "/cancel_mission"
  ]).has(c);
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

function taskIsGrowth(t) {
  const s = String(t?.source || "");
  return s === "manual_audit" || s === "alive_tick" || s === "inspector_auto_scan" || s === "growth_queue" || s === "inspector_structured_audit";
}

function taskIsValid(t) {
  if (!t || typeof t !== "object") return false;
  if (!safeFiles().includes(String(t.file || ""))) return false;
  if (!String(t.title || t.new_logic || t.action || "").trim()) return false;
  if (!commandIsAllowedInside(t.check || "")) return false;
  return true;
}

function missionEvent(type, text, status = "done", extra = {}) {
  return { time: new Date().toISOString(), type, status, text, ...extra };
}

function inferMissionFiles(goal) {
  const g = String(goal || "").toLowerCase();
  const files = [];
  if (g.includes("голос") || g.includes("voice") || g.includes("аудио")) {
    files.push("cloudflare/src/worker-v1.js", "cloudflare/src/worker-inspector.js", "cloudflare/wrangler.toml");
  }
  if (g.includes("агент") || g.includes("coder") || g.includes("tester")) {
    files.push("cloudflare/src/worker-agents.js", "cloudflare/src/worker-inspector.js");
  }
  if (g.includes("очеред") || g.includes("growth") || g.includes("задач")) {
    files.push("cloudflare/src/worker-inspector.js");
  }
  if (g.includes("карта") || g.includes("code map")) {
    files.push("cloudflare/src/worker-codemap.js", "cloudflare/src/worker-inspector.js");
  }
  if (!files.length) files.push("cloudflare/src/worker-inspector.js", "cloudflare/src/worker-agents.js");
  return [...new Set(files)].filter(f => safeFiles().includes(f));
}

function buildMission(goal) {
  const now = new Date().toISOString();
  const files = inferMissionFiles(goal);
  const id = "mission_" + Date.now();
  const events = [
    missionEvent("mission_started", `Приняла миссию: ${goal}`),
    missionEvent("scope_selected", `Определила рабочую область: ${files.length} файл(ов).`, "done", { files }),
    missionEvent("planning_ready", "Следующий шаг: /mission_run запустит planner/coder/tester/security pipeline.")
  ];
  return {
    id,
    version: VERSION,
    goal: String(goal || "").trim(),
    status: "active",
    current_step: "planning_ready",
    files,
    agents: ["planner", "coder", "tester", "security"],
    events,
    created_at: now,
    updated_at: now,
    next_command: "/mission_run"
  };
}

function renderMissionStart(m) {
  return [
    "Mission Control:",
    "✅ Миссия принята.",
    `Цель: ${m.goal}`,
    `ID: ${m.id}`,
    `Файлы: ${m.files.length ? m.files.join(", ") : "пока не выбраны"}`,
    "Следующий шаг: /mission_run"
  ].join("\n");
}

function renderMissionStatus(m) {
  if (!m) return "Mission Status: активной миссии нет. Команда: /mission <цель>";
  const last = (m.events || []).slice(-1)[0];
  const lines = [
    "Mission Status:",
    `ID: ${m.id}`,
    `Статус: ${m.status}`,
    `Цель: ${m.goal}`,
    `Текущий шаг: ${m.current_step || "unknown"}`,
    `Файлы: ${(m.files || []).join(", ") || "?"}`,
    `Агенты: ${(m.agents || []).join(", ") || "?"}`,
    `Последнее событие: ${last?.text || "?"}`
  ];
  if (m.plan) lines.push(`План: ${m.plan.summary}`);
  if (m.change_spec) lines.push(`Change spec: ${m.change_spec.file} → ${m.change_spec.target}`);
  if (m.test_plan) lines.push(`Проверка: ${m.test_plan.command}`);
  if (m.security_review) lines.push(`Security: ${m.security_review.risk_level}`);
  lines.push(`Следующая команда: ${m.next_command || "/mission_log"}`);
  return lines.join("\n");
}

function iconForEvent(e) {
  if (e.status === "failed") return "❌";
  if (e.status === "running") return "🟡";
  if (e.type?.includes("security")) return "🔒";
  if (e.type?.includes("tester")) return "🧪";
  if (e.type?.includes("coder")) return "🧠";
  if (e.type?.includes("planner")) return "🧭";
  if (e.type?.includes("mission")) return "🚀";
  return "✅";
}

function renderMissionLog(m) {
  if (!m) return "Mission Log: активной миссии нет. Команда: /mission <цель>";
  const events = Array.isArray(m.events) ? m.events : [];
  return [
    "Mission Log:",
    `Цель: ${m.goal}`,
    "",
    ...events.slice(-18).map((e, i) => `${i + 1}. ${iconForEvent(e)} ${e.text}`)
  ].join("\n");
}

async function createMission(env, chatId, goal) {
  const cleanGoal = String(goal || "").trim();
  if (!cleanGoal) {
    await send(env, chatId, "Напиши так: /mission <цель>. Например: /mission сделай голосовое управление");
    return;
  }
  const m = buildMission(cleanGoal);
  await kvPut(env, "active_mission", m);
  await kvPut(env, "mission:" + m.id, m);
  await send(env, chatId, renderMissionStart(m));
}

async function showMissionStatus(env, chatId) {
  const m = await kvGet(env, "active_mission", null);
  await send(env, chatId, renderMissionStatus(m));
}

async function showMissionLog(env, chatId) {
  const m = await kvGet(env, "active_mission", null);
  await send(env, chatId, renderMissionLog(m));
}

async function cancelMission(env, chatId) {
  const m = await kvGet(env, "active_mission", null);
  if (!m) {
    await send(env, chatId, "Cancel Mission: активной миссии нет.");
    return;
  }
  const now = new Date().toISOString();
  const updated = { ...m, status: "cancelled", current_step: "cancelled", updated_at: now, events: [...(m.events || []), missionEvent("mission_cancelled", "Миссия отменена Сергеем.")] };
  await kvPut(env, "mission:" + m.id, updated);
  await kvPut(env, "active_mission", null);
  await send(env, chatId, `Mission cancelled: ${m.goal}`);
}

function missionPlan(m) {
  const goal = String(m.goal || "").toLowerCase();
  if (goal.includes("голос") || goal.includes("voice")) {
    return {
      summary: "Добавить голосовой шлюз Telegram: voice input сначала, voice output позже.",
      steps: ["принять Telegram voice", "получить file_id", "скачать аудио", "передать в speech-to-text", "пустить распознанный текст в обычный router"],
      first_file: "cloudflare/src/worker-v1.js"
    };
  }
  return {
    summary: "Разбить цель на безопасную правку верхнего слоя inspector и проверку через Telegram-команды.",
    steps: ["уточнить файл", "подготовить change spec", "подготовить проверку", "проверить risk"],
    first_file: (m.files || ["cloudflare/src/worker-inspector.js"])[0]
  };
}

function missionChangeSpec(m) {
  const plan = m.plan || missionPlan(m);
  const file = safeFiles().includes(plan.first_file) ? plan.first_file : "cloudflare/src/worker-inspector.js";
  const goal = String(m.goal || "").toLowerCase();
  if (goal.includes("голос") || goal.includes("voice")) {
    return {
      file,
      target: "Telegram update router: message.voice",
      old_logic: "router обрабатывает только text commands и natural text",
      new_logic: "если Telegram update содержит voice, создать voice_task в KV и ответить пользователю, что voice input принят; speech-to-text подключить следующим слоем",
      check: "/mission_log"
    };
  }
  return {
    file,
    target: "mission pipeline",
    old_logic: "миссия только хранит цель и лог",
    new_logic: "mission_step двигает миссию через planner/coder/tester/security pipeline",
    check: "/mission_run затем /mission_log"
  };
}

function missionTestPlan(m) {
  const spec = m.change_spec || missionChangeSpec(m);
  return {
    command: spec.check && commandIsAllowedInside(spec.check) ? spec.check : "/mission_log",
    expected: "Mission Log показывает planner_done, coder_done, tester_done, security_done.",
    failure_signal: "миссия застряла на planning_ready или нет событий агентов"
  };
}

function missionSecurityReview(m) {
  const spec = m.change_spec || missionChangeSpec(m);
  const critical = spec.file === "cloudflare/wrangler.toml" || spec.file === "cloudflare/src/worker-v1.js";
  return {
    risk_level: critical ? "medium" : "low",
    risk: critical ? "затрагивает входной router или конфигурацию; применять только после approve" : "верхний слой, низкий риск",
    rule: "код не применяется автоматически; только plan/spec/log"
  };
}

function advanceMissionOnce(m) {
  const now = new Date().toISOString();
  const events = [...(m.events || [])];
  let next = { ...m, updated_at: now, events };

  if (m.current_step === "planning_ready") {
    const plan = missionPlan(m);
    events.push(missionEvent("planner_done", `Planner Agent: план готов — ${plan.summary}`));
    next = { ...next, plan, current_step: "planner_done", next_command: "/mission_step" };
  } else if (m.current_step === "planner_done") {
    const change_spec = missionChangeSpec(next);
    events.push(missionEvent("coder_done", `Coder Agent: change spec готов — ${change_spec.file} / ${change_spec.target}`));
    next = { ...next, change_spec, current_step: "coder_done", next_command: "/mission_step" };
  } else if (m.current_step === "coder_done") {
    const test_plan = missionTestPlan(next);
    events.push(missionEvent("tester_done", `Tester Agent: проверка готова — ${test_plan.command}`));
    next = { ...next, test_plan, current_step: "tester_done", next_command: "/mission_step" };
  } else if (m.current_step === "tester_done") {
    const security_review = missionSecurityReview(next);
    events.push(missionEvent("security_done", `Security Agent: риск ${security_review.risk_level}. Код пока не применяется.`));
    events.push(missionEvent("waiting_approve", "Mission pipeline готов. Следующий слой: pending change / approve."));
    next = { ...next, security_review, current_step: "waiting_approve", status: "waiting_approve", next_command: "/mission_log" };
  } else {
    events.push(missionEvent("mission_idle", "Миссия уже дошла до текущего конца pipeline. Следующий слой ещё не включён."));
  }

  return next;
}

async function saveMission(env, m) {
  await kvPut(env, "active_mission", m);
  if (m?.id) await kvPut(env, "mission:" + m.id, m);
}

async function runMissionStep(env, chatId, all = false) {
  let m = await kvGet(env, "active_mission", null);
  if (!m) {
    await send(env, chatId, "Mission Step: активной миссии нет. Команда: /mission <цель>");
    return;
  }
  const before = (m.events || []).length;
  let guard = all ? 4 : 1;
  while (guard-- > 0 && m.status === "active") m = advanceMissionOnce(m);
  await saveMission(env, m);
  const added = (m.events || []).slice(before);
  await send(env, chatId, [
    all ? "Mission Run:" : "Mission Step:",
    ...added.map(e => `${iconForEvent(e)} ${e.text}`),
    "",
    `Текущий шаг: ${m.current_step}`,
    `Следующая команда: ${m.next_command || "/mission_log"}`
  ].join("\n"));
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
  const mission = await kvGet(env, "active_mission", null);

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
    tasks_total: tasks.length,
    active_tasks: activeTasks.length,
    growth_tasks: validGrowthTasks.length,
    invalid_growth_tasks: invalidGrowthTasks.length,
    latest_growth_task: validGrowthTasks.slice(-1)[0] || null,
    agents_total: Array.isArray(agents.agents) ? agents.agents.length : 0,
    files_total: files.length,
    code_files: files,
    growth_stage: growth.stage || "unknown",
    last_audit_useful: lastAudit?.useful === true,
    mission_active: mission?.status === "active" || mission?.status === "waiting_approve",
    mission_goal: mission?.goal || "",
    mission_step: mission?.current_step || ""
  };
}

function weaknesses(s) {
  const weak = [];
  if (!s.alive) weak.push("alive выключен");
  if (s.files_total < 7) weak.push("code_map неполный или устарел");
  if (s.agents_total < 6) weak.push("agent registry неполный");
  if (s.invalid_growth_tasks > 0) weak.push(`growth queue содержит мусорных задач: ${s.invalid_growth_tasks}`);
  if (s.growth_tasks === 0 && !s.mission_active) weak.push("нет валидной задачи роста и активной миссии");
  if (s.memories_total > 40) weak.push("память шумная, нужна гигиена");
  weak.push("код пока не применяется автоматически");
  return weak;
}

function inspectText(s) {
  const body = s.code_files.length ? s.code_files : safeFiles();
  return [
    "Self Inspection v11:",
    `Активный слой: ${s.active_layer}`,
    "Текущее тело:",
    ...body.map(x => "- " + x),
    "Что умею: level, growth lifecycle, Mission Control v2, mission_step, mission_run, code map, agent runner.",
    `Состояние: alive=${s.alive}, cycles=${s.cycles_total}, memories=${s.memories_total}, archived_memories=${s.memory_archive_total}, tasks=${s.tasks_total}, active_tasks=${s.active_tasks}, growth_tasks=${s.growth_tasks}, invalid_growth_tasks=${s.invalid_growth_tasks}, agents=${s.agents_total}, mission_active=${s.mission_active}`,
    s.mission_active ? `Активная миссия: ${s.mission_goal} / ${s.mission_step}` : "Активная миссия: нет",
    `Главная слабость: ${weaknesses(s).join("; ")}`,
    "Mission Pipeline: /mission_run двигает миссию через planner/coder/tester/security."
  ].join("\n");
}

async function inspect(env, chatId) { const s = await snapshot(env); await kvPut(env, "self_inspection", { version: VERSION, snapshot: s, updated_at: new Date().toISOString() }); await send(env, chatId, inspectText(s)); }

function renderLevel(s) {
  const score = s.mission_active ? (s.mission_step === "waiting_approve" ? 4.4 : 4.2) : (s.growth_stage === "growth_task_done" ? 3.4 : (s.growth_tasks > 0 ? 3.2 : 3.0));
  return [
    `Уровень: ${score}/10`,
    s.mission_active ? "Стадия: Level 4 — Mission Control + Agent Pipeline" : "Стадия: Level 3 — Audit → Memory → Valid Task Queue → Done",
    "Думает: mission mode ведёт цель как live activity feed и двигает её через planner/coder/tester/security.",
    "Обучается: памятью, задачами, картой кода, инженерными спецификациями и миссиями.",
    `Alive: ${s.alive}`,
    `Циклы: всего ${s.cycles_total}`,
    `Память: ${s.memories_total}, архив памяти ${s.memory_archive_total}`,
    `Задачи: всего ${s.tasks_total}, активных ${s.active_tasks}, growth_tasks ${s.growth_tasks}, invalid_growth_tasks ${s.invalid_growth_tasks}`,
    `Mission: ${s.mission_active ? `${s.mission_goal} / ${s.mission_step}` : "нет"}`,
    `Growth stage: ${s.growth_stage}`,
    `Сломано/слабо: ${weaknesses(s).join("; ")}`,
    `Следующий шаг: ${s.mission_active ? "/mission_run или /mission_log" : "/mission <цель>"}`
  ].join("\n");
}

function buildStructuredAudit(s) {
  if (s.invalid_growth_tasks > 0) return { level: "Level 3", weakness: "очередь роста принимает задачи без файла или с несуществующими командами проверки", file: "cloudflare/src/worker-inspector.js", target: "taskIsValid / showGrowthQueue / growth_hygiene", old_logic: "growth_queue могла показывать задачи с Файл:? и Проверка:?", new_logic: "показывать только задачи из allowlist файлов и с реальной Telegram-командой проверки; мусор архивировать через /growth_hygiene", risk: "можно скрыть слабую, но потенциально полезную идею", check: "/growth_hygiene затем /growth_queue" };
  if (s.growth_tasks === 0) return { level: "Level 3", weakness: "после очистки нет валидной задачи роста для следующего инженерного шага", file: "cloudflare/src/worker-inspector.js", target: "structured self_audit", old_logic: "старый self_audit мог создавать мусорные задачи или уходить в общий текст", new_logic: "верхний inspector создаёт структурированную growth task только с реальным файлом и реальной командой проверки", risk: "детерминированный аудит может быть слишком узким", check: "/self_audit затем /growth_queue" };
  return { level: "Level 3", weakness: "есть валидная задача роста, но она ещё не превращена в инженерную спецификацию", file: "cloudflare/src/worker-agents.js", target: "coder/tester workflow", old_logic: "growth_queue хранит задачу, но следующий шаг ещё требует ручного запроса к агентам", new_logic: "next_module должен направлять валидную growth task в /agent coder, затем /agent tester", risk: "агент может дать слишком общий change spec", check: "/next_module затем /agent tester проверить change spec" };
}
function auditKey(a) { return [a.file, a.target || "target", a.weakness].join("|").toLowerCase().slice(0, 420); }
async function storeStructuredAudit(env, audit, source) {
  const now = new Date().toISOString(); const useful = taskIsValid({ file: audit.file, title: audit.weakness, check: audit.check }); const key = auditKey(audit); const result = { useful, memory_added: false, task_added: false, audit };
  await kvPut(env, "last_audit_structured", { version: VERSION, source, useful, audit, updated_at: now }); if (!useful) return result;
  const memData = await kvGet(env, "memories", { memories: [] }); const memories = Array.isArray(memData.memories) ? memData.memories : [];
  if (!memories.some(m => (m.key || "") === key)) { memories.push({ id: "mem_" + Date.now(), key, type: "engineering_lesson", status: "active", source, file: audit.file, lesson: audit.weakness, action: audit.new_logic, check: audit.check, risk: audit.risk, created_at: now }); await kvPut(env, "memories", { ...memData, memories: memories.slice(-140), updated_at: now }); result.memory_added = true; }
  const taskData = await kvGet(env, "tasks", { tasks: [] }); const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
  if (!tasks.some(t => (t.key || "") === key && t.status !== "done" && t.status !== "archived")) { tasks.push({ id: "task_" + Date.now(), key, type: "core", status: "active", source, title: `${audit.file}: ${audit.weakness}`.slice(0, 240), file: audit.file, target: audit.target, old_logic: audit.old_logic, new_logic: audit.new_logic, risk: audit.risk, check: audit.check, created_at: now, updated_at: now }); await kvPut(env, "tasks", { ...taskData, tasks: tasks.slice(-180), updated_at: now }); result.task_added = true; }
  const growth = await kvGet(env, "growth_state", {}); await kvPut(env, "growth_state", { ...growth, stage: "audit_to_valid_task_queue", last_audit_at: now, last_audit_key: key, last_audit_file: audit.file, updated_at: now }); return result;
}
function renderAudit(a) { return [`Уровень: ${a.level || "не указан"}`, `Слабость: ${a.weakness}`, `Файл: ${a.file}`, `Цель: ${a.target}`, `Старая логика: ${a.old_logic}`, `Новая логика: ${a.new_logic}`, `Риск: ${a.risk}`, `Проверка: ${a.check}`].join("\n"); }
function renderBridge(r) { return ["Bridge:", `Useful: ${r.useful ? "yes" : "no"}`, `Память: ${r.memory_added ? "добавлена" : "уже была"}`, `Задача: ${r.task_added ? "создана" : "уже была"}`, `Файл: ${r.audit.file}`, `Проверка: ${r.audit.check}`].join("\n"); }
async function runStructuredAudit(env, chatId) { await send(env, chatId, "Думаю..."); const s = await snapshot(env); const audit = buildStructuredAudit(s); const bridge = await storeStructuredAudit(env, audit, "inspector_structured_audit"); await send(env, chatId, [renderAudit(audit), "", renderBridge(bridge)].join("\n")); }
async function showLastAutoAudit(env, chatId) { const last = await kvGet(env, "last_audit_structured", null); if (!last?.audit) { await send(env, chatId, "Last Audit пока пуст. Запусти /self_audit."); return; } await send(env, chatId, ["Last Audit:", `Источник: ${last.source || "unknown"}`, renderAudit(last.audit), `Useful: ${last.useful ? "yes" : "no"}`].join("\n")); }
async function showGrowthQueue(env, chatId) { const taskData = await kvGet(env, "tasks", { tasks: [] }); const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : []; const active = tasks.filter(t => t.status !== "archived" && t.status !== "done"); const valid = active.filter(taskIsGrowth).filter(taskIsValid).slice(-8).reverse(); const invalid = active.filter(taskIsGrowth).filter(t => !taskIsValid(t)).length; if (!valid.length) { await send(env, chatId, [`Growth Queue: полезных задач нет.`, `Мусорных задач: ${invalid}`, invalid ? "Команда: /growth_hygiene" : "Команда: /self_audit"].join("\n")); return; } await send(env, chatId, ["Growth Queue:", invalid ? `Скрыто мусорных задач: ${invalid}. Очистка: /growth_hygiene` : "Мусорных задач: 0", "", ...valid.map((t, i) => `${i + 1}. ${t.title || t.file || "task"}\nФайл: ${t.file}\nЦель: ${t.target || "?"}\nНовая логика: ${t.new_logic || t.action || "?"}\nПроверка: ${t.check}`)].join("\n\n")); }
async function cleanGrowthQueue(env, chatId) { const taskData = await kvGet(env, "tasks", { tasks: [] }); const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : []; const now = new Date().toISOString(); let archived = 0; const cleaned = tasks.map(t => { if (t.status !== "archived" && t.status !== "done" && taskIsGrowth(t) && !taskIsValid(t)) { archived += 1; return { ...t, status: "archived", archive_reason: "invalid_growth_task", updated_at: now }; } return t; }); await kvPut(env, "tasks", { ...taskData, tasks: cleaned, updated_at: now }); await send(env, chatId, [`Growth Hygiene готова.`, `Архивировано мусорных задач: ${archived}`, `Проверка: /growth_queue`].join("\n")); }
async function markGrowthDone(env, chatId) { const taskData = await kvGet(env, "tasks", { tasks: [] }); const tasks = Array.isArray(taskData.tasks) ? taskData.tasks : []; const active = tasks.filter(t => t.status !== "archived" && t.status !== "done"); const valid = active.filter(taskIsGrowth).filter(taskIsValid); if (!valid.length) { await send(env, chatId, "Growth Done: нет валидной active growth-задачи. Команда: /self_audit"); return; } const task = valid.slice(-1)[0]; const now = new Date().toISOString(); const cleaned = tasks.map(t => t.id === task.id ? { ...t, status: "done", done_at: now, updated_at: now, done_reason: "marked_by_growth_done" } : t); await kvPut(env, "tasks", { ...taskData, tasks: cleaned, updated_at: now }); const growth = await kvGet(env, "growth_state", {}); await kvPut(env, "growth_state", { ...growth, stage: "growth_task_done", last_done_at: now, last_done_key: task.key || task.id, last_done_file: task.file, updated_at: now }); await send(env, chatId, ["Growth Done готово.", `Закрыта задача: ${task.title || task.file}`, `Файл: ${task.file}`, `Проверка: ${task.check}`, "Память: урок записан", "Следующий шаг: /growth_queue затем /next_module"].join("\n")); }

function nextModulePlan(s) {
  if (s.mission_active) return { title: "Continue Mission", command: s.mission_step === "waiting_approve" ? "/mission_log" : "/mission_run", reason: "есть активная миссия, двигаем её через Mission Pipeline.", risk: "миссия пока готовит plan/spec/test/security без применения кода", check: "/mission_log" };
  if (s.invalid_growth_tasks > 0) return { title: "Growth Queue Hygiene", command: "/growth_hygiene", reason: "очередь роста содержит мусорные задачи.", risk: "можно скрыть слабую, но потенциально полезную идею", check: "/growth_hygiene затем /growth_queue" };
  if (s.files_total < 7) return { title: "Refresh Code Map", command: "/code_map", reason: "code_map неполный или устарел.", risk: "решения будут строиться на неполной карте", check: "/code_map затем /inspect_self" };
  if (s.growth_tasks > 0 && s.latest_growth_task?.file) return { title: "Close Verified Growth Task", command: "/growth_done", reason: "есть валидная задача роста; если проверка уже прошла, её нужно закрыть и записать урок.", risk: "можно закрыть задачу раньше фактической проверки", check: "/growth_done затем /growth_queue" };
  return { title: "Start Mission Control", command: "/mission сделай голосовое управление", reason: "базовый self-growth цикл работает; следующий скачок — миссии с live activity feed.", risk: "Mission v2 пока не применяет код", check: "/mission_run затем /mission_log" };
}
function renderNext(p, source) { return ["Dynamic Next Module:", `Источник: ${source}`, `Название: ${p.title}`, `Команда: ${p.command}`, `Причина: ${p.reason}`, `Риск: ${p.risk}`, `Проверка: ${p.check}`, "Ограничение: это выбор следующего шага, код не меняется."].join("\n"); }
async function nextModule(env, chatId) { const s = await snapshot(env); const plan = nextModulePlan(s); await kvPut(env, "next_module", { version: VERSION, source: "deterministic+snapshot", plan, snapshot: s, updated_at: new Date().toISOString() }); await send(env, chatId, renderNext(plan, "deterministic+snapshot")); }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await codeMapWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") { d.self_inspector = VERSION; d.mission_pipeline = true; d.commands = ["/level", "/inspect_self", "/next_module", "/self_audit", "/last_auto_audit", "/growth_queue", "/growth_hygiene", "/growth_done", "/mission", "/mission_status", "/mission_log", "/mission_step", "/mission_run", "/cancel_mission"]; }
      return json(d || { ok: true, self_inspector: VERSION, mission_pipeline: true }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const raw = String(m?.text || "").trim();
      const low = raw.toLowerCase();

      if (m && low.startsWith("/mission ")) { await createMission(env, m.chat.id, raw.split(/\s+/).slice(1).join(" ")); return json({ ok: true, handled_by: VERSION, mission: true }); }
      if (m && (low === "/mission_status" || low === "статус миссии")) { await showMissionStatus(env, m.chat.id); return json({ ok: true, handled_by: VERSION, mission_status: true }); }
      if (m && (low === "/mission_log" || low === "лог миссии")) { await showMissionLog(env, m.chat.id); return json({ ok: true, handled_by: VERSION, mission_log: true }); }
      if (m && (low === "/mission_step" || low === "шаг миссии")) { await runMissionStep(env, m.chat.id, false); return json({ ok: true, handled_by: VERSION, mission_step: true }); }
      if (m && (low === "/mission_run" || low === "запусти миссию")) { await runMissionStep(env, m.chat.id, true); return json({ ok: true, handled_by: VERSION, mission_run: true }); }
      if (m && (low === "/cancel_mission" || low === "отмени миссию")) { await cancelMission(env, m.chat.id); return json({ ok: true, handled_by: VERSION, cancel_mission: true }); }

      if (m && (low === "/level" || low === "уровень" || low === "какой уровень" || low === "на каком уровне")) { await send(env, m.chat.id, renderLevel(await snapshot(env))); return json({ ok: true, handled_by: VERSION, level: true }); }
      if (m && (low === "/inspect_self" || low === "inspect self" || low === "проверь тело")) { await inspect(env, m.chat.id); return json({ ok: true, handled_by: VERSION }); }
      if (m && (low === "/next_module" || low === "следующий модуль")) { await nextModule(env, m.chat.id); return json({ ok: true, handled_by: VERSION }); }
      if (m && (low === "/self_audit" || low === "/grow_one" || low === "самоаудит" || low === "проверь себя")) { await runStructuredAudit(env, m.chat.id); return json({ ok: true, handled_by: VERSION, self_audit: true }); }
      if (m && (low === "/last_auto_audit" || low === "последний аудит")) { await showLastAutoAudit(env, m.chat.id); return json({ ok: true, handled_by: VERSION, last_auto_audit: true }); }
      if (m && (low === "/growth_queue" || low === "очередь роста")) { await showGrowthQueue(env, m.chat.id); return json({ ok: true, handled_by: VERSION, growth_queue: true }); }
      if (m && (low === "/growth_hygiene" || low === "почисти очередь роста")) { await cleanGrowthQueue(env, m.chat.id); return json({ ok: true, handled_by: VERSION, growth_hygiene: true }); }
      if (m && (low === "/growth_done" || low === "закрой задачу роста")) { await markGrowthDone(env, m.chat.id); return json({ ok: true, handled_by: VERSION, growth_done: true }); }
    }
    return await codeMapWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return await codeMapWorker.scheduled(event, env, ctx); }
};
