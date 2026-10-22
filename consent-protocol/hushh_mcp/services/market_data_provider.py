"""Replaceable market-information port. Credentials never belong in its cache keys.

The transitional adapter preserves existing sources until a licensed provider is
selected. Fixtures are explicitly bound in process, never selected by a public
request or silently used when a live source fails.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterator, Literal, Protocol, TypedDict


class MarketQuote(TypedDict, total=False):
    ticker: str
    price: float | None
    quoted_at: str | None
    quote_delay_minutes: int | None
    market_state: str | None
    is_delayed: bool | None
    source: str
    market_cap: float | None
    pe_ratio: float | None
    pb_ratio: float | None
    forward_pe: float | None
    ps_ratio: float | None
    ev_ebitda: float | None
    dividend_yield: float | None


MarketOperation = Literal[
    "quote",
    "quotes",
    "intraday",
    "session_history",
    "market_status",
    "movers",
    "most_active",
    "news",
    "peers",
    "ratios",
    "price_targets",
    "sector_rotation",
]


@dataclass(frozen=True)
class MarketDataRequest:
    operation: MarketOperation
    symbols: tuple[str, ...] = ()
    days_back: int = 7
    exchange: str = "US"
    allow_slow_fallbacks: bool = True


class MarketDataProvider(Protocol):
    """All numeric unknowns are None; dividend_yield is a fraction (0.02 = 2%)."""

    name: str

    async def fetch(self, request: MarketDataRequest) -> Any: ...


class MarketDataUnavailable(RuntimeError):
    """An unavailable capability is explicit and never falls back to fixtures."""


class FixtureMarketDataProvider:
    name = "fixture"

    def __init__(self, records: dict[MarketDataRequest, Any]) -> None:
        self._records = deepcopy(records)
        self.calls: list[MarketDataRequest] = []

    async def fetch(self, request: MarketDataRequest) -> Any:
        self.calls.append(request)
        if request not in self._records:
            raise MarketDataUnavailable(f"fixture_missing:{request.operation}")
        return deepcopy(self._records[request])


_bound_provider: ContextVar[MarketDataProvider | None] = ContextVar(
    "kai_market_data_provider", default=None
)


@contextmanager
def bind_market_data_provider(provider: MarketDataProvider) -> Iterator[None]:
    """Trusted composition/test seam, isolated across concurrent tasks."""
    token = _bound_provider.set(provider)
    try:
        yield
    finally:
        _bound_provider.reset(token)


def get_bound_market_data_provider() -> MarketDataProvider | None:
    return _bound_provider.get()


async def fetch_with_market_provider(
    request: MarketDataRequest, legacy_fetch: Callable[[], Awaitable[Any]]
) -> Any:
    """Transitional route seam: existing adapter remains until explicit cutover."""
    provider = get_bound_market_data_provider()
    if provider is not None:
        return await provider.fetch(request)
    return await legacy_fetch()
