import baseWorker from "./worker-proof-stage.js";

const VERSION = "level-sync-v1-real-chain";

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

function computeLevel(s) {
  let score = 1.0;
  const flags = [];

  if ((s.brain?.stats?.cycles_total || 0) > 0) { score += 0.3; flags.push("cycles"); }
  if ((s.memories?.length || 0) >= 5) { score += 0.3; flags.push("memory"); }
  if ((s.tasks?.length || 0) > 0) { score += 0.2; flags.push("tasks"); }
  if (s.growth?.last_audit_at || s.growth?.stage) { score += 0.4; flags.push("audit_bridge"); }
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

  if (activeTasks(s.tasks || []) > 80) score -= 0.2;
  const finalScore = Math.max(1, Math.min(10, Number(score.toFixed(1))));
  return { score: finalScore, flags };
}

function stageName(score, s) {
  if (has(s.proof, "done")) return "Level 6.2 — Safe GitHub Writer + Proof Stage";
  if (has(s.ghCommit, "committed_safe_log")) return "Level 6.0 — Safe GitHub Writer работает";
  if (s.ghPrepare?.token_connected === true) return "Level 5.8 — GitHub prepare + token connected";
  if (s.ghPrepare?.id) return "Level 5.6 — GitHub prepare";
  if (has(s.repoOp, "ready_for_commit_plan")) return "Level 5.3 — Repo Operation";
  if (has(s.fileOp, "ready_for_repo_step")) return "Level 5.0 — File Operation";
  if (has(s.action, "yes")) return "Level 4.8 — Action confirmed";
  if (has(s.review, "yes")) return "Level 4.6 — Review confirmed";
  if (s.mission?.id) return "Level 4 — Mission pipeline";
  if (score >= 3) return "Level 3 — Audit → Memory → Task Queue";
  return "Level 2 — Memory/Task Hygiene";
}

function nextStep(s) {
  if (!s.mission?.id) return "/self_audit → /growth_queue → /growth_to_mission";
  if (!has(s.review, "yes")) return "/mission_run → /review_card → /review_yes";
  if (!has(s.action, "yes")) return "/action_card → /action_yes";
  if (!has(s.fileOp, "ready_for_repo_step")) return "/file_operation";
  if (!has(s.repoOp, "ready_for_commit_plan")) return "/repo_operation";
  if (!s.ghPrepare?.id) return "/github_writer_status → /github_prepare";
  if (!has(s.ghCommit, "committed_safe_log")) return "/github_commit_status → /github_commit";
  if (!has(s.proof, "done")) return "/proof_status → /proof_write";
  return "следующий слой: active file step";
}

async function snapshot(env) {
  const tasksData = await kvGet(env, "tasks", { tasks: [] });
  const memData = await kvGet(env, "memories", { memories: [] });
  return {
    brain: await kvGet(env, "brain", {}),
    tasks: Array.isArray(tasksData.tasks) ? tasksData.tasks : [],
    memories: Array.isArray(memData.memories) ? memData.memories : [],
    growth: await kvGet(env, "growth_state", {}),
    mission: await kvGet(env, "active_mission", null),
    review: await kvGet(env, "review_card", null),
    action: await kvGet(env, "action_card", null),
    fileOp: await kvGet(env, "file_operation", null),
    repoOp: await kvGet(env, "repo_operation", null),
    ghPrepare: await kvGet(env, "github_prepare", null),
    ghCommit: await kvGet(env, "github_commit_last", null),
    proof: await kvGet(env, "proof_stage_last", null)
  };
}

async function levelText(env) {
  const s = await snapshot(env);
  const lv = computeLevel(s);
  const active = activeTasks(s.tasks || []);
  const stage = stageName(lv.score, s);
  const blockers = [];
  if (!has(s.ghCommit, "committed_safe_log")) blockers.push("ещё нет safe writer commit");
  if (!has(s.proof, "done")) blockers.push("proof stage ещё не выполнен");
  if (s.memories.length > 40) blockers.push("память шумная, нужна гигиена");
  if (!blockers.length) blockers.push("следующий блокер — active file step");

  return [
    `Уровень: ${lv.score}/10`,
    `Стадия: ${stage}`,
    `Измеритель: ${VERSION}`,
    `Alive: ${s.brain?.alive_enabled === true ? "true" : "false"}`,
    `Циклы: всего ${s.brain?.stats?.cycles_total || 0}`,
    `Память: ${s.memories.length}`,
    `Задачи: всего ${s.tasks.length}, активных ${active}`,
    `Mission: ${s.mission?.current_step || s.mission?.status || "none"}`,
    `Review: ${s.review?.status || "none"}`,
    `Action: ${s.action?.status || "none"}`,
    `File operation: ${s.fileOp?.status || "none"}`,
    `Repo operation: ${s.repoOp?.status || "none"}`,
    `GitHub prepare: ${s.ghPrepare?.status || "none"}`,
    `GitHub commit: ${s.ghCommit?.status || "none"}`,
    `Proof stage: ${s.proof?.status || "none"}`,
    `Флаги: ${lv.flags.join(", ") || "none"}`,
    `Слабо/блокер: ${blockers.join("; ")}`,
    `Следующий шаг: ${nextStep(s)}`
  ].join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.level_sync_layer = VERSION;
        d.level_sync = true;
        d.commands = [...new Set([...(d.commands || []), "/level"])]
      }
      return json(d || { ok: true, level_sync_layer: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();
      if (m && (text === "/level" || text === "уровень" || text === "какой уровень" || text === "на каком уровне")) {
        await send(env, m.chat.id, await levelText(env));
        return json({ ok: true, handled_by: VERSION, level: true });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
