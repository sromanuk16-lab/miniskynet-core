from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class AppConfig:
    telegram_bot_token: str
    telegram_allowed_user_id: int | None
    openrouter_api_key: str
    model_cheap: str
    model_coding: str
    max_daily_cost_usd: float
    max_cycles_per_day: int
    cheap_input_cost_per_1m: float
    cheap_output_cost_per_1m: float
    coding_input_cost_per_1m: float
    coding_output_cost_per_1m: float
    max_input_chars: int
    max_output_tokens: int
    alive_interval_seconds: int
    alive_max_steps_per_tick: int
    data_dir: Path

    @classmethod
    def from_env(cls) -> "AppConfig":
        load_dotenv()

        def get_float(name: str, default: float) -> float:
            raw = os.getenv(name, str(default)).strip()
            try:
                return float(raw)
            except ValueError:
                return default

        def get_int(name: str, default: int) -> int:
            raw = os.getenv(name, str(default)).strip()
            try:
                return int(raw)
            except ValueError:
                return default

        allowed_raw = os.getenv("TELEGRAM_ALLOWED_USER_ID", "").strip()
        allowed_id = int(allowed_raw) if allowed_raw.isdigit() else None

        return cls(
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip(),
            telegram_allowed_user_id=allowed_id,
            openrouter_api_key=os.getenv("OPENROUTER_API_KEY", "").strip(),
            model_cheap=os.getenv("OPENROUTER_MODEL_CHEAP", "openai/gpt-4o-mini").strip(),
            model_coding=os.getenv("OPENROUTER_MODEL_CODING", "openai/gpt-4o-mini").strip(),
            max_daily_cost_usd=get_float("MAX_DAILY_COST_USD", 0.50),
            max_cycles_per_day=get_int("MAX_CYCLES_PER_DAY", 20),
            cheap_input_cost_per_1m=get_float("CHEAP_INPUT_COST_PER_1M", 0.15),
            cheap_output_cost_per_1m=get_float("CHEAP_OUTPUT_COST_PER_1M", 0.60),
            coding_input_cost_per_1m=get_float("CODING_INPUT_COST_PER_1M", 0.15),
            coding_output_cost_per_1m=get_float("CODING_OUTPUT_COST_PER_1M", 0.60),
            max_input_chars=get_int("MAX_INPUT_CHARS", 12000),
            max_output_tokens=get_int("MAX_OUTPUT_TOKENS", 900),
            alive_interval_seconds=get_int("ALIVE_INTERVAL_SECONDS", 900),
            alive_max_steps_per_tick=get_int("ALIVE_MAX_STEPS_PER_TICK", 1),
            data_dir=Path(os.getenv("MINISKYNET_DATA_DIR", "data")),
        )

    def validate_for_start(self) -> list[str]:
        problems: list[str] = []
        if not self.telegram_bot_token:
            problems.append("TELEGRAM_BOT_TOKEN is empty")
        if not self.openrouter_api_key:
            problems.append("OPENROUTER_API_KEY is empty")
        return problems
