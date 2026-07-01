from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from brain import BrainStore


def today_key() -> str:
    return datetime.now(timezone.utc).date().isoformat()


@dataclass
class UsageEstimate:
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float


class CostGuard:
    def __init__(self, store: BrainStore, config):
        self.store = store
        self.config = config

    @staticmethod
    def estimate_tokens_from_chars(text: str) -> int:
        return max(1, len(text) // 4)

    def estimate_cost(self, input_tokens: int, output_tokens: int, mode: str = "cheap") -> float:
        if mode == "coding":
            in_price = self.config.coding_input_cost_per_1m
            out_price = self.config.coding_output_cost_per_1m
        else:
            in_price = self.config.cheap_input_cost_per_1m
            out_price = self.config.cheap_output_cost_per_1m
        return (input_tokens / 1_000_000) * in_price + (output_tokens / 1_000_000) * out_price

    def daily_stats(self) -> dict[str, Any]:
        brain = self.store.brain()
        daily = brain.setdefault("stats", {}).setdefault("daily", {})
        key = today_key()
        stats = daily.setdefault(key, {"cycles": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0})
        self.store.save_brain(brain)
        return stats

    def can_start_cycle(self, prompt_text: str, max_output_tokens: int, mode: str = "cheap") -> tuple[bool, str, UsageEstimate]:
        input_tokens = self.estimate_tokens_from_chars(prompt_text)
        estimate = UsageEstimate(
            input_tokens=input_tokens,
            output_tokens=max_output_tokens,
            estimated_cost_usd=self.estimate_cost(input_tokens, max_output_tokens, mode),
        )
        stats = self.daily_stats()
        projected = float(stats.get("cost_usd", 0.0)) + estimate.estimated_cost_usd
        if int(stats.get("cycles", 0)) >= self.config.max_cycles_per_day:
            return False, "daily cycle limit reached", estimate
        if projected > self.config.max_daily_cost_usd:
            return False, f"daily cost limit would be exceeded: ${projected:.4f}", estimate
        return True, "ok", estimate

    def record_usage(self, input_tokens: int, output_tokens: int, mode: str = "cheap") -> float:
        cost = self.estimate_cost(input_tokens, output_tokens, mode)
        brain = self.store.brain()
        daily = brain.setdefault("stats", {}).setdefault("daily", {})
        stats = daily.setdefault(today_key(), {"cycles": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0})
        stats["cycles"] = int(stats.get("cycles", 0)) + 1
        stats["input_tokens"] = int(stats.get("input_tokens", 0)) + int(input_tokens)
        stats["output_tokens"] = int(stats.get("output_tokens", 0)) + int(output_tokens)
        stats["cost_usd"] = round(float(stats.get("cost_usd", 0.0)) + cost, 6)
        brain.setdefault("stats", {})["cycles_total"] = int(brain.get("stats", {}).get("cycles_total", 0)) + 1
        self.store.save_brain(brain)
        return cost

    def format_report(self) -> str:
        stats = self.daily_stats()
        return (
            f"Сегодня:\n"
            f"- cycles: {stats.get('cycles', 0)} / {self.config.max_cycles_per_day}\n"
            f"- input tokens: {stats.get('input_tokens', 0)}\n"
            f"- output tokens: {stats.get('output_tokens', 0)}\n"
            f"- cost: ${float(stats.get('cost_usd', 0.0)):.6f} / ${self.config.max_daily_cost_usd:.2f}"
        )
