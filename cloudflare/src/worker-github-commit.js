import readyWorker from "./worker-github-ready.js";

const VERSION = "github-commit-v1-safe-log";
const LOG_PATH = "cloudflare/skynet_writer_log.json";

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

async function readLogFile(env, repo, branch) {
  const path = `/repos/${repo}/contents/${encodeURIComponent(LOG_PATH).replaceAll("%2F", "/")}?ref=${encodeURIComponent(branch)}`;
  const r = await gh(env, "GET", path);
  if (r.status === 404) return { sha: null, entries: [] };
  if (!r.ok) throw new Error(`GitHub read failed: ${r.status}`);
  const raw = base64ToUtf8(r.data.content || "");
  let entries = [];
  try { entries = JSON.parse(raw); } catch (_) { entries = []; }
  if (!Array.isArray(entries)) entries = [];
  return { sha: r.data.sha, entries };
}

async function writeLogFile(env, repo, branch, sha, entries, message) {
  const path = `/repos/${repo}/contents/${encodeURIComponent(LOG_PATH).replaceAll("%2F", "/")}`;
  const body = {
    message,
    content: utf8ToBase64(JSON.stringify(entries.slice(-50), null, 2) + "\n"),
    branch
  };
  if (sha) body.sha = sha;
  return await gh(env, "PUT", path, body);
}

async function commitStatus(env, chatId) {
  const hasToken = await tokenReady(env);
  const prep = await kvGet(env, "github_prepare", null);
  await send(env, chatId, [
    "GitHub Commit Status:",
    `Token: ${hasToken ? "connected" : "not_connected"}`,
    `Prepare: ${prep ? prep.status : "missing"}`,
    prep ? `Repo: ${prep.repo}` : "Repo: ?",
    prep ? `Branch: ${prep.branch}` : "Branch: ?",
    `Safe write target: ${LOG_PATH}`,
    "Первый commit пишет только журнал writer-а, не меняет рабочий код.",
    `Следующий шаг: ${hasToken && prep ? "/github_commit" : "/github_prepare"}`
  ].join("\n"));
}

async function githubCommit(env, chatId) {
  const hasToken = await tokenReady(env);
  if (!hasToken) {
    await send(env, chatId, "GitHub Commit: token not_connected. Добавь config:GITHUB_TOKEN в KV, потом /github_commit_status.");
    return;
  }

  const prep = await kvGet(env, "github_prepare", null);
  if (!prep || !prep.repo || !prep.file) {
    await send(env, chatId, "GitHub Commit: github_prepare не готов. Команда: /github_prepare затем /github_commit");
    return;
  }

  const branch = prep.branch || "main";
  const log = await readLogFile(env, prep.repo, branch);
  const entry = {
    time: new Date().toISOString(),
    version: VERSION,
    mission_id: prep.mission_id,
    repo: prep.repo,
    branch,
    planned_file: prep.file,
    target: prep.target,
    requested_effect: prep.requested_effect,
    check: prep.check,
    risk_level: prep.risk_level,
    note: "safe writer proof: this commit only updates skynet_writer_log.json"
  };
  const entries = [...log.entries, entry];
  const msg = `MiniSkynet writer log: ${String(prep.target || "repo step").slice(0, 80)}`;
  const wr = await writeLogFile(env, prep.repo, branch, log.sha, entries, msg);

  if (!wr.ok) {
    await kvPut(env, "github_commit_last", { version: VERSION, status: "failed", http_status: wr.status, error: wr.data, updated_at: new Date().toISOString() });
    await send(env, chatId, `GitHub Commit failed: HTTP ${wr.status}. Секрет не показываю.`);
    return;
  }

  const commitSha = wr.data?.commit?.sha || "unknown";
  const result = {
    version: VERSION,
    status: "committed_safe_log",
    repo: prep.repo,
    branch,
    path: LOG_PATH,
    commit_sha: commitSha,
    planned_file: prep.file,
    created_at: new Date().toISOString()
  };
  await kvPut(env, "github_commit_last", result);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id === prep.mission_id) {
    const updated = {
      ...m,
      status: "safe_writer_committed",
      current_step: "safe_writer_committed",
      next_command: "/mission_log",
      updated_at: new Date().toISOString(),
      events: [...(m.events || []), event("github_safe_commit", `GitHub safe writer commit создан: ${commitSha}. Файл: ${LOG_PATH}`)]
    };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }

  await send(env, chatId, [
    "GitHub Commit готов.",
    "✅ Safe writer commit создан.",
    `Repo: ${prep.repo}`,
    `Branch: ${branch}`,
    `Файл: ${LOG_PATH}`,
    `Commit: ${commitSha}`,
    "Рабочий код пока не менялся.",
    "Следующий слой: controlled code edit."
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await readyWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.github_commit_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/github_commit_status", "/github_commit"])]
      }
      return json(d || { ok: true, github_commit_layer: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const low = String(m?.text || "").trim().toLowerCase();

      if (m && (low === "/github_commit_status" || low === "github commit status" || low === "статус github commit")) {
        await commitStatus(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, github_commit_status: true });
      }
      if (m && (low === "/github_commit" || low === "github commit" || low === "сделай github commit")) {
        await githubCommit(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, github_commit: true });
      }
    }

    return await readyWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await readyWorker.scheduled(event, env, ctx);
  }
};
