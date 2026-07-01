from __future__ import annotations

import json
import py_compile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PY_FILES = [
    "main.py",
    "config.py",
    "brain.py",
    "openrouter_client.py",
    "telegram_bot.py",
    "task_engine.py",
    "memory_engine.py",
    "cost_guard.py",
    "self_update.py",
]


def main() -> None:
    for name in PY_FILES:
        py_compile.compile(str(ROOT / name), doraise=True)

    for name in ["data/brain.json", "data/tasks.json", "data/memories.json"]:
        json.loads((ROOT / name).read_text(encoding="utf-8"))

    print("✅ smoke test passed")


if __name__ == "__main__":
    main()
