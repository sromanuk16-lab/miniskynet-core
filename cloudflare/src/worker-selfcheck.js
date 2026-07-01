import coreWorker from "./worker-v1.js";

const VERSION = "selfcheck-v2-format-answer";

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

async function send(env, chatId, text) {
  await hydrate(env);
  if (!env.TELEGRAM_BOT_TOKEN) return;
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
    "Слабость: ответ модели может прийти объектом, а ядро выводит его как [object Object].",
    "Следующий патч: в cloudflare/src/worker-v1.js добавить formatAnswer() для parsed.answer.",
    "Риск: можно сломать обычные ответы, если неправильно обработать JSON.",
    "Проверка: /self_audit должен вернуть эти 5 строк нормальным текстом, без [object Object]."
  ].join("\n");
}

function auditPrompt() {
  return [
    "STRICT SELF-AUDIT MiniSkynet.",
    "Ответ должен быть конкретным и техническим.",
    "Запрещены общие фразы: недостаток практического опыта, собрать информацию, улучшить функциональность, оптимизировать процессы.",
    "Оцени текущий путь роста: Clean Core, Task Hygiene, Self-Audit, Agent Registry, Self-Update Proposal, Agents as Code.",
    "Верни JSON. Поле answer может быть объектом или строкой, но должно содержать эти 5 пунктов:",
    "Уровень, Слабость, Следующий патч, Риск, Проверка.",
    "Следующий патч должен назвать конкретный файл, модуль или команду.",
    "Не предлагай внешние проекты. Не предлагай auto-apply."
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
        { role: "system", content: "Return valid JSON only. Russian language. Be concrete." },
        { role: "user", content: auditPrompt() }
      ],
      temperature: 0.15,
      max_tokens: 700
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return fallbackText();
  const raw = data?.choices?.[0]?.message?.content || "";
  const parsed = parseLoose(raw);
  return formatAnswer(parsed, raw) + `\n\nusage: in=${data?.usage?.prompt_tokens || "?"} out=${data?.usage?.completion_tokens || "?"}`;
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
      }
      return json(d || { ok: true, selfcheck_wrapper: VERSION, format_answer_hotfix: true }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const text = String(m?.text || "").trim().toLowerCase();
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
    return;
  }
};
