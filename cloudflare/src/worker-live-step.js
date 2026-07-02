import baseWorker from "./worker-level-sync.js";

const VERSION = "live-step-v1-version-chain";
const REPO = "sromanuk16-lab/miniskynet-core";
const BRANCH = "main";
const NEW_LAYER_PATH = "cloudflare/src/worker-version-chain.js";
const ENTRY_PATH = "cloudflare/src/worker-current.js";

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

async function fileSha(env, repo, branch, path) {
  const apiPath = `/repos/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}?ref=${encodeURIComponent(branch)}`;
  const r = await gh(env, "GET", apiPath);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`read failed ${r.status}`);
  return r.data.sha || null;
}

async function putFile(env, repo, branch, path, content, message) {
  const sha = await fileSha(env, repo, branch, path);
  const apiPath = `/repos/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`;
  const body = { message, content: utf8ToBase64(content), branch };
  if (sha) body.sha = sha;
  return await gh(env, "PUT", apiPath, body);
}

function versionLayerContent() {
  return `import baseWorker from "./worker-level-sync.js";\n\nconst VERSION = "version-chain-v1";\n\nfunction json(data, status = 200) {\n  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });\n}\n\nasync function hydrate(env) {\n  if (!env.MINISKYNET_KV) return;\n  if (!env.TELEGRAM_BOT_TOKEN) {\n    const v = await env.MINISKYNET_KV.get("config:TELEGRAM_BOT_TOKEN");\n    if (v) env.TELEGRAM_BOT_TOKEN = String(v).trim();\n  }\n}\n\nasync function send(env, chatId, text) {\n  await hydrate(env);\n  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;\n  await fetch(\`https://api.telegram.org/bot\${env.TELEGRAM_BOT_TOKEN}/sendMessage\`, {\n    method: "POST",\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })\n  }).catch(() => null);\n}\n\nfunction getMsg(update) { return update?.message || update?.edited_message || null; }\n\nfunction chainText() {\n  return [\n    "MiniSkynet Version Chain:",\n    "core → selfcheck → memory hygiene → agents → codemap → inspector",\n    "→ queue mission → file operation → repo operation",\n    "→ github ready → github commit → proof stage → level sync → version chain",\n    "",\n    "Status: active proof command works.",\n    "Version: " + VERSION\n  ].join("\\n");\n}\n\nexport default {\n  async fetch(request, env, ctx) {\n    const url = new URL(request.url);\n    if (url.pathname === "/") {\n      const r = await baseWorker.fetch(request, env, ctx);\n      const d = await r.json().catch(() => null);\n      if (d && typeof d === "object") {\n        d.version_chain_layer = VERSION;\n        d.commands = [...new Set([...(d.commands || []), "/version_chain"])]\n      }\n      return json(d || { ok: true, version_chain_layer: VERSION }, r.status);\n    }\n    if (url.pathname === "/telegram" && request.method === "POST") {\n      const u = await request.clone().json().catch(() => null);\n      const m = getMsg(u);\n      const text = String(m?.text || "").trim().toLowerCase();\n      if (m && (text === "/version_chain" || text === "version chain" || text === "цепочка версий")) {\n        await send(env, m.chat.id, chainText());\n        return json({ ok: true, handled_by: VERSION, version_chain: true });\n      }\n    }\n    return await baseWorker.fetch(request, env, ctx);\n  },\n  async scheduled(event, env, ctx) {\n    return await baseWorker.scheduled(event, env, ctx);\n  }\n};\n`;
}

function entryContent(importPath) {
  return `import appWorker from "${importPath}";\n\nexport default {\n  async fetch(request, env, ctx) {\n    return await appWorker.fetch(request, env, ctx);\n  },\n  async scheduled(event, env, ctx) {\n    return await appWorker.scheduled(event, env, ctx);\n  }\n};\n`;
}

async function status(env, chatId) {
  const hasToken = await tokenReady(env);
  const last = await kvGet(env, "live_step_last", null);
  await send(env, chatId, [
    "Live Step Status:",
    `Token: ${hasToken ? "connected" : "not_connected"}`,
    `New layer: ${NEW_LAYER_PATH}`,
    `Entry: ${ENTRY_PATH}`,
    last ? `Last status: ${last.status}` : "Last status: none",
    last ? `Last commit: ${last.commit_sha}` : "Last commit: none",
    `Следующий шаг: ${hasToken ? "/live_step_write" : "/github_writer_status"}`
  ].join("\n"));
}

async function writeLayer(env, chatId) {
  if (!(await tokenReady(env))) {
    await send(env, chatId, "Live Step Write: token not_connected.");
    return;
  }
  const wr = await putFile(env, REPO, BRANCH, NEW_LAYER_PATH, versionLayerContent(), "MiniSkynet live step: add version chain layer");
  if (!wr.ok) {
    await kvPut(env, "live_step_last", { status: "write_failed", http_status: wr.status, error: wr.data, updated_at: new Date().toISOString() });
    await send(env, chatId, `Live Step Write failed: HTTP ${wr.status}`);
    return;
  }
  const commitSha = wr.data?.commit?.sha || "unknown";
  const result = { version: VERSION, status: "layer_written", path: NEW_LAYER_PATH, commit_sha: commitSha, updated_at: new Date().toISOString() };
  await kvPut(env, "live_step_last", result);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id) {
    const updated = { ...m, status: "live_layer_written", current_step: "live_layer_written", next_command: "/live_step_switch", updated_at: new Date().toISOString(), events: [...(m.events || []), event("live_layer_written", `Version chain layer создан самим Worker: ${commitSha}. Файл: ${NEW_LAYER_PATH}`)] };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }

  await send(env, chatId, [
    "Live Step Write готов.",
    "✅ Новый рабочий слой создан самим Worker.",
    `Файл: ${NEW_LAYER_PATH}`,
    `Commit: ${commitSha}`,
    "Следующий шаг: /live_step_switch"
  ].join("\n"));
}

async function switchLayer(env, chatId) {
  if (!(await tokenReady(env))) {
    await send(env, chatId, "Live Step Switch: token not_connected.");
    return;
  }
  const last = await kvGet(env, "live_step_last", null);
  if (!last || last.status !== "layer_written") {
    await send(env, chatId, "Live Step Switch: сначала /live_step_write.");
    return;
  }
  const wr = await putFile(env, REPO, BRANCH, ENTRY_PATH, entryContent("./worker-version-chain.js"), "MiniSkynet live step: switch to version chain layer");
  if (!wr.ok) {
    await kvPut(env, "live_step_last", { ...last, status: "switch_failed", http_status: wr.status, error: wr.data, updated_at: new Date().toISOString() });
    await send(env, chatId, `Live Step Switch failed: HTTP ${wr.status}`);
    return;
  }
  const commitSha = wr.data?.commit?.sha || "unknown";
  const result = { ...last, status: "switched", entry: ENTRY_PATH, switch_commit_sha: commitSha, updated_at: new Date().toISOString() };
  await kvPut(env, "live_step_last", result);

  const m = await kvGet(env, "active_mission", null);
  if (m?.id) {
    const updated = { ...m, status: "live_layer_switched", current_step: "live_layer_switched", next_command: "/version_chain", updated_at: new Date().toISOString(), events: [...(m.events || []), event("live_layer_switched", `Worker entry переключён на version chain layer: ${commitSha}. Проверка: /version_chain`)] };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }

  await send(env, chatId, [
    "Live Step Switch готов.",
    "✅ Entry переключён на новый слой.",
    `Commit: ${commitSha}`,
    "Жди деплой, затем проверь: /version_chain"
  ].join("\n"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      const r = await baseWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.live_step_layer = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/live_step_status", "/live_step_write", "/live_step_switch"])]
      }
      return json(d || { ok: true, live_step_layer: VERSION }, r.status);
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();
      if (m && (text === "/live_step_status" || text === "live step status")) {
        await status(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, live_step_status: true });
      }
      if (m && (text === "/live_step_write" || text === "live step write")) {
        await writeLayer(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, live_step_write: true });
      }
      if (m && (text === "/live_step_switch" || text === "live step switch")) {
        await switchLayer(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, live_step_switch: true });
      }
    }
    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return await baseWorker.scheduled(event, env, ctx);
  }
};
