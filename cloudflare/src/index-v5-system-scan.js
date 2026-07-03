import baseWorker from "./index-v4.js";

const VERSION = "v5.2.0-system-scan-wrapper-2026-07-03";
const H = { "content-type": "application/json; charset=utf-8" };
const NEW_COMMANDS = ["/core_status", "/system_scan", "/core_next"];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: H });
}
function clip(v, n = 3900) { return String(v ?? "").slice(0, n); }
function msg(update) { return update?.message || update?.edited_message || null; }
function commandOf(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) return null;
  const first = raw.split(/\s+/, 1)[0].replace(/@\w+$/, "").toLowerCase();
  return first;
}
async function kvText(env, key) { return String(await env.MINISKYNET_KV.get(key) || "").trim(); }
async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}
async function arr(env, key) {
  const v = await kvGet(env, key, { [key]: [] });
  return Array.isArray(v?.[key]) ? v[key] : [];
}
async function cfg(env) {
  return {
    telegram: String(env.TELEGRAM_BOT_TOKEN || "").trim() || await kvText(env, "config:TELEGRAM_BOT_TOKEN"),
    openrouter: String(env.OPENROUTER_API_KEY || "").trim() || await kvText(env, "config:OPENROUTER_API_KEY"),
    gh: String(env.GITHUB_TOKEN || "").trim() || await kvText(env, "config:GITHUB_TOKEN"),
    model: String(env.OPENROUTER_MODEL_CHEAP || "").trim() || await kvText(env, "config:OPENROUTER_MODEL_CHEAP") || "openai/gpt-4o-mini"
  };
}
async function send(c, chatId, text) {
  if (!c.telegram || !chatId) return;
  await fetch(`https://api.telegram.org/bot${c.telegram}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: clip(text) })
  }).catch(() => null);
}
function activeTasks(tasks) {
  return tasks.filter(t => t?.status !== "done" && t?.status !== "archived").length;
}
function verifiedProps(props) {
  return props.filter(p => p?.state === "verified" || p?.verify?.ok === true).length;
}
function pendingVerify(props) {
  return props.slice().reverse().find(p => p?.state === "applied" && p?.verify?.ok !== true);
}
async function snapshot(env) {
  return {
    self: await kvGet(env, "self", { text: "—" }),
    goals: await kvGet(env, "goals", { goals: [] }),
    plan: await kvGet(env, "plan", { steps: [] }),
    tasks: await arr(env, "tasks"),
    mem: await arr(env, "memories"),
    props: await arr(env, "proposals")
  };
}
function score(s, c) {
  let x = 2.0;
  if (c.openrouter) x += 1.0;
  if (c.gh) x += 1.0;
  if (s.mem.length) x += 0.5;
  if (s.goals.goals?.length) x += 0.5;
  if (s.plan.steps?.length) x += 0.5;
  if (s.props.length) x += 0.7;
  if (verifiedProps(s.props)) x += 0.8;
  return Math.min(10, Number(x.toFixed(1)));
}
async function coreStatus(env, c) {
  const s = await snapshot(env);
  const p = pendingVerify(s.props);
  return [
    "🧠 Core Status v5-native",
    `Version: ${VERSION}`,
    `Base: index-v4 clean core`,
    `Level: ${score(s, c)}/10`,
    `Think/dialog: ${c.openrouter ? "active ✅" : "no key ⛔"}`,
    `GitHub token: ${c.gh ? "connected ✅" : "missing ⛔"}`,
    `Memory: ${s.mem.length}`,
    `Tasks: total ${s.tasks.length}, active ${activeTasks(s.tasks)}`,
    `Goals: ${s.goals.goals?.length || 0}`,
    `Plan steps: ${s.plan.steps?.length || 0}`,
    `Proposals: ${s.props.length}, verified ${verifiedProps(s.props)}`,
    `Pending verify: ${p ? p.id : "none"}`,
    `Next: ${p ? `/post_apply_verify ${p.id}` : "/system_scan"}`
  ].join("\n");
}
async function systemScan(env, c) {
  const s = await snapshot(env);
  const p = pendingVerify(s.props);
  const gaps = [];
  if (!c.openrouter) gaps.push("think/dialog без ключа");
  if (!c.gh) gaps.push("GitHub token не подключён");
  if (p) gaps.push(`proposal ${p.id} применён, но не закрыт verify`);
  if (verifiedProps(s.props) < 1) gaps.push("нет подтверждённого post-apply PASS");
  gaps.push("Verify/Rollback v1 ещё не встроен в clean v5");
  gaps.push("Alive Planner ещё не ведёт цикл сам");
  gaps.push("Unified Memory ещё плоская");
  return [
    "🔎 System Scan v5-native",
    `Version: ${VERSION}`,
    "Работает:",
    "- clean base core: yes",
    `- live dialog: ${c.openrouter ? "yes" : "no"}`,
    "- memory/goals/tasks: yes",
    "- proposal FSM: yes",
    `- confirmed GitHub write: ${s.props.some(x => x.apply_result?.commit_sha) ? "yes" : "not seen in KV"}`,
    `- post-apply verify: ${verifiedProps(s.props) > 0 ? "yes" : "not yet"}`,
    "",
    "Слабые места:",
    ...gaps.map(x => "- " + x),
    "",
    "Следующий шаг:",
    p ? `/post_apply_verify ${p.id}` : "готовить Verify/Rollback v1 как следующий маленький слой"
  ].join("\n");
}
async function coreNext(env) {
  const s = await snapshot(env);
  const p = pendingVerify(s.props);
  if (p) return [
    "Core Next:",
    `1. Закрыть проверку proposal: /post_apply_verify ${p.id}`,
    "2. После PASS — подождать deploy и проверить /core_status",
    "3. Потом делать Verify/Rollback v1"
  ].join("\n");
  return [
    "Core Next:",
    "1. Verify/Rollback v1",
    "Goal: сохранить safe entry, проверить новый entry, уметь вернуть прошлый рабочий слой",
    "Risk: medium",
    "Rule: только через approve Сергея"
  ].join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.system_scan_wrapper = VERSION;
        d.commands = [...new Set([...(d.commands || []), ...NEW_COMMANDS])];
      }
      return json(d || { ok: true, system_scan_wrapper: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const m = msg(update);
      const cmd = commandOf(m?.text);
      if (m && NEW_COMMANDS.includes(cmd)) {
        const c = await cfg(env);
        if (cmd === "/core_status") await send(c, m.chat.id, await coreStatus(env, c));
        if (cmd === "/system_scan") await send(c, m.chat.id, await systemScan(env, c));
        if (cmd === "/core_next") await send(c, m.chat.id, await coreNext(env));
        return json({ ok: true, handled_by: VERSION, command: cmd });
      }
    }

    return await baseWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
