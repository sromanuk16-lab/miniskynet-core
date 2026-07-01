from __future__ import annotations

from dataclasses import dataclass


@dataclass
class UpdateProposal:
    title: str
    summary: str
    risk: str
    patch_plan: list[str]


class SelfUpdatePlanner:
    """
    v0.1 безопасно не переписывает код сам.

    Следующий уровень:
    1. анализ кода;
    2. предложение patch plan;
    3. проверка в sandbox;
    4. diff владельцу;
    5. применение только после approve.
    """

    def propose_next_step(self) -> UpdateProposal:
        return UpdateProposal(
            title="Execution Contract v0.2",
            summary="Добавить строгий отчёт после каждого автоцикла.",
            risk="Низкий, если не трогать Telegram auth и .env.",
            patch_plan=[
                "Добавить task result contract.",
                "Добавить /approve_update stub.",
                "Добавить smoke tests.",
            ],
        )
