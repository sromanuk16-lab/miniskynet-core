from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from cost_guard import CostGuard


@dataclass
class ModelResponse:
    content: str
    input_tokens: int
    output_tokens: int
    raw: dict[str, Any]


class OpenRouterClient:
    def __init__(self, config, cost_guard: CostGuard):
        self.config = config
        self.cost_guard = cost_guard

    def choose_model(self, mode: str = "cheap") -> str:
        return self.config.model_coding if mode == "coding" else self.config.model_cheap

    async def chat(self, prompt: str, mode: str = "cheap", max_tokens: int | None = None) -> ModelResponse:
        if not self.config.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is empty")

        prompt = prompt[: self.config.max_input_chars]
        max_tokens = max_tokens or self.config.max_output_tokens
        ok, reason, _estimate = self.cost_guard.can_start_cycle(prompt, max_tokens, mode=mode)
        if not ok:
            raise RuntimeError(f"CostGuard blocked request: {reason}")

        payload = {
            "model": self.choose_model(mode),
            "messages": [
                {"role": "system", "content": "You are MiniSkynet Core. Reply in Russian. Return valid JSON when asked."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.35,
            "max_tokens": max_tokens,
        }

        headers = {
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/sromanuk16-lab/miniskynet-core",
            "X-Title": "MiniSkynet Core",
        }
        headers["Authorization"] = "Bearer " + self.config.openrouter_api_key

        async with httpx.AsyncClient(timeout=90) as client:
            response = await client.post("https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload)

        if response.status_code >= 400:
            try:
                error_data = response.json()
            except json.JSONDecodeError:
                error_data = {"text": response.text}
            raise RuntimeError(f"OpenRouter HTTP {response.status_code}: {error_data}")

        data = response.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = data.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens") or self.cost_guard.estimate_tokens_from_chars(prompt))
        output_tokens = int(usage.get("completion_tokens") or self.cost_guard.estimate_tokens_from_chars(content))
        self.cost_guard.record_usage(input_tokens, output_tokens, mode=mode)
        return ModelResponse(content=content, input_tokens=input_tokens, output_tokens=output_tokens, raw=data)


def parse_json_loose(text: str) -> dict[str, Any] | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None
