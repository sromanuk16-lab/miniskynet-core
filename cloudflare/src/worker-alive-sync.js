import baseWorker from "./worker-version-chain.js";

const VERSION = "alive-sync-v1-real-level";
const MIN_INTERVAL_MS = 30 * 60 * 1000;

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

function activeTasks(tasks) {
  return tasks.filter(t => t?.status !== "archived" && t?.status !== "done").length;
}

function has(obj, status) {
  if (!obj) return false;
  if (!status) return true;
  if (Array.isArray(status)) return status.includes(obj.status);
  return obj.status === status;
}

async function snapshot(env) {
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  return {
    brain: await kvGet(env, "brain", {}),
    tasks: Array.isArray(tasksData.tasks) ? tasksData.tasks : [],
    memories: Array.isArray(memData.memories) ? memData.memories : [],
    mission: await kvGet(env, "active_mission", null),
    review: await kvGet(env, "review_card", null),
    action: await kvGet(env, "action_card", null),
    fileOp: await kvGet(env, "file_operation", null),
    repoOp: await kvGet(env, "repo_operation", null),
    ghPrepare: await kvGet(env, "github_prepare", null),
    ghCommit: await kvGet(env, "github_commit_last", null),
    proof: await kvGet(env, "proof_stage_last", null),
    live: await kvGet(env, "live_step_last", null),
    aliveSync: await kvGet(env, "alive_sync_state", {})
  };
}

function computeLevel(s) {
  let score = 1.0;
  const flags = [];
  if ((s.brain?.stats?.cycles_total || 0) > 0) { score += 0.3; flags.push("cycles"); }
  if ((s.memories?.length || 0) >= 5) { score += 0.3; flags.push("memory"); }
  if ((s.tasks?.length || 0) > 0) { score += 0.2; flags.push("tasks"); }
  if (s.brain?.alive_enabled === true) { score += 0.2; flags.push("alive"); }
  if (s.mission?.id) { score += 0.5; flags.push("mission"); }
  if (has(s.review, "yes")) { score += 0.4; flags.push("review_yes"); }
  if (has(s.action, "yes")) { score += 0.4; flags.push("action_yes"); }
  if (has(s.fileOp, "ready_for_repo_step")) { score += 0.45; flags.push("file_operation"); }
  if (has(s.repoOp, "ready_for_commit_plan")) { score += 0.45; flags.push("repo_operation"); }
  if (s.ghPrepare?.id) { score += 0.45; flags.push("github_prepare"); }
  if (s.ghPrepare?.token_connected === true) { score += 0.25; flags.push("github_token"); }
  if (has(s.ghCommit, "committed_safe_log")) { score += 0.75; flags.push("safe_commit"); }
  if (has(s.proof, "done")) { score += 0.35; flags.push("proof_stage"); }
  if (has(s.live, "switched")) { score += 0.1; flags.push("live_layer"); }
  return { score: Math.max(1, Math.min(10, Number(score.toFixed(1)))), flags };
}

function stageName(s, score) {
  if (has(s.live, "switched")) return "Level 6.5 — Active Worker Layer Created";
  if (has(s.proof, "done")) return "Level 6.2 — Safe GitHub Writer + Proof Stage";
  if (has(s.ghCommit, "committed_safe_log")) return "Level 6.0 — Safe GitHub Writer работает";
  if (s.ghPrepare?.token_connected === true) return "Level 5.8 — GitHub prepare + token connected";
  if (has(s.repoOp, "ready_for_commit_plan")) return "Level 5.3 — Repo Operation";
  return "Level 3 — legacy pipeline";
}

function nextStep(s) {
  if (!has(s.live, "switched")) return "/version_chain затем /level";
  if (s.memories.length > 50) return "/memory_hygiene затем /level";
  return "active file step: маленькая полезная правка активного слоя";
}

function weakText(s) {
  const weak = [];
  if (s.memories.length > 50) weak.push("память шумная, нужна гигиена");
  if (!has(s.live, "switched")) weak.push("live layer ещё не подтверждён");
  if (!weak.length) weak.push("следующий риск — правка активного файла");
  return weak.join("; ");
}

function reportText(s, reason = "tick") {
  const lv = computeLevel(s);
  return [
    `Alive Sync ${reason}:`,
    `Уровень: ${lv.score}/10`,
    `Стадия: ${stageName(s, lv.score)}`,
    `Измеритель: ${VERSION}`,
    `Alive: ${s.brain?.alive_enabled === true ? "true" : "false"}`,
    `Циклы: всего ${s.brain?.stats?.cycles_total || 0}`,
    `Память: ${s.memories.length}`,
    `Задачи: всего ${s.tasks.length}, активных ${activeTasks(s.tasks || [])}`,
    `Mission: ${s.mission?.current_step || s.mission?.status || "none"}`,
    `GitHub commit: ${s.ghCommit?.status || "none"}`,
    `Proof stage: ${s.proof?.status || "none"}`,
    `Live layer: ${s.live?.status || "none"}`,
    `Слабо/блокер: ${weakText(s)}`,
    `Следующий шаг: ${nextStep(s)}`,
    "Control: старый selfcheck alive tick больше не вызывается этим cron-слоем."
  ].join("\n");
}

async function bumpCycle(env, brain) {
  const today = new Date().toISOString().slice(0, 10);
  const stats = brain.stats || {};
  const updated = {
    ...brain,
    stats: {
      ...stats,
      cycles_total: Number(stats.cycles_total || 0) + 1,
      cycles_today: stats.cycles_date === today ? Number(stats.cycles_today || 0) + 1 : 1,
      cycles_date: today
    },
    last_alive_sync_at: new Date().toISOString()
  };
  await kvPut(env, "brain", updated);
  return updated;
}

async function runAliveSync(env, reason = "tick", force = false) {
  const s0 = await snapshot(env);
  const brain = s0.brain || {};
  const chatId = brain.owner_chat_id || brain.chat_id || brain.telegram_chat_id;
  if (brain.alive_enabled !== true || !chatId) return { ok: false, skipped: true };

  const state = s0.aliveSync || {};
  const now = Date.now();
  if (!force && state.last_sent_ms && now - Number(state.last_sent_ms) < MIN_INTERVAL_MS) {
    return { ok: true, throttled: true };
  }

  const updatedBrain = await bumpCycle(env, brain);
  const s = { ...s0, brain: updatedBrain };
  await kvPut(env, "alive_sync_state", {
    version: VERSION,
    last_sent_ms: now,
    last_sent_at: new Date().toISOString(),
    last_level: computeLevel(s).score,
    last_stage: stageName(s, computeLevel(s).score)
  });
  await send(env, chatId, reportText(s, reason));
  return { ok: true };
}

async function status(env, chatId) {
  const s = await snapshot(env);
  await send(env, chatId, reportText(s, "status"));
}

async function manualTick(env, chatId) {
  const r = await runAliveSync(env, "manual tick", true);
  if (!r.ok) await send(env, chatId, "Alive Sync: не смог отправить tick. Проверь alive_on и owner_chat_id.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.alive_sync_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/alive_sync_status", "/alive_sync_tick"])]
      }
      return json(d || { ok: true, alive_sync_layer: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();
      if (m && (text === "/alive_sync_status" || text === "alive sync status")) {
        await status(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, alive_sync_status: true });
      }
      if (m && (text === "/alive_sync_tick" || text === "alive sync tick")) {
        await manualTick(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, alive_sync_tick: true });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAliveSync(env, "tick", false));
  }
};
