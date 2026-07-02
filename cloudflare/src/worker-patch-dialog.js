import baseWorker from "./worker-universal-proof.js";

const VERSION = "patch-dialog-v1";
const REPO = "sromanuk16-lab/miniskynet-core";
const BRANCH = "main";

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

function getMsg(update) { return update?.message || update?.edited_message || null; }
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

function wantsPatch(text) {
  const s = String(text || "").toLowerCase();
  return (
    s.includes("создай patch") ||
    s.includes("собери patch") ||
    s.includes("сделай patch") ||
    s.includes("подготовь patch") ||
    s.includes("улучши") ||
    s.includes("добавь команд") ||
    s.includes("сделай слой") ||
    s.includes("примени улучш")
  );
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
  const maxOut = Math.min(Number(env.MAX_OUTPUT_TOKENS || "1800"), 2200);
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
        { role: "system", content: "Return valid JSON only. No markdown. Russian text in user-facing fields." },
        { role: "user", content: prompt }
      ],
      temperature: 0.25,
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
  return content;
}

async function snapshot(env) {
  return {
    active_mission: await kvGet(env, "active_mission", null),
    improvement_patch: await kvGet(env, "improvement_patch", null),
    improvement_last: await kvGet(env, "improvement_runner_last", null),
    dialog_proposal: await kvGet(env, "dialog_proposal", null),
    review_card: await kvGet(env, "review_card", null),
    verify_state: await kvGet(env, "verify_state", null)
  };
}

function patchPrompt(goal, state) {
  return [
    "Ты Patch Dialog v1 для MiniSkynet Core.",
    "Твоя задача — по просьбе Сергея подготовить improvement_patch JSON для уже существующего /improve_review и /improve_yes.",
    "Ты НЕ применяешь patch. Только создаёшь pending JSON в KV.",
    "Patch потом пройдёт валидацию, review и явное approve Сергея.",
    "Ограничения patch:",
    "- только files[].action='upsert'",
    "- максимум 5 файлов",
    "- пути только cloudflare/src/, cloudflare/docs/, cloudflare/tests/, docs/, README.md, cloudflare/wrangler.toml",
    "- switch_entry=true только если создаёшь новый wrapper-layer в cloudflare/src/",
    "- новый wrapper должен import baseWorker из текущего верхнего слоя './worker-universal-proof.js' или из уже нужного активного слоя",
    "- не вставляй реальные секреты, токены, пароли, private keys",
    "- изменения должны быть маленькими и проверяемыми",
    "Верни строго JSON такого вида:",
    "{\"title\":\"...\",\"goal\":\"...\",\"risk\":\"low|medium|high\",\"files\":[{\"action\":\"upsert\",\"path\":\"cloudflare/src/worker-example.js\",\"content\":\"полный файл\"}],\"switch_entry\":true|false,\"switch_to\":\"cloudflare/src/worker-example.js или пусто\",\"check_command\":\"/command\"}",
    "Если просьба слишком широкая — сделай маленький первый слой, не большой рефакторинг.",
    `Текущее состояние: ${JSON.stringify(state)}`,
    `Просьба Сергея: ${String(goal || "").slice(0, 3000)}`
  ].join("\n");
}

function normalizePatch(raw, sourceText) {
  const files = Array.isArray(raw.files) ? raw.files.slice(0, 5).map(f => ({
    action: "upsert",
    path: String(f.path || "").trim(),
    content: String(f.content || "")
  })) : [];
  return {
    id: "patch_dialog_" + Date.now(),
    version: VERSION,
    status: "pending",
    title: String(raw.title || "Dialog Patch").slice(0, 120),
    goal: String(raw.goal || sourceText || "улучшение SKYNET").slice(0, 500),
    risk: String(raw.risk || "medium").slice(0, 20),
    repo: REPO,
    branch: BRANCH,
    files,
    switch_entry: raw.switch_entry === true,
    switch_to: String(raw.switch_to || "").trim(),
    check_command: String(raw.check_command || "/improve_status").trim(),
    allow: {
      prefixes: ["cloudflare/src/", "cloudflare/docs/", "cloudflare/tests/", "docs/"],
      exact: ["cloudflare/wrangler.toml", "README.md"]
    },
    source: "patch_dialog_model",
    source_text: String(sourceText || "").slice(0, 1000),
    created_at: now()
  };
}

function renderPatch(p) {
  const files = (p.files || []).map((f, i) => `${i + 1}. ${f.action} ${f.path} (${String(f.content || "").split("\n").length} lines)`).join("\n");
  return [
    "Patch Dialog prepared:",
    `ID: ${p.id}`,
    `Title: ${p.title}`,
    `Goal: ${p.goal}`,
    `Risk: ${p.risk}`,
    "",
    "Files:",
    files || "none",
    "",
    p.switch_entry ? `Switch: ${p.switch_to}` : "Switch: no",
    `Check: ${p.check_command}`,
    "",
    "Дальше:",
    "/improve_review",
    "если всё нормально — /improve_yes"
  ].join("\n");
}

async function preparePatchFromText(env, chatId, text) {
  const state = await snapshot(env);
  const brain = await kvGet(env, "brain", {});
  let raw;
  try {
    const content = await askModel(env, brain, patchPrompt(text, state));
    raw = parseLoose(content);
  } catch (e) {
    await send(env, chatId, "Patch Dialog: модель не смогла собрать patch: " + String(e.message || e).slice(0, 200));
    return;
  }
  if (!raw || !Array.isArray(raw.files) || raw.files.length === 0) {
    await send(env, chatId, "Patch Dialog: модель не вернула files[]. Попробуй сузить задачу.");
    return;
  }
  const patch = normalizePatch(raw, text);
  await kvPut(env, "improvement_patch", patch);
  await send(env, chatId, renderPatch(patch));
}

async function showStatus(env, chatId) {
  const p = await kvGet(env, "improvement_patch", null);
  await send(env, chatId, [
    "Patch Dialog Status:",
    `Version: ${VERSION}`,
    `Current patch: ${p?.status || "none"}`,
    p?.title ? `Title: ${p.title}` : "Title: none",
    "Trigger: обычный текст с 'улучши', 'сделай слой', 'создай patch'",
    "Next: /improve_review → /improve_yes"
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
        d.patch_dialog = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/patch_dialog_status"])]
      }
      return json(d || { ok: true, patch_dialog: VERSION }, r.status);
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
      if (m && (low === "/patch_dialog_status" || low === "patch dialog status")) {
        await showStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, patch_dialog_status: true });
      }
      if (m && raw && !raw.startsWith("/") && wantsPatch(raw)) {
        await preparePatchFromText(env, m.chat.id, raw);
        return json({ ok: true, handled_by: VERSION, patch_prepared: true });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
