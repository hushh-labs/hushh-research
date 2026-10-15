"""Token usage, pinned prices, a hard cost cap and a 429 pause guard.

Exact provider usage metadata is preferred. When a call path does not expose it
(the runtime ADK single-turn path), tokens are estimated from bytes and flagged
``estimated``. A model without a pinned price has cost None, never zero.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

CONFIG = Path(__file__).with_name("config")
BYTES_PER_TOKEN = 4


class BudgetExhausted(RuntimeError):
    """The hard cost cap would be exceeded; remaining work is recorded, not run."""


@dataclass(frozen=True)
class Price:
    input_per_1m: float
    output_per_1m: float
    source: str
    as_of: str
    verified: bool


def load_pricing(path: Path | None = None) -> dict[str, Price]:
    raw = json.loads((path or CONFIG / "pricing.json").read_text())
    if raw.get("schema_version") != "dpe.pricing.v1":
        raise ValueError("unsupported_pricing_version")
    return {
        model: Price(
            input_per_1m=float(item["input_per_1m_usd"]),
            output_per_1m=float(item["output_per_1m_usd"]),
            source=item["source"],
            as_of=item["as_of"],
            verified=bool(item["verified"]),
        )
        for model, item in raw["models"].items()
    }


def estimate_tokens(byte_count: int) -> int:
    return math.ceil(max(0, byte_count) / BYTES_PER_TOKEN)


def cost_usd(
    model: str, input_tokens: int | None, output_tokens: int | None, pricing: dict[str, Price]
) -> float | None:
    price = pricing.get(model)
    if price is None or input_tokens is None or output_tokens is None:
        return None
    return input_tokens / 1e6 * price.input_per_1m + output_tokens / 1e6 * price.output_per_1m


def usage_row(
    *,
    model: str,
    input_tokens: int | None,
    output_tokens: int | None,
    estimated: bool,
    pricing: dict[str, Price],
) -> dict:
    return {
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "estimated": estimated,
        "cost_usd": cost_usd(model, input_tokens, output_tokens, pricing),
    }


@dataclass
class Budget:
    """Hard cap. Unknown-cost calls are counted and priced at the cap's worst case."""

    max_usd: float
    spent_usd: float = 0.0
    calls: int = 0
    unknown_cost_calls: int = 0
    worst_case_call_usd: float = 0.25

    def reserve(self, expected_usd: float | None = None) -> None:
        expected = self.worst_case_call_usd if expected_usd is None else expected_usd
        if self.spent_usd + expected > self.max_usd:
            raise BudgetExhausted("budget_exhausted")

    def record(self, usage: dict) -> None:
        self.calls += 1
        cost = usage.get("cost_usd")
        if cost is None:
            self.unknown_cost_calls += 1
            self.spent_usd += self.worst_case_call_usd
        else:
            self.spent_usd += cost


@dataclass
class RateGuard:
    """Pause the whole batch when provider 429s exceed the threshold."""

    threshold: float = 0.02
    window: int = 200
    min_calls: int = 50
    pause_seconds: float = 60.0
    outcomes: deque = field(default_factory=deque)
    pauses: int = 0

    def record(self, *, rate_limited: bool) -> None:
        self.outcomes.append(bool(rate_limited))
        while len(self.outcomes) > self.window:
            self.outcomes.popleft()

    def rate(self) -> float:
        return sum(self.outcomes) / len(self.outcomes) if self.outcomes else 0.0

    def should_pause(self) -> bool:
        return len(self.outcomes) >= self.min_calls and self.rate() > self.threshold

    async def maybe_pause(self) -> bool:
        if not self.should_pause():
            return False
        self.pauses += 1
        await asyncio.sleep(self.pause_seconds)
        self.outcomes.clear()
        return True


def is_rate_limited(error: BaseException) -> bool:
    seen = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        text = str(current)
        if "429" in text or "RESOURCE_EXHAUSTED" in text:
            return True
        current = current.__cause__ or current.__context__
    return False
