import queueMissionWorker from "./worker-queue-mission.js";

const VERSION = "file-operation-v1";

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
    "cloudflare/wrangler.toml"
  ];
}

function event(type, text, extra = {}) {
  return { time: new Date().toISOString(), type, status: "done", text, ...extra };
}

function makeFileOperation(action) {
  if (!action || action.status !== "yes" || !safeFiles().includes(action.file)) return null;
  const now = new Date().toISOString();
  return {
    id: "fileop_" + Date.now(),
    version: VERSION,
    status: "ready_for_repo_step",
    action_id: action.id,
    mission_id: action.mission_id,
    mission_goal: action.mission_goal,
    file: action.file,
    target: action.target,
    requested_effect: action.requested_effect,
    check: action.check,
    expected: action.expected,
    risk_level: action.risk_level,
    safety_gate: "manual_confirmed_action_card",
    note: "Операция над файлом подготовлена в KV. Файл этим шагом не меняется.",
    created_at: now,
    updated_at: now
  };
}

function renderFileOperation(op) {
  if (!op) return "File Operation: пока пусто. Сначала /action_card затем /action_yes.";
  return [
    "File Operation:",
    `ID: ${op.id}`,
    `Статус: ${op.status}`,
    `Миссия: ${op.mission_goal}`,
    `Файл: ${op.file}`,
    `Цель: ${op.target}`,
    `Что должно измениться: ${op.requested_effect}`,
    `Проверка: ${op.check}`,
    `Ожидание: ${op.expected}`,
    `Риск: ${op.risk_level}`,
    "Ограничение: файл пока не меняется.",
    "Следующий слой: repo operation / commit."
  ].join("\n");
}

async function createFileOperation(env, chatId) {
  let op = await kvGet(env, "file_operation", null);
  if (!op || op.status === "cancelled") {
    const action = await kvGet(env, "action_card", null);
    if (!action || action.status !== "yes") {
      await send(env, chatId, "File Operation: сначала нужна подтверждённая action card. Команда: /action_card затем /action_yes");
      return;
    }
    op = makeFileOperation(action);
    if (!op) {
      await send(env, chatId, "File Operation: не могу собрать операцию. Проверь /action_card.");
      return;
    }
    await kvPut(env, "file_operation", op);

    const m = await kvGet(env, "active_mission", null);
    if (m?.id === op.mission_id) {
      const updated = {
        ...m,
        status: "file_operation_ready",
        current_step: "file_operation_ready",
        next_command: "/file_status",
        updated_at: new Date().toISOString(),
        events: [...(m.events || []), event("file_operation_ready", "File operation подготовлена. Следующий слой: repo operation / commit.")]
      };
      await kvPut(env, "active_mission", updated);
      await kvPut(env, "mission:" + m.id, updated);
    }
  }
  await send(env, chatId, renderFileOperation(op));
}

async function showFileStatus(env, chatId) {
  const op = await kvGet(env, "file_operation", null);
  await send(env, chatId, renderFileOperation(op));
}

async function cancelFileOperation(env, chatId) {
  const op = await kvGet(env, "file_operation", null);
  if (!op) {
    await send(env, chatId, "File Cancel: file operation пустая.");
    return;
  }
  const now = new Date().toISOString();
  const cancelled = { ...op, status: "cancelled", cancelled_at: now, updated_at: now };
  await kvPut(env, "file_operation", cancelled);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id === op.mission_id) {
    const updated = {
      ...m,
      status: "file_operation_cancelled",
      current_step: "file_operation_cancelled",
      next_command: "/mission_log",
      updated_at: now,
      events: [...(m.events || []), event("file_operation_cancelled", "File operation отменена Сергеем.")]
    };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }
  await send(env, chatId, "File Cancel готово. File operation отменена.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await queueMissionWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.file_operation_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/file_operation", "/file_status", "/file_cancel"])]
      }
      return json(d || { ok: true, file_operation_layer: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();

      if (m && (low === "/file_operation" || low === "file operation" || low === "операция файла")) {
        await createFileOperation(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, file_operation: true });
      }
      if (m && (low === "/file_status" || low === "file status" || low === "статус файла")) {
        await showFileStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, file_status: true });
      }
      if (m && (low === "/file_cancel" || low === "file cancel" || low === "отмени операцию файла")) {
        await cancelFileOperation(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, file_cancel: true });
      }
    }

    return await queueMissionWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await queueMissionWorker.scheduled(event, env, ctx);
  }
};
