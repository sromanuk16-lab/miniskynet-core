// MiniSkynet Core v2 — clean single-entry Worker.
// Compact port from Claude v2: one router, KV memory/tasks, cost guard, plan proposals.

const VERSION = "v2-clean-2026-07-02";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}
function now() { return new Date().toISOString(); }
function day() { return now().slice(0, 10); }
function uid(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
function tokenEstimate(s) { return Math.max(1, Math.ceil(String(s || "").length / 4)); }
function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (_) {}
  const a = String(s || "").indexOf("{");
  const b = String(s || "").lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(String(s).slice(a, b + 1)); } catch (_) {} }
  return null;
}

const CFG_KEYS = [
  "TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "TELEGRAM_ALLOWED_USER_ID",
  "OPENROUTER_MODEL_CHEAP", "MAX_DAILY_COST_USD", "MAX_CYCLES_PER_DAY", "MAX_OUTPUT_TOKENS"
];

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

async function getBrain(env) {
  const b = await kvGet(env, "brain", {});
  return {
    alive_enabled: false,
    owner_chat_id: null,
    last_alive_at: null,
    stats: { cycles_total: 0, daily: {} },
    ...b,
    stats: { cycles_total: 0, daily: {}, ...(b.stats || {}) }
  };
}
async function saveBrain(env, brain) { await kvPut(env, "brain", brain); }
async function getTasks(env) { return (await kvGet(env, "tasks", { tasks: [] })).tasks || []; }
async function saveTasks(env, tasks) { await kvPut(env, "tasks", { tasks: tasks.slice(-100) }); }
async function getMemories(env) { return (await kvGet(env, "memories", { memories: [] })).memories || []; }
async function saveMemories(env, memories) { await kvPut(env, "memories", { memories: memories.slice(-200) }); }
async function getProposals(env) { return (await kvGet(env, "proposals", { proposals: [] })).proposals || []; }
async function saveProposals(env, proposals) { await kvPut(env, "proposals", { proposals: proposals.slice(-50) }); }

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
async function tg(cfg, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await res.json().catch(() => ({}));
}
async function send(cfg, chatId, text) {
  if (!cfg.TELEGRAM_BOT_TOKEN || !chatId) return;
  return await tg(cfg, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 3900) });
}

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
  st.cycles += 1;
  st.input_tokens += input;
  st.output_tokens += output;
  st.cost_usd = Number((Number(st.cost_usd || 0) + costUsd(input, output)).toFixed(6));
  brain.stats.daily[d] = st;
  brain.stats.cycles_total = Number(brain.stats.cycles_total || 0) + 1;
  await saveBrain(env, brain);
}
async function costReport(env, cfg) {
  const b = await getBrain(env);
  const st = b.stats.daily?.[day()] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  return [
    "💸 CostGuard:",
    `- циклы сегодня: ${st.cycles} / ${cfg.maxCyclesPerDay}`,
    `- tokens: in=${st.input_tokens}, out=${st.output_tokens}`,
    `- cost: ~$${Number(st.cost_usd || 0).toFixed(6)} / $${cfg.maxDailyCostUsd}`
  ].join("\n");
}

const ACTIVE_TASK_STATUSES = new Set(["todo", "retry_wait", "doing", "pending", "active"]);
const VALID_MEMORY_STATUSES = new Set(["hypothesis", "fact", "rule"]);
const STALE_PATTERNS = [
  "growth_hygiene",
  "growth-задача",
  "очередь роста",
  "worker-inspector",
  "worker-agents",
  "worker-universal-proof",
  "обновление статуса диалога завершено",
  "вывод нужно проверять практикой",
  "метрик использования памяти",
  "метрики использования памяти",
  "мониторинг памяти",
  "мониторинга производительности",
  "несуществующими командами проверки"
];
function taskStatus(t) { return String(t?.status || "todo").toLowerCase(); }
function isActiveTask(t) { return ACTIVE_TASK_STATUSES.has(taskStatus(t)); }
function memoryText(m) { return `${m?.signal || ""} ${m?.lesson || ""} ${m?.action || ""} ${m?.check || ""} ${m?.boundary || ""}`.toLowerCase(); }
function isStaleMemory(m) {
  const status = String(m?.status || "").toLowerCase();
  const text = memoryText(m);
  if (!VALID_MEMORY_STATUSES.has(status)) return true;
  return STALE_PATTERNS.some(p => text.includes(p));
}
function visibleMemories(memories) { return memories.filter(m => !isStaleMemory(m)); }
function cleanState(tasks, memories) {
  const cleanTasks = tasks.filter(isActiveTask);
  const cleanMemories = [];
  const seen = new Set();
  for (const m of memories) {
    if (isStaleMemory(m)) continue;
    const k = String(m.lesson || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    cleanMemories.push(m);
  }
  return {
    cleanTasks,
    cleanMemories,
    removedTasks: tasks.length - cleanTasks.length,
    removedMemories: memories.length - cleanMemories.length
  };
}
function cleanPreviewText(tasks, memories) {
  const c = cleanState(tasks, memories);
  const staleMem = memories.filter(isStaleMemory).slice(0, 8);
  const archivedTasks = tasks.filter(t => !isActiveTask(t)).slice(0, 8);
  return [
    "🧹 KV Hygiene preview:",
    `- задач сейчас: ${tasks.length}, останется active: ${c.cleanTasks.length}, будет убрано: ${c.removedTasks}`,
    `- памяти сейчас: ${memories.length}, останется чистой: ${c.cleanMemories.length}, будет убрано: ${c.removedMemories}`,
    "",
    "Примеры задач на уборку:",
    ...(archivedTasks.length ? archivedTasks.map(t => `- [${t.status}] ${String(t.title || "").slice(0, 120)}`) : ["- нет"]),
    "",
    "Примеры памяти на уборку:",
    ...(staleMem.length ? staleMem.map(m => `- [${m.status}] ${String(m.lesson || m.signal || "").slice(0, 120)}`) : ["- нет"]),
    "",
    "Применить: /clean_apply"
  ].join("\n");
}
async function applyClean(env) {
  const [tasks, memories] = await Promise.all([getTasks(env), getMemories(env)]);
  const c = cleanState(tasks, memories);
  c.cleanMemories.push(normalizeMemory({
    signal: "MiniSkynet Core v2 запущен после очистки KV.",
    lesson: "Старая Growth-память признана устаревшей; дальше развивать v2 маленькими безопасными патчами.",
    action: "Опираться на чистые задачи, явные цели и проверяемые команды v2.",
    check: "Проверять /status, /tasks, /memory и /cost после каждого патча.",
    boundary: "Старая KV могла содержать полезные исторические следы, но не должна управлять v2.",
    status: "fact",
    score: 95
  }, "hygiene"));
  await Promise.all([saveTasks(env, c.cleanTasks), saveMemories(env, c.cleanMemories)]);
  return { ...c, beforeTasks: tasks.length, beforeMemories: memories.length };
}

async function chat(env, cfg, prompt) {
  const input = tokenEstimate(prompt);
  const maxOut = Math.min(cfg.maxOutputTokens, 1200);
  const brain = await checkBudget(env, cfg, input, maxOut);
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + cfg.OPENROUTER_API_KEY },
    body: JSON.stringify({
      model: cfg.modelCheap,
      temperature: 0.3,
      max_tokens: maxOut,
      messages: [
        { role: "system", content: "Ты MiniSkynet Core v2. Отвечай по-русски, коротко, честно. Для JSON-заданий возвращай только валидный JSON." },
        { role: "user", content: prompt }
      ]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const content = data?.choices?.[0]?.message?.content || "";
  const out = Number(data?.usage?.completion_tokens || tokenEstimate(content));
  const usedIn = Number(data?.usage?.prompt_tokens || input);
  await addUsage(env, brain, usedIn, out);
  return { content, usage: { input: usedIn, output: out } };
}

function normalizeMemory(raw, agent = "core") {
  return {
    id: uid("mem"), time: now(), agent,
    signal: String(raw.signal || "Вывод MiniSkynet").slice(0, 300),
    lesson: String(raw.lesson || raw.text || "").slice(0, 600),
    action: String(raw.action || "Учитывать дальше.").slice(0, 400),
    check: String(raw.check || "Проверить практикой.").slice(0, 300),
    boundary: String(raw.boundary || "Может устареть.").slice(0, 300),
    status: ["hypothesis", "fact", "rule"].includes(raw.status) ? raw.status : "hypothesis",
    score: Math.max(1, Math.min(100, Number(raw.score || 50)))
  };
}
async function saveMemory(env, raw, agent = "core") {
  const m = normalizeMemory(raw, agent);
  if (!m.lesson) return null;
  const memories = await getMemories(env);
  memories.push(m);
  await saveMemories(env, memories);
  return m;
}
function selectRelevant(memories, query, n = 6) {
  const q = String(query || "").toLowerCase().split(/\W+/).filter(Boolean);
  return memories.map(m => {
    const hay = `${m.signal} ${m.lesson} ${m.action}`.toLowerCase();
    const hits = q.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0);
    const score = hits * 30 + (m.score || 0) + (m.status === "rule" ? 30 : m.status === "fact" ? 15 : 0);
    return { m, score };
  }).sort((a, b) => b.score - a.score).slice(0, n).map(x => x.m);
}
function formatTasks(tasks) {
  if (!tasks.length) return "пусто";
  return tasks.slice(-20).map(t => `- ${t.id} [${t.status}] p${t.priority}: ${t.title}`).join("\n");
}
function formatMemories(memories) {
  if (!memories.length) return "пусто";
  return memories.slice(-10).map(m => `- [${m.status}/${m.score}] ${m.lesson}\n  action: ${m.action}`).join("\n");
}
async function addTask(env, title, priority = 4) {
  const tasks = await getTasks(env);
  const task = { id: uid("task"), title: String(title).slice(0, 300), priority, status: "todo", created_at: now() };
  tasks.push(task);
  await saveTasks(env, tasks);
  return task;
}

function thinkPrompt({ text, tasks, memories }) {
  return [
    "Ты — MiniSkynet Core v2, личный инженерный агент Сергея.",
    "Цель: быть полезным, честным, не выдумывать выполненные действия.",
    "Верни строго JSON:",
    '{ "message":"ответ владельцу", "memory_artifact":{"lesson":"...","action":"...","status":"hypothesis|fact|rule","score":1}, "next_tasks":["..."] }',
    "Если нечего сохранить в память — memory_artifact=null. next_tasks максимум 3.",
    `Задачи: ${JSON.stringify(tasks.filter(isActiveTask).slice(-10))}`,
    `Релевантная память: ${JSON.stringify(memories)}`,
    `Сообщение владельца: ${text}`
  ].join("\n");
}

async function runThink(env, cfg, chatId, text) {
  const [tasks, allMem] = await Promise.all([getTasks(env), getMemories(env)]);
  const memories = selectRelevant(visibleMemories(allMem), text, 8);
  let response;
  try {
    response = await chat(env, cfg, thinkPrompt({ text, tasks, memories }));
  } catch (err) {
    return await send(cfg, chatId, `⛔ ${String(err).slice(0, 500)}`);
  }
  const parsed = parseJsonLoose(response.content) || {};
  const message = String(parsed.message || parsed.answer || response.content || "Готово.").slice(0, 2500);
  if (parsed.memory_artifact) await saveMemory(env, parsed.memory_artifact, "think");
  for (const t of (parsed.next_tasks || []).slice(0, 3)) await addTask(env, t, 4);
  return await send(cfg, chatId, `${message}\n\nusage: in=${response.usage.input} out=${response.usage.output}`);
}

async function createProposal(env, cfg, request) {
  const prompt = [
    "Создай безопасное предложение улучшения MiniSkynet. Не пиши код, только план.",
    "Верни JSON: {title, summary, risk, file_path, new_content_description, patch_plan:[...]}",
    "file_path только внутри cloudflare/, docs/ или scripts/. Никакого auto-apply.",
    `Запрос: ${request}`
  ].join("\n");
  const r = await chat(env, cfg, prompt);
  const p = parseJsonLoose(r.content);
  if (!p?.title) throw new Error("Модель не вернула валидное proposal JSON.");
  const proposal = {
    id: uid("prop"), status: "pending", created_at: now(), request: String(request).slice(0, 500),
    title: String(p.title).slice(0, 200), summary: String(p.summary || "").slice(0, 1000),
    risk: String(p.risk || "unknown").slice(0, 300), file_path: String(p.file_path || "docs/proposals/idea.md").slice(0, 200),
    description: String(p.new_content_description || "").slice(0, 2000),
    patch_plan: (p.patch_plan || []).slice(0, 6).map(x => String(x).slice(0, 300))
  };
  const list = await getProposals(env);
  list.push(proposal);
  await saveProposals(env, list);
  return proposal;
}
function formatProposal(p) {
  return [`📦 Proposal ${p.id} [${p.status}]`, `Название: ${p.title}`, `Файл: ${p.file_path || "—"}`, `Риск: ${p.risk}`, `Суть: ${p.summary}`, `Изменение: ${p.description}`, "План:", ...(p.patch_plan || []).map((s, i) => `  ${i + 1}. ${s}`), "", `Одобрить: /approve ${p.id}   Отклонить: /reject ${p.id}`].join("\n");
}
async function approveProposal(env, id) {
  const list = await getProposals(env);
  const p = list.find(x => x.id === id);
  if (!p) throw new Error(`Proposal ${id} не найден.`);
  if (p.status !== "pending") throw new Error(`Proposal уже ${p.status}.`);
  p.status = "approved_plan";
  p.approved_at = now();
  await saveProposals(env, list);
  return p;
}
async function rejectProposal(env, id) {
  const list = await getProposals(env);
  const p = list.find(x => x.id === id);
  if (!p) throw new Error(`Proposal ${id} не найден.`);
  p.status = "rejected";
  await saveProposals(env, list);
  return p;
}

async function reflect(env, cfg, chatId = null) {
  const mem = await getMemories(env);
  const seen = new Map();
  let dup = 0;
  const kept = [];
  for (const m of mem) {
    if (isStaleMemory(m)) { dup++; continue; }
    const k = String(m.lesson || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!k) continue;
    if (seen.has(k)) { kept[seen.get(k)].repeat_count = (kept[seen.get(k)].repeat_count || 1) + 1; dup++; continue; }
    seen.set(k, kept.length); kept.push(m);
  }
  await saveMemories(env, kept);
  const report = [`🌙 Рефлексия v2:`, `- мусора/дублей убрано: ${dup}`, `- памяти было: ${mem.length}, стало: ${kept.length}`, "Для задач используй /clean_preview и /clean_apply."].join("\n");
  if (chatId) await send(cfg, chatId, report);
  return report;
}

const HELP = [
  "/start — включить v2 и показать id",
  "/status — состояние ядра",
  "/think текст — один цикл мышления; обычный текст тоже работает",
  "/tasks /tasks_all /addtask текст — задачи",
  "/memory /memory_all — память",
  "/clean_preview /clean_apply — уборка старой KV-памяти и задач",
  "/cost — расходы",
  "/alive_on /alive_off — автоцикл",
  "/reflect — чистка/рефлексия памяти",
  "/propose текст /proposals /show id /approve id /reject id — safe self-update plan"
].join("\n");

async function handleCommand(env, cfg, msg) {
  const { chatId, userId, command, args, text } = msg;
  if (command === "/start") {
    const b = await getBrain(env); b.owner_chat_id = chatId; await saveBrain(env, b);
    let out = `✅ MiniSkynet Core v2 проснулся.\n\nTelegram user id: ${userId}\nChat id: ${chatId}\n\n/help — команды`;
    if (!cfg.TELEGRAM_ALLOWED_USER_ID) out += "\n\n⚠️ TELEGRAM_ALLOWED_USER_ID не задан — бот открыт всем.";
    return await send(cfg, chatId, out);
  }
  if (command === "/help") return await send(cfg, chatId, HELP);
  if (command === "/status") {
    const [b, tasks, mem, props] = await Promise.all([getBrain(env), getTasks(env), getMemories(env), getProposals(env)]);
    const active = tasks.filter(isActiveTask).length;
    const hidden = tasks.length - active;
    const cleanMem = visibleMemories(mem).length;
    const hiddenMem = mem.length - cleanMem;
    const pending = props.filter(p => p.status === "pending").length;
    return await send(cfg, chatId, ["📡 MiniSkynet v2 status", `- version: ${VERSION}`, `- alive: ${b.alive_enabled}`, `- циклов всего: ${b.stats?.cycles_total || 0}`, `- задачи: active=${active}, hidden=${hidden}`, `- память: clean=${cleanMem}, hidden=${hiddenMem}`, `- proposals pending: ${pending}`, `- модель: ${cfg.modelCheap}`].join("\n"));
  }
  if (command === "/think") return await runThink(env, cfg, chatId, args || "Сделай один маленький полезный шаг для развития MiniSkynet.");
  if (command === "/tasks") return await send(cfg, chatId, "📋 Активные задачи:\n" + formatTasks((await getTasks(env)).filter(isActiveTask)));
  if (command === "/tasks_all") return await send(cfg, chatId, "📋 Все задачи:\n" + formatTasks(await getTasks(env)));
  if (command === "/addtask") { if (!args) return await send(cfg, chatId, "Напиши: /addtask проверить память"); const t = await addTask(env, args); return await send(cfg, chatId, `✅ Добавил задачу ${t.id}:\n${t.title}`); }
  if (command === "/memory") return await send(cfg, chatId, "🧠 Чистая память:\n" + formatMemories(visibleMemories(await getMemories(env))));
  if (command === "/memory_all") return await send(cfg, chatId, "🧠 Вся память:\n" + formatMemories(await getMemories(env)));
  if (command === "/clean_preview") { const [tasks, mem] = await Promise.all([getTasks(env), getMemories(env)]); return await send(cfg, chatId, cleanPreviewText(tasks, mem)); }
  if (command === "/clean_apply") { const r = await applyClean(env); return await send(cfg, chatId, [`✅ KV очищена.`, `- задач было: ${r.beforeTasks}, стало: ${r.cleanTasks.length}, убрано: ${r.removedTasks}`, `- памяти было: ${r.beforeMemories}, стало: ${r.cleanMemories.length}, убрано: ${r.removedMemories}`, `Проверь: /status /tasks /memory`].join("\n")); }
  if (command === "/cost") return await send(cfg, chatId, await costReport(env, cfg));
  if (command === "/alive_on") { const b = await getBrain(env); b.alive_enabled = true; b.owner_chat_id = chatId; await saveBrain(env, b); return await send(cfg, chatId, "✅ Alive включён. Cron будет делать маленький шаг примерно раз в 30 минут."); }
  if (command === "/alive_off") { const b = await getBrain(env); b.alive_enabled = false; await saveBrain(env, b); return await send(cfg, chatId, "😴 Alive выключен."); }
  if (command === "/reflect") return await reflect(env, cfg, chatId);
  if (command === "/propose") { if (!args) return await send(cfg, chatId, "Напиши: /propose улучшить память"); await send(cfg, chatId, "🛠 Готовлю proposal..."); try { return await send(cfg, chatId, formatProposal(await createProposal(env, cfg, args))); } catch (e) { return await send(cfg, chatId, `❌ ${String(e).slice(0, 400)}`); } }
  if (command === "/proposals") { const p = await getProposals(env); if (!p.length) return await send(cfg, chatId, "Предложений пока нет. /propose текст — создать."); return await send(cfg, chatId, "📦 Proposals:\n" + p.slice(-10).map(x => `- ${x.id} [${x.status}] ${x.title}`).join("\n")); }
  if (command === "/show") { const p = (await getProposals(env)).find(x => x.id === args.trim()); return await send(cfg, chatId, p ? formatProposal(p) : `Не нашёл proposal ${args}.`); }
  if (command === "/approve") { if (!args) return await send(cfg, chatId, "Укажи id: /approve prop_xxx"); try { const p = await approveProposal(env, args.trim()); return await send(cfg, chatId, `✅ Одобрено как план: ${p.id}. Код в main не меняю.`); } catch (e) { return await send(cfg, chatId, `❌ Approve не прошёл: ${String(e).slice(0, 500)}`); } }
  if (command === "/reject") { if (!args) return await send(cfg, chatId, "Укажи id: /reject prop_xxx"); try { const p = await rejectProposal(env, args.trim()); return await send(cfg, chatId, `🗑 Отклонено: ${p.id}`); } catch (e) { return await send(cfg, chatId, `❌ ${String(e).slice(0, 300)}`); } }
  if (command) return await send(cfg, chatId, `Не знаю команду ${command}. /help — список. Модель не вызываю, чтобы не выдумывать.`);
  if (text) return await runThink(env, cfg, chatId, text);
}

async function aliveTick(env, cfg) {
  const b = await getBrain(env);
  if (!b.alive_enabled || !b.owner_chat_id) return { status: "off" };
  if (b.last_alive_at && Date.now() - Date.parse(b.last_alive_at) < 30 * 60 * 1000) return { status: "too_soon" };
  b.last_alive_at = now(); await saveBrain(env, b);
  await runThink(env, cfg, b.owner_chat_id, "Автоцикл: проверь своё состояние и предложи один маленький полезный шаг. Не делай код сам.");
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
      ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ Внутренняя ошибка: ${String(err).slice(0, 400)}`).catch(() => null)));
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
