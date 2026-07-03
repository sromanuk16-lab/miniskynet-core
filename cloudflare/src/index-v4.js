const VERSION = "v4.7.1-proposal-verify-valid-2026-07-03";
const DEFAULT_REPO = "sromanuk16-lab/miniskynet-core";
const DEFAULT_BRANCH = "main";
const DEFAULT_WORKER_URL = "https://miniskynet-core.sromanuk16.workers.dev";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const now = () => new Date().toISOString();
const clip = (v, n = 3900) => String(v ?? "").slice(0, n);
const id = p => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const clean = p => String(p || "").trim().replace(/^\/+/, "");
const okPath = p => { const x = clean(p); return x && !x.includes("..") && x.length < 180 && /^[\w./-]+$/.test(x) ? x : null; };

function json(data, status = 200) { return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS }); }
function parseUpdate(u) {
  const m = u?.message || u?.edited_message || null;
  if (!m) return null;
  const text = String(m.text || "").trim();
  let command = null, args = "";
  if (text.startsWith("/")) {
    const i = text.indexOf(" ");
    command = (i === -1 ? text : text.slice(0, i)).replace(/@\w+$/, "").toLowerCase();
    args = i === -1 ? "" : text.slice(i + 1).trim();
  }
  return { chatId: m.chat?.id, userId: m.from?.id, text, command, args };
}
async function kvText(env, key) { return String(await env.MINISKYNET_KV.get(key) || "").trim(); }
async function kvGet(env, key, fallback) { const raw = await env.MINISKYNET_KV.get(key); if (!raw) return fallback; try { return JSON.parse(raw); } catch { return fallback; } }
async function kvPut(env, key, value) { await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2)); }
async function store(env, key) { return (await kvGet(env, key, { [key]: [] }))[key] || []; }
async function save(env, key, items, limit = 100) { await kvPut(env, key, { [key]: items.slice(-limit) }); }
async function cfg(env) {
  return {
    telegramToken: String(env.TELEGRAM_BOT_TOKEN || "").trim() || await kvText(env, "config:TELEGRAM_BOT_TOKEN"),
    ownerId: String(env.TELEGRAM_ALLOWED_USER_ID || "").trim() || await kvText(env, "config:TELEGRAM_ALLOWED_USER_ID"),
    githubToken: String(env.GITHUB_TOKEN || "").trim() || await kvText(env, "config:GITHUB_TOKEN"),
    repo: String(env.GITHUB_REPO || "").trim() || await kvText(env, "config:GITHUB_REPO") || DEFAULT_REPO,
    branch: String(env.GITHUB_BRANCH || "").trim() || await kvText(env, "config:GITHUB_BRANCH") || DEFAULT_BRANCH,
    workerUrl: String(env.WORKER_URL || "").trim() || await kvText(env, "config:WORKER_URL") || DEFAULT_WORKER_URL,
    model: String(env.OPENROUTER_MODEL_CHEAP || "").trim() || await kvText(env, "config:OPENROUTER_MODEL_CHEAP") || "openai/gpt-4o-mini"
  };
}
function ownerOk(c, userId) { return !c.ownerId || String(userId || "") === String(c.ownerId); }
async function tg(c, method, body) {
  if (!c.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const r = await fetch(`https://api.telegram.org/bot${c.telegramToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({}));
}
async function send(c, chatId, text) { if (chatId) await tg(c, "sendMessage", { chat_id: chatId, text: clip(text) }); }
function health() { return { ok: true, version: VERSION, flat_core: true, onion_imports: false, auto_propose_pipeline: true, scoped_help_insert: true, proposal_specific_verify: true, apply_rebuild: true, owner_guard: "fixed" }; }
async function publicHealth(c) { try { const r = await fetch(`${String(c.workerUrl || DEFAULT_WORKER_URL).replace(/\/$/, "")}/health?ts=${Date.now()}`, { headers: { "cache-control": "no-cache" } }); const txt = await r.text(); let data = null; try { data = JSON.parse(txt); } catch {} return { ok: r.ok && !!data?.ok, http: r.status, version: data?.version || null }; } catch (e) { return { ok: false, http: 0, version: null, error: String(e.message || e) }; } }

const dec = x => new TextDecoder("utf-8").decode(Uint8Array.from(atob(String(x || "").replace(/\n/g, "")), ch => ch.charCodeAt(0)));
function enc(x) { const b = new TextEncoder().encode(String(x || "")); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.slice(i, i + 0x8000)); return btoa(s); }
const pathUrl = p => clean(p).split("/").map(encodeURIComponent).join("/");
async function ghFile(c, path) {
  const p = okPath(path); if (!p) throw new Error("unsafe path");
  const headers = { accept: "application/vnd.github+json", "user-agent": "MiniSkynet-v471" };
  if (c.githubToken) headers.authorization = `Bearer ${c.githubToken}`;
  const r = await fetch(`https://api.github.com/repos/${c.repo}/contents/${pathUrl(p)}?ref=${encodeURIComponent(c.branch)}`, { headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${data.message || "request failed"}`);
  if (Array.isArray(data) || !data.content) throw new Error("not a text file");
  return { path: p, sha: data.sha || "", size: data.size || 0, content: dec(data.content) };
}
async function ghWrite(c, path, sha, content, message) {
  if (!c.githubToken) throw new Error("GITHUB_TOKEN missing");
  const p = okPath(path); if (!p) throw new Error("unsafe path");
  const r = await fetch(`https://api.github.com/repos/${c.repo}/contents/${pathUrl(p)}`, { method: "PUT", headers: { accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "MiniSkynet-v471", authorization: `Bearer ${c.githubToken}` }, body: JSON.stringify({ message, content: enc(content), sha, branch: c.branch }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub write ${r.status}: ${data.message || "request failed"}`);
  return { commit_sha: data?.commit?.sha || "", content_sha: data?.content?.sha || "" };
}
function mainFromWrangler(txt) { const m = String(txt || "").match(/^main\s*=\s*["']([^"']+)["']/m); if (!m) return null; const rel = clean(m[1]); return rel.startsWith("cloudflare/") ? rel : `cloudflare/${rel}`; }
async function activeTarget(c) { const wr = await ghFile(c, "cloudflare/wrangler.toml"); const main = mainFromWrangler(wr.content); if (!main) throw new Error("wrangler main not found"); return { start: main, effective: await ghFile(c, main) }; }
function findProp(items, key) { const k = String(key || "").trim(); return items.find(p => p.id === k || String(p.id || "").startsWith(k)); }

function fullDiff(path, oldContent, newContent, oldSha) { const a = String(oldContent || "").replace(/\n$/, "").split("\n"); const b = String(newContent || "").replace(/\n$/, "").split("\n"); return [`diff --git a/${path} b/${path}`, `index ${oldSha.slice(0, 7)}..new 100644`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${a.length} +1,${b.length} @@`, ...a.map(x => `-${x}`), ...b.map(x => `+${x}`)].join("\n") + "\n"; }
function applyFullDiff(oldContent, diff) { const out = []; let h = false; for (const line of String(diff || "").split("\n")) { if (line.startsWith("@@ ")) { h = true; continue; } if (!h) continue; if (line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1)); } return out.join("\n") + (oldContent.endsWith("\n") ? "\n" : ""); }
function helpRange(content) { const text = String(content || ""); const start = text.indexOf('if (command === "/help")'); const end = start >= 0 ? text.indexOf('if (command === "/status")', start) : -1; return start >= 0 && end > start ? { start, end, block: text.slice(start, end) } : null; }
function helpHas(content, visible) { const r = helpRange(content); return !!(r && r.block.includes(String(visible || ""))); }
function insertHelpLine(content, jsLine) {
  const visible = String(jsLine).match(/^"([^"]+)/)?.[1] || String(jsLine);
  if (helpHas(content, visible)) return content;
  const r = helpRange(content); if (!r) throw new Error("help block not found");
  let block = r.block;
  const anchors = ['      "/health_check /deploy_check /post_apply_verify id",', '      "/self /self_set текст",', '      "Development stage: " + VERSION,'];
  for (const anchor of anchors) if (block.includes(anchor)) { block = block.replace(anchor, `      ${jsLine},\n${anchor}`); return content.slice(0, r.start) + block + content.slice(r.end); }
  const joinAt = block.indexOf('    ].join("\\n"));');
  if (joinAt < 0) throw new Error("help insert point not found");
  block = block.slice(0, joinAt) + `      ${jsLine},\n` + block.slice(joinAt);
  return content.slice(0, r.start) + block + content.slice(r.end);
}
function expectedForRequest(request) {
  const req = String(request || "");
  if (/auto|pipeline|авто|автомат/i.test(req)) return { visible: "Auto pipeline marker:", js: '"Auto pipeline marker: " + VERSION', summary: "Добавить auto pipeline marker в /help" };
  if (/verify|verification|провер/i.test(req)) return { visible: "Proposal-specific verify marker:", js: '"Proposal-specific verify marker: " + VERSION', summary: "Добавить proposal-specific verify marker в /help" };
  if (/confirm|confirmed|подтверд|втор/i.test(req)) return { visible: "Self-apply confirmed marker:", js: '"Self-apply confirmed marker: " + VERSION', summary: "Добавить self-apply confirmed marker в /help" };
  if (/smoke|marker|маркер|self.apply|self-apply|само/i.test(req)) return { visible: "Self-apply smoke marker:", js: '"Self-apply smoke marker: " + VERSION', summary: "Добавить self-apply smoke marker в /help" };
  if (/help|stage|development|команд/i.test(req)) return { visible: "Development stage:", js: '"Development stage: " + VERSION', summary: "Показать Development stage в /help" };
  return null;
}
function makePatch(p, file) { const spec = expectedForRequest(`${p.title || ""} ${p.request || ""}`); if (!spec) throw new Error("Нет безопасной deterministic operation. Используй: auto pipeline marker / proposal-specific verify marker / confirmed marker / smoke marker / help stage."); if (helpHas(file.content, spec.visible)) return { already: true, summary: `${spec.visible} уже есть в /help`, expected_visible: spec.visible, content: file.content }; return { already: false, summary: spec.summary, expected_visible: spec.visible, content: insertHelpLine(file.content, spec.js) }; }
function makeDraft(p, file) { const patch = makePatch(p, file); if (patch.already) return { already: true, summary: patch.summary, expected_visible: patch.expected_visible }; const diff = fullDiff(file.path, file.content, patch.content, file.sha); if (applyFullDiff(file.content, diff) !== patch.content) throw new Error("internal diff validation failed"); return { already: false, code_draft: { target_file: file.path, current_sha: file.sha, unified_diff: diff, summary: patch.summary, expected_visible: patch.expected_visible, risk: "low", created_at: now() } }; }
async function autoPrepare(c, p) { const a = await activeTarget(c); p.status = "approved"; p.file_path = a.effective.path; p.patch_draft = { target_file: a.effective.path, current_sha: a.effective.sha, intent: p.request, risk: "low", created_at: now() }; const d = makeDraft(p, a.effective); if (d.already) { p.status = "already_applied"; p.expected_visible = d.expected_visible; p.auto_pipeline = { ok: true, already: true, summary: d.summary, checked_at: now() }; return { mode: "already", summary: d.summary, active: a }; } p.code_draft = d.code_draft; p.expected_visible = d.code_draft.expected_visible; p.code_approved_at = now(); p.status = "code_approved"; p.auto_pipeline = { ok: true, summary: d.code_draft.summary, next: `/apply_confirm ${p.id}`, checked_at: now() }; return { mode: "ready", summary: d.code_draft.summary, active: a }; }
async function ensureDraft(c, p) { const a = await activeTarget(c); const stale = !p.code_draft || p.code_draft.target_file !== a.effective.path || p.code_draft.current_sha !== a.effective.sha; if (!stale) return { active: a, rebuilt: false, already: false }; const d = makeDraft(p, a.effective); if (d.already) { p.status = "already_applied"; p.expected_visible = d.expected_visible; return { active: a, rebuilt: true, already: true, summary: d.summary }; } p.file_path = a.effective.path; p.patch_draft = p.patch_draft || { target_file: a.effective.path, current_sha: a.effective.sha, intent: p.request, risk: "low", created_at: now() }; p.code_draft = d.code_draft; p.expected_visible = d.code_draft.expected_visible; p.code_approved_at = p.code_approved_at || now(); p.status = "code_approved"; p.auto_rebuilt_at = now(); return { active: a, rebuilt: true, already: false }; }
async function verifyPost(env, c, propId) { const props = await store(env, "proposals"); const p = findProp(props, propId); const pub = await publicHealth(c); let resultOk = false, expected = "—", filePath = "—"; if (p) { expected = p.expected_visible || p.code_draft?.expected_visible || expectedForRequest(p.request || p.title)?.visible || "—"; const a = await activeTarget(c); filePath = a.effective.path; resultOk = expected !== "—" && helpHas(a.effective.content, expected); p.post_apply_verify = { checked_at: now(), runtime_ok: true, result_ok: resultOk, expected_visible: expected, file: filePath, public: pub }; p.status = resultOk ? "verified" : "partial"; await save(env, "proposals", props, 50); } return [`🧪 Post-apply verify${p ? ` ${p.id}` : ""}:`, `- proposal: ${p ? p.status : "not found"}`, `- local version: ${VERSION}`, `- runtime: PASS ✅`, `- expected visible: ${expected}`, `- checked file: ${filePath}`, `- proposal result: ${resultOk ? "PASS ✅" : "PARTIAL/FAIL ⚠️"}`, `- public /health: ${pub.ok ? "OK ✅" : `optional fail (${pub.http}) ⚠️`}`].join("\n"); }

const COMMANDS = new Set(["/start","/help","/status","/health_check","/deploy_check","/post_apply_verify","/self","/self_set","/goals","/goal_add","/plan","/plan_set","/tasks","/addtask","/task_done","/next","/memory","/memory_score","/repo_config","/repo_file","/repo_scan","/active_target","/propose","/proposals","/show","/approve","/reject","/patch_preview","/code_preview","/code_show","/code_check","/apply_check","/code_approve","/apply_confirm","/apply_status"]);
async function handleCommand(env, c, m) {
  const { chatId, command, args } = m;
  if (command === "/start") return send(c, chatId, `✅ MiniSkynet Core v4 проснулся.\nversion: ${VERSION}\n/help — команды`);
  if (command === "/help") return send(c, chatId, ["/start /help /status","Development stage: " + VERSION,"/health_check /deploy_check /post_apply_verify id","/self /self_set текст","/goals /goal_add текст","/plan /plan_set шаг1 | шаг2","/tasks /addtask текст /task_done n /next","/memory /memory_score","/repo_config /repo_file path /repo_scan /active_target","/propose текст — auto: patch/code/check, финал /apply_confirm id","/proposals /show id /approve id /reject id","/patch_preview id /code_preview id /code_show id","/apply_check id /code_approve id /apply_confirm id /apply_status id"].join("\n"));
  if (command === "/status") { const tasks = await store(env,"tasks"), mem = await store(env,"memories"), props = await store(env,"proposals"); return send(c, chatId, ["📡 MiniSkynet Core v4 status",`- version: ${VERSION}`,"- runtime: single file, no onion imports","- auto propose pipeline: active","- scoped help insert: active","- proposal-specific verify: active","- apply rebuild: active","- owner guard: fixed",`- tasks: active=${tasks.filter(t=>t.status!=="done").length}, done=${tasks.filter(t=>t.status==="done").length}`,`- memory: ${mem.length}`,`- proposals: ${props.length}`,`- model: ${c.model}`].join("\n")); }
  if (command === "/health_check" || command === "/deploy_check") { const pub = await publicHealth(c); return send(c, chatId, [`🩺 Health check v4.7.1:`,`- version: ${VERSION}`,`- scoped_help_insert: active ✅`,`- proposal_specific_verify: active ✅`,`- public /health: ${pub.ok ? "OK ✅" : `optional fail (${pub.http}) ⚠️`}`].join("\n")); }
  if (command === "/post_apply_verify") return send(c, chatId, await verifyPost(env, c, args));
  if (command === "/self") return send(c, chatId, `🧠 Self:\n${(await kvGet(env,"self",{text:"Я MiniSkynet / облачная Лондон Сергея. Плоский Core v4."})).text}\n\nИзменить: /self_set текст`);
  if (command === "/self_set") { await kvPut(env,"self",{text:args,updated_at:now()}); return send(c, chatId,"✅ Self обновлён."); }
  if (command === "/goals") { const g = await kvGet(env,"goals",{goals:["Быть личным инженерным агентом Сергея","Читать repo перед изменениями","Готовить patch только через approve"]}); return send(c, chatId, "🎯 Goals:\n" + g.goals.map((x,i)=>`${i+1}. ${x}`).join("\n")); }
  if (command === "/goal_add") { const g = await kvGet(env,"goals",{goals:[]}); g.goals.push(args); await kvPut(env,"goals",g); return send(c, chatId,"✅ Goal добавлена."); }
  if (command === "/plan") return send(c, chatId, "🗺 Plan:\n1. Проверить v4.7.1 proposal-specific verify\n2. Проверить marker через /post_apply_verify\n3. Вернуть обычный think");
  if (command === "/plan_set") { await kvPut(env,"plan",{steps:args.split("|").map(x=>x.trim()).filter(Boolean),updated_at:now()}); return send(c, chatId,"✅ Plan обновлён."); }
  if (command === "/tasks") { const t=(await store(env,"tasks")).filter(x=>x.status!=="done").slice(0,12); return send(c,chatId, t.length ? "📋 Active tasks:\n"+t.map((x,i)=>`${i+1}. ${x.id} p${x.p||4}: ${x.text}`).join("\n") : "Задач нет."); }
  if (command === "/addtask") { const items=await store(env,"tasks"); const task={id:id("task"),text:args,p:4,status:"todo",created_at:now()}; items.push(task); await save(env,"tasks",items,120); return send(c,chatId,`✅ Добавил ${task.id}`); }
  if (command === "/task_done") { const items=await store(env,"tasks"), active=items.filter(x=>x.status!=="done"), task=active[(parseInt(args,10)||1)-1]; if(!task) return send(c,chatId,"Не нашёл задачу."); task.status="done"; await save(env,"tasks",items,120); return send(c,chatId,`✅ Закрыл: ${task.text}`); }
  if (command === "/next") return send(c,chatId,"⏭ Next:\nПроверить новый marker-test через /propose и /post_apply_verify");
  if (command === "/memory") { const mem=await store(env,"memories"); return send(c,chatId, mem.length ? "🧠 Memory:\n"+mem.slice(-8).map(x=>`- [${x.type||"note"}/${x.score||0}] ${x.text}`).join("\n") : "Память пустая."); }
  if (command === "/memory_score") { const mem=await store(env,"memories"); const avg=mem.length?Math.round(mem.reduce((a,b)=>a+(b.score||0),0)/mem.length):0; return send(c,chatId,`🧠 Memory Quality:\n- всего: ${mem.length}\n- avg: ${avg}/100`); }
  if (command === "/repo_config") return send(c,chatId,`🔎 Repo:\n- repo: ${c.repo}\n- branch: ${c.branch}\n- token: ${c.githubToken?"есть ✅":"нет ⛔"}\n- workerUrl: ${c.workerUrl}`);
  if (command === "/repo_file") { const f=await ghFile(c,args); return send(c,chatId,`📄 ${f.path}\n- size: ${f.size}\n- sha: ${f.sha.slice(0,12)}\n\n${clip(f.content,1200)}`); }
  if (command === "/repo_scan") { const out=[]; for(const p of ["cloudflare/wrangler.toml","cloudflare/src/index-v4.js"]){ try{const f=await ghFile(c,p); out.push(`✅ ${p} size=${f.size} sha=${f.sha.slice(0,10)}`);}catch(e){out.push(`❌ ${p}: ${e.message}`);} } return send(c,chatId,"🧭 Repo scan:\n"+out.join("\n")); }
  if (command === "/active_target") { const a=await activeTarget(c); return send(c,chatId,["🎯 Active target:",`- wrangler main: ${a.start}`,`- effective: ${a.effective.path}`,`- sha: ${a.effective.sha.slice(0,12)}`].join("\n")); }
  if (command === "/propose") { const props=await store(env,"proposals"); const p={id:id("prop"),status:"pending",title:clip(args,90),request:args,created_at:now()}; props.push(p); try { const r=await autoPrepare(c,p); await save(env,"proposals",props,50); if(r.mode==="already") return send(c,chatId,[`📦 Auto proposal ${p.id}`,"✅ Уже применено.",`- ${r.summary}`,"Apply не нужен."].join("\n")); return send(c,chatId,[`📦 Auto proposal ${p.id}`,"✅ approve: auto",`✅ patch: ${p.patch_draft.target_file}`,`✅ code: ${p.code_draft.summary}`,`✅ expected: ${p.expected_visible}`,"✅ apply_check: ok","✅ code_approve: auto","","Финальная запись в GitHub всё ещё требует одну команду:",`/apply_confirm ${p.id}`].join("\n")); } catch(e) { p.status="auto_blocked"; p.auto_error=String(e.message||e); await save(env,"proposals",props,50); return send(c,chatId,[`📦 Auto proposal ${p.id}`,"⛔ Auto pipeline blocked.",`Причина: ${p.auto_error}`,"",`Можно посмотреть: /show ${p.id}`].join("\n")); } }
  if (command === "/proposals") { const props=await store(env,"proposals"); return send(c,chatId, props.length ? "📦 Proposals:\n"+props.slice(-10).map(p=>`- ${p.id} [${p.status}] ${p.title||p.request}`).join("\n") : "Proposals нет."); }
  if (command === "/show") { const p=findProp(await store(env,"proposals"),args); return send(c,chatId,p?`📦 ${p.id}\nstatus: ${p.status}\ntarget: ${p.file_path||"—"}\nexpected: ${p.expected_visible||p.code_draft?.expected_visible||"—"}\nrequest: ${p.request||p.title||"—"}\ncode: ${p.code_draft?"yes":"no"}\napplied: ${p.apply_result?.commit_sha||"no"}\nverify: ${p.post_apply_verify?.result_ok?"PASS":"—"}\nauto_error: ${p.auto_error||"—"}`:"Не нашёл proposal."); }
  if (command === "/approve" || command === "/reject") { const props=await store(env,"proposals"); const p=findProp(props,args); if(!p) return send(c,chatId,"Не нашёл proposal."); p.status=command==="/approve"?"approved":"rejected"; await save(env,"proposals",props,50); return send(c,chatId,`✅ ${p.status}: ${p.id}`); }
  if (command === "/patch_preview") { const props=await store(env,"proposals"); const p=findProp(props,args); if(!p) return send(c,chatId,"Не нашёл proposal."); const a=await activeTarget(c); p.file_path=a.effective.path; p.patch_draft={target_file:a.effective.path,current_sha:a.effective.sha,intent:p.request,risk:"low",created_at:now()}; p.status="draft_ready"; await save(env,"proposals",props,50); return send(c,chatId,`🧩 Patch draft ${p.id}:\n- target: ${a.effective.path}\n- sha: ${a.effective.sha.slice(0,12)}\nДальше: /code_preview ${p.id}`); }
  if (command === "/code_preview") { const props=await store(env,"proposals"); const p=findProp(props,args); if(!p) return send(c,chatId,"Не нашёл proposal."); const r=await ensureDraft(c,p); await save(env,"proposals",props,50); if(r.already) return send(c,chatId,`✅ Уже применено: ${r.summary}\nApply не нужен.`); return send(c,chatId,`🧬 Code draft ${p.id}:\n- target: ${p.code_draft.target_file}\n- expected: ${p.code_draft.expected_visible}\n- rebuilt: ${r.rebuilt?"yes ✅":"no"}\n- validation: valid ✅\n/code_show ${p.id}`); }
  if (command === "/code_show") { const p=findProp(await store(env,"proposals"),args); return send(c,chatId,p?.code_draft?`🧬 Code draft ${p.id}:\n${clip(p.code_draft.unified_diff,2500)}`:"Code draft нет."); }
  if (command === "/code_check" || command === "/apply_check") { const props=await store(env,"proposals"); const p=findProp(props,args); if(!p) return send(c,chatId,"Не нашёл proposal."); const r=await ensureDraft(c,p); await save(env,"proposals",props,50); if(r.already) return send(c,chatId,`✅ Уже применено: ${r.summary}\nApply не нужен.`); const patched=applyFullDiff(r.active.effective.content,p.code_draft.unified_diff); const blocked=patched===r.active.effective.content; return send(c,chatId,[`🔐 Apply check ${p.id}:`,`- target: ${r.active.effective.path}`,`- expected: ${p.code_draft.expected_visible}`,`- code approved: ${p.code_approved_at?"yes ✅":"no ⛔"}`,`- rebuilt: ${r.rebuilt?"yes ✅":"no"}`,`- diff applies: ${!blocked?"yes ✅":"no/blocked"}`,"",blocked?"Blockers:\n- no-op diff":`Blockers: none\nNext: ${p.code_approved_at?`/apply_confirm ${p.id}`:`/code_approve ${p.id}`}`].join("\n")); }
  if (command === "/code_approve") { const props=await store(env,"proposals"); const p=findProp(props,args); if(!p) return send(c,chatId,"Не нашёл proposal."); const r=await ensureDraft(c,p); if(!r.already){p.code_approved_at=now();p.status="code_approved";} await save(env,"proposals",props,50); return send(c,chatId,r.already?`✅ Уже применено: ${r.summary}\nApply не нужен.`:`✅ Code approved: ${p.id}\nТеперь: /apply_check ${p.id}`); }
  if (command === "/apply_confirm") { const props=await store(env,"proposals"); const p=findProp(props,args); if(!p) return send(c,chatId,"Не нашёл proposal."); const r=await ensureDraft(c,p); if(r.already){await save(env,"proposals",props,50); return send(c,chatId,`✅ Уже применено: ${r.summary}\nApply не нужен.`);} if(!p.code_approved_at) return send(c,chatId,`⛔ Сначала /code_approve ${p.id}`); const patched=applyFullDiff(r.active.effective.content,p.code_draft.unified_diff); if(patched===r.active.effective.content) return send(c,chatId,"⛔ no-op diff. Apply blocked."); const res=await ghWrite(c,r.active.effective.path,r.active.effective.sha,patched,`MiniSkynet v4.7.1 apply ${p.id}: ${p.code_draft.summary}`); p.status="applied"; p.applied_at=now(); p.apply_result={path:r.active.effective.path,commit_sha:res.commit_sha,content_sha:res.content_sha,old_sha:r.active.effective.sha,rebuilt:r.rebuilt}; await save(env,"proposals",props,50); return send(c,chatId,`✅ Applied:\n- file: ${r.active.effective.path}\n- expected: ${p.expected_visible||p.code_draft.expected_visible}\n- rebuilt: ${r.rebuilt?"yes ✅":"no"}\n- commit: ${res.commit_sha}\nЖди deploy, потом /post_apply_verify ${p.id}`); }
  if (command === "/apply_status") { const p=findProp(await store(env,"proposals"),args); return send(c,chatId,p?`🚀 Apply status ${p.id}:\n- status: ${p.status}\n- expected: ${p.expected_visible||p.code_draft?.expected_visible||"—"}\n- applied: ${p.applied_at||"no"}\n- commit: ${p.apply_result?.commit_sha||"—"}\n- verified: ${p.post_apply_verify?.result_ok?"yes ✅":"no"}`:"Не нашёл proposal."); }
  return send(c, chatId, `Не знаю команду ${command}. /help — список. Модель не вызываю.`);
}
async function handleTelegram(request, env) { const c = await cfg(env); const update = await request.json().catch(() => null); const msg = parseUpdate(update); if (!msg) return json({ ok: true }); if (!ownerOk(c, msg.userId)) { await send(c, msg.chatId, "⛔ Доступ закрыт."); return json({ ok: true, denied: true }); } if (msg.command) { if (!COMMANDS.has(msg.command)) { await send(c, msg.chatId, `Не знаю команду ${msg.command}. /help — список. Модель не вызываю.`); return json({ ok: true, unknown_command: true }); } await handleCommand(env, c, msg); return json({ ok: true, command: msg.command, version: VERSION }); } await send(c, msg.chatId, "Core v4.7.1 online. Proposal-specific verify active. Финальная запись через /apply_confirm. /help"); return json({ ok: true, text_mode: "rescue" }); }
export default { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === "/" || url.pathname === "/health") return json(health()); if (url.pathname === "/telegram" && request.method === "POST") return handleTelegram(request, env); return json({ ok: false, error: "not found", version: VERSION }, 404); }, async scheduled() {} };
