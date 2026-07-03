import app from "./index-v30.js";

const VERSION = "v3.1-exact-code-draft-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";

function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS }); }
function now() { return new Date().toISOString(); }
function clip(s, n = 3900) { return String(s || "").slice(0, n); }
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
  const c = String(file?.content || "").trim();
  return /^export\s+\{\s*default\s*\}\s+from\s+["']\.\/index-v\d+\.js["'];?\s*$/.test(c);
}
async function chat(ai, prompt) {
  if (!ai.key) throw new Error("OPENROUTER_API_KEY missing");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + ai.key },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.1,
      max_tokens: 2200,
      messages: [
        { role: "system", content: "Ты MiniSkynet Exact Code Draft v3.1. Возвращай только валидный JSON. Не пиши, что код применён. Создай точный unified diff, но не полный файл." },
        { role: "user", content: prompt }
      ]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data?.choices?.[0]?.message?.content || "";
}
function ensureCanDraft(p, file) {
  if (!p.patch_draft) throw new Error("patch_draft missing: run /patch_preview prop_id first");
  if (isEntryForwarder(file)) throw new Error("target is entry-forwarder: run /patch_retarget prop_id real-file.js");
  if (p.patch_draft.current_sha && p.patch_draft.current_sha !== file.sha) throw new Error("target sha changed: rerun /patch_preview prop_id before code draft");
}
function formatCodeDraft(p, full = false) {
  const d = p.code_draft || {};
  if (!d.unified_diff) return `Code draft for ${p.id} отсутствует. Сделай: /code_preview ${p.id}`;
  const diff = full ? d.unified_diff : clip(d.unified_diff, 1700);
  return [
    `🧬 Code draft ${p.id}:`,
    `- status: ${p.status}`,
    `- target: ${d.target_file}`,
    `- sha: ${String(d.current_sha || "").slice(0, 12)}`,
    `- risk: ${d.risk || "—"}`,
    `- mode: exact_unified_diff / no_write`,
    "",
    `Summary: ${d.summary || "—"}`,
    "",
    "Unified diff:",
    diff,
    (!full && d.unified_diff.length > 1700) ? "\n...truncated. Полностью: /code_show prop_id" : "",
    "",
    "Test plan:",
    ...((d.test_plan || []).map(x => `- ${x}`)),
    "",
    "Код в GitHub НЕ изменён. Следующий модуль: apply_after_approve."
  ].join("\n");
}
async function makeCodeDraft(env, proposalId) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  const target = safePath(p.patch_draft?.target_file || p.file_path || "");
  if (!target) throw new Error("target file missing/unsafe");
  const repoCfg = await loadRepoConfig(env);
  const file = await githubFile(repoCfg, target);
  ensureCanDraft(p, file);
  const ai = await loadAiConfig(env);
  const prompt = [
    "Создай exact code draft в формате unified diff.",
    "Верни строго JSON:",
    "{\"summary\":\"...\",\"risk\":\"low|medium|high + reason\",\"unified_diff\":\"diff --git ...\",\"test_plan\":[\"...\"],\"notes\":[\"...\"]}",
    "Правила:",
    "- diff должен менять только target file;",
    "- не добавляй apply/write;",
    "- не трогай токены/секреты;",
    "- изменение должно быть минимальным;",
    "- если proposal плохой, верни diff пустым и объясни в notes.",
    "Proposal:",
    JSON.stringify({ id: p.id, title: p.title, request: p.request, summary: p.summary, patch_draft: p.patch_draft, checked_files: p.checked_files }, null, 2),
    "Target file:",
    `path=${file.path}, sha=${file.sha}, size=${file.size}`,
    file.content.slice(0, 12000)
  ].join("\n\n");
  const raw = await chat(ai, prompt);
  const parsed = parseJsonLoose(raw) || {};
  const unified = String(parsed.unified_diff || "").trim();
  if (!unified) throw new Error("model did not return unified_diff");
  p.code_draft = {
    created_at: now(),
    target_file: file.path,
    current_sha: file.sha,
    summary: clip(parsed.summary || p.patch_draft?.intent || p.title || "Code draft", 600),
    risk: clip(parsed.risk || p.patch_draft?.risk || "medium", 300),
    unified_diff: clip(unified, 12000),
    test_plan: (parsed.test_plan || p.patch_draft?.test_plan || ["/status", "/help"]).slice(0, 8).map(x => clip(x, 300)),
    notes: (parsed.notes || []).slice(0, 8).map(x => clip(x, 300)),
    mode: "exact_unified_diff_no_write"
  };
  p.status = "code_draft_ready";
  p.code_draft_ready_at = now();
  await saveProposals(env, proposals);
  return p;
}
async function clearCodeDraft(env, proposalId) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  delete p.code_draft;
  if (p.status === "code_draft_ready") p.status = "draft_ready";
  await saveProposals(env, proposals);
  return p;
}
async function listCodeDrafts(env) {
  const proposals = await getProposals(env);
  const list = proposals.filter(p => p.code_draft);
  return list.length
    ? "🧬 Code drafts:\n" + list.slice(-10).map(p => `- ${p.id} [${p.status}] ${p.code_draft.target_file}`).join("\n")
    : "Code drafts пока нет. Сделай: /code_preview prop_id";
}
const COMMANDS = new Set(["/code_preview", "/code_show", "/code_drafts", "/code_clear", "/status", "/help"]);
async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/code_preview") {
      if (!args) return await send(cfg, chatId, "Формат: /code_preview prop_id");
      const p = await makeCodeDraft(env, args);
      return await send(cfg, chatId, formatCodeDraft(p, false));
    }
    if (command === "/code_show") {
      if (!args) return await send(cfg, chatId, "Формат: /code_show prop_id");
      const p = findProposal(await getProposals(env), args);
      if (!p) return await send(cfg, chatId, `Не нашёл proposal ${args}.`);
      return await send(cfg, chatId, formatCodeDraft(p, true));
    }
    if (command === "/code_drafts") return await send(cfg, chatId, await listCodeDrafts(env));
    if (command === "/code_clear") {
      if (!args) return await send(cfg, chatId, "Формат: /code_clear prop_id");
      const p = await clearCodeDraft(env, args);
      return await send(cfg, chatId, `🧹 Code draft очищен: ${p.id}`);
    }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v3.1 status`, `- version: ${VERSION}`, `- base: v3.0 target resolver/apply guard`, `- exact code draft: active`, `- output: unified diff`, `- writes to GitHub: disabled`, `- commands: /code_preview /code_show /code_drafts /code_clear`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "/code_preview prop_id — создать exact unified diff без записи",
      "/code_show prop_id — показать полный diff",
      "/code_drafts — список code drafts",
      "/code_clear prop_id — удалить code draft",
      "",
      "Перед этим: /repo_scan → /propose → /patch_preview → /patch_check → /apply_preview",
      "Apply/write в GitHub ещё отключены."
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v3.1 error: ${clip(e.message || e, 900)}`);
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v3.0-target-resolver", code_draft: true, writes: false });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v3.1 internal error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, code_draft: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  }
};
