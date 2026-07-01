import aliveWorker from "./worker-alive.js";

const WRAPPER = "intention-gate-v0.7";
const MIN_GAP_MS = 60 * 60 * 1000;
const LONG_SILENCE_MS = 6 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function nowMs() {
  return Date.now();
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

async function readJson(env, key, fallback) {
  if (!env.MINISKYNET_KV) return fallback;
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function writeJson(env, key, value) {
  if (!env.MINISKYNET_KV) return;
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return env;
  for (const key of ["ALIVE_OWNER_CHAT_ID"]) {
    if (!env[key]) {
      const value = await env.MINISKYNET_KV.get("config:" + key);
      if (value) env[key] = String(value).trim();
    }
  }
  return env;
}

function openTasks(tasks) {
  return tasks.filter((t) => ["todo", "retry_wait"].includes(t.status));
}

function signature(tasks) {
  return openTasks(tasks)
    .map((t) => `${t.id || ""}:${t.priority || 0}:${t.title || ""}`)
    .sort()
    .join("|")
    .slice(0, 1000);
}

function decide({ brain, memories, tasks, state }) {
  const t = nowMs();
  const enabled = brain?.alive_enabled === true;
  if (!enabled) return { fire: false, reason: "alive выключен" };

  const chatId = brain?.owner_chat_id;
  if (!chatId) return { fire: false, reason: "нет owner_chat_id" };

  const lastFire = state?.last_fire_ms || 0;
  const age = lastFire ? t - lastFire : Infinity;
  const opened = openTasks(tasks);
  const topPriority = opened.reduce((mx, task) => Math.max(mx, Number(task.priority || 0)), 0);
  const currentSig = signature(tasks);
  const sigChanged = currentSig && currentSig !== state?.last_task_signature;
  const hasSeed = memories.some((m) => m?.tag === "identity_seed");

  if (!lastFire) return { fire: true, reason: "первый автономный запуск", task_signature: currentSig };
  if (!hasSeed) return { fire: true, reason: "нет стартовой identity-памяти", task_signature: currentSig };
  if (topPriority >= 5 && age >= 15 * 60 * 1000) return { fire: true, reason: "важная задача priority>=5", task_signature: currentSig };
  if (topPriority >= 4 && sigChanged && age >= MIN_GAP_MS) return { fire: true, reason: "новая важная задача priority>=4", task_signature: currentSig };
  if (age >= LONG_SILENCE_MS) return { fire: true, reason: "долгая тишина, стоит написать Сергею", task_signature: currentSig };

  return { fire: false, reason: "ничего важного", task_signature: currentSig };
}

async function intentionTick(event, env, ctx) {
  await hydrate(env);
  const brain = await readJson(env, "brain", { alive_enabled: false, owner_chat_id: "", stats: { cycles_total: 0, daily: {} }, messages: [] });
  const memoriesData = await readJson(env, "memories", { memories: [] });
  const tasksData = await readJson(env, "tasks", { tasks: [] });
  const state = await readJson(env, "alive_state", { silent_checks: 0 });

  const memories = Array.isArray(memoriesData.memories) ? memoriesData.memories : [];
  const tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
  const decision = decide({ brain, memories, tasks, state });

  const nextState = {
    ...state,
    last_check_ms: nowMs(),
    last_check_at: iso(),
    last_decision: decision.reason,
    last_task_signature: decision.task_signature || state.last_task_signature || ""
  };

  if (!decision.fire) {
    nextState.silent_checks = Number(state.silent_checks || 0) + 1;
    await writeJson(env, "alive_state", nextState);
    return;
  }

  nextState.silent_checks = 0;
  nextState.last_fire_ms = nowMs();
  nextState.last_fire_at = iso();
  nextState.last_fire_reason = decision.reason;
  await writeJson(env, "alive_state", nextState);

  aliveWorker.scheduled(event, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const response = await aliveWorker.fetch(request, env, ctx);
      const data = await response.json().catch(() => null);
      if (data && typeof data === "object") {
        data.intention_gate = true;
        data.intention_wrapper = WRAPPER;
        data.intention_policy = "cron checks silently; Telegram message only when important";
        data.intention_reasons = ["first run", "important task", "identity seed missing", "long silence"];
      }
      return json(data, response.status);
    }

    if (url.pathname === "/alive-state") {
      const state = await readJson(env, "alive_state", {});
      return json({ ok: true, wrapper: WRAPPER, state });
    }

    return await aliveWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(intentionTick(event, env, ctx));
  }
};
