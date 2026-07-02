import baseWorker from "./worker-github-commit.js";

const VERSION = "proof-stage-v1";
const TARGET_PATH = "cloudflare/skynet_controlled_state.json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN"]) {
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

function event(type, text, extra = {}) {
  return { time: new Date().toISOString(), type, status: "done", text, ...extra };
}

async function tokenReady(env) {
  await hydrate(env);
  return Boolean(env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).length > 20);
}

function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(s) {
  const bin = atob(String(s || ""));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function gh(env, method, path, body) {
  await hydrate(env);
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "MiniSkynet-Core"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function readState(env, repo, branch) {
  const path = `/repos/${repo}/contents/${encodeURIComponent(TARGET_PATH).replaceAll("%2F", "/")}?ref=${encodeURIComponent(branch)}`;
  const r = await gh(env, "GET", path);
  if (r.status === 404) return { sha: null, items: [] };
  if (!r.ok) throw new Error(`Read failed: ${r.status}`);
  let items = [];
  try { items = JSON.parse(base64ToUtf8(r.data.content || "")); } catch (_) { items = []; }
  if (!Array.isArray(items)) items = [];
  return { sha: r.data.sha, items };
}

async function putState(env, repo, branch, sha, items, message) {
  const path = `/repos/${repo}/contents/${encodeURIComponent(TARGET_PATH).replaceAll("%2F", "/")}`;
  const body = { message, content: utf8ToBase64(JSON.stringify(items.slice(-50), null, 2) + "\n"), branch };
  if (sha) body.sha = sha;
  return await gh(env, "PUT", path, body);
}

async function proofStatus(env, chatId) {
  const hasToken = await tokenReady(env);
  const prep = await kvGet(env, "github_prepare", null);
  const last = await kvGet(env, "proof_stage_last", null);
  await send(env, chatId, [
    "Proof Stage Status:",
    `Token: ${hasToken ? "connected" : "not_connected"}`,
    `Prepare: ${prep ? prep.status : "missing"}`,
    `Target: ${TARGET_PATH}`,
    last ? `Last status: ${last.status}` : "Last status: none",
    last ? `Last sha: ${last.result_sha}` : "Last sha: none",
    `Следующий шаг: ${hasToken && prep ? "/proof_write" : "/github_prepare"}`
  ].join("\n"));
}

async function proofWrite(env, chatId) {
  const hasToken = await tokenReady(env);
  if (!hasToken) {
    await send(env, chatId, "Proof Write: token not_connected. Проверь /github_writer_status.");
    return;
  }
  const prep = await kvGet(env, "github_prepare", null);
  if (!prep || !prep.repo || !prep.file) {
    await send(env, chatId, "Proof Write: github_prepare не готов. Команда: /github_prepare затем /proof_write");
    return;
  }
  const branch = prep.branch || "main";
  const state = await readState(env, prep.repo, branch);
  const item = {
    time: new Date().toISOString(),
    version: VERSION,
    mission_id: prep.mission_id,
    planned_file: prep.file,
    target: prep.target,
    requested_effect: prep.requested_effect,
    check: prep.check,
    risk_level: prep.risk_level,
    note: "controlled repository state proof"
  };
  const wr = await putState(env, prep.repo, branch, state.sha, [...state.items, item], `MiniSkynet proof stage: ${String(prep.target || "state").slice(0, 80)}`);
  if (!wr.ok) {
    await kvPut(env, "proof_stage_last", { version: VERSION, status: "failed", http_status: wr.status, error: wr.data, updated_at: new Date().toISOString() });
    await send(env, chatId, `Proof Write failed: HTTP ${wr.status}.`);
    return;
  }
  const resultSha = wr.data?.commit?.sha || "unknown";
  const result = { version: VERSION, status: "done", path: TARGET_PATH, result_sha: resultSha, updated_at: new Date().toISOString() };
  await kvPut(env, "proof_stage_last", result);
  const m = await kvGet(env, "active_mission", null);
  if (m?.id === prep.mission_id) {
    const updated = { ...m, status: "proof_stage_done", current_step: "proof_stage_done", next_command: "/mission_log", updated_at: new Date().toISOString(), events: [...(m.events || []), event("proof_stage_done", `Controlled repository state записан: ${resultSha}. Файл: ${TARGET_PATH}`)] };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }
  await send(env, chatId, [
    "Proof Write готов.",
    "✅ Controlled repository state записан.",
    `Файл: ${TARGET_PATH}`,
    `Sha: ${resultSha}`,
    "Следующий слой: active file step."
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.proof_stage_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/proof_status", "/proof_write"])]
      }
      return json(d || { ok: true, proof_stage_layer: VERSION }, r.status);
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();
      if (m && (low === "/proof_status" || low === "proof status")) {
        await proofStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, proof_status: true });
      }
      if (m && (low === "/proof_write" || low === "proof write")) {
        await proofWrite(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, proof_write: true });
      }
    }
    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
