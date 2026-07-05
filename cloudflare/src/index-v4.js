// MiniSkynet Core — чистая пересборка (clean-core v1, 2026-07-05)
// Заменяет v5.6.51 (1402 строки, 49 хотфиксов, 29 governor'ов) на читаемое ядро.
//
// Два столпа, которые ты просил:
//   1) Управление ОБЫЧНЫМ языком — без команд-слэшей, без ощущения "программы".
//      Ты пишешь по-человечески, модель понимает намерение и действует.
//   2) Самопатчинг через безопасный шлюз — предложение → diff → твоё "да" →
//      ветка+PR (никогда не main напрямую), с проверкой синтаксиса и клеткой путей.
//
// Философия: ощущение "живого" рождается из ЯСНОСТИ, а не из слоёв правил.
// Одна точка входа, один роутер намерений, один шлюз записи. Всё видно насквозь.
//
// Совместимо с существующим KV: config:*, self, goals, plan, tasks, memories, proposals.

const VERSION = "clean-core-v6-no-eval-2026-07-05"; // гибрид: начинка v5.6.15 + управление речью

// Клетка: что агент не может делать НИКОГДА (перенесено из вашего FORBIDDEN).
const FORBIDDEN_PATHS = [".github/", "wrangler.toml", ".env"];
const ALLOWED_PATH_PREFIXES = ["cloudflare/", "src/", "docs/", "scripts/"];

// ============================================================ KV
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function kvPut(env, key, val) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(val));
}
async function getList(env, key) {
  const d = await kvGet(env, key, { items: [] });
  return Array.isArray(d.items) ? d.items : (Array.isArray(d) ? d : []);
}
async function putList(env, key, items, cap = 200) {
  await kvPut(env, key, { items: items.slice(-cap) });
}

// ============================================================ CONFIG
const CFG_KEYS = ["TELEGRAM_BOT_TOKEN","TELEGRAM_ALLOWED_USER_ID","OPENROUTER_API_KEY",
  "GITHUB_TOKEN","GITHUB_REPO","GITHUB_BRANCH","OPENROUTER_MODEL","OPENROUTER_MODEL_CHEAP","WORKER_URL"];

async function cfg(env) {
  const c = {};
  for (const k of CFG_KEYS) c[k] = env[k] ? String(env[k]).trim() : "";
  const missing = CFG_KEYS.filter(k => !c[k]);
  if (missing.length && env.MINISKYNET_KV) {
    const vals = await Promise.all(missing.map(k => env.MINISKYNET_KV.get("config:" + k)));
    missing.forEach((k, i) => { if (vals[i]) c[k] = String(vals[i]).trim(); });
  }
  return {
    telegram: c.TELEGRAM_BOT_TOKEN,
    owner: c.TELEGRAM_ALLOWED_USER_ID,
    openrouter: c.OPENROUTER_API_KEY,
    model: c.OPENROUTER_MODEL || c.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
    workerUrl: c.WORKER_URL || "",
    ghToken: c.GITHUB_TOKEN,
    repo: c.GITHUB_REPO || "sromanuk16-lab/miniskynet-core", // дефолт как в рабочей версии — устраняет 404
    branch: c.GITHUB_BRANCH || "main",
    kv: env.MINISKYNET_KV
  };
}

// ============================================================ TELEGRAM
async function tg(c, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${c.telegram}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}
async function send(c, chatId, text) {
  if (!chatId || !text) return;
  // Telegram лимит ~4096; режем длинное на части, чтобы ничего не терялось.
  const s = String(text);
  for (let i = 0; i < s.length; i += 3900) {
    await tg(c, "sendMessage", { chat_id: chatId, text: s.slice(i, i + 3900) });
  }
}

// ============================================================ COST GUARD
async function costOk(env, c) {
  const day = today();
  const st = await kvGet(env, "cost:openrouter_daily", { day, count: 0 });
  if (st.day !== day) { st.day = day; st.count = 0; }
  const limit = (await kvGet(env, "cost:openrouter_limits", { perDay: 120 })).perDay || 120;
  if (st.count >= limit) return { ok: false, msg: `Дневной лимит запросов исчерпан (${st.count}/${limit}). Обнулится завтра.` };
  st.count++; await kvPut(env, "cost:openrouter_daily", st);
  return { ok: true };
}

// ============================================================ MODEL
async function ask(env, c, system, user, maxTokens = 700) {
  const gate = await costOk(env, c);
  if (!gate.ok) return { error: gate.msg };
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + c.openrouter },
    body: JSON.stringify({
      model: c.model, max_tokens: maxTokens, temperature: 0.4,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });
  if (!r.ok) return { error: `OpenRouter ${r.status}: ${(await r.text().catch(()=>"" )).slice(0,200)}` };
  const d = await r.json();
  return { text: (d?.choices?.[0]?.message?.content || "").trim() };
}
function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}

// ============================================================ MEMORY / STATE
async function versionInfo() {
  return {
    version: VERSION,
    processedMessages: (await getList(env, 'dialogue')).length
  };
}
async function getSelf(env) {
  return await kvGet(env, "self", {
    identity: "Я MiniSkynet — личный инженерный агент Сергея. Говорю по-русски, живо и по делу, без канцелярита. Не притворяюсь человеком, но и не звучу как робот-автоответчик.",
    updated: now()
  });
}
async function recentDialogue(env) {
  return (await getList(env, "dialogue")).slice(-10);
}
async function pushDialogue(env, role, text) {
  const d = await getList(env, "dialogue");
  d.push({ role, text: String(text).slice(0, 600), t: now() });
  await putList(env, "dialogue", d, 40);
}
async function saveMemory(env, lesson, status = "note", score = 60) {
  if (!lesson || /пароль|token|secret|sk-/i.test(lesson)) return;
  const m = await getList(env, "memories");
  m.push({ lesson: String(lesson).slice(0, 300), status, score, t: now() });
  await putList(env, "memories", m, 150);
}

// ============================================================ GITHUB (только ветка+PR)
async function gh(c, method, path, body) {
  const r = await fetch("https://api.github.com" + path, {
    method,
    headers: { authorization: "Bearer " + c.ghToken, accept: "application/vnd.github+json",
      "user-agent": "miniskynet-clean-core", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : null
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${d?.message || "fail"}`);
  return d;
}
function pathAllowed(p) {
  p = String(p || "").replace(/^\/+/, "");
  if (!p || p.includes("..")) return false;
  if (FORBIDDEN_PATHS.some(f => p.startsWith(f))) return false;
  return ALLOWED_PATH_PREFIXES.some(x => p.startsWith(x));
}
function b64(s) {
  const bytes = new TextEncoder().encode(s); let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(bin);
}
function unb64(s) {
  return new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/\n/g, "")), c => c.charCodeAt(0)));
}
async function ghFile(c, path) {
  const d = await gh(c, "GET", `/repos/${c.repo}/contents/${path}?ref=${c.branch}`);
  return { sha: d.sha, content: unb64(d.content) };
}

// Проверка синтаксиса без node: баланс скобок + целостность строк/шаблонов.
// Надёжная проверка синтаксиса: лексер, корректно пропускающий строки,
// шаблонные литералы, комментарии и регэкспы, затем баланс скобок.
// Не использует new Function и текстовых замен — они сами ломали валидный код.
function syntaxError(code) {
  if (!/export\s+default/.test(code)) return "нет export default";
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let i = 0, n = code.length;
  // для различения regex от деления смотрим предыдущий значимый символ
  let prevSig = "";
  while (i < n) {
    const ch = code[i];
    // строки
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < n && code[i] !== q) { if (code[i] === "\\") i++; i++; }
      if (i >= n) return "незакрытая строка " + q;
      i++; prevSig = "x"; continue;
    }
    // шаблонные литералы (с вложенными ${...})
    if (ch === "`") {
      i++;
      while (i < n && code[i] !== "`") {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === "$" && code[i + 1] === "{") {
          i += 2; let d = 1;
          while (i < n && d > 0) {
            if (code[i] === "{") d++;
            else if (code[i] === "}") d--;
            else if (code[i] === "`") { // вложенный шаблон — простой пропуск
              i++; while (i < n && code[i] !== "`") { if (code[i]==="\\") i++; i++; }
            }
            i++;
          }
          continue;
        }
        i++;
      }
      if (i >= n) return "незакрытый шаблонный литерал";
      i++; prevSig = "x"; continue;
    }
    // комментарии
    if (ch === "/" && code[i + 1] === "/") { while (i < n && code[i] !== "\n") i++; continue; }
    if (ch === "/" && code[i + 1] === "*") { i += 2; while (i < n && !(code[i] === "*" && code[i+1] === "/")) i++; i += 2; continue; }
    // регэксп (если / стоит там, где ожидается значение, а не деление)
    if (ch === "/" && !/[a-zA-Z0-9_$)\]]/.test(prevSig)) {
      i++; let inClass = false;
      while (i < n) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === "[") inClass = true;
        else if (code[i] === "]") inClass = false;
        else if (code[i] === "/" && !inClass) break;
        else if (code[i] === "\n") return "незакрытый регэксп";
        i++;
      }
      i++; while (i < n && /[a-z]/i.test(code[i])) i++; // флаги
      prevSig = "x"; continue;
    }
    // скобки
    if (ch === "(" || ch === "[" || ch === "{") { stack.push(ch); prevSig = ch; i++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== pairs[ch]) return "несбалансированная скобка " + ch + " на позиции " + i;
      prevSig = ch; i++; continue;
    }
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  if (stack.length) return "незакрытых скобок: " + stack.length + " (" + stack.join("") + ")";
  return null;
}
function syntaxLooksSafe(code) { return syntaxError(code) === null; }
// Проверка самого фрагмента replace через парсер (ловит тонкие ошибки:
// битые скобки, незакрытые строки — то, что теряется в балансе большого файла).
function fragmentError(frag) {
  // БЕЗ new Function/eval — они запрещены в Cloudflare Workers ("Code generation
  // from strings disallowed"). Проверяем фрагмент тем же лексером: он не создаёт
  // код из строк, а посимвольно читает — что в Workers разрешено.
  const f = String(frag || "");
  // 1) баланс внутри самого фрагмента (скобки, строки, шаблоны)
  const balErr = syntaxError("export default 0;\n" + f);
  if (balErr && !/нет export default/.test(balErr)) {
    // syntaxError видит несбалансированность/незакрытые строки в самом фрагменте
    if (/скобк|строк|шаблон|регэксп/i.test(balErr)) return balErr;
  }
  // 2) прямая проверка баланса фрагмента изолированно
  const direct = balanceOnly(f);
  if (direct) return direct;
  return null;
}
// Изолированный баланс: считает скобки/строки во фрагменте, ничего не исполняя.
function balanceOnly(code) {
  const stack = []; const pairs = { ")": "(", "]": "[", "}": "{" };
  let i = 0; const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === '"' || ch === "'") { const q = ch; i++; while (i < n && code[i] !== q) { if (code[i] === "\\") i++; i++; } if (i >= n) return "незакрытая строка"; i++; continue; }
    if (ch === "`") { i++; while (i < n && code[i] !== "`") { if (code[i] === "\\") i++; i++; } if (i >= n) return "незакрытый шаблон"; i++; continue; }
    if (ch === "/" && code[i+1] === "/") { while (i < n && code[i] !== "\n") i++; continue; }
    if (ch === "/" && code[i+1] === "*") { i += 2; while (i < n && !(code[i] === "*" && code[i+1] === "/")) i++; i += 2; continue; }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") { if (stack.pop() !== pairs[ch]) return "несбалансированная скобка " + ch; }
    i++;
  }
  if (stack.length) return "незакрытых скобок: " + stack.length;
  return null;
}

// ============================================================ SELF-PATCH GATE
// Создать предложение патча: модель предлагает ТОЧЕЧНОЕ изменение одного файла.
async function proposePatch(env, c, request) {
  const targetPath = "cloudflare/src/index-v4.js";
  if (!pathAllowed(targetPath)) throw new Error("target вне allowlist");
  const file = await ghFile(c, targetPath);
  const sys = "Ты инженер, готовящий безопасный минимальный патч. Верни строго JSON: " +
    '{"summary":"что меняем и зачем, по-русски","find":"уникальный существующий фрагмент кода ДОСЛОВНО","replace":"на что заменить","risk":"low|medium"}. ' +
    "find должен встречаться в файле РОВНО один раз. Меняй минимум.";
  const res = await ask(env, c, sys, `Задача: ${request}\n\nФайл (первые 8000 симв.):\n${file.content.slice(0, 8000)}`, 1200);
  if (res.error) throw new Error(res.error);
  const p = parseJson(res.text);
  if (!p || !p.find || !p.replace) throw new Error("модель не вернула валидный патч");
  if (!file.content.includes(p.find)) throw new Error("фрагмент find не найден в файле — патч не ляжет");
  if (file.content.split(p.find).length > 2) throw new Error("фрагмент find неуникален — уточни задачу");

  const newContent = file.content.replace(p.find, p.replace);
  const synErr = syntaxError(newContent) || fragmentError(p.replace);
  if (synErr) {
    // ДИАГНОСТИКА: показываем, ЧТО модель пыталась вставить и ПОЧЕМУ отклонено.
    const dbg = [
      "❌ Патч отклонён. Диагностика:",
      "ПРИЧИНА: " + synErr,
      "",
      "find (что заменяем):",
      String(p.find).slice(0, 300),
      "",
      "replace (на что):",
      String(p.replace).slice(0, 400)
    ].join("\n");
    throw new Error(dbg);
  }

  const prop = {
    id: "p" + Math.random().toString(36).slice(2, 8),
    request: String(request).slice(0, 300),
    summary: String(p.summary || "").slice(0, 400),
    risk: p.risk === "medium" ? "medium" : "low",
    path: targetPath, base_sha: file.sha,
    find: p.find, replace: p.replace,
    diff: makeDiff(p.find, p.replace),
    status: "pending", created: now()
  };
  const props = await getList(env, "proposals");
  props.push(prop); await putList(env, "proposals", props, 30);
  return prop;
}
function makeDiff(a, b) {
  const rm = a.split("\n").map(l => "- " + l).join("\n");
  const ad = b.split("\n").map(l => "+ " + l).join("\n");
  return (rm + "\n" + ad).slice(0, 1500);
}
// Применить одобренное: коммит в ветку + PR. Никогда не в main напрямую.
async function applyPatch(env, c, id) {
  const props = await getList(env, "proposals");
  const p = props.find(x => x.id === id || x.id.startsWith(id));
  if (!p) throw new Error("предложение не найдено");
  if (p.status !== "pending") throw new Error("уже " + p.status);
  const cur = await ghFile(c, p.path);
  if (cur.sha !== p.base_sha) throw new Error("файл изменился — сделай предложение заново");
  if (!cur.content.includes(p.find)) throw new Error("фрагмент исчез — заново");

  const newContent = cur.content.replace(p.find, p.replace);
  const synErr2 = syntaxError(newContent) || fragmentError(p.replace);
  if (synErr2) throw new Error("синтаксис сломан — отклонено: " + synErr2);

  const branch = `skynet/${p.id}`;
  const baseRef = await gh(c, "GET", `/repos/${c.repo}/git/ref/heads/${c.branch}`);
  await gh(c, "POST", `/repos/${c.repo}/git/refs`,
    { ref: `refs/heads/${branch}`, sha: baseRef.object.sha }).catch(e => { if (!String(e).includes("422")) throw e; });
  await gh(c, "PUT", `/repos/${c.repo}/contents/${p.path}`,
    { message: `skynet: ${p.summary || p.request}`, content: b64(newContent), sha: cur.sha, branch });
  const pr = await gh(c, "POST", `/repos/${c.repo}/pulls`,
    { title: `[MiniSkynet] ${p.summary || p.request}`, head: branch, base: c.branch,
      body: `Авто-предложение.\nРиск: ${p.risk}\n\n${p.summary}` });

  p.status = "pr_open"; p.pr = pr.html_url; p.branch = branch;
  await putList(env, "proposals", props, 30);
  return p;
}

// === ГОЛОСОВОЕ УПРАВЛЕНИЕ (voice v1) ===
async function voiceToText(c, env, voice) {
  try {
    const key = (env.OPENAI_API_KEY || "").trim() || await env.MINISKYNET_KV.get("config:OPENAI_API_KEY");
    if (!key) return { err: "голос не настроен: добавь config:OPENAI_API_KEY (Whisper) в KV" };
    const gf = await fetch(`https://api.telegram.org/bot${c.telegram}/getFile?file_id=${voice.file_id}`);
    const fp = (await gf.json().catch(() => null))?.result?.file_path;
    if (!fp) return { err: "не удалось получить голосовой файл у Telegram" };
    const audio = await fetch(`https://api.telegram.org/file/bot${c.telegram}/${fp}`);
    if (!audio.ok) return { err: "не смог скачать голосовой файл" };
    const form = new FormData();
    form.append("file", await audio.blob(), "voice.ogg");
    form.append("model", "whisper-1");
    form.append("language", "ru");
    const wr = await fetch("https://api.openai.com/v1/audio/transcriptions",
      { method: "POST", headers: { authorization: "Bearer " + key }, body: form });
    if (!wr.ok) return { err: "Whisper " + wr.status };
    const text = String((await wr.json().catch(() => null))?.text || "").trim();
    return text ? { text } : { err: "пустое распознавание" };
  } catch (e) { return { err: "голос: " + String(e.message || e).slice(0, 120) }; }
}

// ============================================================ NATURAL ROUTER
// Сердце "джарвиса": обычный текст → намерение → действие. Одна модель, одно решение.
async function handleText(env, c, chatId, text) {
  await pushDialogue(env, "user", text);
  const self = await getSelf(env);
  const dlg = await recentDialogue(env);
  const tasks = await getList(env, "tasks");
  const mem = (await getList(env, "memories")).slice(-6);
  const props = (await getList(env, "proposals")).filter(p => p.status === "pending");

  // Модель одновременно: понимает намерение, отвечает по-человечески, и — если
  // нужно действие — называет его. Ничего не выполняется молча: действие с
  // последствиями (патч) только предлагается, а подтверждаешь его ты.
  const sys = `${self.identity}
Ты управляешься обычной речью. Отвечай коротко, живо, по делу.
КРИТИЧЕСКИ ВАЖНО: ты НЕ работаешь в фоне и НЕ можешь "сделать позже". У тебя нет фоновых процессов.
Поэтому НИКОГДА не пиши "начинаю работу", "сообщу когда готово", "дай мне время", "займусь этим" — это ложь, ты так не умеешь.
Любое изменение кода происходит ПРЯМО СЕЙЧАС через intent, либо не происходит вообще.
Верни строго JSON:
{"reply":"короткий ответ человеку","intent":"chat|status|add_task|list_tasks|remember|propose_patch|apply_patch|reject_patch","arg":"деталь или пустая строка"}
Как выбирать intent:
- propose_patch: пользователь просит изменить/улучшить/добавить что-то В КОДЕ, ИЛИ говорит "делай", "сделай", "давай делай", "патч", "делай патч", "реализуй". arg = что именно менять (возьми из текущего или предыдущего сообщения). В reply напиши "Готовлю патч." — БЕЗ обещаний.
- apply_patch: пользователь одобряет ГОТОВОЕ предложение ("применяй", "да", "подтверждаю", "оформляй PR"). arg = id если назван.
- add_task: просит запомнить дело на потом. arg = текст.
- remember: просит запомнить факт о себе. arg = что.
- status / list_tasks: спрашивает как дела / что в задачах.
- inspect_code: спрашивает есть ли у тебя функция/команда в коде. arg = что искать.
- chat: обычный разговор.
Если сомневаешься между chat и propose_patch на словах "делай/сделай/патч" — выбирай propose_patch.
Не выдумывай доступы, которых нет. Не знаешь — скажи честно, коротко.`;

  const ctx = `Недавний диалог: ${JSON.stringify(dlg.slice(-6))}
Задачи (${tasks.length}): ${tasks.slice(-5).map(t=>t.title).join("; ")}
Память: ${mem.map(m=>m.lesson).join("; ")}
Ожидают одобрения патчи: ${props.map(p=>p.id+": "+p.summary).join(" | ") || "нет"}
Сообщение: ${text}`;

  const res = await ask(env, c, sys, ctx, 800);
  if (res.error) return send(c, chatId, "⚠️ " + res.error);
  const out = parseJson(res.text) || { reply: res.text, intent: "chat", arg: "" };

  // СТРАХОВКА: командные слова действия принудительно ведут в патч, что бы ни выбрала модель.
  // Защита от "болтовни вместо дела" — если модель написала обещание, но не запустила действие.
  const low = (text || "").toLowerCase().trim();
  const APPROVE = ["применяй","применить","оформляй","подтверждаю","одобряю","оформи pr","оформи пр"];
  const DO = ["делай","сделай","реализуй","патч","запатчи","внедряй","добавь команд","добавь функци","改"];
  const isApprove = /^(да|ага|ок|окей)\b/i.test(low) || APPROVE.some(w => low.includes(w));
  const isDo = DO.some(w => low.includes(w));
  if (isApprove && props.length) { out.intent = "apply_patch"; out.arg = out.arg || ""; }
  else if (isDo) {
    out.intent = "propose_patch";
    // если аргумент пустой — берём последнюю задачу или предыдущее сообщение как цель
    if (!out.arg) {
      const lastTask = (tasks.filter(t=>t.status!=="done").slice(-1)[0]);
      out.arg = lastTask ? lastTask.title : (dlg.slice(-2)[0]?.text || text);
    }
  }

  // Отдаём человеческий ответ (но если это действие-патч — короткий, без обещаний).
  const replyText = (out.intent === "propose_patch") ? "🛠 Готовлю патч, без обещаний — прямо сейчас."
                  : out.reply;
  if (replyText) { await pushDialogue(env, "assistant", replyText); await send(c, chatId, replyText); }

  // Затем — действие, если оно есть.
  try {
    if (out.intent === "add_task" && out.arg) {
      const t = await getList(env, "tasks");
      t.push({ id: "t" + Math.random().toString(36).slice(2,7), title: out.arg.slice(0,200), status: "todo", created: now() });
      await putList(env, "tasks", t, 100);
      await send(c, chatId, `📝 Запомнил как задачу: ${out.arg}`);
    }
    else if (out.intent === "remember" && out.arg) {
      await saveMemory(env, out.arg, "fact", 80);
      await send(c, chatId, "🧠 Запомнил.");
    }
    else if (out.intent === "list_tasks") {
      const t = await getList(env, "tasks");
      const open = t.filter(x => x.status !== "done");
      await send(c, chatId, open.length ? "📋 В работе:\n" + open.map((x,i)=>`${i+1}. ${x.title}`).join("\n") : "Задач нет.");
    }
    else if (out.intent === "status") {
      await send(c, chatId, await humanStatus(env, c));
    }
    else if (out.intent === "inspect_code" && out.arg) {
      // Честность: проверяем по РЕАЛЬНОМУ файлу из репозитория, а не по памяти.
      try {
        const file = await ghFile(c, "cloudflare/src/index-v4.js");
        const q = out.arg.toLowerCase();
        const lines = file.content.split("\n");
        const hits = lines.filter(l => l.toLowerCase().includes(q)).slice(0, 8);
        if (hits.length)
          await send(c, chatId, `Да, нашёл в своём коде (${hits.length}+ совпадений по "${out.arg}"):\n\n` + hits.map(l => l.trim().slice(0,120)).join("\n"));
        else
          await send(c, chatId, `Проверил свой реальный код — про "${out.arg}" там ничего нет. Не выдумываю: этого у меня сейчас правда не реализовано.`);
      } catch (e) {
        await send(c, chatId, "Не смог заглянуть в свой код: " + String(e.message||e).slice(0,200));
      }
    }
    else if (out.intent === "propose_patch" && out.arg) {
      await send(c, chatId, "🛠 Готовлю предложение по изменению кода…");
      const p = await proposePatch(env, c, out.arg);
      await send(c, chatId, `Предложение ${p.id} (риск: ${p.risk})\n${p.summary}\n\nИзменение:\n${p.diff}\n\nСказать "применяй ${p.id}" — и я оформлю это как Pull Request. В сам main ничего не уйдёт без твоего мержа на GitHub.`);
    }
    else if (out.intent === "apply_patch") {
      const pend = props[props.length - 1];
      const id = out.arg || (pend && pend.id);
      if (!id) return send(c, chatId, "Нет предложения для применения.");
      const p = await applyPatch(env, c, id);
      await send(c, chatId, `🚀 Оформил как Pull Request:\n${p.pr}\n\nПосмотри изменение на GitHub и смёржи, если всё верно. Это последний рубеж — он за тобой.`);
    }
    else if (out.intent === "reject_patch") {
      const p = props.find(x => x.id === out.arg) || props[props.length-1];
      if (p) { p.status = "rejected"; await putList(env, "proposals", await getList(env,"proposals"), 30); await send(c, chatId, "🗑 Отклонил."); }
    }
  } catch (e) {
    await send(c, chatId, "❌ " + String(e.message || e).slice(0, 300));
  }
}

async function humanStatus(env, c) {
  const tasks = await getList(env, "tasks");
  const mem = await getList(env, "memories");
  const props = (await getList(env, "proposals")).filter(p => p.status === "pending");
  const cost = await kvGet(env, "cost:openrouter_daily", { count: 0 });
  return [
    "Вот как я сейчас:",
    `• задач в работе: ${tasks.filter(t=>t.status!=="done").length}`,
    `• в памяти записей: ${mem.length}`,
    `• жду твоего решения по патчам: ${props.length}`,
    `• запросов к модели сегодня: ${cost.count || 0}`,
    `• версия ядра: ${VERSION}`
  ].join("\n");
}

// ============================================================ ENTRY
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const c = await cfg(env);

    if (url.pathname === "/" || url.pathname === "/health")
      return json({ ok: true, version: VERSION, has: { telegram: !!c.telegram, model: !!c.openrouter, github: !!c.ghToken } });

    if (url.pathname === "/diag") {
      // Диагностика без утечки секретов: что настроено, а что нет.
      let webhook = null;
      try { webhook = await tg(c, "getWebhookInfo", {}); } catch {}
      // Реальная проверка доступа к GitHub — покажет точную причину 404.
      let ghCheck = "не проверялось";
      if (c.ghToken && c.repo) {
        try {
          await ghFile(c, "cloudflare/src/index-v4.js");
          ghCheck = "✅ файл читается, всё ок";
        } catch (e) {
          const msg = String(e.message || e);
          if (msg.includes("404")) ghCheck = `❌ 404: не найдено. Проверь: GITHUB_REPO="${c.repo}" (должно быть owner/repo), GITHUB_BRANCH="${c.branch}", и что файл лежит по пути cloudflare/src/index-v4.js`;
          else if (msg.includes("401") || msg.includes("403")) ghCheck = `❌ ${msg.slice(0,60)}: токен неверный или без прав на этот репозиторий`;
          else ghCheck = "❌ " + msg.slice(0, 120);
        }
      } else {
        ghCheck = `❌ не хватает: ${!c.ghToken ? "GITHUB_TOKEN " : ""}${!c.repo ? "GITHUB_REPO" : ""}`;
      }
      return json({
        version: VERSION,
        config: {
          telegram_token: c.telegram ? "set" : "MISSING",
          openrouter_key: c.openrouter ? "set" : "MISSING",
          owner_id: c.owner ? "set" : "MISSING (бот открыт всем!)",
          github_repo: c.repo || "MISSING",
          github_branch: c.branch,
          github_token: c.ghToken ? "set" : "MISSING"
        },
        github_file_access: ghCheck,
        listens_on: ["/tg", "/telegram"],
        telegram_webhook: webhook?.result ? {
          url: webhook.result.url || "НЕ НАСТРОЕН",
          pending: webhook.result.pending_update_count,
          last_error: webhook.result.last_error_message || "нет"
        } : "не удалось получить"
      });
    }

    if (url.pathname === "/setup" && url.searchParams.get("secret") &&
        url.searchParams.get("secret") === (await env.MINISKYNET_KV.get("config:SETUP_SECRET"))) {
      const r = await tg(c, "setWebhook", { url: `${url.protocol}//${url.host}/telegram`, allowed_updates: ["message"] });
      return json({ ok: true, telegram: r });
    }

    if ((url.pathname === "/tg" || url.pathname === "/telegram") && request.method === "POST") {
      const upd = await request.json().catch(() => null);
      const msg = upd?.message;
      if (!msg) return json({ ok: true });
      const uid = String(msg.from?.id || "");
      // owner-check ПЕРВЫМ — чужой не тратит Whisper-бюджет и не общается с ботом.
      if (c.owner && uid !== String(c.owner))
        { await send(c, msg.chat.id, "⛔ Этот агент привязан к владельцу."); return json({ ok: true }); }
      // ГОЛОС: голосовое/аудио от владельца → распознаём в текст.
      let userText = msg.text;
      if (!userText && (msg.voice || msg.audio)) {
        const vt = await voiceToText(c, env, msg.voice || msg.audio);
        if (vt.err) { await send(c, msg.chat.id, "🎤 " + vt.err); return json({ ok: true }); }
        userText = vt.text;
        await send(c, msg.chat.id, "🎤 Услышал: «" + userText + "»");
      }
      if (!userText) return json({ ok: true });
      // Отвечаем Telegram сразу, работаем в фоне.
      await handleText(env, c, msg.chat.id, userText.trim()).catch(async e =>
        await send(c, msg.chat.id, "❌ " + String(e.message || e).slice(0, 300)));
      return json({ ok: true });
    }
    return json({ ok: false }, 404);
  },

  // Пульс: раз в тик тихо смотрит; пишет владельцу, ТОЛЬКО если реально есть что сказать.
  async scheduled(event, env) {
    const c = await cfg(env);
    if (!c.telegram || !c.owner) return;
    const last = await kvGet(env, "alive:last", { t: 0 });
    if (Date.now() - (last.t || 0) < 6 * 3600 * 1000) return; // не чаще раза в 6 часов
    const props = (await getList(env, "proposals")).filter(p => p.status === "pending");
    const tasks = (await getList(env, "tasks")).filter(t => t.status !== "done");
    let msg = null;
    if (props.length) msg = `Напоминаю: ждёт твоего решения ${props.length} предложение(й) по коду. Скажи "покажи предложения".`;
    else if (tasks.length >= 5) msg = `У тебя накопилось ${tasks.length} открытых задач. Разгрести?`;
    if (msg) { await kvPut(env, "alive:last", { t: Date.now() }); await send(c, c.owner, msg); }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
