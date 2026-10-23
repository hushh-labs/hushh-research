"""Task-local runtime port; shared persistence is selected only at composition time."""

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Awaitable, Callable, Iterator, Protocol, cast

from .ports import MarketDataRequest


class MarketRuntimePort(Protocol):
    async def fetch(self, request: MarketDataRequest, *, cached: bool = False) -> Any: ...

    async def public_information(
        self, key: str, *, fresh: int, stale: int, fetcher: Callable[[], Awaitable[Any]]
    ) -> Any: ...

    def yahoo_session(self) -> Any: ...


_bound_runtime: ContextVar[MarketRuntimePort | None] = ContextVar(
    "kai_market_runtime", default=None
)


@contextmanager
def bind_market_runtime(runtime: MarketRuntimePort) -> Iterator[None]:
    token = _bound_runtime.set(runtime)
    try:
        yield
    finally:
        _bound_runtime.reset(token)


def get_market_runtime() -> MarketRuntimePort:
    runtime = _bound_runtime.get()
    if runtime is not None:
        return runtime
    # Standalone operon entrypoints retain their existing shared-runtime default.
    from hushh_mcp.services.market_runtime_adapter import shared_market_runtime

    return cast(MarketRuntimePort, shared_market_runtime)
