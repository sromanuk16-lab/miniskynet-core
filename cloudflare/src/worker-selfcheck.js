import coreWorker from "./worker-v1.js";

const VERSION = "selfcheck-v5-grounded-alive";
const AUTO_INTERVAL_MS = 30 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  for (const k of ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "OPENROUTER_MODEL_CHEAP"]) {
    if (!env[k]) {
      const v = await env.MINISKYNET_KV.get("config:" + k);
      if (v) env[k] = String(v).trim();
    }
  }
}

async function kvGet(env, key, fallback) {
  const raw = await env.MINISKYNET_KV.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

async function kvPut(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

async function getBrain(env) {
  return await kvGet(env, "brain", { alive_enabled: false, owner_chat_id: "", stats: { cycles_total: 0, daily: {} }, messages: [] });
}

async function getTasks(env) {
  const data = await kvGet(env, "tasks", { tasks: [] });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function getMemories(env) {
  const data = await kvGet(env, "memories", { memories: [] });
  return Array.isArray(data.memories) ? data.memories : [];
}

async function getGrowth(env) {
  return await kvGet(env, "growth_state", { stage: "core_stability", target: "безопасно писать и использовать агентов как код", last_audit_at: null });
}

async function saveBrain(env, brain) {
  await kvPut(env, "brain", brain);
}

async function send(env, chatId, text) {
  await hydrate(env);
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3900) })
  }).catch(() => null);
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function parseLoose(text) {
  try { return JSON.parse(text); } catch (_) {}
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

function valueToText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valueToText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const preferred = ["Уровень", "level", "Слабость", "weakness", "Следующий патч", "next_patch", "Риск", "risk", "Проверка", "check", "answer"];
    const keys = Object.keys(v);
    const ordered = [...preferred.filter(k => keys.includes(k)), ...keys.filter(k => !preferred.includes(k))];
    return ordered.map(k => `${k}: ${valueToText(v[k])}`).join("\n");
  }
  return String(v);
}

function formatAnswer(parsed, raw) {
  const text = parsed && typeof parsed === "object" ? valueToText(parsed.answer ?? parsed) : String(raw || "");
  const clean = String(text || "").replace(/\[object Object\]/g, "").trim();
  return clean || fallbackText();
}

function fallbackText() {
  return [
    "Уровень: Clean Core.",
    "Слабость: self-audit ещё может фантазировать о файлах, которых нет в репозитории.",
    "Следующий патч: ограничить /self_audit существующими файлами cloudflare/src/worker-v1.js и cloudflare/src/worker-selfcheck.js.",
    "Риск: ответы станут менее свободными, зато честнее.",
    "Проверка: /self_audit не должен предлагать refactor_core.py, schedule_audit.py и другие несуществующие файлы."
  ].join("\n");
}

function auditPrompt() {
  return [
    "STRICT SELF-AUDIT MiniSkynet.",
    "Ответ должен быть конкретным, техническим и grounded.",
    "Запрещены общие фразы: недостаток практического опыта, собрать информацию, улучшить функциональность, оптимизировать процессы.",
    "Запрещено выдумывать файлы. Существующие рабочие файлы сейчас только: cloudflare/src/worker-v1.js, cloudflare/src/worker-selfcheck.js, cloudflare/wrangler.toml.",
    "Если предлагаешь патч, называй только один из этих файлов или пиши 'нужен новый файл' и зачем.",
    "Оцени текущий путь роста: Clean Core, Task Hygiene, Self-Audit, Agent Registry, Self-Update Proposal, Agents as Code.",
    "Верни JSON. Поле answer может быть объектом или строкой, но должно содержать эти 5 пунктов:",
    "Уровень, Слабость, Следующий патч, Риск, Проверка.",
    "Не предлагай внешние проекты. Не предлагай auto-apply. Не предлагай python-файлы: refactor_core.py, update_task_docs.py, schedule_audit.py, optimize_registry.py."
  ].join("\n");
}

async function askAudit(env) {
  await hydrate(env);
  if (!env.OPENROUTER_API_KEY) return fallbackText();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.OPENROUTER_API_KEY },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Return valid JSON only. Russian language. Be concrete and grounded. Do not invent files." },
        { role: "user", content: auditPrompt() }
      ],
      temperature: 0.1,
      max_tokens: 650
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return fallbackText();
  const raw = data?.choices?.[0]?.message?.content || "";
  const parsed = parseLoose(raw);
  return formatAnswer(parsed, raw) + `\n\nusage: in=${data?.usage?.prompt_tokens || "?"} out=${data?.usage?.completion_tokens || "?"}`;
}

function dayStats(brain) {
  const key = new Date().toISOString().slice(0, 10);
  return brain.stats?.daily?.[key] || { cycles: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
}

function countActiveTasks(tasks) {
  return tasks.filter(t => t.status !== "archived" && t.status !== "done").length;
}

function countCoreTasks(tasks) {
  return tasks.filter(t => (t.type || "") === "core" && t.status !== "archived" && t.status !== "done").length;
}

function detectLevel(brain, tasks, memories, growth) {
  const active = countActiveTasks(tasks);
  const core = countCoreTasks(tasks);
  const mem = memories.length;
  const alive = brain.alive_enabled === true;
  let score = 1.0;
  if (brain.stats?.cycles_total > 0) score += 0.3;
  if (mem >= 5) score += 0.3;
  if (core >= 1) score += 0.2;
  if (growth?.last_audit_at) score += 0.3;
  if (alive) score += 0.2;
  if (active > 40) score -= 0.2;
  return Math.max(1, Math.min(2.5, Number(score.toFixed(1))));
}

function levelName(score) {
  if (score < 1.5) return "Level 1 — Clean Core";
  if (score < 2.0) return "Level 1.5 — Clean Core + ранний self-audit";
  return "Level 2 — Memory/Task Hygiene начинается";
}

async function levelText(env) {
  const brain = await getBrain(env);
  const tasks = await getTasks(env);
  const memories = await getMemories(env);
  const growth = await getGrowth(env);
  const st = dayStats(brain);
  const score = detectLevel(brain, tasks, memories, growth);
  const active = countActiveTasks(tasks);
  const core = countCoreTasks(tasks);
  const broken = [];
  if (active > 40) broken.push("очередь задач раздута");
  if (memories.length > 20) broken.push("память уже шумная");
  if (!growth?.last_audit_at) broken.push("self-audit ещё не закреплён");
  if (brain.alive_enabled !== true) broken.push("alive выключен");
  if (!broken.length) broken.push("критичных блокеров не вижу");
  return [
    `Уровень: ${score}/10`,
    `Стадия: ${levelName(score)}`,
    `Думает: только по запросу, /self_audit или alive tick; не непрерывно.`,
    `Обучается: не весами модели, а памятью, задачами и изменениями кода через будущий approve/apply.`,
    `Alive: ${brain.alive_enabled === true ? "true" : "false"}`,
    `Циклы: всего ${brain.stats?.cycles_total || 0}, сегодня ${st.cycles || 0}`,
    `Память: ${memories.length}`,
    `Задачи: всего ${tasks.length}, активных ${active}, core ${core}`,
    `Growth stage: ${growth.stage || "unknown"}`,
    `Сломано/слабо: ${broken.join("; ")}`,
    `Следующий шаг: /tasks_hygiene, затем /self_audit. Если ответ grounded — двигаемся к Agent Registry.`
  ].join("\n");
}

async function enableAlive(env, chatId) {
  const brain = await getBrain(env);
  brain.alive_enabled = true;
  brain.owner_chat_id = String(chatId || brain.owner_chat_id || "");
  brain.alive_mode = "growth";
  brain.alive_updated_at = new Date().toISOString();
  await saveBrain(env, brain);
  await send(env, chatId, "Alive Growth включён. Теперь это реальный флаг в KV. Автотик будет редким и grounded: без выдуманных файлов и без auto-apply.");
}

async function disableAlive(env, chatId) {
  const brain = await getBrain(env);
  brain.alive_enabled = false;
  brain.alive_updated_at = new Date().toISOString();
  await saveBrain(env, brain);
  await send(env, chatId, "Alive выключен.");
}

async function aliveTick(env) {
  const level = await levelText(env);
  return [
    "Alive Growth tick:",
    level,
    "",
    "Автовывод: я не пишу код сама и не выдумываю файлы. Следующий безопасный шаг — очистить задачи и сделать grounded /self_audit."
  ].join("\n");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await coreWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.selfcheck_wrapper = VERSION;
        d.format_answer_hotfix = true;
        d.alive_growth = true;
        d.grounded_alive = true;
        d.level_command = true;
        d.auto_interval_minutes = AUTO_INTERVAL_MS / 60000;
      }
      return json(d || { ok: true, selfcheck_wrapper: VERSION, alive_growth: true, grounded_alive: true, level_command: true }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();

      if (m && (text === "/level" || text === "уровень" || text === "какой уровень" || text === "на каком уровне")) {
        await send(env, m.chat.id, await levelText(env));
        return json({ ok: true, handled_by: VERSION, level: true });
      }

      if (m && (text === "/alive_on" || text === "включи alive" || text === "включи самообучение" || text === "включи автообучение" || text === "живой режим")) {
        await enableAlive(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, alive: true });
      }

      if (m && (text === "/alive_off" || text === "выключи alive" || text === "выключи самообучение" || text === "стоп")) {
        await disableAlive(env, m.chat.id);
        return json({ ok: true, handled_by: VERSION, alive: false });
      }

      if (m && (text === "/self_audit" || text === "/grow_one" || text === "самоаудит" || text === "проверь себя")) {
        await send(env, m.chat.id, "Думаю...");
        const answer = await askAudit(env);
        await send(env, m.chat.id, answer);
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await coreWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    await hydrate(env);
    const brain = await getBrain(env);
    if (brain.alive_enabled !== true || !brain.owner_chat_id) return;
    const last = Number(await env.MINISKYNET_KV.get("runtime:last_alive_growth_ms") || 0);
    const ms = Date.now();
    if (last && ms - last < AUTO_INTERVAL_MS) return;
    await env.MINISKYNET_KV.put("runtime:last_alive_growth_ms", String(ms));
    await send(env, brain.owner_chat_id, await aliveTick(env));
  }
};
