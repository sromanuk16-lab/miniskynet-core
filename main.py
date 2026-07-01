from __future__ import annotations

import asyncio

from brain import BrainStore
from config import AppConfig
from cost_guard import CostGuard
from memory_engine import MemoryEngine
from openrouter_client import OpenRouterClient
from task_engine import TaskEngine
from telegram_bot import MiniSkynetTelegramBot


async def async_main() -> int:
    config = AppConfig.from_env()
    problems = config.validate_for_start()
    if problems:
        print("❌ MiniSkynet cannot start:")
        for problem in problems:
            print(f"- {problem}")
        print("\nCreate .env from .env.example and fill the required values.")
        return 1

    store = BrainStore(config.data_dir)
    cost_guard = CostGuard(store, config)
    openrouter = OpenRouterClient(config, cost_guard)
    memory = MemoryEngine(store)
    task_engine = TaskEngine(store, openrouter, memory, config)
    bot = MiniSkynetTelegramBot(config, store, task_engine, memory, cost_guard)

    await bot.run()
    return 0


def main() -> None:
    try:
        raise SystemExit(asyncio.run(async_main()))
    except KeyboardInterrupt:
        print("\n😴 MiniSkynet stopped by user.")
        raise SystemExit(0)


if __name__ == "__main__":
    main()
