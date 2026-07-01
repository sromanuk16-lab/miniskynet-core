import agentsWorker from "./worker-agents.js";

const VERSION = "codemap-v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function hydrate(env) {
  if (!env.MINISKYNET_KV) return;
  if (!env.TELEGRAM_BOT_TOKEN) {
    const v = await env.MINISKYNET_KV.get("config:TELEGRAM_BOT_TOKEN");
    if (v) env.TELEGRAM_BOT_TOKEN = String(v).trim();
  }
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

async function kvPut(env, key, value) {
  await env.MINISKYNET_KV.put(key, JSON.stringify(value, null, 2));
}

function getMsg(update) {
  return update?.message || update?.edited_message || null;
}

function files() {
  return {
    "cloudflare/src/worker-v1.js": {
      role: "основное ядро Telegram/commands/model/KV",
      commands: ["/start", "/status", "/think", "/tasks", "/memory", "/cost", "/tasks_hygiene"],
      risks: ["не сломать базовый роутер", "не вернуть двойные model calls", "не трогать секреты"],
      check: "/status"
    },
    "cloudflare/src/worker-selfcheck.js": {
      role: "self-audit, alive growth, /level, grounded audit",
      commands: ["/self_audit", "/grow_one", "/level", "/alive_on", "/alive_off"],
      risks: ["не вернуть фантазии о несуществующих файлах", "не сделать cron слишком шумным"],
      check: "/self_audit и /level"
    },
    "cloudflare/src/worker-memory-hygiene.js": {
      role: "чистка памяти, архив мусора и дублей",
      commands: ["/memory_hygiene"],
      risks: ["не удалить важные правила", "не потерять уроки про реальные ошибки"],
      check: "/memory_hygiene затем /level"
    },
    "cloudflare/src/worker-agents.js": {
      role: "реестр агентов и read-only agent runner",
      commands: ["/agents", "/agent <id> <task>"],
      risks: ["не дать агентам права менять код", "не выдумывать файлы", "не усложнить роутер"],
      check: "/agents и /agent critic тест"
    },
    "cloudflare/src/worker-codemap.js": {
      role: "карта собственного кода и роли файлов",
      commands: ["/code_map", "/file_role <file>"],
      risks: ["карта может устареть после новых wrapper-файлов"],
      check: "/code_map"
    },
    "cloudflare/wrangler.toml": {
      role: "точка входа Cloudflare Worker, KV binding, env vars, cron",
      commands: ["not telegram command"],
      risks: ["неверный main отключит новый слой", "ошибка KV binding сломает память"],
      check: "root URL показывает активные версии"
    }
  };
}

function shortName(s) {
  const x = String(s || "").trim();
  if (!x) return "";
  if (x.includes("/")) return x;
  const map = files();
  const key = Object.keys(map).find(k => k.endsWith("/" + x) || k === x);
  return key || x;
}

function renderMap() {
  const map = files();
  return [
    "Code Map v1:",
    ...Object.entries(map).map(([path, info]) => `${path} — ${info.role}`),
    "",
    "Команда: /file_role worker-agents.js"
  ].join("\n");
}

function renderRole(name) {
  const path = shortName(name);
  const info = files()[path];
  if (!info) return "Файл не найден в code map. Напиши /code_map.";
  return [
    `Файл: ${path}`,
    `Роль: ${info.role}`,
    `Команды: ${info.commands.join(", ")}`,
    `Риски: ${info.risks.join("; ")}`,
    `Проверка: ${info.check}`
  ].join("\n");
}

async function saveCodeMap(env) {
  await kvPut(env, "code_map", { version: VERSION, files: files(), updated_at: new Date().toISOString() });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const r = await agentsWorker.fetch(request, env, ctx);
      const d = await r.json().catch(() => null);
      if (d && typeof d === "object") {
        d.code_map = VERSION;
        d.code_map_commands = ["/code_map", "/file_role <file>"];
      }
      return json(d || { ok: true, code_map: VERSION }, r.status);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      const u = await request.clone().json().catch(() => null);
      const m = getMsg(u);
      const raw = String(m?.text || "").trim();
      const low = raw.toLowerCase();

      if (m && (low === "/code_map" || low === "карта кода" || low === "code map")) {
        await saveCodeMap(env);
        await send(env, m.chat.id, renderMap());
        return json({ ok: true, handled_by: VERSION });
      }

      if (m && low.startsWith("/file_role")) {
        const arg = raw.split(/\s+/).slice(1).join(" ");
        await send(env, m.chat.id, renderRole(arg));
        return json({ ok: true, handled_by: VERSION });
      }
    }

    return await agentsWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    return await agentsWorker.scheduled(event, env, ctx);
  }
};
