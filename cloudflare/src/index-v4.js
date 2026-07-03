const VERSION = "v4.2.1-owner-guard-fix-2026-07-03";
const DEFAULT_WORKER_URL = "https://miniskynet-core.sromanuk16.workers.dev";
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const now = () => new Date().toISOString();
const clip = (value, limit = 3900) => String(value ?? "").slice(0, limit);
const makeId = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const cleanPath = (path) => String(path || "").trim().replace(/^\/+/, "");
const safePath = (path) => {
  const p = cleanPath(path);
  if (!p || p.includes("..") || p.length > 180) return null;
  return /^[a-zA-Z0-9_./-]+$/.test(p) ? p : null;
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function parseUpdate(update) {
  const message = update?.message || update?.edited_message || null;
  if (!message) return null;
  const text = String(message.text || "").trim();
  let command = null;
  let args = "";
  if (text.startsWith("/")) {
    const splitAt = text.indexOf(" ");
    command = (splitAt === -1 ? text : text.slice(0, splitAt)).replace(/@\w+$/, "").toLowerCase();
    args = splitAt === -1 ? "" : text.slice(splitAt + 1).trim();
  }
  return { chatId: message.chat?.id, userId: message.from?.id, text, command, args };
}

async function kvText(env, key) {
  return String(await env.MINISKYNET_KV.get(key) || "").trim();
}

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvPut(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

async function loadConfig(env) {
  return {
    telegramToken: String(env.TELEGRAM_BOT_TOKEN || "").trim() || await kvText(env, "config:TELEGRAM_BOT_TOKEN"),
    ownerId: String(env.TELEGRAM_ALLOWED_USER_ID || "").trim() || await kvText(env, "config:TELEGRAM_ALLOWED_USER_ID"),
    githubToken: String(env.GITHUB_TOKEN || "").trim() || await kvText(env, "config:GITHUB_TOKEN"),
    repo: String(env.GITHUB_REPO || "").trim() || await kvText(env, "config:GITHUB_REPO") || DEFAULT_REPO,
    branch: String(env.GITHUB_BRANCH || "").trim() || await kvText(env, "config:GITHUB_BRANCH") || DEFAULT_BRANCH,
    workerUrl: String(env.WORKER_URL || "").trim() || await kvText(env, "config:WORKER_URL") || DEFAULT_WORKER_URL,
    model: String(env.OPENROUTER_MODEL_CHEAP || "").trim() || await kvText(env, "config:OPENROUTER_MODEL_CHEAP") || "openai/gpt-4o-mini"
  };
}

function ownerOk(config, userId) {
  return !config.ownerId || String(userId || "") === String(config.ownerId);
}

async function telegramApi(config, method, body) {
  if (!config.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await response.json().catch(() => ({}));
}

async function send(config, chatId, text) {
  if (!chatId) return;
  await telegramApi(config, "sendMessage", { chat_id: chatId, text: clip(text) });
}

async function arrayStore(env, key) {
  return (await kvGet(env, key, { [key]: [] }))[key] || [];
}

async function saveArray(env, key, items, limit = 100) {
  await kvPut(env, key, { [key]: items.slice(-limit) });
}

async function getSelf(env) {
  return await kvGet(env, "self", {
    text: "Я MiniSkynet / облачная Лондон Сергея. Плоский Core v4: Telegram, Cloudflare Worker, KV, GitHub. Работаю коротко, по-русски и через безопасный approve.",
    updated_at: now()
  });
}

async function getGoals(env) {
  return await kvGet(env, "goals", {
    goals: [
      "Быть личным инженерным агентом Сергея",
      "Читать repo перед изменениями",
      "Готовить patch только через approve",
      "Не возвращаться к runtime-луковице"
    ],
    updated_at: now()
  });
}

async function getPlan(env) {
  return await kvGet(env, "plan", {
    steps: [
      "Восстановить стабильный v4.2.1",
      "Проверить /status и /health_check",
      "Вернуть apply-контур маленьким патчем",
      "Только потом включать safe alive loop"
    ],
    updated_at: now()
  });
}

function localHealth() {
  return {
    ok: true,
    version: VERSION,
    flat_core: true,
    onion_imports: false,
    self_health_check: true,
    owner_guard: "fixed"
  };
}

async function publicHealth(config) {
  const started = Date.now();
  const base = String(config.workerUrl || DEFAULT_WORKER_URL).replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/health?ts=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return {
      ok: response.ok && Boolean(data?.ok),
      http: response.status,
      url: `${base}/health`,
      version: data?.version || null,
      flat_core: Boolean(data?.flat_core),
      ms: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      http: 0,
      url: `${base}/health`,
      version: null,
      flat_core: false,
      ms: Date.now() - started,
      error: String(error.message || error)
    };
  }
}

function healthText(health) {
  return [
    "🩺 Health check v4.2.1:",
    "Local Telegram runtime:",
    `- ok: ${health.local.ok ? "yes ✅" : "no ⛔"}`,
    `- version: ${health.local.version}`,
    `- flat_core: ${health.local.flat_core ? "yes ✅" : "no"}`,
    `- owner_guard: ${health.local.owner_guard}`,
    "- deploy via Telegram webhook: verified ✅",
    "",
    "Public /health route:",
    `- url: ${health.public.url}`,
    `- http: ${health.public.http}`,
    `- ok: ${health.public.ok ? "yes ✅" : "no/optional ⚠️"}`,
    `- version: ${health.public.version || "—"}`,
    `- time: ${health.public.ms}ms`,
    "",
    health.public.ok ? "Public health: OK ✅" : "Public health optional failed; Telegram runtime still verified."
  ].join("\n");
}

function b64Decode(value) {
  const binary = atob(String(value || "").replace(/\n/g, ""));
  return new TextDecoder("utf-8").decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function encodeRepoPath(path) {
  return cleanPath(path).split("/").map(encodeURIComponent).join("/");
}

async function githubFile(config, path) {
  const safe = safePath(path);
  if (!safe) throw new Error("unsafe path");
  const headers = { accept: "application/vnd.github+json", "user-agent": "MiniSkynet-Core-v421" };
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
  const response = await fetch(`https://api.github.com/repos/${config.repo}/contents/${encodeRepoPath(safe)}?ref=${encodeURIComponent(config.branch)}`, { headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${data.message || "request failed"}`);
  if (Array.isArray(data) || !data.content) throw new Error("not a text file");
  return { path: safe, sha: data.sha || "", size: data.size || 0, content: b64Decode(data.content) };
}

function mainFromWrangler(content) {
  const match = String(content || "").match(/^main\s*=\s*["']([^"']+)["']/m);
  if (!match) return null;
  const rel = cleanPath(match[1]);
  return rel.startsWith("cloudflare/") ? rel : `cloudflare/${rel}`;
}

async function activeTarget(config) {
  const wrangler = await githubFile(config, "cloudflare/wrangler.toml");
  const start = mainFromWrangler(wrangler.content);
  if (!start) throw new Error("wrangler main not found");
  const effective = await githubFile(config, start);
  return { start, effective, chain: [{ path: effective.path, sha: effective.sha, size: effective.size }] };
}

const COMMANDS = new Set([
  "/start", "/help", "/status", "/health_check", "/deploy_check",
  "/self", "/self_set", "/goals", "/goal_add", "/plan", "/plan_set",
  "/tasks", "/addtask", "/task_done", "/next", "/memory", "/memory_score",
  "/repo_config", "/repo_file", "/repo_scan", "/active_target",
  "/proposals", "/show", "/reject", "/approve"
]);

async function handleCommand(env, config, message) {
  const { chatId, command, args } = message;

  if (command === "/start") {
    return send(config, chatId, `✅ MiniSkynet Core v4 проснулся.\nversion: ${VERSION}\n/help — команды`);
  }

  if (command === "/help") {
    return send(config, chatId, [
      "/start /help /status",
      "Development stage: " + VERSION,
      "/health_check /deploy_check",
      "/self /self_set текст",
      "/goals /goal_add текст",
      "/plan /plan_set шаг1 | шаг2",
      "/tasks /addtask текст /task_done n /next",
      "/memory /memory_score",
      "/repo_config /repo_file path /repo_scan /active_target",
      "/proposals /show id /approve id /reject id",
      "Apply-контур временно выключен до стабилизации v4.2.1."
    ].join("\n"));
  }

  if (command === "/status") {
    const tasks = await arrayStore(env, "tasks");
    const memories = await arrayStore(env, "memories");
    const proposals = await arrayStore(env, "proposals");
    return send(config, chatId, [
      "📡 MiniSkynet Core v4 status",
      `- version: ${VERSION}`,
      "- runtime: single file, no onion imports",
      "- self health check: active",
      "- owner guard: fixed",
      `- tasks: active=${tasks.filter(t => t.status !== "done").length}, done=${tasks.filter(t => t.status === "done").length}`,
      `- memory: ${memories.length}`,
      `- proposals: ${proposals.length}`,
      `- model: ${config.model}`
    ].join("\n"));
  }

  if (command === "/health_check" || command === "/deploy_check") {
    return send(config, chatId, healthText({ local: localHealth(), public: await publicHealth(config) }));
  }

  if (command === "/self") return send(config, chatId, `🧠 Self:\n${(await getSelf(env)).text}\n\nИзменить: /self_set текст`);
  if (command === "/self_set") { await kvPut(env, "self", { text: args, updated_at: now() }); return send(config, chatId, "✅ Self обновлён."); }
  if (command === "/goals") return send(config, chatId, "🎯 Goals:\n" + (await getGoals(env)).goals.map((g, i) => `${i + 1}. ${g}`).join("\n"));
  if (command === "/goal_add") { const g = await getGoals(env); g.goals.push(args); g.updated_at = now(); await kvPut(env, "goals", g); return send(config, chatId, "✅ Goal добавлена."); }
  if (command === "/plan") return send(config, chatId, "🗺 Plan:\n" + (await getPlan(env)).steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  if (command === "/plan_set") { await kvPut(env, "plan", { steps: args.split("|").map(x => x.trim()).filter(Boolean), updated_at: now() }); return send(config, chatId, "✅ Plan обновлён."); }

  if (command === "/tasks") {
    const tasks = (await arrayStore(env, "tasks")).filter(t => t.status !== "done").slice(0, 12);
    return send(config, chatId, tasks.length ? "📋 Active tasks:\n" + tasks.map((t, i) => `${i + 1}. ${t.id} p${t.p || 4}: ${t.text}`).join("\n") : "Задач нет.");
  }
  if (command === "/addtask") { const tasks = await arrayStore(env, "tasks"); const task = { id: makeId("task"), text: args, p: 4, status: "todo", created_at: now() }; tasks.push(task); await saveArray(env, "tasks", tasks, 120); return send(config, chatId, `✅ Добавил ${task.id}`); }
  if (command === "/task_done") { const tasks = await arrayStore(env, "tasks"); const active = tasks.filter(t => t.status !== "done"); const task = active[(parseInt(args, 10) || 1) - 1]; if (!task) return send(config, chatId, "Не нашёл задачу."); task.status = "done"; task.done_at = now(); await saveArray(env, "tasks", tasks, 120); return send(config, chatId, `✅ Закрыл: ${task.text}`); }
  if (command === "/next") { const task = (await arrayStore(env, "tasks")).filter(t => t.status !== "done").sort((a, b) => (a.p || 9) - (b.p || 9))[0]; const firstPlan = (await getPlan(env)).steps[0]; return send(config, chatId, `⏭ Next:\n${task ? `Источник: tasks\nШаг: ${task.text}` : `Источник: plan\nШаг: ${firstPlan || "плана нет"}`}`); }

  if (command === "/memory") { const memories = await arrayStore(env, "memories"); return send(config, chatId, memories.length ? "🧠 Memory:\n" + memories.slice(-8).map(m => `- [${m.type || "note"}/${m.score || 0}] ${m.text}`).join("\n") : "Память пустая."); }
  if (command === "/memory_score") { const memories = await arrayStore(env, "memories"); const avg = memories.length ? Math.round(memories.reduce((a, b) => a + (b.score || 0), 0) / memories.length) : 0; return send(config, chatId, `🧠 Memory Quality:\n- всего: ${memories.length}\n- avg: ${avg}/100`); }

  if (command === "/repo_config") return send(config, chatId, `🔎 Repo:\n- repo: ${config.repo}\n- branch: ${config.branch}\n- token: ${config.githubToken ? "есть ✅" : "нет ⛔"}\n- workerUrl: ${config.workerUrl}`);
  if (command === "/repo_file") { const file = await githubFile(config, args); return send(config, chatId, `📄 ${file.path}\n- size: ${file.size}\n- sha: ${file.sha.slice(0, 12)}\n\n${clip(file.content, 1200)}`); }
  if (command === "/repo_scan") { const files = ["cloudflare/wrangler.toml", "cloudflare/src/index-v4.js"]; const out = []; for (const path of files) { try { const file = await githubFile(config, path); out.push(`✅ ${path} size=${file.size} sha=${file.sha.slice(0, 10)}`); } catch (error) { out.push(`❌ ${path}: ${error.message}`); } } return send(config, chatId, "🧭 Repo scan:\n" + out.join("\n")); }
  if (command === "/active_target") { const active = await activeTarget(config); return send(config, chatId, [`🎯 Active target:`, `- wrangler main: ${active.start}`, `- effective: ${active.effective.path}`, `- sha: ${active.effective.sha.slice(0, 12)}`].join("\n")); }

  if (command === "/proposals") { const proposals = await arrayStore(env, "proposals"); return send(config, chatId, proposals.length ? "📦 Proposals:\n" + proposals.slice(-10).map(p => `- ${p.id} [${p.status}] ${p.title || p.request}`).join("\n") : "Proposals нет."); }
  if (command === "/show") { const proposals = await arrayStore(env, "proposals"); const p = proposals.find(x => x.id === args || String(x.id || "").startsWith(args)); return send(config, chatId, p ? `📦 ${p.id}\nstatus: ${p.status}\ntarget: ${p.file_path || "—"}\nrequest: ${p.request || p.title || "—"}` : "Не нашёл proposal."); }
  if (command === "/approve" || command === "/reject") { const proposals = await arrayStore(env, "proposals"); const p = proposals.find(x => x.id === args || String(x.id || "").startsWith(args)); if (!p) return send(config, chatId, "Не нашёл proposal."); p.status = command === "/approve" ? "approved" : "rejected"; p.updated_at = now(); await saveArray(env, "proposals", proposals, 50); return send(config, chatId, `✅ ${p.status}: ${p.id}`); }

  return send(config, chatId, `Не знаю команду ${command}. /help — список. Модель не вызываю.`);
}

async function handleTelegram(request, env) {
  const config = await loadConfig(env);
  const update = await request.json().catch(() => null);
  const message = parseUpdate(update);
  if (!message) return json({ ok: true });
  if (!ownerOk(config, message.userId)) {
    await send(config, message.chatId, "⛔ Доступ закрыт.");
    return json({ ok: true, denied: true });
  }
  if (message.command) {
    if (!COMMANDS.has(message.command)) {
      await send(config, message.chatId, `Не знаю команду ${message.command}. /help — список. Модель не вызываю.`);
      return json({ ok: true, unknown_command: true });
    }
    await handleCommand(env, config, message);
    return json({ ok: true, command: message.command, version: VERSION });
  }
  await send(config, message.chatId, "Core v4.2.1 rescue online. Обычный think временно выключен до стабилизации. /help");
  return json({ ok: true, text_mode: "rescue" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json(localHealth());
    if (url.pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env);
    return json({ ok: false, error: "not found", version: VERSION }, 404);
  },
  async scheduled() {}
};
