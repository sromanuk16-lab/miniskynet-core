import fileOperationWorker from "./worker-file-operation.js";

const VERSION = "repo-operation-v1";
const REPO_FULL_NAME = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";

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
    "cloudflare/wrangler.toml"
  ];
}

function event(type, text, extra = {}) {
  return { time: new Date().toISOString(), type, status: "done", text, ...extra };
}

function makeRepoOperation(fileOp) {
  if (!fileOp || fileOp.status !== "ready_for_repo_step" || !safeFiles().includes(fileOp.file)) return null;
  const now = new Date().toISOString();
  return {
    id: "repoop_" + Date.now(),
    version: VERSION,
    status: "ready_for_commit_plan",
    repo: REPO_FULL_NAME,
    branch: DEFAULT_BRANCH,
    file_operation_id: fileOp.id,
    mission_id: fileOp.mission_id,
    mission_goal: fileOp.mission_goal,
    file: fileOp.file,
    target: fileOp.target,
    requested_effect: fileOp.requested_effect,
    check: fileOp.check,
    expected: fileOp.expected,
    risk_level: fileOp.risk_level,
    commit_title: `MiniSkynet: ${String(fileOp.target || "update").slice(0, 80)}`,
    safety_gate: "manual_confirmed_action_and_file_operation",
    note: "Repo operation подготовлена в KV. GitHub commit этим шагом не создаётся.",
    created_at: now,
    updated_at: now
  };
}

function renderRepoOperation(op) {
  if (!op) return "Repo Operation: пока пусто. Сначала /file_operation.";
  return [
    "Repo Operation:",
    `ID: ${op.id}`,
    `Статус: ${op.status}`,
    `Repo: ${op.repo}`,
    `Branch: ${op.branch}`,
    `Миссия: ${op.mission_goal}`,
    `Файл: ${op.file}`,
    `Цель: ${op.target}`,
    `Что должно измениться: ${op.requested_effect}`,
    `Commit title: ${op.commit_title}`,
    `Проверка после деплоя: ${op.check}`,
    `Ожидание: ${op.expected}`,
    `Риск: ${op.risk_level}`,
    "Ограничение: commit пока не создаётся.",
    "Следующий слой: GitHub writer."
  ].join("\n");
}

async function createRepoOperation(env, chatId) {
  let op = await kvGet(env, "repo_operation", null);
  if (!op || op.status === "cancelled") {
    const fileOp = await kvGet(env, "file_operation", null);
    if (!fileOp || fileOp.status !== "ready_for_repo_step") {
      await send(env, chatId, "Repo Operation: сначала нужна file operation. Команда: /file_operation затем /repo_operation");
      return;
    }
    op = makeRepoOperation(fileOp);
    if (!op) {
      await send(env, chatId, "Repo Operation: не могу собрать операцию. Проверь /file_status.");
      return;
    }
    await kvPut(env, "repo_operation", op);

    const m = await kvGet(env, "active_mission", null);
    if (m?.id === op.mission_id) {
      const updated = {
        ...m,
        status: "repo_operation_ready",
        current_step: "repo_operation_ready",
        next_command: "/repo_status",
        updated_at: new Date().toISOString(),
        events: [...(m.events || []), event("repo_operation_ready", "Repo operation подготовлена. Следующий слой: GitHub writer.")]
      };
      await kvPut(env, "active_mission", updated);
      await kvPut(env, "mission:" + m.id, updated);
    }
  }
  await send(env, chatId, renderRepoOperation(op));
}

async function showRepoStatus(env, chatId) {
  const op = await kvGet(env, "repo_operation", null);
  await send(env, chatId, renderRepoOperation(op));
}

async function cancelRepoOperation(env, chatId) {
  const op = await kvGet(env, "repo_operation", null);
  if (!op) {
    await send(env, chatId, "Repo Cancel: repo operation пустая.");
    return;
  }
  const now = new Date().toISOString();
  const cancelled = { ...op, status: "cancelled", cancelled_at: now, updated_at: now };
  await kvPut(env, "repo_operation", cancelled);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id === op.mission_id) {
    const updated = {
      ...m,
      status: "repo_operation_cancelled",
      current_step: "repo_operation_cancelled",
      next_command: "/mission_log",
      updated_at: now,
      events: [...(m.events || []), event("repo_operation_cancelled", "Repo operation отменена Сергеем.")]
    };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }
  await send(env, chatId, "Repo Cancel готово. Repo operation отменена.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await fileOperationWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.repo_operation_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/repo_operation", "/repo_status", "/repo_cancel"])]
      }
      return json(d || { ok: true, repo_operation_layer: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();

      if (m && (low === "/repo_operation" || low === "repo operation" || low === "операция репо")) {
        await createRepoOperation(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, repo_operation: true });
      }
      if (m && (low === "/repo_status" || low === "repo status" || low === "статус репо")) {
        await showRepoStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, repo_status: true });
      }
      if (m && (low === "/repo_cancel" || low === "repo cancel" || low === "отмени операцию репо")) {
        await cancelRepoOperation(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, repo_cancel: true });
      }
    }

    return await fileOperationWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await fileOperationWorker.scheduled(event, env, ctx);
  }
};
