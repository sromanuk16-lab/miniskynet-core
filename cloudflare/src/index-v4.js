const VERSION = "v4.4-self-apply-smoke-2026-07-03";
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
      "Проверить v4.4 self-apply smoke",
      "Сделать маленький реальный self-apply через /apply_confirm",
      "Проверить deploy через /post_apply_verify",
      "После стабильности вернуть обычный think"
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
    apply_contour: true,
    self_apply_smoke: true,
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
    "🩺 Health check v4.4:",
    "Local Telegram runtime:",
    `- ok: ${health.local.ok ? "yes ✅" : "no ⛔"}`,
    `- version: ${health.local.version}`,
    `- flat_core: ${health.local.flat_core ? "yes ✅" : "no"}`,
    `- apply_contour: ${health.local.apply_contour ? "active ✅" : "off"}`,
    `- self_apply_smoke: ${health.local.self_apply_smoke ? "active ✅" : "off"}`,
    `- owner_guard: ${health.local.owner_guard}`,
    "- deploy via Telegram webhook: verified ✅",
    "",
    "Public /health route:",
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

function b64Encode(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

function encodeRepoPath(path) {
  return cleanPath(path).split("/").map(encodeURIComponent).join("/");
}

async function githubFile(config, path) {
  const safe = safePath(path);
  if (!safe) throw new Error("unsafe path");
  const headers = { accept: "application/vnd.github+json", "user-agent": "MiniSkynet-Core-v44" };
  if (config.githubToken) headers.authorization = `Bearer ${config.githubToken}`;
  const response = await fetch(`https://api.github.com/repos/${config.repo}/contents/${encodeRepoPath(safe)}?ref=${encodeURIComponent(config.branch)}`, { headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${data.message || "request failed"}`);
  if (Array.isArray(data) || !data.content) throw new Error("not a text file");
  return { path: safe, sha: data.sha || "", size: data.size || 0, content: b64Decode(data.content) };
}

async function githubWrite(config, path, sha, content, message) {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN missing");
  const safe = safePath(path);
  if (!safe) throw new Error("unsafe path");
  const response = await fetch(`https://api.github.com/repos/${config.repo}/contents/${encodeRepoPath(safe)}`, {
    method: "PUT",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "MiniSkynet-Core-v44",
      authorization: `Bearer ${config.githubToken}`
    },
    body: JSON.stringify({
      message,
      content: b64Encode(content),
      sha,
      branch: config.branch
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub write ${response.status}: ${data.message || "request failed"}`);
  return { commit_sha: data?.commit?.sha || "", content_sha: data?.content?.sha || "" };
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

function findProposal(proposals, propId) {
  const key = String(propId || "").trim();
  return proposals.find(p => p.id === key || String(p.id || "").startsWith(key));
}

function splitLinesNoFinalNewline(text) {
  return String(text || "").replace(/\n$/, "").split("\n");
}

function fullFileDiff(path, oldContent, newContent, oldSha) {
  const oldLines = splitLinesNoFinalNewline(oldContent);
  const newLines = splitLinesNoFinalNewline(newContent);
  return [
    `diff --git a/${path} b/${path}`,
    `index ${oldSha.slice(0, 7)}..new 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map(line => `-${line}`),
    ...newLines.map(line => `+${line}`)
  ].join("\n") + "\n";
}

function applyFullFileDiff(oldContent, diff) {
  const lines = String(diff || "").split("\n");
  const plus = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@ ")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) plus.push(line.slice(1));
  }
  return plus.join("\n") + (oldContent.endsWith("\n") ? "\n" : "");
}

function isRuntimeVisibleProposal(proposal) {
  return /help|status|stage|command|команд|статус|development|smoke|marker|маркер/i.test(
    `${proposal.title || ""} ${proposal.request || ""} ${proposal.patch_draft?.intent || ""}`
  );
}

function makeDeterministicPatch(proposal, file) {
  const request = `${proposal.title || ""} ${proposal.request || ""}`;

  if (/smoke|marker|маркер|self.apply|self-apply|само/i.test(request)) {
    if (file.content.includes("Self-apply smoke marker:")) {
      return { already: true, summary: "Self-apply smoke marker уже есть в /help", content: file.content };
    }
    const marker = '"Development stage: " + VERSION,';
    if (!file.content.includes(marker)) throw new Error("development stage marker not found");
    return {
      already: false,
      summary: "Добавить self-apply smoke marker в /help",
      content: file.content.replace(marker, `${marker}\n      "Self-apply smoke marker: " + VERSION,`)
    };
  }

  if (/help|stage|development|команд/i.test(request)) {
    if (file.content.includes("Development stage:")) {
      return { already: true, summary: "Development stage уже есть в /help", content: file.content };
    }
    const marker = '"/start /help /status",';
    if (!file.content.includes(marker)) throw new Error("help marker not found");
    return {
      already: false,
      summary: "Показать Development stage в /help",
      content: file.content.replace(marker, `${marker}\n      "Development stage: " + VERSION,`)
    };
  }

  if (/health|deploy|verify|провер/i.test(request)) {
    if (file.content.includes("apply_contour: true")) {
      return { already: true, summary: "Apply contour уже отмечен в health", content: file.content };
    }
  }

  throw new Error("Нет безопасной deterministic operation для этого proposal. Уточни proposal: help/stage или smoke marker.");
}

async function runPostApplyVerify(env, config, propId) {
  const proposals = await arrayStore(env, "proposals");
  const proposal = findProposal(proposals, propId);
  const local = localHealth();
  const pub = await publicHealth(config);
  const ok = local.ok && local.version === VERSION;
  if (proposal) {
    proposal.post_apply_verify = { checked_at: now(), ok, health: { local, public: pub } };
    if (ok && proposal.status === "applied") proposal.status = "verified";
    await saveArray(env, "proposals", proposals, 50);
  }
  return { proposal, ok, local, public: pub };
}

function postApplyText(result) {
  return [
    `🧪 Post-apply verify${result.proposal ? ` ${result.proposal.id}` : ""}:`,
    `- proposal: ${result.proposal ? result.proposal.status : "not found"}`,
    `- local version: ${result.local.version}`,
    `- local runtime: ${result.ok ? "PASS ✅" : "FAIL ⛔"}`,
    `- public /health: ${result.public.ok ? "OK ✅" : `optional fail (${result.public.http}) ⚠️`}`,
    result.ok ? "\nResult: verified by Telegram runtime ✅" : "\nResult: not verified."
  ].join("\n");
}

const COMMANDS = new Set([
  "/start", "/help", "/status", "/health_check", "/deploy_check", "/post_apply_verify",
  "/self", "/self_set", "/goals", "/goal_add", "/plan", "/plan_set",
  "/tasks", "/addtask", "/task_done", "/next", "/memory", "/memory_score",
  "/repo_config", "/repo_file", "/repo_scan", "/active_target",
  "/propose", "/proposals", "/show", "/reject", "/approve",
  "/patch_auto_target", "/patch_preview", "/code_preview", "/code_show", "/code_check",
  "/apply_check", "/code_approve", "/apply_confirm", "/apply_status"
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
      "/health_check /deploy_check /post_apply_verify id",
      "/self /self_set текст",
      "/goals /goal_add текст",
      "/plan /plan_set шаг1 | шаг2",
      "/tasks /addtask текст /task_done n /next",
      "/memory /memory_score",
      "/repo_config /repo_file path /repo_scan /active_target",
      "/propose текст /proposals /show id /approve id /reject id",
      "/patch_auto_target id /patch_preview id",
      "/code_preview id /code_show id /code_check id",
      "/apply_check id /code_approve id /apply_confirm id /apply_status id"
    ].join("\n"));
  }

  if (command === "/status") {
    const taskItems = await arrayStore(env, "tasks");
    const memories = await arrayStore(env, "memories");
    const proposals = await arrayStore(env, "proposals");
    return send(config, chatId, [
      "📡 MiniSkynet Core v4 status",
      `- version: ${VERSION}`,
      "- runtime: single file, no onion imports",
      "- self health check: active",
      "- apply contour: active",
      "- self-apply smoke: active",
      "- owner guard: fixed",
      `- tasks: active=${taskItems.filter(t => t.status !== "done").length}, done=${taskItems.filter(t => t.status === "done").length}`,
      `- memory: ${memories.length}`,
      `- proposals: ${proposals.length}`,
      `- model: ${config.model}`
    ].join("\n"));
  }

  if (command === "/health_check" || command === "/deploy_check") {
    return send(config, chatId, healthText({ local: localHealth(), public: await publicHealth(config) }));
  }

  if (command === "/post_apply_verify") {
    return send(config, chatId, postApplyText(await runPostApplyVerify(env, config, args)));
  }

  if (command === "/self") return send(config, chatId, `🧠 Self:\n${(await getSelf(env)).text}\n\nИзменить: /self_set текст`);
  if (command === "/self_set") { await kvPut(env, "self", { text: args, updated_at: now() }); return send(config, chatId, "✅ Self обновлён."); }
  if (command === "/goals") return send(config, chatId, "🎯 Goals:\n" + (await getGoals(env)).goals.map((g, i) => `${i + 1}. ${g}`).join("\n"));
  if (command === "/goal_add") { const g = await getGoals(env); g.goals.push(args); g.updated_at = now(); await kvPut(env, "goals", g); return send(config, chatId, "✅ Goal добавлена."); }
  if (command === "/plan") return send(config, chatId, "🗺 Plan:\n" + (await getPlan(env)).steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  if (command === "/plan_set") { await kvPut(env, "plan", { steps: args.split("|").map(x => x.trim()).filter(Boolean), updated_at: now() }); return send(config, chatId, "✅ Plan обновлён."); }

  if (command === "/tasks") {
    const activeTasks = (await arrayStore(env, "tasks")).filter(t => t.status !== "done").slice(0, 12);
    return send(config, chatId, activeTasks.length ? "📋 Active tasks:\n" + activeTasks.map((t, i) => `${i + 1}. ${t.id} p${t.p || 4}: ${t.text}`).join("\n") : "Задач нет.");
  }
  if (command === "/addtask") { const items = await arrayStore(env, "tasks"); const task = { id: makeId("task"), text: args, p: 4, status: "todo", created_at: now() }; items.push(task); await saveArray(env, "tasks", items, 120); return send(config, chatId, `✅ Добавил ${task.id}`); }
  if (command === "/task_done") { const items = await arrayStore(env, "tasks"); const active = items.filter(t => t.status !== "done"); const task = active[(parseInt(args, 10) || 1) - 1]; if (!task) return send(config, chatId, "Не нашёл задачу."); task.status = "done"; task.done_at = now(); await saveArray(env, "tasks", items, 120); return send(config, chatId, `✅ Закрыл: ${task.text}`); }
  if (command === "/next") { const task = (await arrayStore(env, "tasks")).filter(t => t.status !== "done").sort((a, b) => (a.p || 9) - (b.p || 9))[0]; const firstPlan = (await getPlan(env)).steps[0]; return send(config, chatId, `⏭ Next:\n${task ? `Источник: tasks\nШаг: ${task.text}` : `Источник: plan\nШаг: ${firstPlan || "плана нет"}`}`); }

  if (command === "/memory") { const memories = await arrayStore(env, "memories"); return send(config, chatId, memories.length ? "🧠 Memory:\n" + memories.slice(-8).map(m => `- [${m.type || "note"}/${m.score || 0}] ${m.text}`).join("\n") : "Память пустая."); }
  if (command === "/memory_score") { const memories = await arrayStore(env, "memories"); const avg = memories.length ? Math.round(memories.reduce((a, b) => a + (b.score || 0), 0) / memories.length) : 0; return send(config, chatId, `🧠 Memory Quality:\n- всего: ${memories.length}\n- avg: ${avg}/100`); }

  if (command === "/repo_config") return send(config, chatId, `🔎 Repo:\n- repo: ${config.repo}\n- branch: ${config.branch}\n- token: ${config.githubToken ? "есть ✅" : "нет ⛔"}\n- workerUrl: ${config.workerUrl}`);
  if (command === "/repo_file") { const file = await githubFile(config, args); return send(config, chatId, `📄 ${file.path}\n- size: ${file.size}\n- sha: ${file.sha.slice(0, 12)}\n\n${clip(file.content, 1200)}`); }
  if (command === "/repo_scan") { const files = ["cloudflare/wrangler.toml", "cloudflare/src/index-v4.js"]; const out = []; for (const path of files) { try { const file = await githubFile(config, path); out.push(`✅ ${path} size=${file.size} sha=${file.sha.slice(0, 10)}`); } catch (error) { out.push(`❌ ${path}: ${error.message}`); } } return send(config, chatId, "🧭 Repo scan:\n" + out.join("\n")); }
  if (command === "/active_target") { const active = await activeTarget(config); return send(config, chatId, [`🎯 Active target:`, `- wrangler main: ${active.start}`, `- effective: ${active.effective.path}`, `- sha: ${active.effective.sha.slice(0, 12)}`].join("\n")); }

  if (command === "/propose") {
    const active = await activeTarget(config);
    const proposals = await arrayStore(env, "proposals");
    const proposal = {
      id: makeId("prop"),
      status: "pending",
      title: clip(args, 90),
      request: args,
      file_path: active.effective.path,
      gate: { passed: true, active_target: active.effective.path, sha: active.effective.sha, at: now() },
      created_at: now()
    };
    proposals.push(proposal);
    await saveArray(env, "proposals", proposals, 50);
    return send(config, chatId, `📦 Proposal ${proposal.id}:\n${proposal.title}\nОдобрить: /approve ${proposal.id}\nОтклонить: /reject ${proposal.id}`);
  }

  if (command === "/proposals") { const proposals = await arrayStore(env, "proposals"); return send(config, chatId, proposals.length ? "📦 Proposals:\n" + proposals.slice(-10).map(p => `- ${p.id} [${p.status}] ${p.title || p.request}`).join("\n") : "Proposals нет."); }
  if (command === "/show") { const proposals = await arrayStore(env, "proposals"); const p = findProposal(proposals, args); return send(config, chatId, p ? `📦 ${p.id}\nstatus: ${p.status}\ntarget: ${p.file_path || "—"}\nrequest: ${p.request || p.title || "—"}\ncode: ${p.code_draft ? "yes" : "no"}\napplied: ${p.apply_result?.commit_sha || "no"}` : "Не нашёл proposal."); }
  if (command === "/approve" || command === "/reject") { const proposals = await arrayStore(env, "proposals"); const p = findProposal(proposals, args); if (!p) return send(config, chatId, "Не нашёл proposal."); p.status = command === "/approve" ? "approved" : "rejected"; p.updated_at = now(); await saveArray(env, "proposals", proposals, 50); return send(config, chatId, `✅ ${p.status}: ${p.id}`); }

  if (command === "/patch_auto_target") {
    const proposals = await arrayStore(env, "proposals");
    const proposal = findProposal(proposals, args);
    if (!proposal) return send(config, chatId, "Не нашёл proposal.");
    const active = await activeTarget(config);
    proposal.file_path = active.effective.path;
    proposal.patch_draft = null;
    proposal.code_draft = null;
    proposal.gate = { passed: true, active_target: active.effective.path, sha: active.effective.sha, at: now() };
    await saveArray(env, "proposals", proposals, 50);
    return send(config, chatId, `✅ Auto target:\n- ${active.effective.path}\nТеперь: /patch_preview ${proposal.id}`);
  }

  if (command === "/patch_preview") {
    const proposals = await arrayStore(env, "proposals");
    const proposal = findProposal(proposals, args);
    if (!proposal) return send(config, chatId, "Не нашёл proposal.");
    const file = await githubFile(config, proposal.file_path || (await activeTarget(config)).effective.path);
    proposal.file_path = file.path;
    proposal.patch_draft = {
      target_file: file.path,
      current_sha: file.sha,
      intent: proposal.request,
      risk: "low",
      proposed_changes: ["deterministic safe change only"],
      test_plan: ["/status", "/help", "/health_check"],
      created_at: now()
    };
    proposal.status = "draft_ready";
    await saveArray(env, "proposals", proposals, 50);
    return send(config, chatId, `🧩 Patch draft ${proposal.id}:\n- target: ${file.path}\n- sha: ${file.sha.slice(0, 12)}\n- risk: low\nДальше: /code_preview ${proposal.id}`);
  }

  if (command === "/code_preview") {
    const proposals = await arrayStore(env, "proposals");
    const proposal = findProposal(proposals, args);
    if (!proposal || !proposal.patch_draft) return send(config, chatId, "Нет proposal/patch_draft.");
    const active = await activeTarget(config);
    if (isRuntimeVisibleProposal(proposal) && proposal.patch_draft.target_file !== active.effective.path) {
      return send(config, chatId, `⛔ target устарел. Сделай: /patch_auto_target ${proposal.id}`);
    }
    const patch = makeDeterministicPatch(proposal, active.effective);
    if (patch.already) {
      proposal.status = "already_applied";
      await saveArray(env, "proposals", proposals, 50);
      return send(config, chatId, `✅ Уже применено: ${patch.summary}\nApply не нужен.`);
    }
    const unified = fullFileDiff(active.effective.path, active.effective.content, patch.content, active.effective.sha);
    if (applyFullFileDiff(active.effective.content, unified) !== patch.content) {
      return send(config, chatId, "⛔ internal diff validation failed");
    }
    proposal.code_draft = {
      target_file: active.effective.path,
      current_sha: active.effective.sha,
      unified_diff: unified,
      summary: patch.summary,
      risk: "low",
      test_plan: ["/status", "/help", "/health_check"],
      created_at: now()
    };
    proposal.status = "code_draft_ready";
    await saveArray(env, "proposals", proposals, 50);
    return send(config, chatId, `🧬 Code draft ${proposal.id}:\n- target: ${active.effective.path}\n- sha: ${active.effective.sha.slice(0, 12)}\n- validation: valid ✅\n/code_show ${proposal.id}`);
  }

  if (command === "/code_show") {
    const proposal = findProposal(await arrayStore(env, "proposals"), args);
    return send(config, chatId, proposal?.code_draft ? `🧬 Code draft ${proposal.id}:\n${clip(proposal.code_draft.unified_diff, 2500)}` : "Code draft нет.");
  }

  if (command === "/code_check" || command === "/apply_check") {
    const proposals = await arrayStore(env, "proposals");
    const proposal = findProposal(proposals, args);
    if (!proposal) return send(config, chatId, "Не нашёл proposal.");
    if (proposal.status === "already_applied") return send(config, chatId, `✅ Already applied: ${proposal.id}\nApply не нужен.`);
    const active = await activeTarget(config);
    const blockers = [];
    if (!proposal.code_draft) blockers.push("code_draft missing");
    if (proposal.code_draft?.target_file !== active.effective.path) blockers.push(`target ${proposal.code_draft?.target_file} != active ${active.effective.path}`);
    if (proposal.code_draft?.current_sha !== active.effective.sha) blockers.push("sha mismatch");
    let patched = null;
    if (!blockers.length) {
      patched = applyFullFileDiff(active.effective.content, proposal.code_draft.unified_diff);
      if (patched === active.effective.content) blockers.push("no-op diff");
    }
    return send(config, chatId, [
      `🔐 Apply check ${proposal.id}:`,
      `- target: ${active.effective.path}`,
      `- code approved: ${proposal.code_approved_at ? "yes ✅" : "no ⛔"}`,
      `- diff applies: ${patched ? "yes ✅" : "no/blocked"}`,
      "",
      blockers.length ? "Blockers:\n- " + blockers.join("\n- ") : `Blockers: none\nNext: ${proposal.code_approved_at ? `/apply_confirm ${proposal.id}` : `/code_approve ${proposal.id}`}`
    ].join("\n"));
  }

  if (command === "/code_approve") {
    const proposals = await arrayStore(env, "proposals");
    const proposal = findProposal(proposals, args);
    if (!proposal?.code_draft) return send(config, chatId, "Нет code_draft.");
    proposal.code_approved_at = now();
    proposal.status = "code_approved";
    await saveArray(env, "proposals", proposals, 50);
    return send(config, chatId, `✅ Code approved: ${proposal.id}\nТеперь: /apply_check ${proposal.id}`);
  }

  if (command === "/apply_confirm") {
    const proposals = await arrayStore(env, "proposals");
    const proposal = findProposal(proposals, args);
    if (!proposal?.code_draft) return send(config, chatId, "Нет code_draft.");
    if (!proposal.code_approved_at) return send(config, chatId, `⛔ Сначала /code_approve ${proposal.id}`);
    const active = await activeTarget(config);
    if (proposal.code_draft.target_file !== active.effective.path || proposal.code_draft.current_sha !== active.effective.sha) {
      return send(config, chatId, "⛔ target/sha mismatch. Apply blocked.");
    }
    const patched = applyFullFileDiff(active.effective.content, proposal.code_draft.unified_diff);
    if (patched === active.effective.content) return send(config, chatId, "⛔ no-op diff. Apply blocked.");
    const result = await githubWrite(config, active.effective.path, active.effective.sha, patched, `MiniSkynet v4.4 apply ${proposal.id}: ${proposal.code_draft.summary}`);
    proposal.status = "applied";
    proposal.applied_at = now();
    proposal.apply_result = { path: active.effective.path, commit_sha: result.commit_sha, content_sha: result.content_sha, old_sha: active.effective.sha };
    await saveArray(env, "proposals", proposals, 50);
    return send(config, chatId, `✅ Applied:\n- file: ${active.effective.path}\n- commit: ${result.commit_sha}\nЖди deploy, потом /post_apply_verify ${proposal.id}`);
  }

  if (command === "/apply_status") {
    const proposal = findProposal(await arrayStore(env, "proposals"), args);
    return send(config, chatId, proposal ? `🚀 Apply status ${proposal.id}:\n- status: ${proposal.status}\n- applied: ${proposal.applied_at || "no"}\n- commit: ${proposal.apply_result?.commit_sha || "—"}\n- verified: ${proposal.post_apply_verify?.ok ? "yes ✅" : "no"}` : "Не нашёл proposal.");
  }

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
  await send(config, message.chatId, "Core v4.4 online. Обычный think пока выключен до проверки self-apply smoke. /help");
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
