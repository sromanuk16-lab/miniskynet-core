import baseWorker from "./worker-sky-dialog.js";

const VERSION = "alive-dialog-v1-model-brief";
const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function now() { return new Date().toISOString(); }
function ms(t) { const n = Date.parse(t || ""); return Number.isFinite(n) ? n : 0; }
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

async function getAliveDialog(env) {
  return await kvGet(env, "alive_dialog_state", {
    version: VERSION,
    enabled: false,
    last_checked_at: null,
    last_sent_at: null,
    last_signature: "",
    last_text: "",
    min_interval_minutes: 120
  });
}

async function saveAliveDialog(env, state) {
  state.version = VERSION;
  state.updated_at = now();
  await kvPut(env, "alive_dialog_state", state);
}

async function snapshot(env) {
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  const brain = await kvGet(env, "brain", {});
  return {
    brain_version: brain?.version || "unknown",
    owner_chat_id: brain?.owner_chat_id || "",
    alive_enabled: brain?.alive_enabled === true,
    memories: Array.isArray(memData.memories) ? memData.memories.length : 0,
    tasks_total: Array.isArray(tasksData.tasks) ? tasksData.tasks.length : 0,
    active_tasks: Array.isArray(tasksData.tasks) ? tasksData.tasks.filter(t => t.status !== "done" && t.status !== "archived").length : 0,
    mission: await kvGet(env, "active_mission", null),
    review: await kvGet(env, "review_card", null),
    dialog_proposal: await kvGet(env, "dialog_proposal", null),
    core_plan: await kvGet(env, "core_plan", null),
    core_run: await kvGet(env, "core_run", null),
    verify: await kvGet(env, "verify_state", null),
    safe_entry: await kvGet(env, "safe_entry", null)
  };
}

function signature(s) {
  return [
    s.mission?.status || "m0",
    s.review?.status || "r0",
    s.dialog_proposal?.status || "p0",
    s.core_plan?.status || "c0",
    s.verify?.status || "v0",
    s.safe_entry?.status || "e0",
    s.active_tasks || 0,
    s.memories || 0
  ].join("|");
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
  const maxOut = Math.min(Number(env.MAX_OUTPUT_TOKENS || "650"), 500);
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

function promptForBrief(s, reason) {
  return [
    "Ты Alive Dialog v1 для SKYNET Сергея.",
    "Твоя задача — не сухой лог, а короткое живое сообщение, когда по состоянию есть что сказать.",
    "Пиши на русском, на ты, коротко, без офисного стиля.",
    "Не утверждай, что у тебя есть сознание. Говори как инженерный дежурный агент.",
    "Если важного нет — верни should_send=false.",
    "Если есть изменение, слабое место, pending review/proposal или полезный следующий шаг — should_send=true.",
    "Не запускай команды. Можно только предложить одну команду как next_command.",
    "Верни строго JSON:",
    "{\"should_send\":true|false,\"text\":\"короткий текст Сергею\",\"next_command\":\"/command or empty\",\"reason\":\"short reason\"}",
    `reason=${reason}`,
    `state=${JSON.stringify(s)}`
  ].join("\n");
}

async function runAliveDialog(env, opts = {}) {
  await hydrate(env);
  const state = await getAliveDialog(env);
  const s = await snapshot(env);
  const chatId = String(s.owner_chat_id || env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  const forced = opts.forced === true;
  const enabled = state.enabled === true || forced;
  const currentSig = signature(s);
  const interval = Math.max(30, Number(state.min_interval_minutes || 120)) * 60 * 1000;
  const tooSoon = Date.now() - ms(state.last_sent_at) < interval;
  const unchanged = currentSig === state.last_signature;
  state.last_checked_at = now();

  if (!enabled) {
    state.last_signature = currentSig;
    await saveAliveDialog(env, state);
    return { sent: false, reason: "disabled" };
  }
  if (!forced && tooSoon && unchanged) {
    await saveAliveDialog(env, state);
    return { sent: false, reason: "quiet_unchanged" };
  }
  if (!chatId) {
    await saveAliveDialog(env, state);
    return { sent: false, reason: "no_chat_id" };
  }

  const brain = await kvGet(env, "brain", {});
  let parsed = null;
  try {
    const r = await askModel(env, brain, promptForBrief(s, forced ? "manual" : "scheduled"));
    parsed = parseLoose(r.content) || {};
  } catch (e) {
    state.last_error = String(e.message || e).slice(0, 240);
    await saveAliveDialog(env, state);
    if (forced) await send(env, chatId, "Alive Dialog не смог подумать моделью: " + state.last_error);
    return { sent: false, reason: "model_error", error: state.last_error };
  }

  const shouldSend = forced || parsed.should_send === true;
  const text = String(parsed.text || "").trim();
  if (!shouldSend || !text) {
    state.last_signature = currentSig;
    state.last_text = text || "quiet";
    await saveAliveDialog(env, state);
    return { sent: false, reason: "model_quiet" };
  }

  const next = String(parsed.next_command || "").trim();
  const msg = next ? `${text}\n\nПредложенная команда: ${next}` : text;
  await send(env, chatId, msg);
  state.last_sent_at = now();
  state.last_signature = currentSig;
  state.last_text = msg.slice(0, 1000);
  state.last_reason = String(parsed.reason || "").slice(0, 200);
  delete state.last_error;
  await saveAliveDialog(env, state);
  return { sent: true, reason: "sent" };
}

async function showStatus(env, chatId) {
  const s = await getAliveDialog(env);
  await send(env, chatId, [
    "Alive Dialog Status:",
    `Version: ${VERSION}`,
    `Enabled: ${s.enabled === true}`,
    `Last checked: ${s.last_checked_at || "none"}`,
    `Last sent: ${s.last_sent_at || "none"}`,
    `Min interval: ${s.min_interval_minutes || 120} min`,
    s.last_error ? `Last error: ${s.last_error}` : "Last error: none"
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
        d.alive_dialog = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/alive_dialog_status", "/alive_dialog_now", "/alive_dialog_on", "/alive_dialog_off"])]
      }
      return json(d || { ok: true, alive_dialog: VERSION }, r.status);
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
      if (m && low === "/alive_dialog_status") {
        await showStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, alive_dialog_status: true });
      }
      if (m && low === "/alive_dialog_on") {
        const s = await getAliveDialog(env);
        s.enabled = true;
        await saveAliveDialog(env, s);
        await send(env, m.chat.id, "Alive Dialog включён. Буду писать только если есть заметное изменение или полезный следующий шаг.");
        return json({ ok: true, handled_by: VERSION, alive_dialog_on: true });
      }
      if (m && low === "/alive_dialog_off") {
        const s = await getAliveDialog(env);
        s.enabled = false;
        await saveAliveDialog(env, s);
        await send(env, m.chat.id, "Alive Dialog выключен. По времени не пишу.");
        return json({ ok: true, handled_by: VERSION, alive_dialog_off: true });
      }
      if (m && low === "/alive_dialog_now") {
        const r = await runAliveDialog(env, { forced: true });
        return json({ ok: true, handled_by: VERSION, alive_dialog_now: r });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    await baseWorker.scheduled(event, env, ctx);
    return await runAliveDialog(env, { forced: false });
  }
};
