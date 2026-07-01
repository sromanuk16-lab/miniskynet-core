# MiniSkynet Cloudflare Worker

Это бесплатная serverless-версия MiniSkynet без постоянно включённого Python-процесса.

Схема:

```text
Telegram webhook -> Cloudflare Worker -> OpenRouter
Cloudflare Cron -> alive loop
Cloudflare KV -> brain / memory / tasks / config
```

## Что уже умеет

- `/start` — проснуться и показать Telegram user id / chat id.
- `/status` — состояние ядра.
- `/think текст` — ручной цикл мышления.
- `/addtask текст` — добавить задачу.
- `/tasks` — очередь задач.
- `/memory` — последние Memory Artifact.
- `/cost` — примерный расход.
- `/alive_on` — включить cron-автоцикл.
- `/alive_off` — выключить cron-автоцикл.

## KV binding

Нужно создать KV namespace и привязать к Worker:

```text
Binding name: MINISKYNET_KV
KV namespace: MINISKYNET
```

## Секреты через KV Pairs

Если мобильный интерфейс Cloudflare не даёт добавить Variables/Secrets, можно положить конфиг прямо в KV Pairs.

В KV namespace `MINISKYNET` добавь entries:

```text
config:TELEGRAM_BOT_TOKEN = token from BotFather
config:OPENROUTER_API_KEY = OpenRouter key
config:SETUP_SECRET = miniskynet-setup-2026
```

Опционально позже:

```text
config:TELEGRAM_ALLOWED_USER_ID = your Telegram user id
config:OPENROUTER_MODEL_CHEAP = openai/gpt-4o-mini
config:MAX_DAILY_COST_USD = 0.50
config:MAX_CYCLES_PER_DAY = 20
config:MAX_OUTPUT_TOKENS = 800
```

Worker v0.1.1 сначала читает обычные Cloudflare env vars, а если их нет — подтягивает `config:*` из KV.

## Webhook setup

После деплоя открой в браузере:

```text
https://YOUR_WORKER_URL/setup-webhook?secret=YOUR_SETUP_SECRET
```

Например:

```text
https://miniskynet-core.sromanuk16.workers.dev/setup-webhook?secret=miniskynet-setup-2026
```

Worker сам вызовет Telegram `setWebhook` и привяжет Telegram-бота к адресу:

```text
https://YOUR_WORKER_URL/telegram
```

## Важная логика

Cloudflare версия не держит вечный процесс. Она просыпается:

- когда Telegram присылает webhook;
- по cron-триггеру из `wrangler.toml`.

Это лучше для телефона и бесплатного режима: не нужен Codespaces, Render или Replit.
