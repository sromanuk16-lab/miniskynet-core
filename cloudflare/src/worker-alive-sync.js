import baseWorker from "./worker-version-chain.js";

const VERSION = "alive-sync-v3-core-orchestrator";
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

function st(obj) {
  return obj?.status || (obj ? "present" : "none");
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
    aliveSync: await kvGet(env, "alive_sync_state", {}),
    naturalIntent: await kvGet(env, "last_natural_intent", null),
    corePlan: await kvGet(env, "core_plan", null),
    coreRun: await kvGet(env, "core_run", null)
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
  if (s.naturalIntent?.status === "captured") { score += 0.1; flags.push("natural_intent"); }
  if (s.corePlan?.status) { score += 0.15; flags.push("core_plan"); }
  return { score: Math.max(1, Math.min(10, Number(score.toFixed(1)))), flags };
}

function stageName(s, score) {
  if (s.corePlan?.status) return "Level 6.7 — Core Orchestrator connected";
  if (has(s.live, "switched")) return "Level 6.5 — Active Worker Layer Created";
  if (has(s.proof, "done")) return "Level 6.2 — Safe GitHub Writer + Proof Stage";
  if (has(s.ghCommit, "committed_safe_log")) return "Level 6.0 — Safe GitHub Writer работает";
  if (s.ghPrepare?.token_connected === true) return "Level 5.8 — GitHub prepare + token connected";
  if (has(s.repoOp, "ready_for_commit_plan")) return "Level 5.3 — Repo Operation";
  return "Level 3 — legacy pipeline";
}

function weaknessList(s) {
  const items = [];
  if (!s.naturalIntent) items.push("natural text router ещё не ведёт задачи в mission loop");
  if (!s.corePlan) items.push("нет единого core plan для следующего улучшения");
  if (s.memories.length > 50) items.push("память шумная: нужна отдельная гигиена и типы памяти");
  items.push("нет verify/rollback слоя после изменения активного entry");
  items.push("voice input/output ещё не подключены");
  return items;
}

function nextImprovement(s) {
  if (!s.naturalIntent) return { id: "intent-router-v1", title: "Intent Router v1", goal: "живой текст превращается в system_scan / improvement_plan / mission_request", risk: "low-medium" };
  if (!s.corePlan) return { id: "core-plan-v1", title: "Core Plan v1", goal: "единый план улучшения вместо отдельных KV-фрагментов", risk: "low" };
  if (s.memories.length > 50) return { id: "memory-hygiene-v1", title: "Memory Hygiene v1", goal: "разделить шум, уроки, системные факты и проектную память", risk: "medium" };
  return { id: "verify-rollback-v1", title: "Verify/Rollback v1", goal: "после любого switch проверять команду и уметь откатить entry", risk: "medium" };
}

function nextStep(s) {
  if (!has(s.live, "switched")) return "/version_chain затем /level";
  if (!s.corePlan) return "/core_plan";
  if (s.corePlan?.status === "planned") return "/core_approve";
  if (s.corePlan?.status === "approved") return "/core_run";
  if (s.memories.length > 50) return "/memory_hygiene затем /level";
  return "следующее улучшение через /core_next";
}

function weakText(s) {
  return weaknessList(s).slice(0, 3).join("; ");
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
    `Core plan: ${s.corePlan?.status || "none"}`,
    `Слабо/блокер: ${weakText(s)}`,
    `Следующий шаг: ${nextStep(s)}`,
    "Control: старый selfcheck alive tick больше не вызывается этим cron-слоем."
  ].join("\n");
}

function systemMapText(s) {
  const connected = [];
  if (s.mission) connected.push("mission");
  if (s.review?.status === "yes") connected.push("review_yes");
  if (s.action?.status === "yes") connected.push("action_yes");
  if (s.fileOp) connected.push("file_operation");
  if (s.repoOp) connected.push("repo_operation");
  if (s.ghPrepare) connected.push("github_prepare");
  if (s.ghCommit) connected.push("github_commit");
  if (s.proof) connected.push("proof_stage");
  if (s.live?.status === "switched") connected.push("live_layer");
  if (s.aliveSync) connected.push("alive_sync");
  if (s.corePlan) connected.push("core_plan");
  if (s.naturalIntent) connected.push("natural_intent_capture");

  return [
    "System Map:",
    `Version: ${VERSION}`,
    "",
    "Active chain:",
    "wrangler → worker-current → alive-sync/core-orchestrator → version-chain → level-sync → proof/github layers",
    "",
    "KV state:",
    `Memory: ${s.memories.length}`,
    `Tasks: total ${s.tasks.length}, active ${activeTasks(s.tasks || [])}`,
    `Mission: ${st(s.mission)}`,
    `Review: ${st(s.review)}`,
    `Action: ${st(s.action)}`,
    `File operation: ${st(s.fileOp)}`,
    `Repo operation: ${st(s.repoOp)}`,
    `GitHub prepare: ${st(s.ghPrepare)}`,
    `GitHub commit: ${st(s.ghCommit)}`,
    `Proof stage: ${st(s.proof)}`,
    `Live layer: ${st(s.live)}`,
    `Alive sync: ${st(s.aliveSync)}`,
    `Natural intent: ${st(s.naturalIntent)}`,
    `Core plan: ${st(s.corePlan)}`,
    "",
    `Connected modules: ${connected.join(", ") || "none"}`,
    `Gaps: ${weaknessList(s).join("; ")}`,
    "Verdict: командная writer-цепочка работает; core orchestrator теперь ловит живые задачи и готовит единый план."
  ].join("\n");
}

function coreScanText(s) {
  const lv = computeLevel(s);
  const next = nextImprovement(s);
  return [
    "Core Scan:",
    `Version: ${VERSION}`,
    `Level: ${lv.score}/10`,
    `Stage: ${stageName(s, lv.score)}`,
    "",
    "Работает:",
    `- writer chain: ${s.ghCommit ? "yes" : "no"}`,
    `- proof stage: ${s.proof ? "yes" : "no"}`,
    `- live layer: ${s.live?.status || "none"}`,
    `- alive sync: ${s.aliveSync ? "yes" : "no"}`,
    "",
    "Слабые места:",
    ...weaknessList(s).map(x => "- " + x),
    "",
    "Следующее улучшение:",
    `${next.title}: ${next.goal}`,
    `Risk: ${next.risk}`,
    "Команда: /core_plan"
  ].join("\n");
}

function buildCorePlan(s, sourceText = "") {
  const next = nextImprovement(s);
  return {
    id: "core_plan_" + Date.now(),
    version: VERSION,
    status: "planned",
    improvement_id: next.id,
    title: next.title,
    goal: next.goal,
    risk: next.risk,
    source_text: sourceText.slice(0, 1000),
    steps: [
      "read system_map snapshot",
      "classify user intent",
      "create review/action plan",
      "route to existing writer chain only after approve",
      "verify result and save lesson"
    ],
    safe_rule: "no active entry switch without explicit approve",
    next_command: "/core_approve",
    created_at: new Date().toISOString()
  };
}

function renderCorePlan(p) {
  if (!p) return "Core Plan: none. Команда: /core_plan";
  return [
    "Core Plan:",
    `ID: ${p.id}`,
    `Status: ${p.status}`,
    `Improvement: ${p.title}`,
    `Goal: ${p.goal}`,
    `Risk: ${p.risk}`,
    "Steps:",
    ...(p.steps || []).map((x, i) => `${i + 1}. ${x}`),
    `Rule: ${p.safe_rule}`,
    `Next: ${p.status === "planned" ? "/core_approve" : p.status === "approved" ? "/core_run" : "/core_next"}`
  ].join("\n");
}

async function coreStatus(env, chatId) {
  const s = await snapshot(env);
  await send(env, chatId, [
    "Core Status:",
    `Version: ${VERSION}`,
    `Plan: ${st(s.corePlan)}`,
    `Run: ${st(s.coreRun)}`,
    `Natural intent: ${st(s.naturalIntent)}`,
    `Mission: ${st(s.mission)}`,
    `Writer: ${st(s.ghCommit)}`,
    `Live: ${st(s.live)}`,
    `Next: ${nextStep(s)}`
  ].join("\n"));
}

async function corePlan(env, chatId, sourceText = "") {
  const p = buildCorePlan(await snapshot(env), sourceText);
  await kvPut(env, "core_plan", p);
  await send(env, chatId, renderCorePlan(p));
}

async function coreApprove(env, chatId) {
  const p = await kvGet(env, "core_plan", null);
  if (!p || p.status !== "planned") {
    await send(env, chatId, "Core Approve: сначала /core_plan");
    return;
  }
  const approved = { ...p, status: "approved", approved_at: new Date().toISOString(), next_command: "/core_run" };
  await kvPut(env, "core_plan", approved);
  await send(env, chatId, renderCorePlan(approved));
}

async function coreRun(env, chatId) {
  const p = await kvGet(env, "core_plan", null);
  if (!p || p.status !== "approved") {
    await send(env, chatId, "Core Run: сначала /core_plan затем /core_approve");
    return;
  }

  const run = {
    id: "core_run_" + Date.now(),
    version: VERSION,
    status: "prepared",
    plan_id: p.id,
    improvement_id: p.improvement_id,
    title: p.title,
    result: "mission/review/action state prepared; code writer step remains gated by approve-specific layer",
    next_command: p.improvement_id === "intent-router-v1" ? "создать dedicated intent-router layer" : "/core_next",
    created_at: new Date().toISOString()
  };
  await kvPut(env, "core_run", run);

  const mission = {
    id: "mission_core_" + Date.now(),
    status: "core_prepared",
    current_step: "core_orchestrator_prepared",
    goal: p.goal,
    source: "core_orchestrator",
    next_command: run.next_command,
    updated_at: new Date().toISOString(),
    events: [{ time: new Date().toISOString(), type: "core_run", status: "prepared", text: run.result }]
  };
  await kvPut(env, "active_mission", mission);
  await kvPut(env, "mission:" + mission.id, mission);

  const review = {
    id: "review_core_" + Date.now(),
    status: "pending",
    source: "core_orchestrator",
    mission_id: mission.id,
    title: p.title,
    goal: p.goal,
    risk: p.risk,
    recommendation: "next implementation should be a small active layer with explicit approve",
    created_at: new Date().toISOString()
  };
  await kvPut(env, "review_card", review);

  await send(env, chatId, [
    "Core Run prepared:",
    `Mission: ${mission.id}`,
    `Review: ${review.id}`,
    `Improvement: ${p.title}`,
    "Статус: единый контур создан в KV.",
    "Следующий шаг: dedicated active layer для intent router, затем verify/rollback."
  ].join("\n"));
}

async function coreNext(env, chatId) {
  const s = await snapshot(env);
  const next = nextImprovement(s);
  await send(env, chatId, [
    "Core Next:",
    `Next improvement: ${next.title}`,
    `Goal: ${next.goal}`,
    `Risk: ${next.risk}`,
    "Command: /core_plan"
  ].join("\n"));
}

function classifyNaturalText(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (!t || t.startsWith("/")) return null;
  const hasWake = t.includes("скайнет") || t.includes("skynet");
  const asksScan = t.includes("проверь") || t.includes("что работает") || t.includes("слаб") || t.includes("синхрон") || t.includes("карта системы");
  const asksImprove = t.includes("улучш") || t.includes("сделай") || t.includes("добавь") || t.includes("почини") || t.includes("реализ") || t.includes("внедр");
  if (hasWake && asksScan) return "system_scan";
  if (hasWake && asksImprove) return "improvement_plan";
  if (asksScan && t.includes("себ")) return "system_scan";
  if (asksImprove && (t.includes("себ") || t.includes("систем") || t.includes("памят") || t.includes("голос") || t.includes("текст"))) return "improvement_plan";
  return null;
}

async function handleNatural(env, chatId, raw, kind) {
  const intent = {
    id: "intent_" + Date.now(),
    version: VERSION,
    status: "captured",
    kind,
    text: String(raw || "").slice(0, 1000),
    created_at: new Date().toISOString()
  };
  await kvPut(env, "last_natural_intent", intent);
  if (kind === "system_scan") {
    await send(env, chatId, "Natural Intent: system_scan\nЗапускаю core scan вместо model fallback.\n\n" + coreScanText(await snapshot(env)));
    return;
  }
  await corePlan(env, chatId, raw);
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
    last_stage: stageName(s, computeLevel(s).score),
    last_core_next: nextImprovement(s).id
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

async function showSystemMap(env, chatId) {
  await send(env, chatId, systemMapText(await snapshot(env)));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.alive_sync_layer = VERSION;
        d.core_orchestrator = true;
        d.commands = [...new Set([...(d.commands || []), "/alive_sync_status", "/alive_sync_tick", "/system_map", "/core_status", "/core_scan", "/core_next", "/core_plan", "/core_approve", "/core_run"])]
      }
      return json(d || { ok: true, alive_sync_layer: VERSION, core_orchestrator: true }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const raw = String(m?.text || "").trim();
      const text = raw.toLowerCase();
      if (m && (text === "/alive_sync_status" || text === "alive sync status")) {
        await status(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, alive_sync_status: true });
      }
      if (m && (text === "/alive_sync_tick" || text === "alive sync tick")) {
        await manualTick(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, alive_sync_tick: true });
      }
      if (m && (text === "/system_map" || text === "system map" || text === "карта системы")) {
        await showSystemMap(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, system_map: true });
      }
      if (m && (text === "/core_status" || text === "core status")) {
        await coreStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, core_status: true });
      }
      if (m && (text === "/core_scan" || text === "core scan" || text === "проверь себя")) {
        await send(env, m.chat.id, coreScanText(await snapshot(env)));
        return json({ ok: true, handled_by: VERSION, core_scan: true });
      }
      if (m && (text === "/core_next" || text === "core next")) {
        await coreNext(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, core_next: true });
      }
      if (m && (text === "/core_plan" || text === "core plan")) {
        await corePlan(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, core_plan: true });
      }
      if (m && (text === "/core_approve" || text === "core approve" || text === "/approve")) {
        await coreApprove(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, core_approve: true });
      }
      if (m && (text === "/core_run" || text === "core run")) {
        await coreRun(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, core_run: true });
      }
      if (m) {
        const kind = classifyNaturalText(raw);
        if (kind) {
          await handleNatural(env, m.chat.id, raw, kind);
          return json({ ok: true, handled_by: VERSION, natural_intent: kind });
        }
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAliveSync(env, "tick", false));
  }
};
