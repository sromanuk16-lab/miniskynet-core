import baseWorker from "./worker-alive-dialog.js";

const VERSION = "dialog-confirm-v1";
const MAX_PROPOSAL_AGE_MS = 12 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function now() { return new Date().toISOString(); }
function ageMs(t) { const n = Date.parse(t || ""); return Number.isFinite(n) ? Date.now() - n : Infinity; }

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

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function allowedUser(env, userId) {
  const owner = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}

function yesText(text) {
  return /^(да|yes|y|ок|окей|подтверждаю|запускай|делай)$/i.test(String(text || "").trim());
}

function noText(text) {
  return /^(нет|no|n|не надо|отмена|cancel|стоп)$/i.test(String(text || "").trim());
}

function allowedCommand(command) {
  const c = String(command || "").trim();
  if (!c.startsWith("/")) return false;
  if (c.includes("\n") || c.length > 320) return false;
  if (c.startsWith("/mission ")) return c.length > 14 && c.length < 260;
  return new Set([
    "/system_map",
    "/core_status",
    "/core_scan",
    "/core_next",
    "/core_plan",
    "/core_approve",
    "/core_run",
    "/review_card",
    "/review_yes",
    "/review_no",
    "/verify_status",
    "/verify_current",
    "/rollback_status",
    "/mission_status",
    "/mission_log",
    "/memory",
    "/tasks",
    "/alive_dialog_status",
    "/alive_dialog_now",
    "/alive_dialog_on",
    "/alive_dialog_off"
  ]).has(c);
}

async function getProposal(env) {
  return await kvGet(env, "dialog_proposal", null);
}

async function showProposal(env, chatId) {
  const p = await getProposal(env);
  if (!p) {
    await send(env, chatId, "Proposal Status: предложений пока нет.");
    return;
  }
  await send(env, chatId, [
    "Proposal Status:",
    `ID: ${p.id || "unknown"}`,
    `Status: ${p.status || "unknown"}`,
    `Title: ${p.title || "не указано"}`,
    `Command: ${p.command || "none"}`,
    `Risk: ${p.risk || "unknown"}`,
    `Created: ${p.created_at || "unknown"}`,
    p.status === "pending" ? "Ответь: /proposal_yes или /proposal_no" : "Pending-предложения нет."
  ].join("\n"));
}

async function callCommand(env, chatId, userId, command, request) {
  const url = new URL(request.url);
  const update = { message: { chat: { id: chatId }, from: { id: userId }, text: command } };
  const req = new Request(`${url.origin}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update)
  });
  return await baseWorker.fetch(req, env, { waitUntil() {} });
}

async function acceptProposal(env, chatId, userId, request) {
  const p = await getProposal(env);
  if (!p || p.status !== "pending") {
    await send(env, chatId, "Proposal Yes: pending-предложения нет. Сначала обычным текстом попроси SKYNET что-то предложить.");
    return;
  }
  if (ageMs(p.created_at) > MAX_PROPOSAL_AGE_MS) {
    await kvPut(env, "dialog_proposal", { ...p, status: "expired", expired_at: now() });
    await send(env, chatId, "Proposal Yes: предложение устарело. Попроси SKYNET предложить заново.");
    return;
  }
  if (!allowedCommand(p.command)) {
    await kvPut(env, "dialog_proposal", { ...p, status: "blocked", blocked_at: now(), reason: "command_not_allowed" });
    await send(env, chatId, `Proposal Yes: не запускаю команду вне текущего allowlist:\n${p.command || "none"}`);
    return;
  }

  const accepted = { ...p, status: "accepted", accepted_at: now(), confirmed_by: VERSION };
  await kvPut(env, "dialog_proposal", accepted);
  await send(env, chatId, [
    "Proposal Yes принято.",
    `Запускаю команду: ${p.command}`,
    "Дальше результат придёт отдельным сообщением от SKYNET."
  ].join("\n"));
  await callCommand(env, chatId, userId, p.command, request);
}

async function rejectProposal(env, chatId) {
  const p = await getProposal(env);
  if (!p || p.status !== "pending") {
    await send(env, chatId, "Proposal No: pending-предложения нет.");
    return;
  }
  await kvPut(env, "dialog_proposal", { ...p, status: "rejected", rejected_at: now(), confirmed_by: VERSION });
  await send(env, chatId, "Ок, не запускаю. Предложение отклонено.");
}

export default {
  async fetch(request, env, ctx) {
    await hydrate(env);
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.dialog_confirm = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/proposal_status", "/proposal_yes", "/proposal_no"])]
      }
      return json(d || { ok: true, dialog_confirm: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const m = getMsg(update);
      const raw = String(m?.text || "").trim();
      const low = raw.toLowerCase();

      if (m && !allowedUser(env, m.from?.id)) {
        await send(env, m.chat.id, "Доступ закрыт.");
        return json({ ok: true, handled_by: VERSION, denied: true });
      }

      if (m && (low === "/proposal_status" || low === "proposal status" || low === "предложение статус")) {
        await showProposal(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, proposal_status: true });
      }

      const p = m ? await getProposal(env) : null;
      const hasPending = p?.status === "pending";

      if (m && (low === "/proposal_yes" || low === "proposal yes" || (hasPending && yesText(raw)))) {
        await acceptProposal(env, m.chat.id, m.from?.id, request);
        return json({ ok: true, handled_by: VERSION, proposal_yes: true });
      }

      if (m && (low === "/proposal_no" || low === "proposal no" || (hasPending && noText(raw)))) {
        await rejectProposal(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, proposal_no: true });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
