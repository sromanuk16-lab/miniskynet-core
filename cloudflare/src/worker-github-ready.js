import repoOperationWorker from "./worker-repo-operation.js";

const VERSION = "github-ready-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN"]) {
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
    "cloudflare/src/worker-queue-mission.js",
    "cloudflare/src/worker-file-operation.js",
    "cloudflare/src/worker-repo-operation.js",
    "cloudflare/wrangler.toml"
  ];
}

function event(type, text, extra = {}) {
  return { time: new Date().toISOString(), type, status: "done", text, ...extra };
}

async function tokenState(env) {
  await hydrate(env);
  return Boolean(env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).length > 20);
}

async function writerStatus(env, chatId) {
  const hasToken = await tokenState(env);
  const repoOp = await kvGet(env, "repo_operation", null);
  const ready = repoOp?.status === "ready_for_commit_plan" && safeFiles().includes(repoOp.file);
  await send(env, chatId, [
    "GitHub Writer Status:",
    `Token: ${hasToken ? "connected" : "not_connected"}`,
    `Repo operation: ${ready ? "ready" : "not_ready"}`,
    repoOp ? `Repo: ${repoOp.repo}` : "Repo: ?",
    repoOp ? `Branch: ${repoOp.branch}` : "Branch: ?",
    repoOp ? `Файл: ${repoOp.file}` : "Файл: ?",
    `Следующий шаг: ${ready ? "/github_prepare" : "/repo_operation"}`,
    "Секрет не показывается. Коммит этим шагом не создаётся."
  ].join("\n"));
}

function makePrepare(repoOp, hasToken) {
  if (!repoOp || repoOp.status !== "ready_for_commit_plan" || !safeFiles().includes(repoOp.file)) return null;
  const now = new Date().toISOString();
  return {
    id: "ghprep_" + Date.now(),
    version: VERSION,
    status: hasToken ? "ready_for_next_layer" : "waiting_for_token",
    token_connected: hasToken,
    repo_operation_id: repoOp.id,
    mission_id: repoOp.mission_id,
    repo: repoOp.repo,
    branch: repoOp.branch || "main",
    file: repoOp.file,
    target: repoOp.target,
    requested_effect: repoOp.requested_effect,
    commit_title: repoOp.commit_title,
    check: repoOp.check,
    expected: repoOp.expected,
    risk_level: repoOp.risk_level,
    plan: [
      "read current file from repository",
      "build exact replacement content from approved operation",
      "update one allowlisted file",
      "store resulting commit sha",
      "wait for deploy and run Telegram check"
    ],
    note: "Prepare готовит состояние. Файл и репозиторий этим шагом не меняются.",
    created_at: now,
    updated_at: now
  };
}

function renderPrepare(p) {
  if (!p) return "GitHub Prepare: пока пусто. Сначала /repo_operation.";
  return [
    "GitHub Prepare:",
    `ID: ${p.id}`,
    `Статус: ${p.status}`,
    `Token: ${p.token_connected ? "connected" : "not_connected"}`,
    `Repo: ${p.repo}`,
    `Branch: ${p.branch}`,
    `Файл: ${p.file}`,
    `Цель: ${p.target}`,
    `Что должно измениться: ${p.requested_effect}`,
    `Commit title: ${p.commit_title}`,
    `Проверка: ${p.check}`,
    `Риск: ${p.risk_level}`,
    "План:",
    ...p.plan.map((x, i) => `${i + 1}. ${x}`),
    "Ограничение: commit пока не создаётся.",
    "Следующий слой: github commit executor."
  ].join("\n");
}

async function githubPrepare(env, chatId) {
  const repoOp = await kvGet(env, "repo_operation", null);
  const hasToken = await tokenState(env);
  const prep = makePrepare(repoOp, hasToken);
  if (!prep) {
    await send(env, chatId, "GitHub Prepare: repo operation не готова. Команда: /repo_operation затем /github_prepare");
    return;
  }
  await kvPut(env, "github_prepare", prep);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id === prep.mission_id) {
    const updated = {
      ...m,
      status: prep.status,
      current_step: "github_prepare",
      next_command: "/mission_log",
      updated_at: new Date().toISOString(),
      events: [...(m.events || []), event("github_prepare", `GitHub prepare готов. Token: ${prep.token_connected ? "connected" : "not_connected"}. Следующий слой: commit executor.`)]
    };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }

  await send(env, chatId, renderPrepare(prep));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await repoOperationWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.github_ready_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/github_writer_status", "/github_prepare"])]
      }
      return json(d || { ok: true, github_ready_layer: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();

      if (m && (low === "/github_writer_status" || low === "github writer status" || low === "статус github writer")) {
        await writerStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, github_writer_status: true });
      }
      if (m && (low === "/github_prepare" || low === "github prepare" || low === "подготовь github")) {
        await githubPrepare(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, github_prepare: true });
      }
    }

    return await repoOperationWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await repoOperationWorker.scheduled(event, env, ctx);
  }
};
