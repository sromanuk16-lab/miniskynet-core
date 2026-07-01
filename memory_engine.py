from __future__ import annotations

import re
from typing import Any

from brain import BrainStore, utc_now


SECRET_RE = re.compile(
    r"(sk-or-[A-Za-z0-9_\-]{10,}|sk-[A-Za-z0-9_\-]{10,}|password|пароль|token|токен|secret|cookie|session)",
    re.IGNORECASE,
)


class MemoryEngine:
    REQUIRED_FIELDS = ("agent", "signal", "lesson", "action", "check", "boundary", "status", "score", "privacy")
    ALLOWED_STATUS = {"fact", "hypothesis", "rule", "action-only"}

    def __init__(self, store: BrainStore):
        self.store = store

    def has_secret(self, text: str) -> bool:
        return bool(SECRET_RE.search(text or ""))

    def normalize_memory(self, raw: dict[str, Any], fallback_agent: str = "core") -> dict[str, Any]:
        memory = dict(raw or {})
        memory.setdefault("agent", fallback_agent)
        memory.setdefault("signal", "Получен новый вывод MiniSkynet.")
        memory.setdefault("lesson", "Вывод нужно проверить практикой.")
        memory.setdefault("action", "Сохранить короткий проверяемый шаг.")
        memory.setdefault("check", "Есть понятный результат проверки.")
        memory.setdefault("boundary", "Если применимость не ясна, считать hypothesis.")
        memory.setdefault("status", "hypothesis")
        memory.setdefault("privacy", "safe")

        if memory["status"] not in self.ALLOWED_STATUS:
            memory["status"] = "hypothesis"

        try:
            score = int(float(memory.get("score", 75)))
        except (TypeError, ValueError):
            score = 75
        if 0 < score <= 10:
            score *= 10
        memory["score"] = max(0, min(100, score))
        memory["time"] = memory.get("time") or utc_now()
        return memory

    def save_memory(self, raw: dict[str, Any], fallback_agent: str = "core") -> tuple[bool, str, dict[str, Any] | None]:
        memory = self.normalize_memory(raw, fallback_agent=fallback_agent)
        text = str(memory)
        if self.has_secret(text):
            return False, "memory blocked: secret-like content", None

        missing = [field for field in self.REQUIRED_FIELDS if field not in memory]
        if missing:
            return False, f"memory blocked: missing fields {missing}", None

        memories = self.store.memories()
        memories.append(memory)
        self.store.save_memories(memories)
        return True, "memory saved", memory

    def recent_context(self, limit: int = 6) -> list[dict[str, Any]]:
        memories = self.store.memories()
        return memories[-limit:]

    def format_recent(self, limit: int = 8) -> str:
        memories = self.store.memories()[-limit:]
        if not memories:
            return "Память пока пустая."
        lines = []
        for idx, mem in enumerate(reversed(memories), start=1):
            lines.append(
                f"{idx}. [{mem.get('status')}/{mem.get('score')}] "
                f"{mem.get('lesson')} → {mem.get('action')}"
            )
        return "\n".join(lines)
