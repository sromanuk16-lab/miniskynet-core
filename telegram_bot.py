from __future__ import annotations

import asyncio
from typing import Any

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

from brain import BrainStore
from cost_guard import CostGuard
from memory_engine import MemoryEngine
from task_engine import TaskEngine


class MiniSkynetTelegramBot:
    def __init__(self, config, store: BrainStore, task_engine: TaskEngine, memory_engine: MemoryEngine, cost_guard: CostGuard):
        self.config = config
        self.store = store
        self.task_engine = task_engine
        self.memory_engine = memory_engine
        self.cost_guard = cost_guard
        self.alive_task: asyncio.Task | None = None

    def is_allowed(self, update: Update) -> bool:
        if self.config.telegram_allowed_user_id is None:
            return True
        user = update.effective_user
        return bool(user and user.id == self.config.telegram_allowed_user_id)

    async def deny_if_needed(self, update: Update) -> bool:
        if self.is_allowed(update):
            return False
        if update.message:
            await update.message.reply_text("⛔ Доступ закрыт. Этот MiniSkynet привязан к владельцу.")
        return True

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        user_id = update.effective_user.id if update.effective_user else None
        chat_id = update.effective_chat.id if update.effective_chat else None
        self.store.set_alive(False, owner_chat_id=chat_id)
        text = (
            "✅ MiniSkynet Core v0.1 проснулся.\n\n"
            f"Твой Telegram user id: {user_id}\n"
            f"Chat id: {chat_id}\n\n"
            "Команды: /help, /status, /think, /tasks, /memory, /alive_on"
        )
        if self.config.telegram_allowed_user_id is None:
            text += "\n\n⚠️ TELEGRAM_ALLOWED_USER_ID не задан. Впиши свой user id в .env."
        await update.message.reply_text(text)

    async def help(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        await update.message.reply_text(
            "/start — запустить и показать id\n"
            "/status — состояние\n"
            "/think текст — один цикл мышления\n"
            "/tasks — задачи\n"
            "/addtask текст — добавить задачу\n"
            "/memory — последние памяти\n"
            "/alive_on — включить автоцикл\n"
            "/alive_off — выключить автоцикл\n"
            "/cost — расход"
        )

    async def status(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        brain = self.store.brain()
        tasks = self.store.tasks()
        memories = self.store.memories()
        todo = len([t for t in tasks if t.get("status") in {"todo", "retry_wait"}])
        done = len([t for t in tasks if t.get("status") == "done"])
        await update.message.reply_text(
            "📡 MiniSkynet status\n"
            f"- alive: {brain.get('alive_enabled')}\n"
            f"- cycles total: {brain.get('stats', {}).get('cycles_total', 0)}\n"
            f"- tasks: todo={todo}, done={done}\n"
            f"- memories: {len(memories)}\n"
            f"- model cheap: {self.config.model_cheap}\n"
            f"- interval: {self.config.alive_interval_seconds}s"
        )

    async def think(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        text = " ".join(context.args).strip() or "Сделай один маленький полезный шаг для развития MiniSkynet."
        await update.message.reply_text("🤔 Думаю...")
        try:
            result = await self.task_engine.think(text, agent="core", mode="cheap")
            await update.message.reply_text(
                f"🧠 {result['answer'][:3000]}\n\n"
                f"memory: {result['memory_status']}\n"
                f"usage: in={result['input_tokens']} out={result['output_tokens']}"
            )
        except Exception as exc:
            await update.message.reply_text(f"❌ Ошибка think:\n{exc}")

    async def memory(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        await update.message.reply_text("🧠 Последняя память:\n" + self.memory_engine.format_recent(limit=8))

    async def tasks(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        tasks = self.store.tasks()[-15:]
        if not tasks:
            await update.message.reply_text("Очередь задач пустая.")
            return
        lines = []
        for task in tasks:
            lines.append(
                f"- {task.get('status')} | p{task.get('priority')} | {task.get('title')} | retry {task.get('retry_count')}/{task.get('max_retries')}"
            )
        await update.message.reply_text("📋 Задачи:\n" + "\n".join(lines))

    async def addtask(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        title = " ".join(context.args).strip()
        if not title:
            await update.message.reply_text("Напиши так: /addtask проверить память")
            return
        task = self.task_engine.add_task(title, agent="core", priority=5)
        await update.message.reply_text(f"✅ Добавил задачу: {task['id']}\n{task['title']}")

    async def cost(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        await update.message.reply_text("💰 " + self.cost_guard.format_report())

    async def alive_on(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        chat_id = update.effective_chat.id
        self.store.set_alive(True, owner_chat_id=chat_id)
        if self.alive_task is None or self.alive_task.done():
            self.alive_task = context.application.create_task(self.alive_loop(context.application, chat_id))
        await update.message.reply_text(f"✅ Alive Loop включён. Интервал: {self.config.alive_interval_seconds}s.")

    async def alive_off(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if await self.deny_if_needed(update):
            return
        self.store.set_alive(False)
        if self.alive_task and not self.alive_task.done():
            self.alive_task.cancel()
        await update.message.reply_text("😴 Alive Loop выключен.")

    async def alive_loop(self, app: Application, chat_id: int) -> None:
        while True:
            try:
                if not self.store.brain().get("alive_enabled"):
                    return
                if not any(t.get("status") in {"todo", "retry_wait"} for t in self.store.tasks()):
                    self.task_engine.add_task("Сформулировать один маленький следующий шаг развития MiniSkynet.", agent="goal", priority=3)
                result: dict[str, Any] = {"status": "idle", "message": "Нет действий."}
                for _ in range(self.config.alive_max_steps_per_tick):
                    result = await self.task_engine.run_next_task()
                if result.get("status") == "done":
                    msg = result.get("result", {}).get("message") or result.get("task", {}).get("result", {}).get("summary") or "Шаг выполнен."
                    await app.bot.send_message(chat_id=chat_id, text=f"🌙 MiniSkynet сам сделал шаг:\n{msg[:3000]}")
                elif result.get("status") in {"failed", "retry_wait"}:
                    await app.bot.send_message(chat_id=chat_id, text=f"⚠️ Alive task {result.get('status')}: {result.get('error')}")
            except asyncio.CancelledError:
                return
            except Exception as exc:
                try:
                    await app.bot.send_message(chat_id=chat_id, text=f"❌ Alive Loop error: {exc}")
                except Exception:
                    pass
            await asyncio.sleep(self.config.alive_interval_seconds)

    def run(self) -> None:
        application = Application.builder().token(self.config.telegram_bot_token).build()
        application.add_handler(CommandHandler("start", self.start))
        application.add_handler(CommandHandler("help", self.help))
        application.add_handler(CommandHandler("status", self.status))
        application.add_handler(CommandHandler("think", self.think))
        application.add_handler(CommandHandler("memory", self.memory))
        application.add_handler(CommandHandler("tasks", self.tasks))
        application.add_handler(CommandHandler("addtask", self.addtask))
        application.add_handler(CommandHandler("alive_on", self.alive_on))
        application.add_handler(CommandHandler("alive_off", self.alive_off))
        application.add_handler(CommandHandler("cost", self.cost))
        print("✅ MiniSkynet Telegram bot started.")
        application.run_polling()
