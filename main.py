from __future__ import annotations

from brain import BrainStore
from config import AppConfig
from cost_guard import CostGuard
from memory_engine import MemoryEngine
from openrouter_client import OpenRouterClient
from task_engine import TaskEngine
from telegram_bot import MiniSkynetTelegramBot


def main() -> None:
    config = AppConfig.from_env()
    problems = config.validate_for_start()
    if problems:
        print("MiniSkynet cannot start:")
        for problem in problems:
            print(f"- {problem}")
        print("Create .env from .env.example and fill required values.")
        return

    store = BrainStore(config.data_dir)
    cost_guard = CostGuard(store, config)
    client = OpenRouterClient(config, cost_guard)
    memory = MemoryEngine(store)
    task_engine = TaskEngine(store, client, memory, config)
    bot = MiniSkynetTelegramBot(config, store, task_engine, memory, cost_guard)
    bot.run()


if __name__ == "__main__":
    main()
