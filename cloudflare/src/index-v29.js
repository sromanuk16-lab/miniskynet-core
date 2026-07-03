import app from "./index-v28.js";

const VERSION = "v2.9-patch-draft-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";
const READ_TTL_MS = 2 * 60 * 60 * 1000;

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
async function getReadLog(env) { return (await kvGet(env, "repo:read_log", { reads: [] })).reads || []; }
async function recentReads(env) {
  const cutoff = Date.now() - READ_TTL_MS;
  return (await getReadLog(env)).filter(r => Date.parse(r.time || 0) >= cutoff);
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
async function chat(ai, prompt) {
  if (!ai.key) throw new Error("OPENROUTER_API_KEY missing");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + ai.key },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: "system", content: "Ты MiniSkynet Patch Draft v2.9. Пиши по-русски, строго JSON. Не придумывай, что код применён. Только draft/plan." },
        { role: "user", content: prompt }
      ]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data?.choices?.[0]?.message?.content || "";
}
function findProposal(list, id) {
  const key = String(id || "").trim();
  return list.find(p => p.id === key || String(p.id || "").startsWith(key)) || null;
}
function patchPlanText(p, reads) {
  return [
    `🧩 Patch plan for ${p.id}:`,
    `- proposal: ${p.title || p.request || "—"}`,
    `- target file: ${p.file_path || "—"}`,
    `- status: ${p.status}`,
    `- gate: ${p.gate?.passed ? "repo read passed ✅" : "unknown/old ⚠️"}`,
    "",
    "Checked files from proposal:",
    ...((p.checked_files || []).length ? p.checked_files.map(x => `- ${x}`) : ["- нет"]),
    "",
    `Fresh repo reads: ${reads.length}`,
    ...(reads.slice(-8).map(r => `- ${r.path} sha=${String(r.sha || "").slice(0, 10)}`)),
    "",
    "Следующий шаг:",
    `/patch_preview ${p.id}`,
    "",
    "Важно: это draft. Код в GitHub не меняю."
  ].join("\n");
}
function formatDraft(p) {
  const d = p.patch_draft || {};
  return [
    `🧪 Patch preview ${p.id}:`,
    `- status: ${p.status}`,
    `- target: ${d.target_file || p.file_path || "—"}`,
    `- current sha: ${d.current_sha || "—"}`,
    `- risk: ${d.risk || "—"}`,
    "",
    `Intent: ${d.intent || "—"}`,
    "",
    "Evidence:",
    ...((d.evidence || []).length ? d.evidence.map(x => `- ${x}`) : ["- —"]),
    "",
    "Proposed changes:",
    ...((d.proposed_changes || []).length ? d.proposed_changes.map((x, i) => `${i + 1}. ${x}`) : ["1. —"]),
    "",
    "Test plan:",
    ...((d.test_plan || []).length ? d.test_plan.map(x => `- ${x}`) : ["- /status", "- /self_inspect"]),
    "",
    "Rollback:",
    ...((d.rollback || []).length ? d.rollback.map(x => `- ${x}`) : ["- revert commit if deploy fails"]),
    "",
    "Следующий модуль будет apply после approve. Сейчас код НЕ изменён."
  ].join("\n");
}
async function makePatchDraft(env, proposalId) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, proposalId);
  if (!p) throw new Error(`proposal ${proposalId} not found`);
  if (!p.gate?.passed && !(p.checked_files || []).length) throw new Error("proposal has no repo gate/checked_files");
  const target = safePath(p.file_path || (p.checked_files || [])[0] || "cloudflare/src/index.js");
  if (!target) throw new Error("proposal target file is unsafe/empty");
  const repoCfg = await loadRepoConfig(env);
  const targetFile = await githubFile(repoCfg, target);
  const ai = await loadAiConfig(env);
  const prompt = [
    "Создай patch draft, но НЕ полный файл и НЕ diff. Только безопасный план изменения.",
    "Верни строго JSON с полями:",
    "{ target_file, intent, evidence:[...], proposed_changes:[...], risk, test_plan:[...], rollback:[...] }",
    "Контекст proposal:",
    JSON.stringify({ id: p.id, title: p.title, request: p.request, summary: p.summary, description: p.description, patch_plan: p.patch_plan, checked_files: p.checked_files }, null, 2),
    "Текущий target file:",
    `path=${targetFile.path}, sha=${targetFile.sha}, size=${targetFile.size}`,
    targetFile.content.slice(0, 9000),
    "Правила: не заявляй, что код применён; не меняй GitHub; предложи минимальный безопасный patch plan."
  ].join("\n\n");
  const raw = await chat(ai, prompt);
  const parsed = parseJsonLoose(raw) || {};
  const draft = {
    created_at: now(),
    target_file: targetFile.path,
    current_sha: targetFile.sha,
    intent: clip(parsed.intent || p.request || p.title || "Patch draft", 500),
    evidence: (parsed.evidence || []).slice(0, 8).map(x => clip(x, 300)),
    proposed_changes: (parsed.proposed_changes || parsed.steps || []).slice(0, 10).map(x => clip(x, 400)),
    risk: clip(parsed.risk || "medium", 300),
    test_plan: (parsed.test_plan || []).slice(0, 8).map(x => clip(x, 300)),
    rollback: (parsed.rollback || []).slice(0, 6).map(x => clip(x, 300)),
    mode: "draft_only_no_write"
  };
  if (!draft.proposed_changes.length) draft.proposed_changes = ["Сначала уточнить target file и повторить /repo_file перед apply."];
  p.patch_draft = draft;
  p.status = p.status === "pending" ? "draft_ready" : p.status;
  p.draft_ready_at = now();
  await saveProposals(env, proposals);
  return p;
}
async function listPatchDrafts(env) {
  const proposals = await getProposals(env);
  const withDraft = proposals.filter(p => p.patch_draft);
  return withDraft.length
    ? "🧪 Patch drafts:\n" + withDraft.slice(-10).map(p => `- ${p.id} [${p.status}] ${p.patch_draft.target_file}`).join("\n")
    : "Patch drafts пока нет. Сначала: /proposals → /patch_plan id → /patch_preview id";
}
const COMMANDS = new Set(["/patch_plan", "/patch_preview", "/patch_drafts", "/patch_clear", "/status", "/help"]);
async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/patch_plan") {
      if (!args) return await send(cfg, chatId, "Формат: /patch_plan prop_id");
      const proposals = await getProposals(env);
      const p = findProposal(proposals, args);
      if (!p) return await send(cfg, chatId, `Не нашёл proposal ${args}. Смотри /proposals`);
      return await send(cfg, chatId, patchPlanText(p, await recentReads(env)));
    }
    if (command === "/patch_preview") {
      if (!args) return await send(cfg, chatId, "Формат: /patch_preview prop_id");
      const p = await makePatchDraft(env, args);
      return await send(cfg, chatId, formatDraft(p));
    }
    if (command === "/patch_drafts") return await send(cfg, chatId, await listPatchDrafts(env));
    if (command === "/patch_clear") {
      const proposals = await getProposals(env);
      const p = findProposal(proposals, args);
      if (!p) return await send(cfg, chatId, `Не нашёл proposal ${args}.`);
      delete p.patch_draft;
      if (p.status === "draft_ready") p.status = "pending";
      await saveProposals(env, proposals);
      return await send(cfg, chatId, `🧹 Убрал draft у ${p.id}.`);
    }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v2.9 status`, `- version: ${VERSION}`, `- base: v2.8 proposal gate`, `- patch draft: active`, `- writes to GitHub: disabled`, `- commands: /patch_plan /patch_preview /patch_drafts /patch_clear`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "/repo_scan /repo_file /proposal_gate /propose /proposals /show",
      "/patch_plan prop_id — план по proposal",
      "/patch_preview prop_id — создать draft без записи в GitHub",
      "/patch_drafts — список drafts",
      "/patch_clear prop_id — удалить draft",
      "",
      "Apply/write в GitHub ещё отключены."
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v2.9 error: ${clip(e.message || e, 700)}`);
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v2.8-proposal-gate", patch_draft: true, writes: false });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v2.9 internal error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, patch_draft: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  }
};
