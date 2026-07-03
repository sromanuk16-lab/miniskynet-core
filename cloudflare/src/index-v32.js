import app from "./index-v31.js";

const VERSION = "v3.2-apply-after-code-approve-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";

function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS }); }
function now() { return new Date().toISOString(); }
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
function encodeBase64Utf8(s) {
  const bytes = new TextEncoder().encode(String(s || ""));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(bin);
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
async function loadTelegramConfig(env) {
  const cfg = { TELEGRAM_BOT_TOKEN: String(env.TELEGRAM_BOT_TOKEN || "").trim(), TELEGRAM_ALLOWED_USER_ID: String(env.TELEGRAM_ALLOWED_USER_ID || "").trim() };
  if (!cfg.TELEGRAM_BOT_TOKEN) cfg.TELEGRAM_BOT_TOKEN = await kvGetText(env, "config:TELEGRAM_BOT_TOKEN");
  if (!cfg.TELEGRAM_ALLOWED_USER_ID) cfg.TELEGRAM_ALLOWED_USER_ID = await kvGetText(env, "config:TELEGRAM_ALLOWED_USER_ID");
  return cfg;
}
async function loadRepoConfig(env) {
  return {
    token: String(env.GITHUB_TOKEN || await kvGetText(env, "config:GITHUB_TOKEN") || "").trim(),
    repo: String(env.GITHUB_REPO || await kvGetText(env, "config:GITHUB_REPO") || DEFAULT_REPO).trim(),
    branch: String(env.GITHUB_BRANCH || await kvGetText(env, "config:GITHUB_BRANCH") || DEFAULT_BRANCH).trim()
  };
}
function isOwner(cfg, userId) {
  const owner = String(cfg.TELEGRAM_ALLOWED_USER_ID || "").trim();
  return !owner || String(userId || "") === owner;
}
async function tg(cfg, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await res.json().catch(() => ({}));
}
async function send(cfg, chatId, text) { if (cfg.TELEGRAM_BOT_TOKEN && chatId) return await tg(cfg, "sendMessage", { chat_id: chatId, text: clip(text) }); }
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
async function githubUpdateFile(repoCfg, path, oldSha, newContent, message) {
  if (!repoCfg.token) throw new Error("GITHUB_TOKEN missing");
  const p = safePath(path);
  if (!p) throw new Error("unsafe_path");
  const url = `https://api.github.com/repos/${repoCfg.repo}/contents/${encodePath(p)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "MiniSkynet-Core", authorization: `Bearer ${repoCfg.token}` },
    body: JSON.stringify({ message, content: encodeBase64Utf8(newContent), sha: oldSha, branch: repoCfg.branch })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub write ${res.status}: ${data?.message || "request failed"}`);
  return { commit_sha: data?.commit?.sha || "", content_sha: data?.content?.sha || "" };
}
function findProposal(list, id) {
  const key = String(id || "").trim();
  return list.find(p => p.id === key || String(p.id || "").startsWith(key)) || null;
}
function isEntryForwarder(file) {
  const c = String(file?.content || "").trim();
  return /^export\s+\{\s*default\s*\}\s+from\s+["']\.\/index-v\d+\.js["'];?\s*$/.test(c);
}
function activeMainFromWrangler(content) {
  const m = String(content || "").match(/^main\s*=\s*["']([^"']+)["']/m);
  if (!m) return null;
  const rel = cleanPath(m[1]);
  return rel.startsWith("cloudflare/") ? rel : `cloudflare/${rel}`;
}
function requestLooksRuntimeVisible(p) {
  const s = compact(`${p.title || ""} ${p.request || ""} ${p.summary || ""} ${p.description || ""} ${(p.patch_draft?.intent || "")}`);
  return /help|status|stage|command|команд|статус|стейдж|development/.test(s);
}
function applyUnifiedDiff(original, diff) {
  const originalHadFinalNewline = original.endsWith("\n");
  const src = original.replace(/\n$/, "").split("\n");
  const lines = String(diff || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let srcIndex = 0;
  let sawHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!h) continue;
    sawHunk = true;
    const oldStart = parseInt(h[1], 10) - 1;
    while (srcIndex < oldStart) out.push(src[srcIndex++]);
    i++;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith("@@ ")) { i--; break; }
      if (l.startsWith("\\ No newline")) continue;
      const body = l.slice(1);
      if (l.startsWith(" ")) {
        if (src[srcIndex] !== body) throw new Error(`diff context mismatch near source line ${srcIndex + 1}`);
        out.push(src[srcIndex++]);
      } else if (l.startsWith("-")) {
        if (src[srcIndex] !== body) throw new Error(`diff removal mismatch near source line ${srcIndex + 1}`);
        srcIndex++;
      } else if (l.startsWith("+")) {
        out.push(body);
      } else if (l === "") {
        if (src[srcIndex] !== "") throw new Error(`diff blank context mismatch near source line ${srcIndex + 1}`);
        out.push(src[srcIndex++]);
      }
    }
  }
  if (!sawHunk) throw new Error("no unified diff hunk found");
  while (srcIndex < src.length) out.push(src[srcIndex++]);
  return out.join("\n") + (originalHadFinalNewline ? "\n" : "");
}
async function inspectApply(env, id) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, id);
  if (!p) throw new Error(`proposal ${id} not found`);
  if (!p.code_draft) throw new Error("code_draft missing: run /code_preview first");
  const target = safePath(p.code_draft.target_file || p.patch_draft?.target_file || p.file_path || "");
  if (!target) throw new Error("target missing/unsafe");
  const repoCfg = await loadRepoConfig(env);
  const [file, wrangler] = await Promise.all([githubFile(repoCfg, target), githubFile(repoCfg, "cloudflare/wrangler.toml")]);
  const activeMain = activeMainFromWrangler(wrangler.content);
  const warnings = [];
  const blockers = [];
  if (isEntryForwarder(file)) blockers.push("target is entry-forwarder");
  if (p.code_draft.current_sha !== file.sha) blockers.push("code_draft sha differs from current GitHub sha");
  if (requestLooksRuntimeVisible(p) && activeMain && target !== activeMain) blockers.push(`runtime-visible change targets ${target}, but active main is ${activeMain}`);
  if (!p.code_draft.unified_diff) blockers.push("unified_diff missing");
  let patched = null;
  if (!blockers.length) {
    try {
      patched = applyUnifiedDiff(file.content, p.code_draft.unified_diff);
      if (patched === file.content) warnings.push("patch produces identical content");
    } catch (e) {
      blockers.push(`diff does not apply: ${e.message || e}`);
    }
  }
  return { proposals, proposal: p, repoCfg, file, wrangler, activeMain, warnings, blockers, patched };
}
function applyCheckText(r) {
  const p = r.proposal;
  return [
    `🔐 Apply check ${p.id}:`,
    `- status: ${p.status}`,
    `- target: ${r.file.path}`,
    `- target sha: ${String(r.file.sha).slice(0, 12)}`,
    `- draft sha: ${String(p.code_draft?.current_sha || "").slice(0, 12)}`,
    `- active main: ${r.activeMain || "—"}`,
    `- code approved: ${p.status === "code_approved" || Boolean(p.code_approved_at) ? "yes ✅" : "no ⛔"}`,
    `- diff applies: ${r.patched ? "yes ✅" : "no/blocked"}`,
    "",
    r.blockers.length ? "Blockers:" : "Blockers: none",
    ...r.blockers.map(x => `- ${x}`),
    r.warnings.length ? "\nWarnings:" : "\nWarnings: none",
    ...r.warnings.map(x => `- ${x}`),
    "",
    r.blockers.length ? "Next: исправь blockers." : (p.status === "code_approved" || p.code_approved_at) ? `/apply_confirm ${p.id}` : `/code_approve ${p.id}`
  ].join("\n");
}
function applyStatusText(p) {
  return [
    `🚀 Apply status ${p.id}:`,
    `- status: ${p.status}`,
    `- code approved: ${p.code_approved_at ? p.code_approved_at : "no"}`,
    `- applied: ${p.applied_at ? p.applied_at : "no"}`,
    `- target: ${p.apply_result?.path || p.code_draft?.target_file || "—"}`,
    `- commit: ${p.apply_result?.commit_sha || "—"}`,
    `- previous sha: ${p.apply_result?.old_sha || "—"}`,
    `- new content sha: ${p.apply_result?.content_sha || "—"}`
  ].join("\n");
}
const COMMANDS = new Set(["/code_approve", "/code_unapprove", "/apply_check", "/apply_confirm", "/apply_status", "/status", "/help"]);
async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/code_approve") {
      const proposals = await getProposals(env);
      const p = findProposal(proposals, args);
      if (!p) return await send(cfg, chatId, `Не нашёл proposal ${args}.`);
      if (!p.code_draft) return await send(cfg, chatId, "Нет code_draft. Сначала /code_preview prop_id");
      p.status = "code_approved";
      p.code_approved_at = now();
      await saveProposals(env, proposals);
      return await send(cfg, chatId, `✅ Code approved: ${p.id}\nТеперь: /apply_check ${p.id}`);
    }
    if (command === "/code_unapprove") {
      const proposals = await getProposals(env);
      const p = findProposal(proposals, args);
      if (!p) return await send(cfg, chatId, `Не нашёл proposal ${args}.`);
      delete p.code_approved_at;
      if (p.status === "code_approved") p.status = "code_draft_ready";
      await saveProposals(env, proposals);
      return await send(cfg, chatId, `↩️ Code approval снят: ${p.id}`);
    }
    if (command === "/apply_check") {
      if (!args) return await send(cfg, chatId, "Формат: /apply_check prop_id");
      return await send(cfg, chatId, applyCheckText(await inspectApply(env, args)));
    }
    if (command === "/apply_confirm") {
      if (!args) return await send(cfg, chatId, "Формат: /apply_confirm prop_id");
      const r = await inspectApply(env, args);
      const p = r.proposal;
      if (r.blockers.length) return await send(cfg, chatId, applyCheckText(r));
      if (!(p.status === "code_approved" || p.code_approved_at)) return await send(cfg, chatId, `⛔ Code не одобрен. Сначала: /code_approve ${p.id}`);
      const message = `MiniSkynet apply ${p.id}: ${clip(p.code_draft?.summary || p.title || "code draft", 120)}`;
      const result = await githubUpdateFile(r.repoCfg, r.file.path, r.file.sha, r.patched, message);
      p.status = "applied";
      p.applied_at = now();
      p.apply_result = { path: r.file.path, old_sha: r.file.sha, commit_sha: result.commit_sha, content_sha: result.content_sha, branch: r.repoCfg.branch, message };
      await saveProposals(env, r.proposals);
      return await send(cfg, chatId, [`✅ Applied to GitHub: ${p.id}`, `- file: ${r.file.path}`, `- commit: ${result.commit_sha}`, `- content sha: ${result.content_sha}`, "", "Жди Cloudflare deploy, потом проверь:", "/status", "/help", "/self_inspect"].join("\n"));
    }
    if (command === "/apply_status") {
      const p = findProposal(await getProposals(env), args);
      if (!p) return await send(cfg, chatId, `Не нашёл proposal ${args}.`);
      return await send(cfg, chatId, applyStatusText(p));
    }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v3.2 status`, `- version: ${VERSION}`, `- base: v3.1 exact code draft`, `- apply after code approve: active`, `- GitHub write: enabled only after /code_approve + /apply_confirm`, `- commands: /code_approve /apply_check /apply_confirm /apply_status`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "/code_approve prop_id — одобрить exact diff",
      "/code_unapprove prop_id — снять approval",
      "/apply_check prop_id — финальная проверка",
      "/apply_confirm prop_id — записать в GitHub после approval",
      "/apply_status prop_id — статус применения",
      "",
      "Перед apply: /repo_scan → /propose → /patch_preview → /patch_check → /apply_preview → /code_preview → /code_show"
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v3.2 error: ${clip(e.message || e, 900)}`);
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v3.1-exact-code-draft", apply_after_code_approve: true });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v3.2 internal error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, apply_after_code_approve: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return app.scheduled(event, env, ctx); }
};
