import patchDialogWorker from "./worker-patch-dialog.js";
import improvementWorker from "./worker-improvement-runner.js";
import proofWorker from "./worker-universal-proof.js";

const VERSION = "stable-root-v1";

const LEGACY_COMMANDS = new Set([
  "/start", "/status", "/memory", "/tasks", "/cost", "/alive_on", "/alive_off",
  "/self_audit", "/last_auto_audit", "/growth_queue", "/growth_hygiene", "/growth_done",
  "/agents", "/code_map", "/inspect_self", "/next_module",
  "/mission_status", "/mission_log", "/mission_run", "/cancel_mission",
  "/review_card", "/review_yes", "/review_no",
  "/action_card", "/action_yes", "/action_no", "/growth_to_mission",
  "/file_operation", "/file_status", "/file_cancel",
  "/repo_operation", "/repo_status", "/repo_cancel",
  "/github_writer_status", "/github_prepare", "/github_commit_status", "/github_commit",
  "/proof_status", "/proof_write",
  "/live_step_status", "/live_step_write", "/live_step_switch",
  "/version_chain", "/level", "/alive_sync_status", "/alive_sync_tick", "/system_map",
  "/core_status", "/core_scan", "/core_next", "/core_plan", "/core_approve", "/core_run",
  "/verify_status", "/verify_current", "/rollback_status", "/rollback_to_safe",
  "/dialog_status", "/alive_dialog_status", "/alive_dialog_now", "/alive_dialog_on", "/alive_dialog_off",
  "/proposal_status", "/proposal_yes", "/proposal_no",
  "/patch_dialog_status", "/universal_proof"
]);

const IMPROVE_READ_COMMANDS = new Set([
  "/improve_status", "/improve_prepare", "/improve_review", "/improve_no", "/improve_clear"
]);

const ROOT_COMMANDS = new Set([
  "/skynet_status", "/root_status", "/release_status", "/release_review", "/release_apply", "/release_discard"
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function now() { return new Date().toISOString(); }
function getMsg(update) { return update?.message || update?.edited_message || null; }

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]) {
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

function allowedUser(env, userId) {
  const owner = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}

function firstCommand(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) return "";
  return raw.split(/\s+/)[0].toLowerCase();
}

function wantsPatch(text) {
  const s = String(text || "").toLowerCase();
  return (
    s.includes("создай patch") || s.includes("собери patch") || s.includes("сделай patch") ||
    s.includes("подготовь patch") || s.includes("улучши") || s.includes("добавь команд") ||
    s.includes("сделай слой") || s.includes("примени улучш")
  );
}

function makeTelegramRequest(request, chatId, userId, text) {
  const url = new URL(request.url);
  const update = { message: { chat: { id: chatId }, from: { id: userId }, text } };
  return new Request(`${url.origin}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update)
  });
}

async function routeTo(worker, request, env, ctx) {
  return await worker.fetch(request, env, ctx);
}

async function showRootStatus(env, chatId) {
  const patch = await kvGet(env, "improvement_patch", null);
  const last = await kvGet(env, "improvement_runner_last", null);
  const proposal = await kvGet(env, "dialog_proposal", null);
  const verify = await kvGet(env, "verify_state", null);
  await send(env, chatId, [
    "Stable Root Status:",
    `Version: ${VERSION}`,
    "Entry: worker-stable-root.js",
    "Slash policy: strict router, no model fallback",
    "Self-switch policy: blocked; use /release_apply",
    `Patch: ${patch?.status || "none"}`,
    patch?.title ? `Patch title: ${patch.title}` : "Patch title: none",
    last ? `Last release: ${last.status}` : "Last release: none",
    proposal ? `Dialog proposal: ${proposal.status}` : "Dialog proposal: none",
    verify ? `Verify: ${verify.status}` : "Verify: none",
    "Next: обычный текст 'улучши...' → /release_review → /release_apply"
  ].join("\n"));
}

async function showReleaseStatus(env, chatId) {
  const patch = await kvGet(env, "improvement_patch", null);
  const last = await kvGet(env, "improvement_runner_last", null);
  await send(env, chatId, [
    "Release Queue Status:",
    `Root: ${VERSION}`,
    `Patch: ${patch?.status || "none"}`,
    patch?.title ? `Title: ${patch.title}` : "Title: none",
    patch?.risk ? `Risk: ${patch.risk}` : "Risk: none",
    patch?.files ? `Files: ${patch.files.length}` : "Files: 0",
    patch?.switch_entry ? "Entry switch requested: yes → will be stripped by Stable Root" : "Entry switch requested: no",
    last ? `Last: ${last.status}` : "Last: none",
    "Apply: /release_apply"
  ].join("\n"));
}

async function showReleaseReview(env, chatId, request, ctx) {
  const patch = await kvGet(env, "improvement_patch", null);
  if (!patch) {
    await send(env, chatId, "Release Review: patch пустой. Сначала обычным текстом попроси: 'Скайнет, улучши ... маленьким слоем'.");
    return;
  }
  await send(env, chatId, [
    "Release Review:",
    `Patch: ${patch.status}`,
    `Title: ${patch.title || "none"}`,
    `Risk: ${patch.risk || "unknown"}`,
    `Files: ${(patch.files || []).map(f => f.path).join(", ") || "none"}`,
    patch.switch_entry ? "Entry switch: requested, but Stable Root will keep entry unchanged." : "Entry switch: no",
    "Next: /release_apply или /release_discard"
  ].join("\n"));
  const req = makeTelegramRequest(request, chatId, chatId, "/improve_review");
  await routeTo(improvementWorker, req, env, ctx).catch(() => null);
}

async function discardRelease(env, chatId) {
  const patch = await kvGet(env, "improvement_patch", null);
  if (!patch) {
    await send(env, chatId, "Release Discard: patch уже пустой.");
    return;
  }
  await kvPut(env, "improvement_patch", { ...patch, status: "discarded", discarded_at: now(), discarded_by: VERSION });
  await send(env, chatId, "Release Discard готово. Patch снят с выполнения.");
}

async function applyRelease(env, chatId, userId, request, ctx) {
  const patch = await kvGet(env, "improvement_patch", null);
  if (!patch || patch.status !== "pending") {
    await send(env, chatId, "Release Apply: pending patch нет. Сначала создай patch обычным текстом и проверь /release_review.");
    return;
  }

  const sanitized = {
    ...patch,
    switch_entry: false,
    switch_to: "",
    stable_root_note: "Entry switch stripped by stable-root-v1. worker-current.js must remain stable-root.",
    release_apply_at: now()
  };
  await kvPut(env, "improvement_patch", sanitized);
  await send(env, chatId, [
    "Release Apply:",
    "Запускаю запись файлов через Improvement Runner.",
    "Entry switch отключён: stable-root остаётся главным.",
    "После результата deploy ждать не нужно, если менялись только KV/docs. Если создан новый worker-файл — он будет лежать в GitHub до отдельного подключения."
  ].join("\n"));
  const req = makeTelegramRequest(request, chatId, userId, "/improve_yes");
  await routeTo(improvementWorker, req, env, ctx);
}

async function unknownCommand(env, chatId, cmd) {
  await send(env, chatId, [
    "Команда не найдена.",
    `Command: ${cmd}`,
    "Модель не вызываю, чтобы не выдумывать ответ.",
    "Проверь: /skynet_status"
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    await hydrate(env);
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        ok: true,
        stable_root: VERSION,
        entry: "worker-stable-root.js",
        slash_policy: "strict_no_model_fallback",
        commands: [
          "/skynet_status", "/release_status", "/release_review", "/release_apply", "/release_discard",
          "/patch_dialog_status", "/improve_status", "/improve_review", "/universal_proof"
        ]
      });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const m = getMsg(update);
      const raw = String(m?.text || "").trim();
      const cmd = firstCommand(raw);
      if (!m) return json({ ok: true, handled_by: VERSION, no_message: true });
      if (!allowedUser(env, m.from?.id)) {
        await send(env, m.chat.id, "Доступ закрыт.");
        return json({ ok: true, handled_by: VERSION, denied: true });
      }

      if (cmd === "/skynet_status" || cmd === "/root_status") {
        await showRootStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, root_status: true });
      }
      if (cmd === "/release_status") {
        await showReleaseStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, release_status: true });
      }
      if (cmd === "/release_review") {
        await showReleaseReview(env, m.chat.id, request, ctx);
        return json({ ok: true, handled_by: VERSION, release_review: true });
      }
      if (cmd === "/release_apply") {
        await applyRelease(env, m.chat.id, m.from?.id, request, ctx);
        return json({ ok: true, handled_by: VERSION, release_apply: true });
      }
      if (cmd === "/release_discard") {
        await discardRelease(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, release_discard: true });
      }

      if (cmd === "/improve_yes") {
        await send(env, m.chat.id, "Прямой /improve_yes заблокирован Stable Root. Используй /release_review → /release_apply, чтобы не выбить worker-current.js.");
        return json({ ok: true, handled_by: VERSION, improve_yes_blocked: true });
      }
      if (IMPROVE_READ_COMMANDS.has(cmd)) {
        return await routeTo(improvementWorker, request, env, ctx);
      }
      if (cmd === "/universal_proof") {
        return await routeTo(proofWorker, request, env, ctx);
      }
      if (cmd === "/patch_dialog_status") {
        return await routeTo(patchDialogWorker, request, env, ctx);
      }
      if (cmd && LEGACY_COMMANDS.has(cmd)) {
        return await routeTo(patchDialogWorker, request, env, ctx);
      }
      if (cmd) {
        await unknownCommand(env, m.chat.id, cmd);
        return json({ ok: true, handled_by: VERSION, unknown_command: cmd });
      }

      if (wantsPatch(raw)) {
        return await routeTo(patchDialogWorker, request, env, ctx);
      }
      return await routeTo(patchDialogWorker, request, env, ctx);
    }

    return await routeTo(patchDialogWorker, request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await patchDialogWorker.scheduled(event, env, ctx);
  }
};
