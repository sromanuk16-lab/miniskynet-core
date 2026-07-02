import baseWorker from "./worker-review-adapter.js";

const VERSION = "sky-dialog-v1-model-suggest";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function now() { return new Date().toISOString(); }
function tokens(s) { return Math.max(1, Math.ceil(String(s || "").length / 4)); }
function costUsd(i, o) { return (i / 1000000) * 0.15 + (o / 1000000) * 0.60; }

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "OPENROUTER_MODEL_CHEAP", "MAX_DAILY_COST_USD", "MAX_CYCLES_PER_DAY", "MAX_OUTPUT_TOKENS", "TELEGRAM_ALLOWED_USER_ID"]) {
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

function parseLoose(s) {
  try { return JSON.parse(s); } catch (_) {}
  const a = String(s || "").indexOf("{");
  const b = String(s || "").lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(String(s).slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

async function snapshot(env) {
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  return {
    mission: await kvGet(env, "active_mission", null),
    review: await kvGet(env, "review_card", null),
    core_plan: await kvGet(env, "core_plan", null),
    core_run: await kvGet(env, "core_run", null),
    verify: await kvGet(env, "verify_state", null),
    safe_entry: await kvGet(env, "safe_entry", null),
    memories: Array.isArray(memData.memories) ? memData.memories.length : 0,
    tasks_total: Array.isArray(tasksData.tasks) ? tasksData.tasks.length : 0,
    active_tasks: Array.isArray(tasksData.tasks) ? tasksData.tasks.filter(t => t.status !== "done" && t.status !== "archived").length : 0
  };
}

function manifest() {
  return [
    "/system_map — карта системы",
    "/core_status — статус core",
    "/core_scan — найти слабые места",
    "/core_next — следующий шаг",
    "/core_plan — создать план улучшения",
    "/core_approve — одобрить план",
    "/core_run — создать mission/review state",
    "/review_card — показать review",
    "/review_yes — подтвердить review",
    "/review_no — отклонить review",
    "/verify_status — статус проверки",
    "/verify_current — проверить текущую цепочку",
    "/rollback_status — показать аварийный откат",
    "/mission <цель> — создать инженерную миссию",
    "/mission_status — статус миссии",
    "/mission_log — лог миссии",
    "/memory — последние записи памяти",
    "/tasks — задачи"
  ].join("\n");
}

function promptFor(text, state) {
  return [
    "Ты SKYNET Dialog Brain v1. Ты обычный разговорный мозг Telegram-бота Сергея.",
    "Ты не просто отвечаешь: ты знаешь реальные команды SKYNET и в подходящий момент предлагаешь их.",
    "Отвечай на русском, коротко, живо, на ты.",
    "Если Сергей просто рассуждает — отвечай как собеседник.",
    "Если из темы можно сделать проект, модуль или проверку — предложи действие через команду.",
    "Не выполняй команду сама. Только предложи её и спроси: запускать?",
    "Верни строго JSON без markdown:",
    "{\"mode\":\"answer|proposal\",\"reply\":\"текст ответа\",\"command\":\"/команда или пусто\",\"title\":\"название предложения\",\"risk\":\"low|medium|high\"}",
    "Примеры:",
    "радиомашинка → предложи /mission спроектировать управление радиомашинкой через Skynet",
    "камера → предложи /mission спроектировать Camera Agent для Skynet",
    "что дальше → предложи /core_next",
    "покажи систему → предложи /system_map",
    "review → предложи /review_card",
    "проверка/откат → предложи /verify_status или /rollback_status",
    `Команды SKYNET:\n${manifest()}`,
    `Текущее состояние:\n${JSON.stringify(state)}`,
    "Сообщение Сергея:",
    String(text || "").slice(0, 2500)
  ].join("\n");
}

function dayStats(brain) {
  const day = now().slice(0, 10);
  brain.stats = brain.stats || { cycles_total: 0, daily: {} };
  brain.stats.daily = brain.stats.daily || {};
  brain.stats.daily[day] = brain.stats.daily[day] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  return brain.stats.daily[day];
}

async function askModel(env, brain, prompt) {
  await hydrate(env);
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");
  const maxOut = Math.min(Number(env.MAX_OUTPUT_TOKENS || "650"), 700);
  const st = dayStats(brain);
  if (Number(st.cycles || 0) >= Number(env.MAX_CYCLES_PER_DAY || "25")) throw new Error("daily cycle limit reached");
  const projected = Number(st.cost_usd || 0) + costUsd(tokens(prompt), maxOut);
  if (projected > Number(env.MAX_DAILY_COST_USD || "0.50")) throw new Error("daily cost limit would be exceeded");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.OPENROUTER_API_KEY },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Reply in Russian. Return valid JSON only. No markdown." },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      max_tokens: maxOut
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const content = data?.choices?.[0]?.message?.content || "";
  const input = Number(data?.usage?.prompt_tokens || tokens(prompt));
  const output = Number(data?.usage?.completion_tokens || tokens(content));
  st.cycles = Number(st.cycles || 0) + 1;
  st.input_tokens = Number(st.input_tokens || 0) + input;
  st.output_tokens = Number(st.output_tokens || 0) + output;
  st.cost_usd = Number((Number(st.cost_usd || 0) + costUsd(input, output)).toFixed(6));
  brain.stats.cycles_total = Number(brain.stats?.cycles_total || 0) + 1;
  await kvPut(env, "brain", brain);
  return { content, input, output };
}

function allowedCommand(c) {
  const x = String(c || "").trim();
  if (!x.startsWith("/")) return false;
  if (x.startsWith("/mission ")) return x.length > 14 && x.length < 260;
  return new Set(["/system_map", "/core_status", "/core_scan", "/core_next", "/core_plan", "/core_approve", "/core_run", "/review_card", "/review_yes", "/review_no", "/verify_status", "/verify_current", "/rollback_status", "/mission_status", "/mission_log", "/memory", "/tasks"]).has(x);
}

async function handleDialog(env, chatId, raw) {
  const state = await snapshot(env);
  const brain = await kvGet(env, "brain", {});
  const r = await askModel(env, brain, promptFor(raw, state));
  const p = parseLoose(r.content) || {};
  const mode = String(p.mode || "answer");
  const command = String(p.command || "").trim();
  if (mode === "proposal" && command && allowedCommand(command)) {
    const proposal = {
      id: "dialog_proposal_" + Date.now(),
      version: VERSION,
      status: "pending",
      title: String(p.title || "Предложение SKYNET").slice(0, 160),
      command,
      risk: String(p.risk || "low").slice(0, 20),
      reply: String(p.reply || "Могу предложить действие.").slice(0, 1200),
      source_text: String(raw || "").slice(0, 1000),
      created_at: now()
    };
    await kvPut(env, "dialog_proposal", proposal);
    await send(env, chatId, [
      proposal.reply,
      "",
      "Могу предложить действие:",
      `Название: ${proposal.title}`,
      `Команда: ${proposal.command}`,
      `Риск: ${proposal.risk}`,
      "Запуск пока вручную: нажми/отправь команду выше."
    ].join("\n"));
    return;
  }
  await send(env, chatId, String(p.reply || p.answer || r.content || "Я поняла, но ответ пустой.").slice(0, 1800));
}

async function showDialogStatus(env, chatId) {
  const p = await kvGet(env, "dialog_proposal", null);
  await send(env, chatId, [
    "Dialog Brain Status:",
    `Version: ${VERSION}`,
    `Model: ${env.OPENROUTER_MODEL_CHEAP || "default"}`,
    `Last proposal: ${p?.status || "none"}`,
    p?.command ? `Command: ${p.command}` : "Command: none"
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    await hydrate(env);
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.dialog_brain = VERSION;
        d.capability_manifest = true;
        d.commands = [...new Set([...(d.commands || []), "/dialog_status"])]
      }
      return json(d || { ok: true, dialog_brain: VERSION }, r.status);
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
      if (m && (low === "/dialog_status" || low === "dialog status" || low === "диалог статус")) {
        await showDialogStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, dialog_status: true });
      }
      if (m && raw && !raw.startsWith("/")) {
        await handleDialog(env, m.chat.id, raw);
        return json({ ok: true, handled_by: VERSION, dialog_brain: true });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
