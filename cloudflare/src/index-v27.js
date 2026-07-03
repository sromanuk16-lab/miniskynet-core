import app from "./index-v26.js";

const VERSION = "v2.7-github-readonly-inspection-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";
const SCAN_FILES = [
  "cloudflare/wrangler.toml",
  "cloudflare/src/index.js",
  "cloudflare/src/index-v27.js",
  "cloudflare/src/index-v26.js",
  "cloudflare/src/index-v25.js"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}
function clip(s, n = 3900) { return String(s || "").slice(0, n); }
function compact(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function cleanPath(path) { return String(path || "").trim().replace(/^\/+/, ""); }
function safePath(path) {
  const p = cleanPath(path);
  if (!p || p.includes("..") || p.length > 180) return null;
  if (/^[a-zA-Z0-9_./-]+$/.test(p)) return p;
  return null;
}
function encodePath(path) { return cleanPath(path).split("/").map(encodeURIComponent).join("/"); }
function decodeBase64Utf8(s) {
  const bin = atob(String(s || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
function extractInteresting(content) {
  const lines = String(content || "").split("\n");
  const hits = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^const VERSION\s*=/.test(t) || /^main\s*=/.test(t) || /^export \{ default \}/.test(t) || /^import app from/.test(t) || /wrangler deploy/.test(t) || /kv_namespaces/.test(t)) hits.push(t);
  }
  return hits.slice(0, 8);
}

async function kvGetText(env, key) {
  if (!env.MINISKYNET_KV) return "";
  return String(await env.MINISKYNET_KV.get(key) || "").trim();
}
async function loadTelegramConfig(env) {
  const cfg = {
    TELEGRAM_BOT_TOKEN: String(env.TELEGRAM_BOT_TOKEN || "").trim(),
    TELEGRAM_ALLOWED_USER_ID: String(env.TELEGRAM_ALLOWED_USER_ID || "").trim()
  };
  if (!cfg.TELEGRAM_BOT_TOKEN) cfg.TELEGRAM_BOT_TOKEN = await kvGetText(env, "config:TELEGRAM_BOT_TOKEN");
  if (!cfg.TELEGRAM_ALLOWED_USER_ID) cfg.TELEGRAM_ALLOWED_USER_ID = await kvGetText(env, "config:TELEGRAM_ALLOWED_USER_ID");
  return cfg;
}
async function loadRepoConfig(env) {
  const token = String(env.GITHUB_TOKEN || await kvGetText(env, "config:GITHUB_TOKEN") || "").trim();
  const repo = String(env.GITHUB_REPO || await kvGetText(env, "config:GITHUB_REPO") || DEFAULT_REPO).trim();
  const branch = String(env.GITHUB_BRANCH || await kvGetText(env, "config:GITHUB_BRANCH") || DEFAULT_BRANCH).trim();
  return { token, repo, branch };
}
function isOwner(cfg, userId) {
  const owner = String(cfg.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}
async function tg(cfg, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await res.json().catch(() => ({}));
}
async function send(cfg, chatId, text) {
  if (cfg.TELEGRAM_BOT_TOKEN && chatId) return await tg(cfg, "sendMessage", { chat_id: chatId, text: clip(text) });
}
function parseUpdate(update) {
  const msg = update?.message || update?.edited_message || null;
  if (!msg) return null;
  const text = String(msg.text || "").trim();
  let command = null, args = "";
  if (text.startsWith("/")) {
    const i = text.indexOf(" ");
    command = (i === -1 ? text : text.slice(0, i)).replace(/@\w+$/, "").toLowerCase();
    args = i === -1 ? "" : text.slice(i + 1).trim();
  }
  return { chatId: msg.chat?.id, userId: msg.from?.id, text, command, args };
}

async function githubFile(repoCfg, path) {
  const p = safePath(path);
  if (!p) throw new Error("unsafe_path");
  const url = `https://api.github.com/repos/${repoCfg.repo}/contents/${encodePath(p)}?ref=${encodeURIComponent(repoCfg.branch)}`;
  const headers = { "accept": "application/vnd.github+json", "user-agent": "MiniSkynet-Core" };
  if (repoCfg.token) headers.authorization = `Bearer ${repoCfg.token}`;
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data?.message || "request failed"}`);
  if (Array.isArray(data)) throw new Error("path_is_directory");
  if (!data.content) throw new Error("no_file_content");
  const content = decodeBase64Utf8(data.content);
  return { path: p, sha: data.sha || "", size: data.size || content.length, content };
}
async function repoConfigText(env) {
  const c = await loadRepoConfig(env);
  return [
    "🔎 Repo config:",
    `- repo: ${c.repo}`,
    `- branch: ${c.branch}`,
    `- GITHUB_TOKEN: ${c.token ? "есть ✅" : "нет ⚠️"}`,
    "- mode: read-only",
    "",
    c.token ? "Готово: /repo_scan" : "Если репозиторий private, добавь token в KV: config:GITHUB_TOKEN"
  ].join("\n");
}
async function repoFileText(env, path) {
  const c = await loadRepoConfig(env);
  const f = await githubFile(c, path);
  const body = f.content.length > 2600 ? f.content.slice(0, 2600) + "\n...truncated..." : f.content;
  return [`📄 ${f.path}`, `- repo: ${c.repo}`, `- branch: ${c.branch}`, `- size: ${f.size}`, `- sha: ${String(f.sha).slice(0, 12)}`, "", body].join("\n");
}
async function repoScan(env) {
  const c = await loadRepoConfig(env);
  const rows = [];
  for (const path of SCAN_FILES) {
    try {
      const f = await githubFile(c, path);
      const interesting = extractInteresting(f.content);
      rows.push({ path, ok: true, size: f.size, sha: f.sha, interesting });
    } catch (e) {
      rows.push({ path, ok: false, error: String(e.message || e).slice(0, 120) });
    }
  }
  return { config: c, rows };
}
function repoScanText(scan) {
  const out = [
    "🧭 Repo scan:",
    `- repo: ${scan.config.repo}`,
    `- branch: ${scan.config.branch}`,
    `- token: ${scan.config.token ? "есть" : "нет"}`,
    ""
  ];
  for (const r of scan.rows) {
    out.push(`${r.ok ? "✅" : "❌"} ${r.path}`);
    if (r.ok) {
      out.push(`  size=${r.size}, sha=${String(r.sha).slice(0, 10)}`);
      for (const h of r.interesting || []) out.push(`  ${h}`);
    } else {
      out.push(`  error=${r.error}`);
    }
  }
  return out.join("\n");
}
async function selfInspectText(env) {
  const scan = await repoScan(env);
  const findFile = (p) => scan.rows.find(r => r.path === p);
  const wrangler = findFile("cloudflare/wrangler.toml");
  const index = findFile("cloudflare/src/index.js");
  const v27 = findFile("cloudflare/src/index-v27.js");
  const v26 = findFile("cloudflare/src/index-v26.js");
  const risks = [];
  if (!scan.config.token) risks.push("GITHUB_TOKEN не найден: private repo может не читаться.");
  if (!wrangler?.ok) risks.push("Не удалось прочитать wrangler.toml.");
  if (!index?.ok) risks.push("Не удалось прочитать active index.js.");
  if (index?.ok && !(index.interesting || []).join(" ").includes("index-v27.js")) risks.push("index.js может указывать не на v2.7.");
  if (!v27?.ok) risks.push("index-v27.js не читается.");
  const ok = risks.length === 0;
  return [
    "🧠 Self-inspection:",
    `- version: ${VERSION}`,
    `- repo: ${scan.config.repo}`,
    `- branch: ${scan.config.branch}`,
    `- read mode: GitHub contents API, read-only`,
    `- active index: ${index?.ok ? (index.interesting || ["прочитан"])[0] : "не прочитан"}`,
    `- wrangler: ${wrangler?.ok ? "прочитан" : "ошибка"}`,
    `- v27 wrapper: ${v27?.ok ? "прочитан" : "ошибка"}`,
    `- v26 base: ${v26?.ok ? "прочитан" : "ошибка"}`,
    "",
    ok ? "✅ Риск: критичных проблем не вижу." : "⚠️ Риски:",
    ...risks.map(x => `- ${x}`),
    "",
    "Следующий шаг: проверить /repo_file cloudflare/src/index.js, потом создавать proposal только после чтения нужных файлов."
  ].join("\n");
}

const REPO_COMMANDS = new Set(["/repo_config", "/repo_file", "/repo_scan", "/self_inspect", "/status", "/help"]);

async function handleRepoCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/repo_config") return await send(cfg, chatId, await repoConfigText(env));
    if (command === "/repo_file") {
      if (!args) return await send(cfg, chatId, "Формат: /repo_file cloudflare/src/index.js");
      return await send(cfg, chatId, await repoFileText(env, args));
    }
    if (command === "/repo_scan") return await send(cfg, chatId, repoScanText(await repoScan(env)));
    if (command === "/self_inspect") return await send(cfg, chatId, await selfInspectText(env));
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v2.7 status`, `- version: ${VERSION}`, `- base: v2.6 task control + v2.5 project knowledge`, `- GitHub read-only: active`, `- commands: /repo_config /repo_scan /repo_file /self_inspect`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "/repo_config — проверить GitHub KV config",
      "/repo_scan — прочитать главные файлы ядра",
      "/repo_file путь — прочитать файл",
      "/self_inspect — самоаудит активного entry/config",
      "",
      "Остальное работает из v2.6: /tasks /task_done /projects /next /self /goals /plan /think"
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ Repo read error: ${clip(e.message || e, 500)}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v2.6-task-control", mode: "github-read-only" });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && REPO_COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleRepoCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v2.7 error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, repo_read: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  }
};
