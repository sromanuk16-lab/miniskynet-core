import app from "./index-v32.js";

const VERSION = "v3.3-code-draft-validator-regenerator-2026-07-03";
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
function stripCodeFence(s) {
  let x = String(s || "");
  const m = x.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (m) x = m[1];
  return x;
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
  const s = compact(`${p.title || ""} ${p.request || ""} ${p.summary || ""} ${p.description || ""} ${p.patch_draft?.intent || ""}`);
  return /help|status|stage|command|команд|статус|стейдж|development/.test(s);
}
function normalizeFinalNewline(text, reference) {
  let x = String(text || "");
  if (reference.endsWith("\n") && !x.endsWith("\n")) x += "\n";
  if (!reference.endsWith("\n") && x.endsWith("\n")) x = x.replace(/\n+$/, "");
  return x;
}
function splitNoFinalNewline(s) { return String(s || "").replace(/\n$/, "").split("\n"); }
function buildFullFileUnifiedDiff(path, oldContent, newContent, oldSha = "old", newSha = "new") {
  const oldLines = splitNoFinalNewline(oldContent);
  const newLines = splitNoFinalNewline(newContent);
  const header = [
    `diff --git a/${path} b/${path}`,
    `index ${String(oldSha).slice(0, 7)}..${String(newSha).slice(0, 7)} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`
  ];
  return [...header, ...oldLines.map(l => `-${l}`), ...newLines.map(l => `+${l}`)].join("\n") + "\n";
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
async function chat(ai, prompt) {
  if (!ai.key) throw new Error("OPENROUTER_API_KEY missing");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + ai.key },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.1,
      max_tokens: 7000,
      messages: [
        { role: "system", content: "Ты MiniSkynet Code Draft Validator v3.3. Возвращай только JSON. Не применяй код. Твоя задача — вернуть полный новый файл new_content, чтобы система сама построила валидный diff." },
        { role: "user", content: prompt }
      ]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data?.choices?.[0]?.message?.content || "";
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
  return { repoCfg, file, wrangler, activeMain, blockers };
}
function validateDraftAgainstFile(p, file, activeMain) {
  const blockers = [];
  const warnings = [];
  if (!p.code_draft) blockers.push("code_draft missing");
  if (p.code_draft && p.code_draft.current_sha !== file.sha) blockers.push("code_draft sha differs from current GitHub sha");
  if (isEntryForwarder(file)) blockers.push("target is entry-forwarder");
  if (requestLooksRuntimeVisible(p) && activeMain && p.code_draft?.target_file !== activeMain) blockers.push(`runtime-visible change targets ${p.code_draft?.target_file}, but active main is ${activeMain}`);
  let patched = null;
  if (!blockers.length) {
    try {
      patched = applyUnifiedDiff(file.content, p.code_draft.unified_diff);
      if (patched === file.content) warnings.push("patch produces identical content");
    } catch (e) {
      blockers.push(`diff does not apply: ${e.message || e}`);
    }
  }
  return { blockers, warnings, patched };
}
async function checkCodeDraft(env, proposalId) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  const target = safePath(p.code_draft?.target_file || p.patch_draft?.target_file || p.file_path || "");
  if (!target) throw new Error("target missing/unsafe");
  const repoCfg = await loadRepoConfig(env);
  const [file, wrangler] = await Promise.all([githubFile(repoCfg, target), githubFile(repoCfg, "cloudflare/wrangler.toml")]);
  const activeMain = activeMainFromWrangler(wrangler.content);
  const result = validateDraftAgainstFile(p, file, activeMain);
  p.code_draft_validation = { checked_at: now(), target_file: file.path, current_sha: file.sha, active_main: activeMain, ok: result.blockers.length === 0, blockers: result.blockers, warnings: result.warnings };
  await saveProposals(env, proposals);
  return { p, file, activeMain, ...result };
}
function codeCheckText(r) {
  return [
    `🧪 Code check ${r.p.id}:`,
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
function formatDraft(p) {
  const d = p.code_draft || {};
  return [
    `🧬 Validated code draft ${p.id}:`,
    `- status: ${p.status}`,
    `- target: ${d.target_file}`,
    `- sha: ${String(d.current_sha || "").slice(0, 12)}`,
    `- validation: ${p.code_draft_validation?.ok ? "valid ✅" : "unknown"}`,
    `- risk: ${d.risk || "—"}`,
    "",
    `Summary: ${d.summary || "—"}`,
    "",
    "Unified diff:",
    clip(d.unified_diff || "", 1700),
    d.unified_diff && d.unified_diff.length > 1700 ? "\n...truncated. Полностью: /code_show prop_id" : "",
    "",
    "Код в GitHub НЕ изменён."
  ].join("\n");
}
async function generateValidatedCodeDraft(env, proposalId, mode = "regen") {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  const base = await baseChecks(env, p);
  if (base.blockers.length) throw new Error(base.blockers.join("; "));
  const ai = await loadAiConfig(env);
  const repairContext = p.code_draft_validation?.blockers?.length ? `Previous draft failed: ${p.code_draft_validation.blockers.join("; ")}` : "No previous validation error.";
  const prompt = [
    "Создай полный новый target file как new_content. Система сама построит валидный unified diff и проверит его в памяти.",
    "Верни строго JSON:",
    "{\"summary\":\"...\",\"risk\":\"low|medium|high + reason\",\"new_content\":\"FULL FILE CONTENT HERE\",\"test_plan\":[\"...\"],\"notes\":[\"...\"]}",
    "Правила:",
    "- new_content должен быть полным содержимым target file, не фрагментом;",
    "- не используй markdown fences;",
    "- изменение минимальное;",
    "- не трогай токены/секреты;",
    "- сохраняй весь существующий код, кроме нужного изменения;",
    "- не добавляй apply/write без запроса;",
    repairContext,
    `Mode: ${mode}`,
    "Proposal:",
    JSON.stringify({ id: p.id, title: p.title, request: p.request, summary: p.summary, patch_draft: p.patch_draft, checked_files: p.checked_files }, null, 2),
    "Current target file:",
    `path=${base.file.path}, sha=${base.file.sha}, size=${base.file.size}`,
    base.file.content
  ].join("\n\n");
  const raw = await chat(ai, prompt);
  const parsed = parseJsonLoose(raw) || {};
  let newContent = stripCodeFence(parsed.new_content || parsed.full_new_content || parsed.content || "");
  if (!newContent) throw new Error("model did not return new_content");
  newContent = normalizeFinalNewline(newContent, base.file.content);
  if (newContent === base.file.content) throw new Error("new_content is identical to current file");
  const diff = buildFullFileUnifiedDiff(base.file.path, base.file.content, newContent, base.file.sha, "new");
  const patched = applyUnifiedDiff(base.file.content, diff);
  if (patched !== newContent) throw new Error("internal validator: generated diff does not recreate new_content");
  p.code_draft = {
    created_at: now(),
    target_file: base.file.path,
    current_sha: base.file.sha,
    summary: clip(parsed.summary || p.patch_draft?.intent || p.title || "Validated code draft", 600),
    risk: clip(parsed.risk || p.patch_draft?.risk || "medium", 300),
    unified_diff: diff,
    test_plan: (parsed.test_plan || p.patch_draft?.test_plan || ["/status", "/help"]).slice(0, 8).map(x => clip(x, 300)),
    notes: (parsed.notes || []).slice(0, 8).map(x => clip(x, 300)),
    mode: "validated_full_file_generated_diff_no_write"
  };
  p.code_draft_validation = { checked_at: now(), target_file: base.file.path, current_sha: base.file.sha, active_main: base.activeMain, ok: true, blockers: [], warnings: [] };
  p.status = "code_draft_ready";
  p.code_draft_ready_at = now();
  await saveProposals(env, proposals);
  return p;
}
const COMMANDS = new Set(["/code_preview", "/code_regen", "/code_repair", "/code_check", "/status", "/help"]);
async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/code_preview" || command === "/code_regen") {
      if (!args) return await send(cfg, chatId, `Формат: ${command} prop_id`);
      const p = await generateValidatedCodeDraft(env, args, command.slice(1));
      return await send(cfg, chatId, formatDraft(p));
    }
    if (command === "/code_repair") {
      if (!args) return await send(cfg, chatId, "Формат: /code_repair prop_id");
      const p = await generateValidatedCodeDraft(env, args, "repair_failed_diff");
      return await send(cfg, chatId, formatDraft(p));
    }
    if (command === "/code_check") {
      if (!args) return await send(cfg, chatId, "Формат: /code_check prop_id");
      return await send(cfg, chatId, codeCheckText(await checkCodeDraft(env, args)));
    }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v3.3 status`, `- version: ${VERSION}`, `- base: v3.2 apply after approve`, `- code draft validator: active`, `- code regen/repair: active`, `- GitHub write: still only through v3.2 /code_approve + /apply_confirm`, `- commands: /code_preview /code_check /code_repair /code_regen`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "/code_preview prop_id — создать validated code draft",
      "/code_check prop_id — проверить, применится ли diff",
      "/code_repair prop_id — пересоздать diff после mismatch",
      "/code_regen prop_id — пересоздать validated diff",
      "",
      "После valid: /apply_check → /code_approve → /apply_confirm",
      "Write guard остаётся в v3.2."
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v3.3 error: ${clip(e.message || e, 900)}`);
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v3.2-apply-after-code-approve", code_validator: true });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v3.3 internal error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, code_validator: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) { return app.scheduled(event, env, ctx); }
};
