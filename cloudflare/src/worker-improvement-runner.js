import baseWorker from "./worker-dialog-confirm.js";

const VERSION = "improvement-runner-v1-universal-gated";
const REPO_DEFAULT = "sromanuk16-lab/miniskynet-core";
const BRANCH_DEFAULT = "main";
const ENTRY_PATH = "cloudflare/src/worker-current.js";
const MAX_FILES_PER_PATCH = 5;
const MAX_FILE_CHARS = 120000;

const DEFAULT_ALLOWED_PREFIXES = [
  "cloudflare/src/",
  "cloudflare/docs/",
  "cloudflare/tests/",
  "docs/"
];

const DEFAULT_ALLOWED_EXACT = [
  "cloudflare/wrangler.toml",
  "README.md"
];

const BLOCKED_PATH_PARTS = [
  ".env",
  "secrets",
  "secret",
  "token",
  "password",
  "private_key",
  "id_rsa",
  ".ssh",
  ".git/"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function now() { return new Date().toISOString(); }
function getMsg(update) { return update?.message || update?.edited_message || null; }
function event(type, text, extra = {}) { return { time: now(), type, status: "done", text, ...extra }; }

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "TELEGRAM_ALLOWED_USER_ID"]) {
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
async function kvPut(env, key, value) { await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2)); }
async function kvDelete(env, key) { await env.MINISKYNET_KV.delete(key).catch(() => null); }

function allowedUser(env, userId) {
  const owner = String(env.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}
function yesText(text) { return /^(да|yes|y|ок|окей|подтверждаю|запускай|делай)$/i.test(String(text || "").trim()); }
function noText(text) { return /^(нет|no|n|не надо|отмена|cancel|стоп)$/i.test(String(text || "").trim()); }

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
async function tokenReady(env) {
  await hydrate(env);
  return Boolean(env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).length > 20);
}

function cleanPath(p) { return String(p || "").replaceAll("\\", "/").replace(/^\/+/, "").trim(); }
function pathAllowed(path, allow = {}) {
  const p = cleanPath(path);
  if (!p || p.includes("..") || p.startsWith("/")) return false;
  const low = p.toLowerCase();
  if (BLOCKED_PATH_PARTS.some(x => low.includes(x))) return false;
  const exact = Array.isArray(allow.exact) ? allow.exact : DEFAULT_ALLOWED_EXACT;
  const prefixes = Array.isArray(allow.prefixes) ? allow.prefixes : DEFAULT_ALLOWED_PREFIXES;
  if (exact.includes(p)) return true;
  if (prefixes.some(prefix => p.startsWith(prefix))) return true;
  return false;
}
function looksLikeSecretContent(content) {
  const s = String(content || "");
  const patterns = [
    /ghp_[A-Za-z0-9_]{30,}/,
    /github_pat_[A-Za-z0-9_]{30,}/,
    /sk-[A-Za-z0-9_-]{30,}/,
    /bot\d+:[A-Za-z0-9_-]{25,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /Bearer\s+[A-Za-z0-9._-]{40,}/,
    /(password|пароль)\s*[:=]\s*["'][^"']{8,}["']/i,
    /(token|secret)\s*[:=]\s*["'][A-Za-z0-9._:-]{20,}["']/i
  ];
  return patterns.some(re => re.test(s));
}

function importPathForWorker(path) {
  const p = cleanPath(path);
  if (!p.startsWith("cloudflare/src/")) return null;
  if (!p.endsWith(".js")) return null;
  const file = p.slice("cloudflare/src/".length);
  if (!file || file.includes("/") || file.includes("..")) return null;
  return "./" + file;
}
function entryContent(importPath) {
  return `import appWorker from "${importPath}";\n\nexport default {\n  async fetch(request, env, ctx) {\n    return await appWorker.fetch(request, env, ctx);\n  },\n  async scheduled(event, env, ctx) {\n    return await appWorker.scheduled(event, env, ctx);\n  }\n};\n`;
}

async function fileInfo(env, repo, branch, path) {
  const apiPath = `/repos/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}?ref=${encodeURIComponent(branch)}`;
  const r = await gh(env, "GET", apiPath);
  if (r.status === 404) return { exists: false, sha: null, content: "" };
  if (!r.ok) throw new Error(`GitHub read failed ${r.status}`);
  return { exists: true, sha: r.data.sha || null, content: base64ToUtf8(r.data.content || "") };
}
async function putFile(env, repo, branch, path, content, message) {
  const info = await fileInfo(env, repo, branch, path);
  const apiPath = `/repos/${repo}/contents/${encodeURIComponent(path).replaceAll("%2F", "/")}`;
  const body = { message, content: utf8ToBase64(content), branch };
  if (info.sha) body.sha = info.sha;
  return await gh(env, "PUT", apiPath, body);
}

function validatePatch(patch) {
  const errors = [];
  const files = Array.isArray(patch?.files) ? patch.files : [];
  const allow = patch?.allow || {};
  if (!files.length) errors.push("files[] пустой");
  if (files.length > MAX_FILES_PER_PATCH) errors.push(`слишком много файлов: max ${MAX_FILES_PER_PATCH}`);
  for (const f of files) {
    const path = cleanPath(f.path);
    const action = String(f.action || "upsert").trim();
    const content = String(f.content || "");
    if (!["upsert"].includes(action)) errors.push(`action запрещён: ${action}`);
    if (!pathAllowed(path, allow)) errors.push(`path вне allowlist: ${path}`);
    if (content.length > MAX_FILE_CHARS) errors.push(`слишком большой файл: ${path}`);
    if (looksLikeSecretContent(content)) {
      errors.push(`похоже на реальный секрет в content: ${path}`);
    }
  }
  if (patch?.switch_entry === true) {
    const target = cleanPath(patch.switch_to || "");
    const importPath = importPathForWorker(target);
    if (!importPath) errors.push(`switch_to должен быть одиночным JS-файлом в cloudflare/src/: ${target}`);
    if (!files.some(f => cleanPath(f.path) === target)) errors.push("switch_to должен быть среди files[] этого patch");
  }
  return errors;
}

function patchSummary(p) {
  const files = (p.files || []).map((f, i) => {
    const path = cleanPath(f.path);
    const lines = String(f.content || "").split("\n").length;
    return `${i + 1}. ${f.action || "upsert"} ${path} (${lines} lines)`;
  }).join("\n");
  return [
    "Improvement Patch:",
    `ID: ${p.id || "none"}`,
    `Status: ${p.status || "unknown"}`,
    `Title: ${p.title || "не указано"}`,
    `Goal: ${p.goal || "не указана"}`,
    `Risk: ${p.risk || "unknown"}`,
    `Repo: ${p.repo || REPO_DEFAULT}`,
    `Branch: ${p.branch || BRANCH_DEFAULT}`,
    "",
    "Files:",
    files || "none",
    "",
    p.switch_entry ? `Switch entry: ${ENTRY_PATH} → ${p.switch_to}` : "Switch entry: no",
    `Check: ${p.check_command || "none"}`,
    "",
    p.status === "pending" ? "Подтвердить: /improve_yes или просто да" : "Pending-patch нет."
  ].join("\n");
}

function defaultProofLayerContent() {
  return `import baseWorker from "./worker-dialog-confirm.js";\n\nconst VERSION = "universal-proof-layer-v1";\nconst CREATED_AT = "${now()}";\n\nfunction json(data, status = 200) {\n  return new Response(JSON.stringify(data, null, 2), {\n    status,\n    headers: { "content-type": "application/json; charset=utf-8" }\n  });\n}\n\nasync function hydrate(env) {\n  if (!env.MINISKYNET_KV) return;\n  if (!env.TELEGRAM_BOT_TOKEN) {\n    const v = await env.MINISKYNET_KV.get("config:TELEGRAM_BOT_TOKEN");\n    if (v) env.TELEGRAM_BOT_TOKEN = String(v).trim();\n  }\n}\n\nasync function send(env, chatId, text) {\n  await hydrate(env);\n  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;\n  await fetch(\`https://api.telegram.org/bot\${env.TELEGRAM_BOT_TOKEN}/sendMessage\`, {\n    method: "POST",\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })\n  }).catch(() => null);\n}\n\nfunction getMsg(update) { return update?.message || update?.edited_message || null; }\n\nexport default {\n  async fetch(request, env, ctx) {\n    const url = new URL(request.url);\n    if (url.pathname === "/") {\n      const r = await baseWorker.fetch(request, env, ctx);\n      const d = await r.json().catch(() => null);\n      if (d && typeof d === "object") {\n        d.universal_proof_layer = VERSION;\n        d.commands = [...new Set([...(d.commands || []), "/universal_proof")] ];\n      }\n      return json(d || { ok: true, universal_proof_layer: VERSION }, r.status);\n    }\n    if (url.pathname === "/telegram" && request.method === "POST") {\n      const u = await request.clone().json().catch(() => null);\n      const m = getMsg(u);\n      const low = String(m?.text || "").trim().toLowerCase();\n      if (m && (low === "/universal_proof" || low === "universal proof")) {\n        await send(env, m.chat.id, [\n          "Universal Proof:",\n          "✅ Improvement Runner применил patch после approve.",\n          "Layer: " + VERSION,\n          "Created: " + CREATED_AT\n        ].join("\\n"));\n        return json({ ok: true, handled_by: VERSION, universal_proof: true });\n      }\n    }\n    return await baseWorker.fetch(request, env, ctx);\n  },\n  async scheduled(event, env, ctx) { return await baseWorker.scheduled(event, env, ctx); }\n};\n`;
}

async function saveDefaultProofPatch(env, chatId) {
  const patch = {
    id: "patch_" + Date.now(),
    version: VERSION,
    status: "pending",
    title: "Universal Proof Layer",
    goal: "проверить универсальный контур patch → approve → GitHub write → entry switch → proof command",
    risk: "medium",
    repo: REPO_DEFAULT,
    branch: BRANCH_DEFAULT,
    files: [{ action: "upsert", path: "cloudflare/src/worker-universal-proof.js", content: defaultProofLayerContent() }],
    switch_entry: true,
    switch_to: "cloudflare/src/worker-universal-proof.js",
    check_command: "/universal_proof",
    allow: { prefixes: DEFAULT_ALLOWED_PREFIXES, exact: DEFAULT_ALLOWED_EXACT },
    created_at: now()
  };
  await kvPut(env, "improvement_patch", patch);
  await send(env, chatId, patchSummary(patch));
}

async function showStatus(env, chatId) {
  const hasToken = await tokenReady(env);
  const p = await kvGet(env, "improvement_patch", null);
  const last = await kvGet(env, "improvement_runner_last", null);
  await send(env, chatId, [
    "Improvement Runner Status:",
    `Version: ${VERSION}`,
    `Token: ${hasToken ? "connected" : "not_connected"}`,
    `Patch: ${p?.status || "none"}`,
    p?.title ? `Title: ${p.title}` : "Title: none",
    p?.check_command ? `Check: ${p.check_command}` : "Check: none",
    last ? `Last: ${last.status}` : "Last: none",
    last?.commits ? `Commits: ${last.commits.map(x => x.commit_sha || "unknown").join(", ")}` : "Commits: none",
    "Commands: /improve_status /improve_prepare /improve_review /improve_yes /improve_no /improve_clear"
  ].join("\n"));
}

async function showReview(env, chatId) {
  const p = await kvGet(env, "improvement_patch", null);
  if (!p) { await send(env, chatId, "Improvement Review: patch пустой. Команда: /improve_prepare"); return; }
  const errors = validatePatch(p);
  const text = errors.length ? `${patchSummary(p)}\n\nValidation errors:\n- ${errors.join("\n- ")}` : `${patchSummary(p)}\n\nValidation: OK`;
  await send(env, chatId, text);
}

async function reject(env, chatId) {
  const p = await kvGet(env, "improvement_patch", null);
  if (!p || p.status !== "pending") { await send(env, chatId, "Improve No: pending patch нет."); return; }
  await kvPut(env, "improvement_patch", { ...p, status: "rejected", rejected_at: now() });
  await send(env, chatId, "Improve No готово. Patch отклонён.");
}
async function clearPatch(env, chatId) { await kvDelete(env, "improvement_patch"); await send(env, chatId, "Improvement patch очищен."); }

async function accept(env, chatId) {
  const p = await kvGet(env, "improvement_patch", null);
  if (!p || p.status !== "pending") { await send(env, chatId, "Improve Yes: pending patch нет. Сначала /improve_prepare или запиши improvement_patch в KV."); return; }
  if (!(await tokenReady(env))) { await send(env, chatId, "Improve Yes: GITHUB_TOKEN не подключён."); return; }
  const errors = validatePatch(p);
  if (errors.length) {
    const blocked = { ...p, status: "blocked", blocked_at: now(), errors };
    await kvPut(env, "improvement_patch", blocked);
    await kvPut(env, "improvement_runner_last", blocked);
    await send(env, chatId, "Improve Yes заблокирован:\n- " + errors.join("\n- "));
    return;
  }
  const repo = p.repo || REPO_DEFAULT;
  const branch = p.branch || BRANCH_DEFAULT;
  const commits = [];
  for (const f of p.files) {
    const path = cleanPath(f.path);
    const message = String(f.message || `Apply improvement: ${path}`).slice(0, 120);
    const wr = await putFile(env, repo, branch, path, String(f.content || ""), message);
    if (!wr.ok) {
      const fail = { ...p, status: "write_failed", failed_path: path, http_status: wr.status, error: wr.data, commits, updated_at: now() };
      await kvPut(env, "improvement_patch", fail);
      await kvPut(env, "improvement_runner_last", fail);
      await send(env, chatId, `Improve Yes: запись не удалась: ${path}. HTTP ${wr.status}`);
      return;
    }
    commits.push({ path, commit_sha: wr.data?.commit?.sha || "unknown" });
  }
  if (p.switch_entry === true) {
    const importPath = importPathForWorker(p.switch_to);
    const wr = await putFile(env, repo, branch, ENTRY_PATH, entryContent(importPath), `Switch entry to ${importPath}`);
    if (!wr.ok) {
      const partial = { ...p, status: "files_written_switch_failed", http_status: wr.status, error: wr.data, commits, updated_at: now() };
      await kvPut(env, "improvement_patch", partial);
      await kvPut(env, "improvement_runner_last", partial);
      await send(env, chatId, `Файлы записаны, но switch не прошёл. HTTP ${wr.status}`);
      return;
    }
    commits.push({ path: ENTRY_PATH, commit_sha: wr.data?.commit?.sha || "unknown" });
  }
  const done = { ...p, status: "applied", applied_at: now(), commits };
  await kvPut(env, "improvement_patch", done);
  await kvPut(env, "improvement_runner_last", done);
  const m = await kvGet(env, "active_mission", null);
  if (m?.id) {
    const updated = {
      ...m,
      status: "improvement_patch_applied",
      current_step: "improvement_patch_applied",
      next_command: p.check_command || "/improve_status",
      updated_at: now(),
      events: [...(m.events || []), event("improvement_patch_applied", `Improvement patch applied. Files: ${commits.map(x => x.path).join(", ")}`)]
    };
    await kvPut(env, "active_mission", updated);
    await kvPut(env, "mission:" + m.id, updated);
  }
  await send(env, chatId, [
    "Improve Yes готово.",
    "✅ Patch применён через GitHub.",
    `Files: ${commits.map(x => x.path).join(", ")}`,
    p.switch_entry ? "Entry: switched" : "Entry: not changed",
    p.check_command ? `Жди деплой, затем проверь: ${p.check_command}` : "Проверка: /improve_status"
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
        d.improvement_runner = VERSION;
        d.commands = [...new Set([...(d.commands || []), "/improve_status", "/improve_prepare", "/improve_review", "/improve_yes", "/improve_no", "/improve_clear"])]
      }
      return json(d || { ok: true, improvement_runner: VERSION }, r.status);
    }
    if (url.pathname === "/telegram" && request.method === "POST") {
      const update = await request.clone().json().catch(() => null);
      const m = getMsg(update);
      const raw = String(m?.text || "").trim();
      const low = raw.toLowerCase();
      if (m && !allowedUser(env, m.from?.id)) { await send(env, m.chat.id, "Доступ закрыт."); return json({ ok: true, handled_by: VERSION, denied: true }); }
      if (m && low === "/improve_status") { await showStatus(env, m.chat.id); return json({ ok: true, handled_by: VERSION, improve_status: true }); }
      if (m && low === "/improve_prepare") { await saveDefaultProofPatch(env, m.chat.id); return json({ ok: true, handled_by: VERSION, improve_prepare: true }); }
      if (m && low === "/improve_review") { await showReview(env, m.chat.id); return json({ ok: true, handled_by: VERSION, improve_review: true }); }
      if (m && low === "/improve_clear") { await clearPatch(env, m.chat.id); return json({ ok: true, handled_by: VERSION, improve_clear: true }); }
      const p = m ? await kvGet(env, "improvement_patch", null) : null;
      const pending = p?.status === "pending";
      if (m && (low === "/improve_yes" || (pending && yesText(raw)))) { await accept(env, m.chat.id); return json({ ok: true, handled_by: VERSION, improve_yes: true }); }
      if (m && (low === "/improve_no" || (pending && noText(raw)))) { await reject(env, m.chat.id); return json({ ok: true, handled_by: VERSION, improve_no: true }); }
    }
    return await baseWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return await baseWorker.scheduled(event, env, ctx); }
};
