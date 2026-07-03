import app from "./index-v33.js";

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
function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (_) {}
  const a = String(s || "").indexOf("{");
  const b = String(s || "").lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(String(s).slice(a, b + 1)); } catch (_) {} }
  return null;
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
async function loadAiConfig(env) {
  return {
    key: String(env.OPENROUTER_API_KEY || await kvGetText(env, "config:OPENROUTER_API_KEY") || "").trim(),
    model: String(env.OPENROUTER_MODEL_CHEAP || await kvGetText(env, "config:OPENROUTER_MODEL_CHEAP") || "openai/gpt-4o-mini").trim()
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
function isEntryForwarder(file) {
  return /^export\s+\{\s*default\s*\}\s+from\s+["']\.\/index-v\d+\.js["'];?\s*$/.test(String(file?.content || "").trim());
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
      if (l.startsWith("\\ No newline")) continue;
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
function applyOperation(content, op) {
  const lines = String(content || "").split("\n");
  const type = String(op?.type || "").trim();
  if (type === "insert_after") {
    const anchor = String(op.anchor || "");
    const insert = String(op.text || "");
    const idx = lines.findIndex(l => l.includes(anchor));
    if (idx < 0) throw new Error(`anchor not found: ${anchor}`);
    if (content.includes(insert.trim())) throw new Error("operation already present / duplicate risk");
    lines.splice(idx + 1, 0, insert);
    return lines.join("\n");
  }
  if (type === "replace_exact") {
    const oldText = String(op.old_text || "");
    const newText = String(op.new_text || "");
    if (!oldText || !content.includes(oldText)) throw new Error("replace_exact old_text not found");
    return content.replace(oldText, newText);
  }
  throw new Error(`unsupported operation: ${type}`);
}
function deterministicOperation(p, file) {
  const s = compact(`${p.title || ""} ${p.request || ""} ${p.summary || ""} ${p.patch_draft?.intent || ""}`);
  if (/help|команд/.test(s) && /stage|development|стейдж|статус/.test(s)) {
    const marker = '"/start /help /status",';
    if (!file.content.includes(marker)) return null;
    return {
      summary: "Добавить отображение текущего development stage в /help.",
      risk: "low — меняется только текст help-команды",
      operations: [{ type: "insert_after", anchor: marker, text: '      "Development stage: " + VERSION,' }],
      test_plan: ["/status", "/help"]
    };
  }
  return null;
}
function relevantSnippet(content) {
  const lines = String(content || "").split("\n");
  const hit = lines.findIndex(l => l.includes('command === "/help"') || l.includes('"/start /help /status"'));
  const start = Math.max(0, hit - 25);
  const end = Math.min(lines.length, hit + 55);
  return lines.slice(start, end).join("\n");
}
async function aiOperation(env, p, file) {
  const ai = await loadAiConfig(env);
  if (!ai.key) throw new Error("OPENROUTER_API_KEY missing");
  const prompt = [
    "Верни маленькую patch operation, НЕ полный файл и НЕ diff.",
    "JSON строго: {\"summary\":\"...\",\"risk\":\"low|medium|high\",\"operations\":[{\"type\":\"insert_after\",\"anchor\":\"exact text from a line\",\"text\":\"full new line with indentation\"}],\"test_plan\":[\"/status\",\"/help\"]}",
    "Поддерживаются только insert_after и replace_exact. Используй точный anchor из snippet.",
    "Proposal:", JSON.stringify({ title: p.title, request: p.request, summary: p.summary, patch_draft: p.patch_draft }, null, 2),
    "Relevant target snippet:", relevantSnippet(file.content)
  ].join("\n\n");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + ai.key },
    body: JSON.stringify({ model: ai.model, temperature: 0.1, max_tokens: 900, messages: [{ role: "system", content: "Ты MiniSkynet Lightweight Code Draft. Возвращай только JSON с маленькими operation." }, { role: "user", content: prompt }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const parsed = parseJsonLoose(data?.choices?.[0]?.message?.content || "");
  if (!parsed?.operations?.length) throw new Error("model did not return operations");
  return parsed;
}
async function baseChecks(env, p) {
  if (!p.patch_draft) throw new Error("patch_draft missing: run /patch_preview first");
  const target = safePath(p.patch_draft?.target_file || p.file_path || "");
  if (!target) throw new Error("target missing/unsafe");
  const repoCfg = await loadRepoConfig(env);
  const [file, wrangler] = await Promise.all([githubFile(repoCfg, target), githubFile(repoCfg, "cloudflare/wrangler.toml")]);
  const activeMain = activeMainFromWrangler(wrangler.content);
  const blockers = [];
  if (isEntryForwarder(file)) blockers.push("target is entry-forwarder");
  if (p.patch_draft.current_sha && p.patch_draft.current_sha !== file.sha) blockers.push("patch_draft sha differs from current GitHub sha");
  if (requestLooksRuntimeVisible(p) && activeMain && target !== activeMain) blockers.push(`runtime-visible change targets ${target}, but active main is ${activeMain}`);
  return { repoCfg, file, activeMain, blockers };
}
async function generateLightweightCodeDraft(env, proposalId, mode = "lightweight") {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  const base = await baseChecks(env, p);
  if (base.blockers.length) throw new Error(base.blockers.join("; "));
  let spec = deterministicOperation(p, base.file);
  if (!spec) spec = await aiOperation(env, p, base.file);
  let newContent = base.file.content;
  for (const op of spec.operations || []) newContent = applyOperation(newContent, op);
  newContent = normalizeFinalNewline(newContent, base.file.content);
  if (newContent === base.file.content) throw new Error("operations produced identical content");
  const diff = buildFullFileUnifiedDiff(base.file.path, base.file.content, newContent, base.file.sha, "new");
  const patched = applyUnifiedDiff(base.file.content, diff);
  if (patched !== newContent) throw new Error("internal validator: generated diff does not recreate new content");
  p.code_draft = {
    created_at: now(),
    target_file: base.file.path,
    current_sha: base.file.sha,
    summary: clip(spec.summary || p.patch_draft?.intent || p.title || "Lightweight code draft", 600),
    risk: clip(spec.risk || p.patch_draft?.risk || "low", 300),
    unified_diff: diff,
    test_plan: (spec.test_plan || p.patch_draft?.test_plan || ["/status", "/help"]).slice(0, 8).map(x => clip(x, 300)),
    operations: (spec.operations || []).slice(0, 8),
    mode: "lightweight_operations_generated_diff_no_write"
  };
  p.code_draft_validation = { checked_at: now(), target_file: base.file.path, current_sha: base.file.sha, active_main: base.activeMain, ok: true, blockers: [], warnings: [] };
  p.status = "code_draft_ready";
  p.code_draft_ready_at = now();
  await saveProposals(env, proposals);
  return p;
}
function formatDraft(p) {
  const d = p.code_draft || {};
  return [
    `🪶 Lightweight code draft ${p.id}:`,
    `- status: ${p.status}`,
    `- target: ${d.target_file}`,
    `- sha: ${String(d.current_sha || "").slice(0, 12)}`,
    `- validation: ${p.code_draft_validation?.ok ? "valid ✅" : "unknown"}`,
    `- mode: ${d.mode || "—"}`,
    `- risk: ${d.risk || "—"}`,
    "",
    `Summary: ${d.summary || "—"}`,
    "",
    "Operations:",
    ...((d.operations || []).map((op, i) => `${i + 1}. ${op.type}: ${op.anchor || op.old_text || "—"}`)),
    "",
    "Unified diff:",
    clip(d.unified_diff || "", 1700),
    d.unified_diff && d.unified_diff.length > 1700 ? "\n...truncated. Полностью: /code_show prop_id" : "",
    "",
    "Код в GitHub НЕ изменён."
  ].join("\n");
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
  let patched = null;
  if (!blockers.length) {
    try {
      patched = applyUnifiedDiff(base.file.content, p.code_draft.unified_diff);
      if (patched === base.file.content) warnings.push("patch produces identical content");
    } catch (e) { blockers.push(`diff does not apply: ${e.message || e}`); }
  }
  p.code_draft_validation = { checked_at: now(), target_file: base.file.path, current_sha: base.file.sha, active_main: base.activeMain, ok: blockers.length === 0, blockers, warnings };
  await saveProposals(env, proposals);
  return { p, file: base.file, activeMain: base.activeMain, blockers, warnings, patched };
}
function codeCheckText(r) {
  return [
    `🧪 Lightweight code check ${r.p.id}:`,
    `- target: ${r.file.path}`,
    `- sha: ${String(r.file.sha).slice(0, 12)}`,
    `- active main: ${r.activeMain || "—"}`,
    `- status: ${r.blockers.length ? "blocked ⛔" : "valid ✅"}`,
    "",
    r.blockers.length ? "Blockers:" : "Blockers: none",
    ...r.blockers.map(x => `- ${x}`),
    r.warnings.length ? "\nWarnings:" : "\nWarnings: none",
    ...r.warnings.map(x => `- ${x}`),
    "",
    r.blockers.length ? `/code_repair ${r.p.id}` : `/apply_check ${r.p.id}`
  ].join("\n");
}
const COMMANDS = new Set(["/code_preview", "/code_regen", "/code_repair", "/code_check", "/status", "/help"]);
async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/code_preview" || command === "/code_regen" || command === "/code_repair") {
      if (!args) return await send(cfg, chatId, `Формат: ${command} prop_id`);
      const p = await generateLightweightCodeDraft(env, args, command.slice(1));
      return await send(cfg, chatId, formatDraft(p));
    }
    if (command === "/code_check") {
      if (!args) return await send(cfg, chatId, "Формат: /code_check prop_id");
      return await send(cfg, chatId, codeCheckText(await checkCodeDraft(env, args)));
    }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v3.3.1 status`, `- version: ${VERSION}`, `- base: v3.3 validator`, `- lightweight code draft: active`, `- full-file AI generation: disabled`, `- operations: insert_after / replace_exact`, `- write guard: v3.2 /code_approve + /apply_confirm`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "Development stage: " + VERSION,
      "/code_preview prop_id — лёгкий operation-based draft",
      "/code_check prop_id — проверить diff",
      "/code_repair prop_id — пересоздать lightweight draft",
      "/code_regen prop_id — пересоздать lightweight draft",
      "",
      "После valid: /apply_check → /code_approve → /apply_confirm"
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v3.3.1 error: ${clip(e.message || e, 900)}`);
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v3.3-code-draft-validator", lightweight_code_draft: true });
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
