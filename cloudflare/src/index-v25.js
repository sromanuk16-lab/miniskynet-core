// MiniSkynet Core v2.5 — project knowledge.
// Single Cloudflare Worker entry: Telegram router, KV memory/tasks/proposals, identity/goals/plan/projects.

const VERSION = "v2.5-project-knowledge-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS }); }
function now() { return new Date().toISOString(); }
function day() { return now().slice(0, 10); }
function uid(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
function clip(s, n = 3900) { return String(s || "").slice(0, n); }
function compact(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function tokenEstimate(s) { return Math.max(1, Math.ceil(String(s || "").length / 4)); }
function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (_) {}
  const a = String(s || "").indexOf("{");
  const b = String(s || "").lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(String(s).slice(a, b + 1)); } catch (_) {} }
  return null;
}
function splitList(text) { return String(text || "").split(/\n|\|/g).map(x => x.trim()).filter(Boolean).slice(0, 12); }

const CFG_KEYS = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "TELEGRAM_ALLOWED_USER_ID", "OPENROUTER_MODEL_CHEAP", "MAX_DAILY_COST_USD", "MAX_CYCLES_PER_DAY", "MAX_OUTPUT_TOKENS"];

async function loadConfig(env) {
  const cfg = {};
  for (const k of CFG_KEYS) cfg[k] = env[k] ? String(env[k]).trim() : "";
  if (env.MINISKYNET_KV) {
    const missing = CFG_KEYS.filter(k => !cfg[k]);
    const vals = await Promise.all(missing.map(k => env.MINISKYNET_KV.get("config:" + k)));
    missing.forEach((k, i) => { if (vals[i]) cfg[k] = String(vals[i]).trim(); });
  }
  return {
    ...cfg,
    kv: env.MINISKYNET_KV,
    modelCheap: cfg.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
    maxDailyCostUsd: parseFloat(cfg.MAX_DAILY_COST_USD || "0.50") || 0.5,
    maxCyclesPerDay: parseInt(cfg.MAX_CYCLES_PER_DAY || "40", 10) || 40,
    maxOutputTokens: parseInt(cfg.MAX_OUTPUT_TOKENS || "900", 10) || 900
  };
}
function missingCritical(cfg) {
  const m = [];
  if (!cfg.kv) m.push("MINISKYNET_KV binding");
  if (!cfg.TELEGRAM_BOT_TOKEN) m.push("TELEGRAM_BOT_TOKEN");
  if (!cfg.OPENROUTER_API_KEY) m.push("OPENROUTER_API_KEY");
  return m;
}
function isOwner(cfg, userId) {
  const owner = String(cfg.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}
async function kvPut(env, key, value) { await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2)); }
async function getTasks(env) { return (await kvGet(env, "tasks", { tasks: [] })).tasks || []; }
async function saveTasks(env, tasks) { await kvPut(env, "tasks", { tasks: tasks.slice(-100) }); }
async function getMemories(env) { return (await kvGet(env, "memories", { memories: [] })).memories || []; }
async function saveMemories(env, memories) { await kvPut(env, "memories", { memories: memories.slice(-200) }); }
async function getProposals(env) { return (await kvGet(env, "proposals", { proposals: [] })).proposals || []; }
async function saveProposals(env, proposals) { await kvPut(env, "proposals", { proposals: proposals.slice(-50) }); }
async function getBrain(env) {
  const b = await kvGet(env, "brain", {});
  return { alive_enabled: false, owner_chat_id: null, last_alive_at: null, stats: { cycles_total: 0, daily: {} }, ...b, stats: { cycles_total: 0, daily: {}, ...(b.stats || {}) } };
}
async function saveBrain(env, brain) { await kvPut(env, "brain", brain); }

const DEFAULT_SELF = {
  name: "MiniSkynet Core v2.5",
  role: "личный инженерный агент Сергея в Telegram на Cloudflare Worker",
  identity: "Я помогаю вести MiniSkynet и другие проекты, держу память, цели, план, активный проект и предлагаю маленькие безопасные шаги.",
  limits: ["не выдумывать выполненные действия", "не менять код без явного approve", "не включать автономные циклы без проверки", "писать коротко по-русски"]
};
const DEFAULT_GOALS = [
  { id: "g1", text: "Стать стабильным личным инженерным агентом Сергея.", status: "active" },
  { id: "g2", text: "Держать чистую проектную память и не сохранять generic-мусор.", status: "active" },
  { id: "g3", text: "Учитывать активный проект при выборе следующего шага.", status: "active" },
  { id: "g4", text: "Перед изменениями кода читать актуальные файлы и после деплоя проверять результат.", status: "active" }
];
const DEFAULT_PLAN = [
  { id: "p1", text: "Проверить /projects, /project_status и /next после деплоя v2.5.", status: "todo" },
  { id: "p2", text: "Добавить GitHub read-only self-inspection после стабилизации Project Knowledge.", status: "todo" },
  { id: "p3", text: "Вернуть безопасный proposal → approve → patch только после чтения файлов и проверки.", status: "todo" }
];
const DEFAULT_PROJECTS = [
  { id: "project_miniskynet", name: "MiniSkynet", status: "active", description: "Telegram-бот SKYNET на Cloudflare Worker: личный инженерный агент с KV-памятью, целями, планом, проектным фокусом, OpenRouter и безопасными патчами.", created_at: now(), updated_at: now() }
];
async function getSelf(env) { return { ...DEFAULT_SELF, ...(await kvGet(env, "identity:self", {})) }; }
async function saveSelf(env, s) { await kvPut(env, "identity:self", { ...s, updated_at: now() }); }
async function getGoals(env) { return (await kvGet(env, "identity:goals", { goals: DEFAULT_GOALS })).goals || DEFAULT_GOALS; }
async function saveGoals(env, goals) { await kvPut(env, "identity:goals", { goals: goals.slice(0, 20), updated_at: now() }); }
async function getPlan(env) { return (await kvGet(env, "identity:plan", { plan: DEFAULT_PLAN })).plan || DEFAULT_PLAN; }
async function savePlan(env, plan) { await kvPut(env, "identity:plan", { plan: plan.slice(0, 20), updated_at: now() }); }
async function getProjectState(env) {
  const state = await kvGet(env, "projects:state", { projects: DEFAULT_PROJECTS, active: "MiniSkynet" });
  const projects = (state.projects && state.projects.length) ? state.projects : DEFAULT_PROJECTS;
  return { projects, active: state.active || projects[0]?.name || null, updated_at: state.updated_at || null };
}
async function saveProjectState(env, state) { await kvPut(env, "projects:state", { projects: (state.projects || []).slice(0, 30), active: state.active || null, updated_at: now() }); }
function projectKey(s) { return compact(s).replace(/^#/, ""); }
function parseProjectArgs(args) {
  const s = String(args || "").trim();
  const i = s.indexOf(":");
  if (i > 0) return { name: s.slice(0, i).trim(), description: s.slice(i + 1).trim() };
  const j = s.indexOf(" — ");
  if (j > 0) return { name: s.slice(0, j).trim(), description: s.slice(j + 3).trim() };
  return { name: s, description: "" };
}
function resolveProject(projects, ref) {
  const s = String(ref || "").trim();
  const n = parseInt(s, 10);
  if (n && n >= 1 && n <= projects.length) return projects[n - 1];
  const k = projectKey(s);
  return projects.find(p => projectKey(p.name) === k || projectKey(p.id) === k) || null;
}
function activeProject(state) { return resolveProject(state.projects, state.active) || state.projects[0] || null; }
function formatSelf(s) { return ["🪪 Self:", `- version: ${VERSION}`, `- name: ${s.name}`, `- role: ${s.role}`, `- identity: ${s.identity}`, "- limits:", ...(s.limits || []).map(x => `  • ${x}`), "", "Изменить: /self_set текст", "Сбросить: /self_reset"].join("\n"); }
function formatGoals(goals) { return ["🎯 Goals:", ...(goals.length ? goals.map((g, i) => `${i + 1}. [${g.status || "active"}] ${g.text}`) : ["пусто"]), "", "Изменить: /goal_add текст | /goal_del номер | /goals_set цель1 | цель2 | /goals_reset"].join("\n"); }
function formatPlan(plan) { return ["🧭 Plan:", ...(plan.length ? plan.map((p, i) => `${i + 1}. [${p.status || "todo"}] ${p.text}`) : ["пусто"]), "", "Изменить: /plan_set шаг1 | шаг2 | /plan_add текст | /plan_done номер | /plan_reset"].join("\n"); }
function formatProjects(state) {
  const ap = activeProject(state);
  return ["🗂 Projects:", ...(state.projects.length ? state.projects.map((p, i) => `${i + 1}. ${ap && projectKey(ap.name) === projectKey(p.name) ? "⭐" : "▫️"} ${p.name} [${p.status || "active"}] — ${clip(p.description, 180)}`) : ["пусто"]), "", "Команды: /project_add Name: desc | /project_set Name: desc | /project_focus Name | /project_del Name | /project_reset"].join("\n");
}
function formatProjectStatus(state) {
  const p = activeProject(state);
  if (!p) return "🗂 Active project: нет. Добавь: /project_add MiniSkynet: описание";
  return ["🗂 Active project:", `- name: ${p.name}`, `- status: ${p.status || "active"}`, `- description: ${p.description || "—"}`, "", "Сменить: /project_focus Name", "Редактировать: /project_set Name: описание"].join("\n");
}
function nextStepText(tasks, plan, goals, project) {
  const t = visibleTasks(tasks).find(x => ["todo", "retry_wait", "doing", "pending", "active"].includes(String(x.status || "todo")));
  if (t) return [`⏭ Next:`, `Источник: tasks`, project ? `Проект: ${project.name}` : null, `Шаг: ${t.title}`, `Почему: это активная задача с приоритетом p${t.priority || 4}.`].filter(Boolean).join("\n");
  const p = plan.find(x => String(x.status || "todo") !== "done");
  if (p) return [`⏭ Next:`, `Источник: plan`, project ? `Проект: ${project.name}` : null, `Шаг: ${p.text}`, `Почему: это первый незавершённый шаг плана.`].filter(Boolean).join("\n");
  if (project) return [`⏭ Next:`, `Источник: active project`, `Проект: ${project.name}`, `Шаг: уточнить ближайший проверяемый шаг по проекту.`, `Контекст: ${clip(project.description, 400)}`].join("\n");
  const g = goals.find(x => String(x.status || "active") === "active");
  if (g) return [`⏭ Next:`, `Источник: goals`, `Шаг: превратить цель в задачу`, `Цель: ${g.text}`].join("\n");
  return "⏭ Next: нет активных задач, плана, проекта и целей.";
}

function parseUpdate(update) {
  const msg = update?.message || update?.edited_message || null;
  if (!msg) return null;
  const text = String(msg.text || "").trim();
  let command = null, args = "";
  if (text.startsWith("/")) {
    const i = text.indexOf(" ");
    command = (i === -1 ? text : text.slice(0, i)).replace(/@\w+$/, "").toLowerCase();
    args = i === -1 ? "" : text.slice(i + 1).trim();
  }
  return { chatId: msg.chat?.id, userId: msg.from?.id, text, command, args };
}
async function tg(cfg, method, body) { const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return await res.json().catch(() => ({})); }
async function send(cfg, chatId, text) { if (cfg.TELEGRAM_BOT_TOKEN && chatId) return await tg(cfg, "sendMessage", { chat_id: chatId, text: clip(text) }); }

function costUsd(input, output) { return (input / 1000000) * 0.15 + (output / 1000000) * 0.60; }
async function checkBudget(env, cfg, inputTokens, maxOut) {
  const brain = await getBrain(env);
  const d = day();
  brain.stats.daily[d] = brain.stats.daily[d] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const st = brain.stats.daily[d];
  if (st.cycles >= cfg.maxCyclesPerDay) throw new Error(`CostGuard: лимит циклов на сегодня ${st.cycles}/${cfg.maxCyclesPerDay}.`);
  const projected = Number(st.cost_usd || 0) + costUsd(inputTokens, maxOut);
  if (projected > cfg.maxDailyCostUsd) throw new Error(`CostGuard: дневной лимит $${cfg.maxDailyCostUsd} будет превышен.`);
  return brain;
}
async function addUsage(env, brain, input, output) {
  const d = day();
  const st = brain.stats.daily[d] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  st.cycles += 1; st.input_tokens += input; st.output_tokens += output;
  st.cost_usd = Number((Number(st.cost_usd || 0) + costUsd(input, output)).toFixed(6));
  brain.stats.daily[d] = st; brain.stats.cycles_total = Number(brain.stats.cycles_total || 0) + 1;
  await saveBrain(env, brain);
}
async function costReport(env, cfg) { const b = await getBrain(env); const st = b.stats.daily?.[day()] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }; return ["💸 CostGuard:", `- циклы сегодня: ${st.cycles} / ${cfg.maxCyclesPerDay}`, `- tokens: in=${st.input_tokens}, out=${st.output_tokens}`, `- cost: ~$${Number(st.cost_usd || 0).toFixed(6)} / $${cfg.maxDailyCostUsd}`].join("\n"); }

const ACTIVE_TASK_STATUSES = new Set(["todo", "retry_wait", "doing", "pending", "active"]);
const VALID_MEMORY_STATUSES = new Set(["hypothesis", "fact", "rule"]);
const MEMORY_KEEP_SCORE = 65;
const STALE_PATTERNS = ["growth_hygiene", "growth-задача", "очередь роста", "worker-inspector", "worker-agents", "вывод нужно провер", "проверить практикой", "следующий маленький безопасный шаг", "улучшения функциональности", "саморазвитие", "анализ логов", "сбор метрик", "использования памяти", "мониторинг памяти", "фокус на полезной информации", "определить шаги"];
const QUALITY_GOOD_TERMS = ["miniskynet", "skynet", "v2", "cloudflare", "worker", "telegram", "openrouter", "kv", "github", "wrangler", "deploy", "memory", "tasks", "costguard", "status", "clean", "hygiene", "project", "projects", "команда", "деплой", "память", "задачи", "проект", "репозитор", "патч", "ошибка", "правило", "архитектур", "goal", "plan", "aurora", "subastatech", "aurum"];
function taskStatus(t) { return String(t?.status || "todo").toLowerCase(); }
function taskText(t) { return compact(`${t?.title || ""} ${t?.description || ""} ${t?.action || ""}`); }
function isStaleTask(t) { const text = taskText(t); return !ACTIVE_TASK_STATUSES.has(taskStatus(t)) || !text || STALE_PATTERNS.some(p => text.includes(p)); }
function visibleTasks(tasks) { return tasks.filter(t => !isStaleTask(t)); }
function memoryText(m) { return compact(`${m?.signal || ""} ${m?.lesson || ""} ${m?.action || ""} ${m?.check || ""} ${m?.boundary || ""}`); }
function memoryQuality(m) {
  const status = String(m?.status || "").toLowerCase();
  const lesson = compact(m?.lesson || "");
  const action = compact(m?.action || "");
  const check = compact(m?.check || "");
  const boundary = compact(m?.boundary || "");
  const text = memoryText(m);
  let score = 35;
  if (!VALID_MEMORY_STATUSES.has(status)) score -= 40;
  if (status === "rule") score += 15;
  if (status === "fact") score += 12;
  if (lesson.length >= 35) score += 12; else score -= 18;
  if (action.length >= 25) score += 10; else score -= 10;
  if (check.length >= 20) score += 7;
  if (boundary.length >= 20) score += 4;
  if (QUALITY_GOOD_TERMS.some(p => text.includes(p))) score += 15; else score -= 12;
  if (/\/[a-z_]+/.test(text) || /cloudflare|github|telegram|openrouter|kv|worker|wrangler|deploy|project/i.test(text)) score += 10;
  if (STALE_PATTERNS.some(p => text.includes(p))) score -= 35;
  if (/развит|улучш|полезн|следующ/.test(text) && !/\/[a-z_]+|cloudflare|github|telegram|openrouter|kv|worker|wrangler|deploy|project/i.test(text)) score -= 22;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, keep: score >= MEMORY_KEEP_SCORE };
}
function isStaleMemory(m) { return !memoryQuality(m).keep; }
function visibleMemories(memories) { return memories.filter(m => !isStaleMemory(m)); }
function normalizeMemory(raw, agent = "core") { return { id: uid("mem"), time: now(), agent, signal: clip(raw.signal || "Вывод MiniSkynet", 300), lesson: clip(raw.lesson || raw.text || "", 600), action: clip(raw.action || "Учитывать дальше.", 400), check: clip(raw.check || "Проверить практикой.", 300), boundary: clip(raw.boundary || "Может устареть.", 300), status: ["hypothesis", "fact", "rule"].includes(raw.status) ? raw.status : "hypothesis", score: Math.max(1, Math.min(100, Number(raw.score || 50))) }; }
async function saveMemory(env, raw, agent = "core") { const m = normalizeMemory(raw, agent); if (!m.lesson || !memoryQuality(m).keep) return null; const memories = await getMemories(env); memories.push(m); await saveMemories(env, memories); return m; }
function formatTasks(tasks) { return tasks.length ? tasks.slice(-20).map(t => `- ${t.id} [${t.status}] p${t.priority}: ${t.title}`).join("\n") : "пусто"; }
function formatMemories(memories) { return memories.length ? memories.slice(-10).map(m => `- [${m.status}/${memoryQuality(m).score}] ${m.lesson}\n  action: ${m.action}`).join("\n") : "пусто"; }
async function addTask(env, title, priority = 4, force = true) { const task = { id: uid("task"), title: clip(title, 300), priority, status: "todo", created_at: now() }; if (!force && isStaleTask(task)) return null; const tasks = await getTasks(env); tasks.push(task); await saveTasks(env, tasks); return task; }
function cleanState(tasks, memories) { const cleanTasks = visibleTasks(tasks); const cleanMemories = []; const seen = new Set(); for (const m of memories) { const k = compact(m.lesson); if (isStaleMemory(m) || !k || seen.has(k)) continue; seen.add(k); cleanMemories.push(m); } return { cleanTasks, cleanMemories, removedTasks: tasks.length - cleanTasks.length, removedMemories: memories.length - cleanMemories.length }; }
function seedMemory() { return normalizeMemory({ signal: "MiniSkynet Core v2.5 Project Knowledge активен.", lesson: "Скайнет теперь хранит список проектов и активный проект в KV, а /think и /next учитывают project focus.", action: "Использовать /project_add, /project_set, /project_focus и /project_status для управления проектным контекстом.", check: "Проверять /projects, /project_status, /next и /think после смены проекта.", boundary: "Project Knowledge хранится в KV и редактируется владельцем через Telegram без редеплоя.", status: "fact", score: 95 }, "project"); }
function cleanPreviewText(tasks, memories) { const c = cleanState(tasks, memories); return ["🧹 KV preview:", `- задач: ${tasks.length} → ${c.cleanTasks.length}`, `- памяти: ${memories.length} → ${c.cleanMemories.length}`, "Применить: /clean_apply"].join("\n"); }
async function applyClean(env) { const [tasks, memories] = await Promise.all([getTasks(env), getMemories(env)]); const c = cleanState(tasks, memories); const finalMemories = [...c.cleanMemories]; if (!finalMemories.some(m => compact(m.lesson) === compact(seedMemory().lesson))) finalMemories.push(seedMemory()); await Promise.all([saveTasks(env, c.cleanTasks), saveMemories(env, finalMemories)]); return { ...c, beforeTasks: tasks.length, beforeMemories: memories.length, cleanMemories: finalMemories }; }
function memoryScoreText(memories) { if (!memories.length) return "🧠 Memory Quality: памяти нет."; const rows = memories.map(m => ({ m, q: memoryQuality(m) })); const keep = rows.filter(x => x.q.keep).length; const avg = Math.round(rows.reduce((a, x) => a + x.q.score, 0) / rows.length); return ["🧠 Memory Quality Gate:", `- всего: ${rows.length}`, `- проходит gate: ${keep}`, `- слабая/generic: ${rows.length - keep}`, `- средний score: ${avg}/100`, "", ...rows.slice(-10).map(x => `- q${x.q.score} ${x.q.keep ? "✅" : "🗑"} [${x.m.status}] ${clip(x.m.lesson, 95)}`)].join("\n"); }
async function memoryPruneApply(env) { const memories = await getMemories(env); const kept = visibleMemories(memories); await saveMemories(env, kept); return { before: memories.length, after: kept.length, removed: memories.length - kept.length }; }
function memoryPrunePreviewText(memories) { const weak = memories.filter(m => !memoryQuality(m).keep); return ["🧹 Memory prune preview:", `- памяти сейчас: ${memories.length}`, `- будет удалено: ${weak.length}`, ...weak.slice(0, 12).map(m => `- q${memoryQuality(m).score} ${clip(m.lesson || m.signal, 120)}`), "", "Применить: /memory_prune_apply"].join("\n"); }
function selectRelevant(memories, query, n = 6) { const q = compact(query).split(/\W+/).filter(Boolean); return memories.map(m => { const hay = memoryText(m); const hits = q.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0); return { m, score: hits * 30 + memoryQuality(m).score + (m.status === "rule" ? 30 : m.status === "fact" ? 15 : 0) }; }).sort((a, b) => b.score - a.score).slice(0, n).map(x => x.m); }

async function chat(env, cfg, prompt) {
  const input = tokenEstimate(prompt);
  const maxOut = Math.min(cfg.maxOutputTokens, 1200);
  const brain = await checkBudget(env, cfg, input, maxOut);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cfg.OPENROUTER_API_KEY }, body: JSON.stringify({ model: cfg.modelCheap, temperature: 0.3, max_tokens: maxOut, messages: [{ role: "system", content: "Ты MiniSkynet Core v2.5. Отвечай по-русски, коротко, честно. Для JSON-заданий возвращай только валидный JSON." }, { role: "user", content: prompt }] }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const content = data?.choices?.[0]?.message?.content || "";
  const out = Number(data?.usage?.completion_tokens || tokenEstimate(content));
  const usedIn = Number(data?.usage?.prompt_tokens || input);
  await addUsage(env, brain, usedIn, out);
  return { content, usage: { input: usedIn, output: out } };
}
function thinkPrompt({ text, tasks, memories, self, goals, plan, project }) {
  return [
    "Ты — MiniSkynet Core v2.5, личный инженерный агент Сергея.",
    `Self: ${JSON.stringify(self)}`,
    `Goals: ${JSON.stringify(goals)}`,
    `Plan: ${JSON.stringify(plan)}`,
    `Active project: ${JSON.stringify(project)}`,
    "Верни строго JSON:",
    '{ "message":"ответ владельцу", "memory_artifact":{"lesson":"...","action":"...","status":"hypothesis|fact|rule","score":1}, "next_tasks":["..."] }',
    "Учитывай active project. Память сохраняй только если это конкретный факт/правило/ошибка/архитектурный вывод о проекте. Не сохраняй generic-фразы. Если нечего сохранить — memory_artifact=null.",
    `Задачи: ${JSON.stringify(visibleTasks(tasks).slice(-10))}`,
    `Релевантная память: ${JSON.stringify(memories)}`,
    `Сообщение владельца: ${text}`
  ].join("\n");
}
async function runThink(env, cfg, chatId, text) {
  const [tasks, allMem, self, goals, plan, projectState] = await Promise.all([getTasks(env), getMemories(env), getSelf(env), getGoals(env), getPlan(env), getProjectState(env)]);
  const project = activeProject(projectState);
  const memories = selectRelevant(visibleMemories(allMem), `${project?.name || ""} ${project?.description || ""} ${text}`, 8);
  let response;
  try { response = await chat(env, cfg, thinkPrompt({ text, tasks, memories, self, goals, plan, project })); }
  catch (err) { return await send(cfg, chatId, `⛔ ${clip(err, 500)}`); }
  const parsed = parseJsonLoose(response.content) || {};
  const message = clip(parsed.message || parsed.answer || response.content || "Готово.", 2500);
  if (parsed.memory_artifact) await saveMemory(env, parsed.memory_artifact, "think");
  for (const t of (parsed.next_tasks || []).slice(0, 3)) await addTask(env, t, 4, false);
  return await send(cfg, chatId, `${message}\n\nusage: in=${response.usage.input} out=${response.usage.output}`);
}

async function createProposal(env, cfg, request) { const r = await chat(env, cfg, ["Создай безопасное предложение улучшения MiniSkynet. Не пиши код, только план.", "Верни JSON: {title, summary, risk, file_path, new_content_description, patch_plan:[...]}", `Запрос: ${request}`].join("\n")); const p = parseJsonLoose(r.content); if (!p?.title) throw new Error("Модель не вернула валидное proposal JSON."); const proposal = { id: uid("prop"), status: "pending", created_at: now(), request: clip(request, 500), title: clip(p.title, 200), summary: clip(p.summary, 1000), risk: clip(p.risk || "unknown", 300), file_path: clip(p.file_path || "docs/proposals/idea.md", 200), description: clip(p.new_content_description, 2000), patch_plan: (p.patch_plan || []).slice(0, 6).map(x => clip(x, 300)) }; const list = await getProposals(env); list.push(proposal); await saveProposals(env, list); return proposal; }
function formatProposal(p) { return [`📦 Proposal ${p.id} [${p.status}]`, `Название: ${p.title}`, `Файл: ${p.file_path || "—"}`, `Риск: ${p.risk}`, `Суть: ${p.summary}`, `Изменение: ${p.description}`, "План:", ...(p.patch_plan || []).map((s, i) => `  ${i + 1}. ${s}`), "", `Одобрить: /approve ${p.id}   Отклонить: /reject ${p.id}`].join("\n"); }
async function approveProposal(env, id) { const list = await getProposals(env); const p = list.find(x => x.id === id); if (!p) throw new Error(`Proposal ${id} не найден.`); if (p.status !== "pending") throw new Error(`Proposal уже ${p.status}.`); p.status = "approved_plan"; p.approved_at = now(); await saveProposals(env, list); return p; }
async function rejectProposal(env, id) { const list = await getProposals(env); const p = list.find(x => x.id === id); if (!p) throw new Error(`Proposal ${id} не найден.`); p.status = "rejected"; await saveProposals(env, list); return p; }
async function reflect(env, cfg, chatId = null) { const r = await memoryPruneApply(env); const report = `🌙 Рефлексия v2.5:\n- память было: ${r.before}\n- стало: ${r.after}\n- удалено слабой/generic: ${r.removed}`; if (chatId) await send(cfg, chatId, report); return report; }

const HELP = [
  "/start /help /status",
  "/self /self_set текст /self_reset",
  "/goals /goal_add текст /goal_del номер /goals_set цель1 | цель2 /goals_reset",
  "/plan /plan_set шаг1 | шаг2 /plan_add текст /plan_done номер /plan_reset /next",
  "/projects /project_add Name: desc /project_set Name: desc /project_focus Name /project_del Name /project_status /project_reset",
  "/think текст — один цикл мышления; обычный текст тоже работает",
  "/tasks /tasks_all /addtask текст",
  "/memory /memory_all /memory_score /memory_prune_preview /memory_prune_apply",
  "/clean_preview /clean_apply /cost /alive_on /alive_off /reflect",
  "/propose текст /proposals /show id /approve id /reject id"
].join("\n");

async function handleCommand(env, cfg, msg) {
  const { chatId, userId, command, args, text } = msg;
  if (command === "/start") { const b = await getBrain(env); b.owner_chat_id = chatId; await saveBrain(env, b); return await send(cfg, chatId, `✅ MiniSkynet Core v2.5 проснулся.\n\nTelegram user id: ${userId}\nChat id: ${chatId}\n\n/help — команды`); }
  if (command === "/help") return await send(cfg, chatId, HELP);
  if (command === "/status") { const [b, tasks, mem, props, goals, plan, projectState] = await Promise.all([getBrain(env), getTasks(env), getMemories(env), getProposals(env), getGoals(env), getPlan(env), getProjectState(env)]); const project = activeProject(projectState); return await send(cfg, chatId, ["📡 MiniSkynet v2.5 status", `- version: ${VERSION}`, `- alive: ${b.alive_enabled}`, `- циклов всего: ${b.stats?.cycles_total || 0}`, `- active project: ${project?.name || "—"}`, `- projects: ${projectState.projects.length}`, `- задачи: active=${visibleTasks(tasks).length}, hidden=${tasks.length - visibleTasks(tasks).length}`, `- память: clean=${visibleMemories(mem).length}, weak=${mem.length - visibleMemories(mem).length}`, `- goals: ${goals.length}`, `- plan steps: ${plan.length}`, `- proposals pending: ${props.filter(p => p.status === "pending").length}`, `- модель: ${cfg.modelCheap}`].join("\n")); }

  if (command === "/self") return await send(cfg, chatId, formatSelf(await getSelf(env)));
  if (command === "/self_set") { if (!args) return await send(cfg, chatId, "Напиши: /self_set Я — ..."); const s = await getSelf(env); s.identity = clip(args, 1200); await saveSelf(env, s); await saveMemory(env, { signal: "Self MiniSkynet изменён владельцем в Telegram.", lesson: "Identity/Self ядра MiniSkynet редактируется через /self_set без редеплоя.", action: "Использовать новый self в /think, /plan и /next.", check: "Проверить командой /self.", status: "fact", score: 95 }, "identity"); return await send(cfg, chatId, "✅ Self обновлён. Проверь: /self"); }
  if (command === "/self_reset") { await kvPut(env, "identity:self", DEFAULT_SELF); return await send(cfg, chatId, "✅ Self сброшен. Проверь: /self"); }
  if (command === "/goals") return await send(cfg, chatId, formatGoals(await getGoals(env)));
  if (command === "/goal_add") { if (!args) return await send(cfg, chatId, "Напиши: /goal_add цель"); const goals = await getGoals(env); goals.push({ id: uid("goal"), text: clip(args, 300), status: "active", created_at: now() }); await saveGoals(env, goals); return await send(cfg, chatId, "✅ Цель добавлена. Проверь: /goals"); }
  if (command === "/goal_del") { const n = parseInt(args, 10); const goals = await getGoals(env); if (!n || n < 1 || n > goals.length) return await send(cfg, chatId, "Укажи номер: /goal_del 2"); const [g] = goals.splice(n - 1, 1); await saveGoals(env, goals); return await send(cfg, chatId, `🗑 Удалил цель: ${g.text}`); }
  if (command === "/goals_set") { const items = splitList(args); if (!items.length) return await send(cfg, chatId, "Напиши: /goals_set цель1 | цель2 | цель3"); await saveGoals(env, items.map((x, i) => ({ id: `g${i + 1}`, text: clip(x, 300), status: "active", updated_at: now() }))); return await send(cfg, chatId, "✅ Goals заменены. Проверь: /goals"); }
  if (command === "/goals_reset") { await saveGoals(env, DEFAULT_GOALS); return await send(cfg, chatId, "✅ Goals сброшены. Проверь: /goals"); }
  if (command === "/plan") return await send(cfg, chatId, formatPlan(await getPlan(env)));
  if (command === "/plan_set") { const items = splitList(args); if (!items.length) return await send(cfg, chatId, "Напиши: /plan_set шаг1 | шаг2 | шаг3"); await savePlan(env, items.map((x, i) => ({ id: `p${i + 1}`, text: clip(x, 300), status: "todo", updated_at: now() }))); return await send(cfg, chatId, "✅ Plan заменён. Проверь: /plan"); }
  if (command === "/plan_add") { if (!args) return await send(cfg, chatId, "Напиши: /plan_add шаг"); const plan = await getPlan(env); plan.push({ id: uid("plan"), text: clip(args, 300), status: "todo", created_at: now() }); await savePlan(env, plan); return await send(cfg, chatId, "✅ Шаг плана добавлен. Проверь: /plan"); }
  if (command === "/plan_done") { const n = parseInt(args, 10); const plan = await getPlan(env); if (!n || n < 1 || n > plan.length) return await send(cfg, chatId, "Укажи номер: /plan_done 1"); plan[n - 1].status = "done"; plan[n - 1].done_at = now(); await savePlan(env, plan); return await send(cfg, chatId, `✅ Закрыл шаг: ${plan[n - 1].text}`); }
  if (command === "/plan_reset") { await savePlan(env, DEFAULT_PLAN); return await send(cfg, chatId, "✅ Plan сброшен. Проверь: /plan"); }
  if (command === "/next") { const [tasks, plan, goals, ps] = await Promise.all([getTasks(env), getPlan(env), getGoals(env), getProjectState(env)]); return await send(cfg, chatId, nextStepText(tasks, plan, goals, activeProject(ps))); }

  if (command === "/projects") return await send(cfg, chatId, formatProjects(await getProjectState(env)));
  if (command === "/project_status") return await send(cfg, chatId, formatProjectStatus(await getProjectState(env)));
  if (command === "/project_add") { const parsed = parseProjectArgs(args); if (!parsed.name || !parsed.description) return await send(cfg, chatId, "Напиши: /project_add MiniSkynet: описание проекта"); const ps = await getProjectState(env); if (resolveProject(ps.projects, parsed.name)) return await send(cfg, chatId, "Такой проект уже есть. Используй /project_set Name: описание"); const p = { id: uid("project"), name: clip(parsed.name, 80), description: clip(parsed.description, 1000), status: "active", created_at: now(), updated_at: now() }; ps.projects.push(p); ps.active = p.name; await saveProjectState(env, ps); await saveMemory(env, { signal: "Project Knowledge обновлён через Telegram.", lesson: `Добавлен проект ${p.name} в KV Project Knowledge MiniSkynet.`, action: "Учитывать активный проект в /think и /next.", check: "Проверить /projects и /project_status.", status: "fact", score: 95 }, "project"); return await send(cfg, chatId, `✅ Проект добавлен и выбран: ${p.name}`); }
  if (command === "/project_set") { const parsed = parseProjectArgs(args); if (!parsed.name || !parsed.description) return await send(cfg, chatId, "Напиши: /project_set MiniSkynet: новое описание"); const ps = await getProjectState(env); let p = resolveProject(ps.projects, parsed.name); if (!p) { p = { id: uid("project"), name: clip(parsed.name, 80), status: "active", created_at: now() }; ps.projects.push(p); } p.description = clip(parsed.description, 1000); p.updated_at = now(); ps.active = p.name; await saveProjectState(env, ps); return await send(cfg, chatId, `✅ Проект обновлён и выбран: ${p.name}`); }
  if (command === "/project_focus") { const ps = await getProjectState(env); const p = resolveProject(ps.projects, args); if (!p) return await send(cfg, chatId, "Не нашёл проект. Посмотри /projects"); ps.active = p.name; await saveProjectState(env, ps); return await send(cfg, chatId, `⭐ Активный проект: ${p.name}`); }
  if (command === "/project_del") { const ps = await getProjectState(env); const p = resolveProject(ps.projects, args); if (!p) return await send(cfg, chatId, "Не нашёл проект. Посмотри /projects"); ps.projects = ps.projects.filter(x => x.id !== p.id); if (projectKey(ps.active) === projectKey(p.name)) ps.active = ps.projects[0]?.name || null; await saveProjectState(env, ps); return await send(cfg, chatId, `🗑 Проект удалён: ${p.name}`); }
  if (command === "/project_reset") { await saveProjectState(env, { projects: DEFAULT_PROJECTS, active: "MiniSkynet" }); return await send(cfg, chatId, "✅ Projects сброшены. Проверь: /projects"); }

  if (command === "/think") return await runThink(env, cfg, chatId, args || "Сделай один маленький полезный шаг для развития активного проекта.");
  if (command === "/tasks") return await send(cfg, chatId, "📋 Активные задачи:\n" + formatTasks(visibleTasks(await getTasks(env))));
  if (command === "/tasks_all") return await send(cfg, chatId, "📋 Все задачи:\n" + formatTasks(await getTasks(env)));
  if (command === "/addtask") { if (!args) return await send(cfg, chatId, "Напиши: /addtask проверить память"); const t = await addTask(env, args, 4, true); return await send(cfg, chatId, `✅ Добавил задачу ${t.id}:\n${t.title}`); }
  if (command === "/memory") return await send(cfg, chatId, "🧠 Качественная память:\n" + formatMemories(visibleMemories(await getMemories(env))));
  if (command === "/memory_all") return await send(cfg, chatId, "🧠 Вся память:\n" + formatMemories(await getMemories(env)));
  if (command === "/memory_score") return await send(cfg, chatId, memoryScoreText(await getMemories(env)));
  if (command === "/memory_prune_preview") return await send(cfg, chatId, memoryPrunePreviewText(await getMemories(env)));
  if (command === "/memory_prune_apply") { const r = await memoryPruneApply(env); return await send(cfg, chatId, `✅ Memory prune применён.\n- было: ${r.before}\n- стало: ${r.after}\n- удалено: ${r.removed}\nПроверь: /memory_score /memory`); }
  if (command === "/clean_preview") { const [tasks, mem] = await Promise.all([getTasks(env), getMemories(env)]); return await send(cfg, chatId, cleanPreviewText(tasks, mem)); }
  if (command === "/clean_apply") { const r = await applyClean(env); return await send(cfg, chatId, `✅ KV очищена.\n- задач было: ${r.beforeTasks}, стало: ${r.cleanTasks.length}\n- памяти было: ${r.beforeMemories}, стало: ${r.cleanMemories.length}\nПроверь: /status /projects /memory_score`); }
  if (command === "/cost") return await send(cfg, chatId, await costReport(env, cfg));
  if (command === "/alive_on") { const b = await getBrain(env); b.alive_enabled = true; b.owner_chat_id = chatId; await saveBrain(env, b); return await send(cfg, chatId, "✅ Alive включён. Cron будет делать маленький шаг примерно раз в 30 минут."); }
  if (command === "/alive_off") { const b = await getBrain(env); b.alive_enabled = false; await saveBrain(env, b); return await send(cfg, chatId, "😴 Alive выключен."); }
  if (command === "/reflect") return await reflect(env, cfg, chatId);
  if (command === "/propose") { if (!args) return await send(cfg, chatId, "Напиши: /propose улучшить память"); await send(cfg, chatId, "🛠 Готовлю proposal..."); try { return await send(cfg, chatId, formatProposal(await createProposal(env, cfg, args))); } catch (e) { return await send(cfg, chatId, `❌ ${clip(e, 400)}`); } }
  if (command === "/proposals") { const p = await getProposals(env); return await send(cfg, chatId, p.length ? "📦 Proposals:\n" + p.slice(-10).map(x => `- ${x.id} [${x.status}] ${x.title}`).join("\n") : "Предложений пока нет. /propose текст — создать."); }
  if (command === "/show") { const p = (await getProposals(env)).find(x => x.id === args.trim()); return await send(cfg, chatId, p ? formatProposal(p) : `Не нашёл proposal ${args}.`); }
  if (command === "/approve") { try { const p = await approveProposal(env, args.trim()); return await send(cfg, chatId, `✅ Одобрено как план: ${p.id}. Код в main не меняю.`); } catch (e) { return await send(cfg, chatId, `❌ ${clip(e, 500)}`); } }
  if (command === "/reject") { try { const p = await rejectProposal(env, args.trim()); return await send(cfg, chatId, `🗑 Отклонено: ${p.id}`); } catch (e) { return await send(cfg, chatId, `❌ ${clip(e, 300)}`); } }
  if (command) return await send(cfg, chatId, `Не знаю команду ${command}. /help — список. Модель не вызываю, чтобы не выдумывать.`);
  if (text) return await runThink(env, cfg, chatId, text);
}

async function aliveTick(env, cfg) {
  const b = await getBrain(env);
  if (!b.alive_enabled || !b.owner_chat_id) return { status: "off" };
  if (b.last_alive_at && Date.now() - Date.parse(b.last_alive_at) < 30 * 60 * 1000) return { status: "too_soon" };
  b.last_alive_at = now(); await saveBrain(env, b);
  await runThink(env, cfg, b.owner_chat_id, "Автоцикл: проверь активный проект, self/goals/plan и предложи один полезный следующий шаг. Не делай код сам.");
  return { status: "done" };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = await loadConfig(env);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, missing: missingCritical(cfg) });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const miss = missingCritical(cfg); if (miss.length) return json({ ok: false, missing: miss }, 500);
      const update = await request.json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (!msg) return json({ ok: true, skipped: "no message" });
      if (!isOwner(cfg, msg.userId)) { await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null); return json({ ok: true, denied: true }); }
      ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ Внутренняя ошибка: ${clip(err, 400)}`).catch(() => null)));
      return json({ ok: true });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    const cfg = await loadConfig(env);
    if (missingCritical(cfg).length) return;
    ctx.waitUntil(aliveTick(env, cfg));
  }
};
