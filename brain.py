from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class BrainStore:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.brain_path = self.data_dir / "brain.json"
        self.tasks_path = self.data_dir / "tasks.json"
        self.memories_path = self.data_dir / "memories.json"
        self.ensure_files()

    def ensure_files(self) -> None:
        if not self.brain_path.exists():
            self.write_json(self.brain_path, self.default_brain())
        if not self.tasks_path.exists():
            self.write_json(self.tasks_path, {"tasks": []})
        if not self.memories_path.exists():
            self.write_json(self.memories_path, {"memories": []})

    @staticmethod
    def default_brain() -> dict[str, Any]:
        return {
            "version": "0.1.0",
            "created_at": utc_now(),
            "alive_enabled": False,
            "owner_chat_id": None,
            "stats": {
                "cycles_total": 0,
                "last_cycle_at": None,
                "daily": {},
            },
            "messages": [],
            "notes": [],
        }

    def read_json(self, path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.write_json(path, fallback)
            return fallback
        except json.JSONDecodeError:
            backup = path.with_suffix(path.suffix + ".broken")
            path.replace(backup)
            self.write_json(path, fallback)
            return fallback

    def write_json(self, path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=str(path.parent))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_name, path)

    def brain(self) -> dict[str, Any]:
        return self.read_json(self.brain_path, self.default_brain())

    def save_brain(self, brain: dict[str, Any]) -> None:
        messages = brain.get("messages", [])
        if isinstance(messages, list):
            brain["messages"] = messages[-120:]
        notes = brain.get("notes", [])
        if isinstance(notes, list):
            brain["notes"] = notes[-120:]
        self.write_json(self.brain_path, brain)

    def tasks(self) -> list[dict[str, Any]]:
        data = self.read_json(self.tasks_path, {"tasks": []})
        tasks = data.get("tasks", [])
        return tasks if isinstance(tasks, list) else []

    def save_tasks(self, tasks: list[dict[str, Any]]) -> None:
        self.write_json(self.tasks_path, {"tasks": tasks[-80:]})

    def memories(self) -> list[dict[str, Any]]:
        data = self.read_json(self.memories_path, {"memories": []})
        memories = data.get("memories", [])
        return memories if isinstance(memories, list) else []

    def save_memories(self, memories: list[dict[str, Any]]) -> None:
        self.write_json(self.memories_path, {"memories": memories[-200:]})

    def add_message(self, text: str, source: str = "core") -> None:
        brain = self.brain()
        brain.setdefault("messages", []).append(
            {"time": utc_now(), "source": source, "text": text[:4000]}
        )
        self.save_brain(brain)

    def set_alive(self, enabled: bool, owner_chat_id: int | None = None) -> None:
        brain = self.brain()
        brain["alive_enabled"] = enabled
        if owner_chat_id is not None:
            brain["owner_chat_id"] = owner_chat_id
        self.save_brain(brain)
