from __future__ import annotations

import uuid
from typing import Any

from brain import BrainStore, utc_now
from memory_engine import MemoryEngine
from openrouter_client import OpenRouterClient, parse_json_loose


class TaskEngine:
    def __init__(self, store: BrainStore, openrouter: OpenRouterClient, memory: MemoryEngine, config):
        self.store = store
        self.openrouter = openrouter
        self.memory = memory
        self.config = config

    def add_task(self, title: str, agent: str = "core", priority: int = 5) -> dict[str, Any]:
        task = {
            "id": "task_" + uuid.uuid4().hex[:10],
            "title": title.strip()[:500],
            "agent": agent,
            "status": "todo",
            "priority": int(priority),
            "retry_count": 0,
            "max_retries": 2,
            "created_at": utc_now(),
            "started_at": None,
            "finished_at": None,
            "timeout_ms": 90000,
            "result": None,
            "blocked_reason": None,
        }
        tasks = self.store.tasks()
        tasks.append(task)
        self.store.save_tasks(tasks)
        return task

    def select_next_task(self) -> dict[str, Any] | None:
        candidates = [t for t in self.store.tasks() if t.get("status") in {"todo", "retry_wait"}]
        if not candidates:
            return None
        return sorted(candidates, key=lambda t: (-int(t.get("priority", 0)), t.get("created_at", "")))[0]

    def _save_task(self, updated_task: dict[str, Any]) -> None:
        tasks = self.store.tasks()
        for index, task in enumerate(tasks):
            if task.get("id") == updated_task.get("id"):
                tasks[index] = updated_task
                break
        else:
            tasks.append(updated_task)
        self.store.save_tasks(tasks)

    def _make_prompt(self, title: str, agent: str) -> str:
        memories = self.memory.recent_context(limit=6)
        return (
            "Пиши по-русски, коротко, инженерно. "
            "Верни JSON с полями answer, message, memory_artifact, next_tasks.\n"
            f"agent={agent}\n"
            f"task={title}\n"
            f"memory={memories}\n"
            "memory_artifact fields: agent, signal, lesson, action, check, boundary, status, score, privacy."
        )

    async def think(self, text: str, agent: str = "core", mode: str = "cheap") -> dict[str, Any]:
        response = await self.openrouter.chat(self._make_prompt(text, agent), mode=mode)
        parsed = parse_json_loose(response.content) or {}
        answer = str(parsed.get("answer") or response.content).strip()
        message = str(parsed.get("message") or answer).strip()
        artifact = parsed.get("memory_artifact") or {
            "agent": agent,
            "signal": "Получен ответ модели.",
            "lesson": "Ответ нужно проверить практикой.",
            "action": "Сохранить короткий вывод.",
            "check": "Есть понятный следующий шаг.",
            "boundary": "Если вывод не проверен, считать hypothesis.",
            "status": "hypothesis",
            "score": 60,
            "privacy": "safe",
        }
        saved, memory_status, memory_obj = self.memory.save_memory(artifact, fallback_agent=agent)
        for next_title in parsed.get("next_tasks") or []:
            if isinstance(next_title, str) and next_title.strip():
                self.add_task(next_title.strip(), agent=agent, priority=4)
        self.store.add_message(message[:1000], source=agent)
        return {
            "answer": answer,
            "message": message,
            "memory_saved": saved,
            "memory_status": memory_status,
            "memory": memory_obj,
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
        }

    async def run_next_task(self) -> dict[str, Any]:
        task = self.select_next_task()
        if not task:
            return {"status": "idle", "message": "Нет задач в очереди."}
        task["status"] = "running"
        task["started_at"] = utc_now()
        self._save_task(task)
        try:
            result = await self.think(task["title"], agent=task.get("agent", "core"))
            task["status"] = "done"
            task["finished_at"] = utc_now()
            task["result"] = {"summary": result.get("message", "")[:1200], "memory_saved": result.get("memory_saved", False)}
            self._save_task(task)
            return {"status": "done", "task": task, "result": result}
        except Exception as exc:
            task["retry_count"] = int(task.get("retry_count", 0)) + 1
            task["blocked_reason"] = str(exc)[:1000]
            if task["retry_count"] <= int(task.get("max_retries", 2)):
                task["status"] = "retry_wait"
            else:
                task["status"] = "failed"
                task["finished_at"] = utc_now()
            self._save_task(task)
            return {"status": task["status"], "task": task, "error": str(exc)}
