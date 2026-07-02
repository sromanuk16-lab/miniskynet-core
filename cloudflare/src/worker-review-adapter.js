import baseWorker from "./worker-alive-sync.js";

const VERSION = "review-adapter-v1-core-format";

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

function isCoreReview(r) {
  return r?.source === "core_orchestrator" || (r?.mission_id && r?.goal && r?.title && !r?.file);
}

function renderCoreReview(r, mission) {
  if (!r) return "Review Card: пока пусто.";
  return [
    "Review Card:",
    `ID: ${r.id}`,
    `Статус: ${r.status || "unknown"}`,
    `Тип: ${r.source || "core"}`,
    `Миссия: ${mission?.id || r.mission_id || "none"}`,
    `Статус миссии: ${mission?.status || "unknown"}`,
    `Текущий шаг: ${mission?.current_step || "unknown"}`,
    `Улучшение: ${r.title || "не указано"}`,
    `Цель: ${r.goal || mission?.goal || "не указана"}`,
    `Риск: ${r.risk || r.risk_level || "unknown"}`,
    `Рекомендация: ${r.recommendation || "маленький безопасный слой, без switch без approve"}`,
    "Ограничение: код этой карточкой не меняется.",
    "Команды: /review_yes или /review_no"
  ].join("\n");
}

function renderLegacyReview(r) {
  if (!r) return "Review Card: пока пусто.";
  return [
    "Review Card:",
    `ID: ${r.id}`,
    `Статус: ${r.status || "unknown"}`,
    `Миссия: ${r.mission_goal || r.mission_id || "не указана"}`,
    `Файл: ${r.file || "не указан"}`,
    `Цель: ${r.target || r.title || "не указана"}`,
    `Старая логика: ${r.old_logic || "не указана"}`,
    `Новая логика: ${r.new_logic || r.recommendation || "не указана"}`,
    `Проверка: ${r.check || "не указана"}`,
    `Ожидание: ${r.expected || "не указано"}`,
    `Риск: ${r.risk_level || r.risk || "unknown"}`,
    "Ограничение: код пока не меняется.",
    "Команды: /review_yes или /review_no"
  ].join("\n");
}

async function showReviewCard(env, chatId) {
  const r = await kvGet(env, "review_card", null);
  const m = await kvGet(env, "active_mission", null);
  if (!r) {
    await send(env, chatId, "Review Card: пока пусто. Сначала нужен /core_plan → /core_approve → /core_run или старая mission pipeline.");
    return;
  }
  await send(env, chatId, isCoreReview(r) ? renderCoreReview(r, m) : renderLegacyReview(r));
}

async function reviewYes(env, chatId) {
  const r = await kvGet(env, "review_card", null);
  if (!r || !["pending", "ready"].includes(String(r.status || ""))) {
    await send(env, chatId, "Review Yes: нет review card в статусе pending/ready. Команда: /review_card");
    return;
  }
  const now = new Date().toISOString();
  const yes = { ...r, status: "yes", yes_at: now, updated_at: now, adapter: VERSION };
  await kvPut(env, "review_card", yes);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id && (!r.mission_id || m.id === r.mission_id)) {
    const updated = {
      ...m,
      status: "review_yes",
      current_step: "review_yes",
      next_command: isCoreReview(r) ? "/core_next" : "/action_card",
      updated_at: now,
      events: [
        ...(m.events || []),
        { time: now, type: "review_yes", status: "done", text: isCoreReview(r) ? "Сергей подтвердил core review. Следующий шаг: /core_next." : "Сергей подтвердил review card. Следующий шаг: /action_card." }
      ]
    };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }

  await send(env, chatId, [
    "Review Yes готово.",
    "✅ Review card подтверждена.",
    `Тип: ${yes.source || "legacy"}`,
    `Цель: ${yes.goal || yes.target || yes.mission_goal || "не указана"}`,
    `Следующий шаг: ${isCoreReview(yes) ? "/core_next" : "/action_card"}`
  ].join("\n"));
}

async function reviewNo(env, chatId) {
  const r = await kvGet(env, "review_card", null);
  if (!r) {
    await send(env, chatId, "Review No: review card пустая.");
    return;
  }
  const now = new Date().toISOString();
  const no = { ...r, status: "no", no_at: now, updated_at: now, adapter: VERSION };
  await kvPut(env, "review_card", no);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id && (!r.mission_id || m.id === r.mission_id)) {
    const updated = {
      ...m,
      status: "review_no",
      current_step: "review_no",
      next_command: "/core_next",
      updated_at: now,
      events: [
        ...(m.events || []),
        { time: now, type: "review_no", status: "done", text: "Сергей отклонил review card." }
      ]
    };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }

  await send(env, chatId, "Review No готово. Review card отклонена. Следующий шаг: /core_next");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.review_adapter = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/review_card", "/review_yes", "/review_no"])]
      }
      return json(d || { ok: true, review_adapter: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();
      if (m && (text === "/review_card" || text === "review card" || text === "карточка проверки")) {
        await showReviewCard(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, review_card: true });
      }
      if (m && (text === "/review_yes" || text === "review yes")) {
        await reviewYes(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, review_yes: true });
      }
      if (m && (text === "/review_no" || text === "review no")) {
        await reviewNo(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, review_no: true });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
