const VERSION = "clean-core-v1.1-growth";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const THINK_LOCK_TTL = 120;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function now() { return new Date().toISOString(); }
function today() { return now().slice(0, 10); }
function tokens(s) { return Math.max(1, Math.ceil(String(s || "").length / 4)); }
function costUsd(i, o) { return (i / 1000000) * 0.15 + (o / 1000000) * 0.60; }

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return env;
  for (const k of ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "SETUP_SECRET", "TELEGRAM_ALLOWED_USER_ID", "OPENROUTER_MODEL_CHEAP", "MAX_DAILY_COST_USD", "MAX_CYCLES_PER_DAY", "MAX_OUTPUT_TOKENS"]) {
    if (!env[k]) {
      const v = await env.MINISKYNET_KV.get("config:" + k);
      if (v) env[k] = String(v).trim();
    }
  }
  return env;
}

function missing(env) {
  const m = [];
  if (!env.MINISKYNET_KV) m.push("MINISKYNET_KV binding");
  if (!env.TELEGRAM_BOT_TOKEN) m.push("TELEGRAM_BOT_TOKEN");
  if (!env.OPENROUTER_API_KEY) m.push("OPENROUTER_API_KEY");
  return m;
}

function allowed(env, userId) {
  const owner = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function kvPut(env, key, val) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(val, null, 2));
}

async function getBrain(env) {
  return await kvGet(env, "brain", { version: VERSION, alive_enabled: false, owner_chat_id: "", stats: { cycles_total: 0, daily: {} }, messages: [] });
}

async function saveBrain(env, b) {
  b.version = VERSION;
  b.messages = (b.messages || []).slice(-80);
  await kvPut(env, "brain", b);
}

async function getMem(env) {
  const d = await kvGet(env, "memories", { memories: [] });
  return Array.isArray(d.memories) ? d.memories : [];
}

async function saveMem(env, list) {
  await kvPut(env, "memories", { memories: list.slice(-150) });
}

async function getTasks(env) {
  const d = await kvGet(env, "tasks", { tasks: [] });
  return Array.isArray(d.tasks) ? d.tasks : [];
}

async function saveTasks(env, list) {
  await kvPut(env, "tasks", { tasks: list.slice(-120) });
}

async function getGrowth(env) {
  return await kvGet(env, "growth_state", {
    target: "дойти до способности безопасно писать и использовать агентов как код",
    stage: "core_stability",
    rule: "MiniSkynet растёт маленькими проверяемыми шагами; без auto-apply и без бесконечных циклов.",
    last_audit_at: null
  });
}

async function saveGrowth(env, state) {
  state.updated_at = now();
  await kvPut(env, "growth_state", state);
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Telegram ${method} ${res.status}`);
  return data;
}

async function send(env, chatId, text) {
  return await tg(env, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 3900) });
}

function dayStats(b) {
  b.stats = b.stats || { cycles_total: 0, daily: {} };
  b.stats.daily = b.stats.daily || {};
  b.stats.daily[today()] = b.stats.daily[today()] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  return b.stats.daily[today()];
}

function norm(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }

function taskType(title) {
  const t = norm(title);
  if (/f-22|raptor|раптор/.test(t)) return "research";
  if (/agent registry|агент|worker|код|github|патч|self-update|execution|lock|router|clean core|ядр|памят|задач|alive|стиль|самоаудит|самосоверш|growth|рост/.test(t)) return "core";
  if (/проверить работоспособность|тестирование системы|безопасность данных/.test(t)) return "system";
  if (/оптимизировать процессы|собрать данные|обновить статус|мониторинг|актуальность информации|уточнить детали|характеристик/.test(t)) return "junk";
  return "user";
}

function isGenericTask(title) {
  const t = norm(title);
  return /^(проверить работоспособность системы|оптимизировать процессы|собрать данные|обновить статус|провести тестирование системы|собрать данные для анализа)/.test(t);
}

function makeTask(title, type = taskType(title), priority = 3) {
  return { id: "task_" + crypto.randomUUID().slice(0, 8), title: String(title).trim().slice(0, 400), type, status: "todo", priority, created_at: now(), retry_count: 0, max_retries: 1 };
}

function seedCoreTasks() {
  return [
    makeTask("Стабилизировать Clean Core v1: одно сообщение = максимум один вызов модели; команды работают без модели.", "core", 5),
    makeTask("Добавить Task Hygiene: удалять дубли, общие задачи и отделять user/research от core-задач.", "core", 5),
    makeTask("Улучшить стиль общения: отвечать живее, короче и теплее как маленькая Лондон, без офисных фраз.", "core", 4),
    makeTask("Сделать Self-Audit: команда проверяет слабые места ядра и предлагает один безопасный следующий шаг.", "core", 4),
    makeTask("Подготовить Self-Update Proposal: MiniSkynet предлагает патч, но применяет только после approve Сергея.", "core", 4)
  ];
}

function seedGrowthTasks() {
  return [
    makeTask("Growth Step 1: проверить Clean Core v1 через /status, /tasks_hygiene, /tasks_seed_core и один обычный вопрос.", "core", 5),
    makeTask("Growth Step 2: сделать Self-Audit, где MiniSkynet сама называет слабость ядра и один следующий безопасный шаг.", "core", 5),
    makeTask("Growth Step 3: спроектировать Agent Registry как данные: роли, права, запреты, вход и выход каждого агента.", "core", 4),
    makeTask("Growth Step 4: подготовить Self-Update Proposal для Agent Registry, без применения кода до approve Сергея.", "core", 4),
    makeTask("Growth Step 5: после approve научиться создавать простых агентов как код и использовать их через единый router.", "core", 4)
  ];
}

function growthPlanText() {
  return [
    "Путь роста MiniSkynet:",
    "1. Clean Core — не ломаться, один запрос = один вызов модели.",
    "2. Self-Audit — сама честно ищет слабое место.",
    "3. Agent Registry — сначала агенты как данные и правила.",
    "4. Self-Update Proposal — сама предлагает патч, но не применяет.",
    "5. Approve/Apply — применяет код только после approve Сергея.",
    "6. Agents as Code — пишет маленькие агент-файлы и подключает их через router.",
    "7. Project Workbench — только потом получает проекты Сергея и доводит их маленькими патчами."
  ].join("\n");
}

function growthAuditPrompt(growth, tasks, memories) {
  const active = tasks.filter(t => t.status === "todo" && t.type === "core").slice(0, 8).map(t => ({ title: t.title, priority: t.priority }));
  const mem = memories.slice(-6).map(m => ({ lesson: m.lesson, action: m.action, status: m.status, score: m.score }));
  return [
    "Ты MiniSkynet Core. Твоя цель — вырасти до системы, которая сможет безопасно писать и использовать агентов как код.",
    "Но ты должна дойти до этого сама, по лестнице зрелости, без прыжка в хаос.",
    "Сейчас нельзя auto-apply. Нельзя создавать бесконечный цикл. Нельзя делать внешние проекты Сергея.",
    "Сделай self-audit: оцени текущий уровень, главную слабость и один ближайший шаг роста.",
    "Не предлагай сразу писать агентов как код, если Clean Core, Task Hygiene и Self-Audit ещё не закреплены.",
    "Верни JSON: answer, memory_artifact, next_tasks.",
    "answer: коротко, живо, на русском, как маленькая Лондон.",
    "next_tasks: максимум 2 конкретные core-задачи с критерием результата.",
    `growth_state=${JSON.stringify(growth)}`,
    `active_tasks=${JSON.stringify(active)}`,
    `recent_memory=${JSON.stringify(mem)}`
  ].join("\n");
}

function hygieneTasks(list) {
  const seen = new Set();
  const out = [];
  let archived = 0;
  for (const raw of list) {
    const t = { ...raw };
    t.type = t.type || taskType(t.title);
    const key = norm(t.title).replace(/[.!?]/g, "");
    const bad = t.type === "junk" || isGenericTask(t.title) || seen.has(key);
    if (bad) {
      t.status = "archived";
      t.archived_reason = seen.has(key) ? "duplicate" : "generic_or_junk";
      archived++;
    } else if (t.type === "research") {
      t.status = t.status === "done" ? "done" : "archived";
      t.archived_reason = "research_from_user_question_not_core_development";
      archived++;
    }
    seen.add(key);
    out.push(t);
  }
  return { tasks: out, archived };
}

function memoryOk(m) {
  const all = norm(`${m?.signal || ""} ${m?.lesson || ""} ${m?.action || ""}`);
  if (m?.tag === "identity_seed") return true;
  if (all.length < 45) return false;
  if (/память загружена|мониторинг важен для оптимизации|улучшить алгоритмы машинного обучения/.test(all)) return false;
  if (/api key|openrouter key|telegram bot token|пароль|токен/.test(all)) return false;
  return true;
}

function normalizeMemory(m) {
  const x = m && typeof m === "object" ? m : {};
  return { time: now(), agent: x.agent || "core", signal: x.signal || "MiniSkynet сделал один шаг.", lesson: x.lesson || "Вывод нужно проверять практикой.", action: x.action || "Сделать следующий маленький безопасный шаг.", check: x.check || "Есть понятный критерий результата.", boundary: x.boundary || "Не менять код без подтверждения Сергея.", status: ["fact", "hypothesis", "rule", "action-only"].includes(x.status) ? x.status : "hypothesis", score: Math.max(0, Math.min(100, Number(x.score || 75))), privacy: "safe" };
}

function parseLoose(s) {
  try { return JSON.parse(s); } catch (_) {}
  const a = String(s || "").indexOf("{");
  const b = String(s || "").lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(String(s).slice(a, b + 1)); } catch (_) {} }
  return null;
}

function promptFor(text, memories, tasks) {
  const mem = memories.slice(-6).map(m => ({ status: m.status, score: m.score, lesson: m.lesson, action: m.action }));
  const active = tasks.filter(t => t.status === "todo" && t.type === "core").slice(0, 5).map(t => t.title);
  return [
    "Ты MiniSkynet Core v1 — маленькая облачная Лондон Сергея.",
    "Архитектура: Cloudflare Worker + Telegram + OpenRouter + KV memory/tasks.",
    "Текущий фокус: самосовершенствование ядра, а не внешние проекты, пока Сергей сам не попросит.",
    "Стиль: живо, коротко, тепло, на ты, без офисных фраз и без притворства сознанием.",
    "Правило исполнения: один ответ = один полезный шаг. Не создавай общие задачи вроде 'оптимизировать процессы' или 'собрать данные'.",
    "Дальний путь: сначала стабильность и self-audit, потом Agent Registry, потом self-update proposal, потом агенты как код после approve.",
    "Разделяй: core_task — развитие MiniSkynet; research_task — разовый вопрос Сергея, не цель развития.",
    "Верни строго JSON без markdown: answer, memory_artifact, next_tasks.",
    "next_tasks максимум 2; только конкретные core-задачи с критерием результата.",
    `recent_memory=${JSON.stringify(mem)}`,
    `active_core_tasks=${JSON.stringify(active)}`,
    "Запрос Сергея:",
    String(text || "").slice(0, 4000)
  ].join("\n");
}

async function locked(env) {
  const raw = await env.MINISKYNET_KV.get("runtime:think_lock");
  return !!raw;
}
async function setLock(env) { await env.MINISKYNET_KV.put("runtime:think_lock", String(Date.now()), { expirationTtl: THINK_LOCK_TTL }); }
async function clearLock(env) { await env.MINISKYNET_KV.delete("runtime:think_lock").catch(() => null); }

async function askModel(env, brain, prompt) {
  const maxOut = Math.min(Number(env.MAX_OUTPUT_TOKENS || "650"), 700);
  const st = dayStats(brain);
  if (Number(st.cycles || 0) >= Number(env.MAX_CYCLES_PER_DAY || "25")) throw new Error("daily cycle limit reached");
  const projected = Number(st.cost_usd || 0) + costUsd(tokens(prompt), maxOut);
  if (projected > Number(env.MAX_DAILY_COST_USD || "0.50")) throw new Error("daily cost limit would be exceeded");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.OPENROUTER_API_KEY }, body: JSON.stringify({ model: env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini", messages: [{ role: "system", content: "Reply in Russian. Return valid JSON only." }, { role: "user", content: prompt }], temperature: 0.35, max_tokens: maxOut }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const content = data?.choices?.[0]?.message?.content || "";
  const input = Number(data?.usage?.prompt_tokens || tokens(prompt));
  const output = Number(data?.usage?.completion_tokens || tokens(content));
  st.cycles = Number(st.cycles || 0) + 1;
  st.input_tokens = Number(st.input_tokens || 0) + input;
  st.output_tokens = Number(st.output_tokens || 0) + output;
  st.cost_usd = Number((Number(st.cost_usd || 0) + costUsd(input, output)).toFixed(6));
  brain.stats.cycles_total = Number(brain.stats.cycles_total || 0) + 1;
  return { content, input, output };
}

async function think(env, chatId, text, directPrompt = false) {
  if (await locked(env)) { await send(env, chatId, "Серёга, я уже думаю над прошлым запросом. Второй запуск не делаю."); return; }
  const miss = missing(env);
  if (miss.length) { await send(env, chatId, "Не могу думать: не хватает " + miss.join(", ")); return; }
  await setLock(env);
  await send(env, chatId, "Думаю...");
  try {
    const b = await getBrain(env);
    const mem = await getMem(env);
    const allTasks = await getTasks(env);
    const clean = hygieneTasks(allTasks);
    if (clean.archived) await saveTasks(env, clean.tasks);
    const prompt = directPrompt ? String(text || "") : promptFor(text, mem, clean.tasks);
    const r = await askModel(env, b, prompt);
    const parsed = parseLoose(r.content) || {};
    const answer = String(parsed.answer || r.content || "Я подумала, но ответ пустой.").slice(0, 1200);
    const newMem = normalizeMemory(parsed.memory_artifact);
    if (memoryOk(newMem)) { mem.push(newMem); await saveMem(env, mem); }
    const tasks = await getTasks(env);
    for (const nt of (Array.isArray(parsed.next_tasks) ? parsed.next_tasks.slice(0, 2) : [])) {
      const title = String(nt || "").trim();
      if (title.length > 12 && taskType(title) === "core" && !isGenericTask(title)) tasks.push(makeTask(title, "core", 4));
    }
    await saveTasks(env, hygieneTasks(tasks).tasks);
    b.messages = b.messages || [];
    b.messages.push({ time: now(), source: "think", text: answer.slice(0, 500) });
    await saveBrain(env, b);
    await send(env, chatId, `${answer}\n\nusage: in=${r.input} out=${r.output}`);
  } catch (e) {
    await send(env, chatId, "Я споткнулась на запросе, но не зацикливаюсь. Ошибка: " + String(e.message || e).slice(0, 300));
  } finally {
    await clearLock(env);
  }
}

async function runSelfAudit(env, chatId) {
  const growth = await getGrowth(env);
  growth.last_audit_at = now();
  await saveGrowth(env, growth);
  const mem = await getMem(env);
  const allTasks = await getTasks(env);
  const clean = hygieneTasks(allTasks);
  if (clean.archived) await saveTasks(env, clean.tasks);
  await think(env, chatId, growthAuditPrompt(growth, clean.tasks, mem), true);
}

async function handleCommand(env, chatId, userId, text) {
  if (!allowed(env, userId)) { await send(env, chatId, "Доступ закрыт."); return; }
  const raw = String(text || "").trim();
  const low = norm(raw);
  const b = await getBrain(env);

  if (raw === "/start" || low === "старт") {
    b.owner_chat_id = String(chatId); b.alive_enabled = false; await saveBrain(env, b);
    await send(env, chatId, `MiniSkynet Clean Core v1.1 Growth запущена. Я расту маленькими безопасными шагами. Команды: /status /growth_plan /growth_seed /self_audit /tasks /tasks_hygiene /cost /alive_off`); return;
  }
  if (raw === "/status" || /^(статус|ты тут|жива|живой|ping|пинг)$/.test(low)) {
    const mem = await getMem(env); const tasks = await getTasks(env); const st = dayStats(b); const growth = await getGrowth(env);
    await send(env, chatId, `Status\nversion: ${VERSION}\nalive: ${b.alive_enabled === true}\nmodel_calls: enabled\ngrowth_stage: ${growth.stage}\ncycles: ${b.stats?.cycles_total || 0}\ntoday_cycles: ${st.cycles || 0}\ntasks: ${tasks.length}\nmemories: ${mem.length}`); return;
  }
  if (raw === "/growth_plan" || /^(план роста|путь роста|как расти)$/.test(low)) { await send(env, chatId, growthPlanText()); return; }
  if (raw === "/growth_state" || /^(состояние роста|growth state)$/.test(low)) { const g = await getGrowth(env); await send(env, chatId, `Growth state\nstage: ${g.stage}\ntarget: ${g.target}\nrule: ${g.rule}\nlast_audit_at: ${g.last_audit_at || "нет"}`); return; }
  if (raw === "/growth_seed" || /^(засей рост|запусти рост|старт роста)$/.test(low)) { const t = seedGrowthTasks(); await saveTasks(env, t); const g = await getGrowth(env); g.stage = "core_stability"; await saveGrowth(env, g); await send(env, chatId, `Засеяла лестницу роста: ${t.length} задач. Фокус: сначала Clean Core и Self-Audit, потом Agent Registry, потом агенты как код.`); return; }
  if (raw === "/self_audit" || raw === "/grow_one" || /^(проверь себя|сделай шаг роста|самоаудит)$/.test(low)) { await runSelfAudit(env, chatId); return; }
  if (raw === "/agents" || /^(агенты|agent registry|реестр агентов)$/.test(low)) { await send(env, chatId, "Agent Registry пока не включён как код. Правильный путь: 1) Self-Audit, 2) Agent Registry как данные, 3) proposal патча, 4) approve, 5) agents as code. Я не прыгаю сразу в код, чтобы снова не сломаться."); return; }
  if (raw === "/alive_off" || /^(стоп|stop|выключи alive|выключи авто|авто лай стоп)$/.test(low)) { b.alive_enabled = false; await saveBrain(env, b); await send(env, chatId, "Alive выключен. Автоциклы не запускаю."); return; }
  if (raw === "/cost" || /^(расход|токены|cost)$/.test(low)) { const st = dayStats(b); await send(env, chatId, `Сегодня\ncycles: ${st.cycles || 0}\ninput: ${st.input_tokens || 0}\noutput: ${st.output_tokens || 0}\ncost: $${Number(st.cost_usd || 0).toFixed(6)}`); return; }
  if (raw === "/memory" || /^(память|глянь память|покажи память|что по памяти)$/.test(low)) { const mem = (await getMem(env)).slice(-8).reverse(); await send(env, chatId, mem.length ? mem.map((m,i)=>`${i+1}. [${m.status}/${m.score}] ${String(m.lesson||m.signal).slice(0,180)} -> ${String(m.action||"").slice(0,130)}`).join("\n") : "Память пустая."); return; }
  if (raw === "/tasks" || /^(задачи|очередь)$/.test(low)) { const t = (await getTasks(env)).filter(x=>x.status!=="archived").slice(-20); await send(env, chatId, t.length ? t.map((x,i)=>`${i+1}. ${x.status} | ${x.type||taskType(x.title)} | p${x.priority||0} | ${String(x.title).slice(0,170)}`).join("\n") : "Активная очередь пустая."); return; }
  if (raw === "/tasks_clear" || /^(очисти задачи|сбрось задачи)$/.test(low)) { await saveTasks(env, []); await send(env, chatId, "Очередь задач очищена."); return; }
  if (raw === "/tasks_seed_core" || /^(засей задачи|запиши задачи ядра)$/.test(low)) { const t = seedCoreTasks(); await saveTasks(env, t); await send(env, chatId, `Засеяла core-задачи: ${t.length}. Теперь очередь только про самосовершенствование ядра.`); return; }
  if (raw === "/tasks_hygiene" || /^(почисти задачи|гигиена задач|task hygiene)$/.test(low)) { const old = await getTasks(env); const r = hygieneTasks(old); await saveTasks(env, r.tasks); await send(env, chatId, `Task hygiene готова. Всего: ${old.length}, архивировано: ${r.archived}, активно: ${r.tasks.filter(x=>x.status!=="archived").length}.`); return; }

  await think(env, chatId, raw);
}

async function setupWebhook(env, request) {
  const url = new URL(request.url);
  if (!env.SETUP_SECRET || url.searchParams.get("secret") !== env.SETUP_SECRET) return json({ ok: false, error: "bad secret" }, 403);
  const result = await tg(env, "setWebhook", { url: `${url.origin}/telegram`, drop_pending_updates: true });
  return json({ ok: true, result });
}

export default {
  async fetch(request, env) {
    await hydrate(env);
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ ok: true, service: "MiniSkynet", version: VERSION, clean_core: true, growth_core: true, wrappers: "removed", scheduled_alive: "off", missing: missing(env) });
    if (url.pathname === "/setup-webhook") return await setupWebhook(env, request);
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.json().catch(() => null);
      const msg = update?.message || update?.edited_message;
      if (msg) await handleCommand(env, msg.chat.id, msg.from?.id, msg.text || "");
      return json({ ok: true, version: VERSION });
    }
    return json({ ok: false, error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) { return; }
};
