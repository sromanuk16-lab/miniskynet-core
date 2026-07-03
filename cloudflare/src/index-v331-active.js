import app from "./index-v32.js";

const VERSION = "v3.3.1-lightweight-code-draft-2026-07-03";
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
function findProposal(list, id) {
  const key = String(id || "").trim();
  return list.find(p => p.id === key || String(p.id || "").startsWith(key)) || null;
}
function activeMainFromWrangler(content) {
  const m = String(content || "").match(/^main\s*=\s*["']([^"']+)["']/m);
  if (!m) return null;
  const rel = cleanPath(m[1]);
  return rel.startsWith("cloudflare/") ? rel : `cloudflare/${rel}`;
}
function requestLooksRuntimeVisible(p) {
  const s = compact(`${p.title || ""} ${p.request || ""} ${p.summary || ""} ${p.description || ""} ${p.patch_draft?.intent || ""}`);
  return /help|status|stage|command|команд|статус|стейдж|development/.test(s);
}
function splitNoFinalNewline(s) { return String(s || "").replace(/\n$/, "").split("\n"); }
function normalizeFinalNewline(text, reference) {
  let x = String(text || "");
  if (reference.endsWith("\n") && !x.endsWith("\n")) x += "\n";
  if (!reference.endsWith("\n") && x.endsWith("\n")) x = x.replace(/\n+$/, "");
  return x;
}
function buildFullFileUnifiedDiff(path, oldContent, newContent, oldSha = "old", newSha = "new") {
  const oldLines = splitNoFinalNewline(oldContent);
  const newLines = splitNoFinalNewline(newContent);
  return [
    `diff --git a/${path} b/${path}`,
    `index ${String(oldSha).slice(0, 7)}..${String(newSha).slice(0, 7)} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map(l => `-${l}`),
    ...newLines.map(l => `+${l}`)
  ].join("\n") + "\n";
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
      const body = l.slice(1);
      if (l.startsWith(" ")) {
        if (src[srcIndex] !== body) throw new Error(`diff context mismatch near source line ${srcIndex + 1}`);
        out.push(src[srcIndex++]);
      } else if (l.startsWith("-")) {
        if (src[srcIndex] !== body) throw new Error(`diff removal mismatch near source line ${srcIndex + 1}`);
        srcIndex++;
      } else if (l.startsWith("+")) out.push(body);
    }
  }
  if (!sawHunk) throw new Error("no unified diff hunk found");
  while (srcIndex < src.length) out.push(src[srcIndex++]);
  return out.join("\n") + (originalHadFinalNewline ? "\n" : "");
}
async function baseChecks(env, p) {
  if (!p.patch_draft) throw new Error("patch_draft missing: run /patch_preview first");
  const target = safePath(p.patch_draft?.target_file || p.file_path || "");
  if (!target) throw new Error("target missing/unsafe");
  const repoCfg = await loadRepoConfig(env);
  const [file, wrangler] = await Promise.all([githubFile(repoCfg, target), githubFile(repoCfg, "cloudflare/wrangler.toml")]);
  const activeMain = activeMainFromWrangler(wrangler.content);
  const blockers = [];
  if (p.patch_draft.current_sha && p.patch_draft.current_sha !== file.sha) blockers.push("patch_draft sha differs from current GitHub sha");
  if (requestLooksRuntimeVisible(p) && activeMain && target !== activeMain) blockers.push(`runtime-visible change targets ${target}, but active main is ${activeMain}`);
  return { repoCfg, file, activeMain, blockers };
}
function deterministicNewContent(p, file) {
  const s = compact(`${p.title || ""} ${p.request || ""} ${p.summary || ""} ${p.patch_draft?.intent || ""}`);
  if (!(/help|команд/.test(s) && /stage|development|стейдж|статус/.test(s))) return null;
  const marker = '"/start /help /status",';
  if (!file.content.includes(marker)) return null;
  const line = '      "Development stage: " + VERSION,';
  if (file.content.includes(line.trim())) throw new Error("development stage line already exists");
  return file.content.replace(marker, `${marker}\n${line}`);
}
async function generateLightweightCodeDraft(env, proposalId) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  const base = await baseChecks(env, p);
  if (base.blockers.length) throw new Error(base.blockers.join("; "));
  let newContent = deterministicNewContent(p, base.file);
  if (!newContent) throw new Error("lightweight deterministic operation not found for this proposal; make proposal more specific or add operation support");
  newContent = normalizeFinalNewline(newContent, base.file.content);
  if (newContent === base.file.content) throw new Error("operation produced identical content");
  const diff = buildFullFileUnifiedDiff(base.file.path, base.file.content, newContent, base.file.sha, "new");
  const patched = applyUnifiedDiff(base.file.content, diff);
  if (patched !== newContent) throw new Error("internal validator: generated diff does not recreate new content");
  p.code_draft = {
    created_at: now(),
    target_file: base.file.path,
    current_sha: base.file.sha,
    summary: "Добавить отображение текущего development stage в /help.",
    risk: "low — меняется только текст help-команды",
    unified_diff: diff,
    test_plan: ["/status", "/help"],
    operations: [{ type: "insert_after", anchor: marker, text: line }],
    mode: "lightweight_deterministic_operation_no_write"
  };
  p.code_draft_validation = { checked_at: now(), target_file: base.file.path, current_sha: base.file.sha, active_main: base.activeMain, ok: true, blockers: [], warnings: [] };
  p.status = "code_draft_ready";
  p.code_draft_ready_at = now();
  await saveProposals(env, proposals);
  return p;
}
async function checkCodeDraft(env, proposalId) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  const base = await baseChecks(env, p);
  const blockers = [...base.blockers];
  const warnings = [];
  if (!p.code_draft) blockers.push("code_draft missing");
  if (p.code_draft && p.code_draft.current_sha !== base.file.sha) blockers.push("code_draft sha differs from current GitHub sha");
  if (!blockers.length) {
    try {
      const patched = applyUnifiedDiff(base.file.content, p.code_draft.unified_diff);
      if (patched === base.file.content) warnings.push("patch produces identical content");
    } catch (e) { blockers.push(`diff does not apply: ${e.message || e}`); }
  }
  p.code_draft_validation = { checked_at: now(), target_file: base.file.path, current_sha: base.file.sha, active_main: base.activeMain, ok: blockers.length === 0, blockers, warnings };
  await saveProposals(env, proposals);
  return { p, file: base.file, activeMain: base.activeMain, blockers, warnings };
}
function formatDraft(p) {
  const d = p.code_draft || {};
  return [`🪶 Lightweight code draft ${p.id}:`, `- status: ${p.status}`, `- target: ${d.target_file}`, `- sha: ${String(d.current_sha || "").slice(0, 12)}`, `- validation: ${p.code_draft_validation?.ok ? "valid ✅" : "unknown"}`, `- mode: ${d.mode || "—"}`, `- risk: ${d.risk || "—"}`, "", `Summary: ${d.summary || "—"}`, "", "Unified diff:", clip(d.unified_diff || "", 1800), d.unified_diff && d.unified_diff.length > 1800 ? "\n...truncated. Полностью: /code_show prop_id" : "", "", "Код в GitHub НЕ изменён."].join("\n");
}
function codeCheckText(r) {
  return [`🧪 Lightweight code check ${r.p.id}:`, `- target: ${r.file.path}`, `- sha: ${String(r.file.sha).slice(0, 12)}`, `- active main: ${r.activeMain || "—"}`, `- status: ${r.blockers.length ? "blocked ⛔" : "valid ✅"}`, "", r.blockers.length ? "Blockers:" : "Blockers: none", ...r.blockers.map(x => `- ${x}`), r.warnings.length ? "\nWarnings:" : "\nWarnings: none", ...r.warnings.map(x => `- ${x}`), "", r.blockers.length ? `/code_repair ${r.p.id}` : `/apply_check ${r.p.id}`].join("\n");
}
const COMMANDS = new Set(["/code_preview", "/code_regen", "/code_repair", "/code_check", "/status", "/help"]);
async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/code_preview" || command === "/code_regen" || command === "/code_repair") {
      if (!args) return await send(cfg, chatId, `Формат: ${command} prop_id`);
      const p = await generateLightweightCodeDraft(env, args);
      return await send(cfg, chatId, formatDraft(p));
    }
    if (command === "/code_check") {
      if (!args) return await send(cfg, chatId, "Формат: /code_check prop_id");
      return await send(cfg, chatId, codeCheckText(await checkCodeDraft(env, args)));
    }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v3.3.1 status`, `- version: ${VERSION}`, `- base: v3.2 apply guard`, `- lightweight code draft: active`, `- full-file AI generation: disabled`, `- write guard: /code_approve + /apply_confirm`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, ["/start /help /status", "Development stage: " + VERSION, "/code_preview prop_id — лёгкий deterministic draft", "/code_check prop_id — проверить diff", "/code_repair prop_id — пересоздать lightweight draft", "", "После valid: /apply_check → /code_approve → /apply_confirm"].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v3.3.1 error: ${clip(e.message || e, 900)}`);
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v3.2-apply-after-code-approve", lightweight_code_draft: true });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v3.3.1 internal error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, lightweight_code_draft: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return app.scheduled(event, env, ctx); }
};
