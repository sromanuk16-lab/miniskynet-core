import app from "./index-v29.js";

const VERSION = "v3.0-target-resolver-apply-guard-2026-07-03";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}
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
function parseTwoArgs(args) {
  const s = String(args || "").trim();
  const parts = s.split(/\s+/);
  return { id: parts.shift() || "", path: parts.join(" ").trim() };
}
function isEntryForwarder(file) {
  const c = String(file?.content || "").trim();
  const m = c.match(/^export\s+\{\s*default\s*\}\s+from\s+["']\.\/(index-v\d+\.js)["'];?\s*$/);
  return m ? m[1] : null;
}
function suggestTargetFromEntry(file) {
  const forwarded = isEntryForwarder(file);
  if (!forwarded) return null;
  const base = file.path.split("/").slice(0, -1).join("/");
  return `${base}/${forwarded}`;
}
function targetSummary(p) {
  const d = p.patch_draft || {};
  return [
    `🎯 Proposal target ${p.id}:`,
    `- proposal status: ${p.status}`,
    `- file_path: ${p.file_path || "—"}`,
    `- draft target: ${d.target_file || "—"}`,
    `- draft sha: ${d.current_sha || "—"}`,
    "",
    "Изменить target:",
    `/proposal_target ${p.id} path`,
    `/patch_retarget ${p.id} path`,
    "",
    "Проверить:",
    `/patch_check ${p.id}`
  ].join("\n");
}
async function checkProposal(env, id) {
  const proposals = await getProposals(env);
  const p = findProposal(proposals, id);
  if (!p) throw new Error(`proposal ${id} not found`);
  const target = safePath((p.patch_draft && p.patch_draft.target_file) || p.file_path || "");
  if (!target) return { p, ok: false, blocked: true, reason: "target file is empty/unsafe" };
  const repoCfg = await loadRepoConfig(env);
  const file = await githubFile(repoCfg, target);
  const forwardedTarget = suggestTargetFromEntry(file);
  const warnings = [];
  if (forwardedTarget) warnings.push(`target is only entry-forwarder; real file likely ${forwardedTarget}`);
  if (p.patch_draft?.current_sha && p.patch_draft.current_sha !== file.sha) warnings.push("draft sha differs from current GitHub sha; refresh /patch_preview after retarget/read");
  const blocked = Boolean(forwardedTarget);
  return { p, file, ok: !blocked && warnings.length === 0, blocked, warnings, forwardedTarget };
}
function checkText(result) {
  const { p, file, blocked, warnings, forwardedTarget } = result;
  return [
    `🛡 Patch check ${p.id}:`,
    `- target: ${file?.path || p.file_path || "—"}`,
    `- sha: ${file?.sha ? String(file.sha).slice(0, 12) : "—"}`,
    `- size: ${file?.size || "—"}`,
    `- status: ${blocked ? "blocked ⛔" : warnings?.length ? "warning ⚠️" : "ok ✅"}`,
    "",
    ...(warnings?.length ? ["Warnings:", ...warnings.map(x => `- ${x}`)] : ["Warnings: none"]),
    "",
    forwardedTarget ? `Fix: /patch_retarget ${p.id} ${forwardedTarget}` : `Next: /apply_preview ${p.id}`,
    "",
    "Apply Guard: запись в GitHub всё ещё отключена."
  ].join("\n");
}
function applyPreviewText(result) {
  const { p, file, blocked, warnings, forwardedTarget } = result;
  if (blocked) {
    return [
      `⛔ Apply preview blocked for ${p.id}`,
      `target: ${file?.path || p.file_path || "—"}`,
      "Причина: target выглядит как entry-forwarder, а не реальный файл логики.",
      forwardedTarget ? `Решение: /patch_retarget ${p.id} ${forwardedTarget}` : "Решение: выбрать реальный target file через /patch_retarget.",
      "",
      "Код НЕ изменён."
    ].join("\n");
  }
  const d = p.patch_draft || {};
  return [
    `🧾 Apply preview ${p.id}:`,
    `- target: ${file.path}`,
    `- current sha: ${String(file.sha).slice(0, 12)}`,
    `- draft sha: ${d.current_sha ? String(d.current_sha).slice(0, 12) : "—"}`,
    `- risk: ${d.risk || p.risk || "—"}`,
    "",
    warnings?.length ? "Warnings:" : "Warnings: none",
    ...(warnings || []).map(x => `- ${x}`),
    "",
    "Would change:",
    ...((d.proposed_changes || p.patch_plan || []).slice(0, 10).map((x, i) => `${i + 1}. ${x}`)),
    "",
    "Test plan:",
    ...((d.test_plan || ["/status", "/self_inspect", "/repo_scan"]).map(x => `- ${x}`)),
    "",
    "Rollback:",
    ...((d.rollback || ["revert commit if deploy fails"]).map(x => `- ${x}`)),
    "",
    "Apply/write в GitHub пока отключён. Следующий модуль: apply_after_approve."
  ].join("\n");
}
async function setTarget(env, id, path, mode = "target") {
  const target = safePath(path);
  if (!target) throw new Error("unsafe or empty target path");
  const proposals = await getProposals(env);
  const p = findProposal(proposals, id);
  if (!p) throw new Error(`proposal ${id} not found`);
  const repoCfg = await loadRepoConfig(env);
  const file = await githubFile(repoCfg, target);
  p.file_path = file.path;
  p.target_updated_at = now();
  p.target_guard = { mode, checked_at: now(), path: file.path, sha: file.sha, entry_forwarder_to: suggestTargetFromEntry(file) };
  if (p.patch_draft) {
    p.patch_draft.target_file = file.path;
    p.patch_draft.current_sha = file.sha;
    p.patch_draft.retargeted_at = now();
  }
  await saveProposals(env, proposals);
  return { p, file, forwardedTarget: suggestTargetFromEntry(file) };
}
const COMMANDS = new Set(["/proposal_target", "/patch_retarget", "/patch_check", "/apply_preview", "/status", "/help"]);
async function handleCommand(env, cfg, msg) {
  const { chatId, command, args } = msg;
  try {
    if (command === "/proposal_target") {
      const parsed = parseTwoArgs(args);
      if (!parsed.id || !parsed.path) return await send(cfg, chatId, "Формат: /proposal_target prop_id cloudflare/src/index-v29.js");
      const { p, file, forwardedTarget } = await setTarget(env, parsed.id, parsed.path, "proposal_target");
      return await send(cfg, chatId, [`✅ Target обновлён для ${p.id}:`, `- ${file.path}`, `- sha=${String(file.sha).slice(0, 12)}`, forwardedTarget ? `⚠️ Это entry-forwarder → ${forwardedTarget}` : "✅ Файл не похож на пустой entry-forwarder", "", `/patch_check ${p.id}`].join("\n"));
    }
    if (command === "/patch_retarget") {
      const parsed = parseTwoArgs(args);
      if (!parsed.id || !parsed.path) return await send(cfg, chatId, "Формат: /patch_retarget prop_id cloudflare/src/index-v29.js");
      const { p, file, forwardedTarget } = await setTarget(env, parsed.id, parsed.path, "patch_retarget");
      return await send(cfg, chatId, [`🎯 Patch retargeted ${p.id}:`, `- ${file.path}`, `- sha=${String(file.sha).slice(0, 12)}`, forwardedTarget ? `⚠️ Это entry-forwarder → ${forwardedTarget}` : "✅ Target выглядит рабочим", "", `Теперь: /patch_preview ${p.id}`, `Потом: /patch_check ${p.id}`].join("\n"));
    }
    if (command === "/patch_check") {
      if (!args) return await send(cfg, chatId, "Формат: /patch_check prop_id");
      return await send(cfg, chatId, checkText(await checkProposal(env, args)));
    }
    if (command === "/apply_preview") {
      if (!args) return await send(cfg, chatId, "Формат: /apply_preview prop_id");
      return await send(cfg, chatId, applyPreviewText(await checkProposal(env, args)));
    }
    if (command === "/status") return await send(cfg, chatId, [`📡 MiniSkynet v3.0 status`, `- version: ${VERSION}`, `- base: v2.9 patch draft`, `- target resolver: active`, `- apply guard: active`, `- writes to GitHub: disabled`, `- commands: /proposal_target /patch_retarget /patch_check /apply_preview`].join("\n"));
    if (command === "/help") return await send(cfg, chatId, [
      "/start /help /status",
      "/proposal_target prop_id path — задать target file proposal",
      "/patch_retarget prop_id path — сменить target draft",
      "/patch_check prop_id — проверить target и guard",
      "/apply_preview prop_id — preview без записи",
      "",
      "Остальное из v2.9: /repo_scan /propose /patch_plan /patch_preview /patch_drafts",
      "Apply/write в GitHub ещё отключены."
    ].join("\n"));
  } catch (e) {
    return await send(cfg, chatId, `❌ v3.0 error: ${clip(e.message || e, 700)}`);
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, version: VERSION, base: "v2.9-patch-draft", target_resolver: true, apply_guard: true, writes: false });
    if (url.pathname === "/telegram" && request.method === "POST") {
      const cfg = await loadTelegramConfig(env);
      const update = await request.clone().json().catch(() => null);
      const msg = update ? parseUpdate(update) : null;
      if (msg && COMMANDS.has(msg.command)) {
        if (!isOwner(cfg, msg.userId)) {
          await send(cfg, msg.chatId, "⛔ Доступ закрыт.").catch(() => null);
          return json({ ok: true, denied: true });
        }
        ctx.waitUntil(handleCommand(env, cfg, msg).catch(err => send(cfg, msg.chatId, `❌ v3.0 internal error: ${clip(err, 400)}`).catch(() => null)));
        return json({ ok: true, target_resolver: true });
      }
    }
    return app.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    return app.scheduled(event, env, ctx);
  }
};
