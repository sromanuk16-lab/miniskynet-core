# MiniSkynet Core

MiniSkynet Core — личный Telegram-агент с памятью, задачами, OpenRouter и безопасным контрактом исполнения.

## Сейчас есть две версии

### 1. Python Core

Подходит для Codespaces/ПК/VPS, но требует постоянно запущенный процесс.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

### 2. Cloudflare Worker Core

Подходит для телефона и бесплатного serverless-пути. Не требует постоянно включённого процесса.

Файлы лежат в папке:

```text
cloudflare/
```

Схема:

```text
Telegram webhook -> Cloudflare Worker -> OpenRouter
Cloudflare Cron -> alive loop
Cloudflare KV -> brain / memory / tasks
```

Инструкция: `cloudflare/README.md`.

## Команды Telegram

- `/start` — подключить владельца и показать Telegram user id.
- `/help` — список команд.
- `/status` — состояние Core, память, задачи, лимиты.
- `/think текст` — один ручной цикл мышления.
- `/memory` — последние записи памяти.
- `/tasks` — очередь задач.
- `/addtask текст` — добавить задачу.
- `/alive_on` — включить автоцикл.
- `/alive_off` — выключить автоцикл.
- `/cost` — расход токенов и примерная стоимость.

## Безопасность

Настоящие ключи нельзя коммитить в GitHub. Храни их только в `.env`, Render/Replit/Cloudflare secrets или environment variables.

MiniSkynet не применяет self-update без подтверждения владельца. В v0.1 self-update пока только архитектурно подготовлен.
