import app from "./index-v27.js";

const VERSION = "v2.8-proposal-gate-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";
const READ_TTL_MS = 2 * 60 * 60 * 1000;
const SCAN_FILES = [
  "cloudflare/wrangler.toml",
  "cloudflare/src/index.js",
  "cloudflare/src/index-v28.js",
  "cloudflare/src/index-v27.js",
  "cloudflare/src/index-v26.js",
  "cloudflare/src/index-v25.js"
];

function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS }); }
function now() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
function clip(s, n = 3900) { return String(s || "").slice(0, n); }
function compact(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function cleanPath(path) { return String(path || "").trim().replace(/^\/+/, ""); }
function safePath(path) {
  const p = cleanPath(path);
  if (!p || p.includes("..") || p.length > 180) return null;
  return /^[a-zA-Z0-9_./-]+$/.test(p) ? p : null;
}
function encodePath(path) { return cleanPath(path).split("/").map(encodeURIComponent).join("/"); }
function decodeBase64Utf8(s) {
  const bin = atob(String(s || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
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
async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}
async function kvPut(env, key, value) { await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2)); }
async function kvGetText(env, key) { return String(await env.MINISKYNET_KV.get(key) || "").trim(); }
async function getProposals(env) { return (await kvGet(env, "proposals", { proposals: [] })).proposals || []; }
async function saveProposals(env, proposals) { await kvPut(env, "proposals", { proposals: proposals.slice(-50) }); }
async function getReadLog(env) { return (await kvGet(env, "repo:read_log", { reads: [] })).reads || []; }
async function saveReadLog(env, reads) { await kvPut(env, "repo:read_log", { reads: reads.slice(-30), updated_at: now() }); }
async function recentReads(env) {
  const cutoff = Date.now() - READ_TTL_MS;
  const reads = (await getReadLog(env)).filter(r => Date.parse(r.time || 0) >= cutoff);
  if (reads.length !== (await getReadLog(env)).length) await saveReadLog(env, reads);
  return reads;
}
async function recordRead(env, item) {
  const reads = await getReadLog(env);
  const entry = { ...item, time: now() };
  const withoutSame = reads.filter(r => !(r.path === entry.path && r.repo === entry.repo));
  withoutSame.push(entry);
  await saveReadLog(env, withoutSame);
  return entry;
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
function extractInteresting(content) {
  const hits = [];
  for (const line of String(content || "").split("\n")) {
    const t = line.trim();
    if (/^const VERSION\s*=/.test(t) || /^main\s*=/.test(t) || /^export \{ default \}/.test(t) || /^import app from/.test(t) || /wrangler deploy/.test(t) || /kv_namespaces/.test(t)) hits.push(t);
  }
  return hits.slice(0, 8);
}
async function githubFile(repoCfg, path) {
  const p = safePath(path);
  if (!p) throw new Error("unsafe_path");
  const url = `https://api.github.com/repos/${repoCfg.repo}/contents/${encodePath(p)}?ref=${encodeURIComponent(repoCfg.branch)}`;
  const headers = { accept: "application/vnd.github+json", "user-agent": "MiniSkynet-Core" };
  if (repoCfg.token) headers.authorization = `Bearer ${repoCfg.token}`;
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data?.message || "request failed"}`);
  if (Array.isArray(data)) throw new Error("path_is_directory");
  if (!data.content) throw new Error("no_file_content");
  const content = decodeBase64Utf8(data.content);
  return { path: p, sha: data.sha || "", size: data.size || content.length, content };
}
async function repoFile(env, path, shouldRecord = true) {
  const c = await loadRepoConfig(env);
  const f = await githubFile(c, path);
  if (shouldRecord) await recordRead(env, { repo: c.repo, branch: c.branch, path: f.path, sha: f.sha, size: f.size, type: "file" });
  return { config: c, file: f };
}
async function repoFileText(env, path) {
  const { config, file } = await repoFile(env, path, true);
  const body = file.content.length > 2600 ? file.content.slice(0, 2600) + "\n...truncated..." : file.content;
  return [`📄 ${file.path}`, `- repo: ${config.repo}`, `- branch: ${config.branch}`, `- size: ${file.size}`, `- sha: ${String(file.sha).slice(0, 12)}`, "", body].join("\n");
}
async function repoScan(env) {
  const c = await loadRepoConfig(env);
  const rows = [];
  for (const path of SCAN_FILES) {
    try {
      const f = await githubFile(c, path);
      const interesting = extractInteresting(f.content);
      rows.push({ path, ok: true, size: f.size, sha: f.sha, interesting });
      await recordRead(env, { repo: c.repo, branch: c.branch, path: f.path, sha: f.sha, size: f.size, type: "scan" });
    } catch (e) {
      rows.push({ path, ok: false, error: String(e.message || e).slice(0, 120) });
    }
  }
  return { config: c, rows };
}
function repoScanText(scan) {
  const out = ["🧭 Repo scan:", `- repo: ${scan.config.repo}`, `- branch: ${scan.config.branch}`, `- token: ${scan.config.token ? "есть" : "нет"}`, ""];
  for (const r of scan.rows) {
    out.push(`${r.ok ? "✅" : "❌"} ${r.path}`);
    if (r.ok) {
      out.push(`  size=${r.size}, sha=${String(r.sha).slice(0, 10)}`);
      for (const h of r.interesting || []) out.push(`  ${h}`);
    } else out.push(`  error=${r.error}`);
  }
  return out.join("\n");
}
async function repoConfigText(env) {
  const c = await loadRepoConfig(env);
  return ["🔎 Repo config:", `- repo: ${c.repo}`, `- branch: ${c.branch}`, `- GITHUB_TOKEN: ${c.token ? "есть ✅" : "нет ⚠️"}`, "- mode: read-only", "", c.token ? "Готово: /repo_scan" : "Если repo private, добавь KV config:GITHUB_TOKEN"].join("\n");
}
function readLogText(reads) {
  return [
    "📚 Repo reads:",
    `- recent window: 2h`,
    `- files read: ${reads.length}`,
    "",
    ...(reads.length ? reads.slice(-12).map((r, i) => `${i + 1}. ${r.path} (${r.type || "file"}, sha=${String(r.sha || "").slice(0, 10)})`) : ["нет. Используй /repo_scan или /repo_file path"])
  ].join("\n");
}
async function selfInspectText(env) {
  const scan = await repoScan(env);
  const findFile = p => scan.rows.find(r => r.path === p);
  const wrangler = findFile("cloudflare/wrangler.toml");
  const index = findFile("cloudflare/src/index.js");
  const v28 = findFile("cloudflare/src/index-v28.js");
  const v27 = findFile("cloudflare/src/index-v27.js");
  const risks = [];
  if (!scan.config.token) risks.push("GITHUB_TOKEN не найден: private repo может не читаться.");
  if (!wrangler?.ok) risks.push("Не удалось прочитать wrangler.toml.");
  if (!index?.ok) risks.push("Не удалось прочитать active index.js.");
  if (index?.ok && !(index.interesting || []).join(" ").includes("index-v28.js")) risks.push("index.js может указывать не на v2.8.");
  if (!v28?.ok) risks.push("index-v28.js не читается.");
  return [
    "🧠 Self-inspection:",
    `- version: ${VERSION}`,
    `- repo: ${scan.config.repo}`,
    `- branch: ${scan.config.branch}`,
    `- read mode: GitHub contents API, read-only`,
    `- active index: ${index?.ok ? (index.interesting || ["прочитан"])[0] : "не прочитан"}`,
    `- wrangler: ${wrangler?.ok ? "прочитан" : "ошибка"}`,
    `- v28 gate: ${v28?.ok ? "прочитан" : "ошибка"}`,
    `- v27 read-only: ${v27?.ok ? "прочитан" : "ошибка"}`,
    "",
    risks.length ? "⚠️ Риски:" : "✅ Риск: критичных проблем не вижу.",
    ...risks.map(x => `- ${x}`),
    "",
    "Proposal gate: /propose разрешён только после свежего /repo_scan или /repo_file."
  ].join("\n");
}
function inferFilePath(request, reads) {
  const text = compact(request);
  for (const r of reads) if (text.includes(compact(r.path)) || text.includes(compact(r.path.split("/").pop()))) return r.path;
  const code = reads.find(r => r.path.endsWith(".js"));
  return code?.path || reads[0]?.path || "docs/proposals/idea.md";
}
function formatProposal(p) {
  return [
    `📦 Proposal ${p.id} [${p.status}]`,
    `Название: ${p.title}`,
    `Файл: ${p.file_path || "—"}`,
    `Риск: ${p.risk}`,
    `Checked files:`,
    ...(p.checked_files || []).map(x => `- ${x}`),
    `Суть: ${p.summary}`,
    `Изменение: ${p.description}`,
    "План:",
    ...(p.patch_plan || []).map((s, i) => `  ${i + 1}. ${s}`),
    "",
    `Одобрить: /approve ${p.id}   Отклонить: /reject ${p.id}`
  ].join("\n");
}
async function createRepoAwareProposal(env, request) {
  const reads = await recentReads(env);
  if (!reads.length) {
    return { ok: false, text: [
      "⛔ Proposal Gate: файловый контекст пуст.",
      "Перед /propose нужно прочитать repo:",
      "1) /repo_scan",
      "или",
      "2) /repo_file cloudflare/src/index.js",
      "",
      "После этого повтори /propose."
    ].join("\n") };
  }
  const checked = reads.slice(-8).map(r => r.path);
  const target = inferFilePath(request, reads);
  const proposal = {
    id: uid("prop"),
    status: "pending",
    created_at: now(),
    request: clip(request, 500),
    title: clip(`Repo-aware proposal: ${request}`, 200),
    summary: `Предложение создано только после чтения файлов репозитория. Проверенные файлы: ${checked.join(", ")}.`,
    risk: "medium: plan only, no code write; перед apply нужно снова читать target file и получить approve",
    file_path: target,
    description: clip(`Сделать изменение по запросу: ${request}. Не применять автоматически. Сначала подготовить точный patch plan на основе checked files.`, 2000),
    patch_plan: [
      `Подтвердить target file: ${target}`,
      "Перед кодовым изменением снова прочитать target через /repo_file.",
      "Сформировать минимальный diff только для нужного файла.",
      "Показать план владельцу и ждать approve.",
      "После deploy проверить /status и затронутые команды."
    ],
    checked_files: checked,
    gate: { type: "repo_read_required", passed: true, reads: reads.slice(-8), ttl_minutes: 120 }
  };
  const list = await getProposals(env);
  list.push(proposal);
  await saveProposals(env, list);
  return { ok: true, text: formatProposal(proposal) };
}
async function approveProposal(env, id) {
  const list = await getProposals(env);
  const p = list.find(x => x.id === id);
  if (!p) throw new Error(`Proposal ${id} не найден.`);
  if (p.status !== "pending") throw new Error(`Proposal уже ${p.status}.`);
  p.status = "approved_plan";
  p.approved_at = now();
  await saveProposals(env, list);
  return p;
}
async function rejectProposal(env, id) {
  const list = await getProposals(env);
  const p = list.find(x => x.id === id);
  if (!p) throw new Error(`Proposal ${id} не найден.`);
  p.status = "rejected";
  p.rejected_at = now();
  await saveProposals(env, list);
  return p;
}
async function proposalsText(env) {
  const p = await getProposals(env);
  return p.length ? "📦 Proposals:\n" + p.slice(-10).map(x => `- ${x.id} [${x.status}] ${x.title}${x.checked_files ? " ✅repo" : ""}`).join("\n") : "Предложений пока нет. /propose текст — создать после /repo_scan.";
}
async function showProposalText(env, id) {
  const p = (await getProposals(env)).find(x => x.id === String(id || "").trim());
  return p ? formatProposal(p) : `Не нашёл proposal ${id}.`;
}

const COMMANDS = new Set(["/repo_config", "/repo_file", "/repo_scan", "/repo_reads", "/repo_clear_reads", "/self_inspect", "/proposal_gate", "/propose", "/proposals", "/show", "/approve", "/reject", "/status", "/help"]);

async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/repo_config") return await send(cfg, chatId, await repoConfigText(env));
    if (command === "/repo_file") {
      if (!args) return await send(cfg, chatId, "Формат: /repo_file cloudflare/src/index.js");
      return await send(cfg, chatId, await repoFileText(env, args));
    }
    if (command === "/repo_scan") return await send(cfg, chatId, repoScanText(await repoScan(env)));
    if (command === "/repo_reads") return await send(cfg, chatId, readLogText(await recentReads(env)));
    if (command === "/repo_clear_reads") { await saveReadLog(env, []); return await send(cfg, chatId, "🧹 Repo read log очищен."); }
    if (command === "/self_inspect") return await send(cfg, chatId, await selfInspectText(env));
    if (command === "/proposal_gate") {
      const reads = await recentReads(env);
      return await send(cfg, chatId, [`🚪 Proposal Gate v2.8:`, `- required: свежий /repo_scan или /repo_file`, `- window: 2h`, `- reads now: ${reads.length}`, `- status: ${reads.length ? "open ✅" : "blocked ⛔"}`, "", reads.length ? "Можно: /propose текст" : "Сначала: /repo_scan"].join("\n"));
    }
    if (command === "/propose") {
      if (!args) return await send(cfg, chatId, "Напиши: /propose что улучшить. Перед этим нужен /repo_scan или /repo_file.");
      const result = await createRepoAwareProposal(env, args);
      return await send(cfg, chatId, result.text);
    }
    if (command === "/proposals") return await send(cfg, chatId, await proposalsText(env));
    if (command === "/show") return await send(cfg, chatId, await showProposalText(env, args));
    if (command === "/approve") { const p = await approveProposal(env, args.trim()); return await send(cfg, chatId, `✅ Одобрено как plan: ${p.id}. Код не меняю. Перед apply нужен отдельный patch step.`); }
    if (command === "/reject") { const p = await rejectProposal(env, args.trim()); return await send(cfg, chatId, `🗑 Отклонено: ${p.id}`); }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v2.8 status`, `- version: ${VERSION}`, `- base: v2.7 read-only + v2.6 task control`, `- proposal gate: active`, `- commands: /proposal_gate /repo_reads /propose /repo_scan /repo_file`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "/repo_config /repo_scan /repo_file путь /repo_reads /repo_clear_reads",
      "/self_inspect",
      "/proposal_gate — статус gate",
      "/propose текст — только после repo read",
      "/proposals /show id /approve id /reject id",
      "",
      "Остальное из v2.7/v2.6: /tasks /task_done /projects /next /self /goals /plan /think"
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v2.8 error: ${clip(e.message || e, 600)}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v2.7-github-readonly", proposal_gate: true });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v2.8 internal error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, proposal_gate: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  }
};
