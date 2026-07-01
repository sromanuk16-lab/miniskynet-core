# MiniSkynet Core

MiniSkynet Core — личный Telegram-агент с памятью, задачами, OpenRouter и безопасным контрактом исполнения.

Цель v0.1: живой Core, который отвечает в Telegram, ведёт память, хранит задачи, контролирует расход токенов и умеет запускать ручной/автоцикл, пока Codespaces открыт.

## Быстрый старт в Codespaces

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

Потом заполни `.env` своими ключами:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
OPENROUTER_API_KEY=...
```

Настоящие ключи нельзя коммитить в GitHub.

## Команды Telegram

- `/start` — подключить владельца и показать Telegram user id.
- `/help` — список команд.
- `/status` — состояние Core, память, задачи, лимиты.
- `/think текст` — один ручной цикл мышления.
- `/memory` — последние записи памяти.
- `/tasks` — очередь задач.
- `/addtask текст` — добавить задачу.
- `/alive_on` — включить автоцикл, пока процесс запущен.
- `/alive_off` — выключить автоцикл.
- `/cost` — расход токенов и примерная стоимость.

## Архитектура v0.1

```text
Telegram Bot
→ Task Engine
→ OpenRouter Client
→ Memory Engine
→ Brain Store / JSON files
→ Cost Guard
```

## Безопасность

MiniSkynet не применяет self-update без подтверждения владельца. В v0.1 self-update пока только архитектурно подготовлен.
