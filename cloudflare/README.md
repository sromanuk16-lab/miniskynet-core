# MiniSkynet Cloudflare Worker

Это бесплатная серверная версия MiniSkynet без постоянно включённого Python-процесса.

Схема:

```text
Telegram webhook -> Cloudflare Worker -> OpenRouter
Cloudflare Cron -> alive loop
Cloudflare KV -> brain / memory / tasks
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

## Переменные окружения / Secrets

В Cloudflare Worker добавь:

```env
TELEGRAM_BOT_TOKEN=token from BotFather
OPENROUTER_API_KEY=OpenRouter key
SETUP_SECRET=random-long-secret
TELEGRAM_ALLOWED_USER_ID=
OPENROUTER_MODEL_CHEAP=openai/gpt-4o-mini
MAX_DAILY_COST_USD=0.50
MAX_CYCLES_PER_DAY=20
MAX_OUTPUT_TOKENS=800
```

`TELEGRAM_ALLOWED_USER_ID` сначала можно оставить пустым. После `/start` бот покажет твой user id; потом впиши его для защиты.

## KV binding

Нужно создать KV namespace и привязать к Worker:

```text
Binding name: MINISKYNET_KV
```

Без этого Worker откроется, но Telegram/память не заработают.

## Webhook setup

После деплоя открой в браузере:

```text
https://YOUR_WORKER_URL/setup-webhook?secret=YOUR_SETUP_SECRET
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
