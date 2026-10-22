"""Per-analysis outbound attempt counts, without URLs, keys or owner details."""

from __future__ import annotations

import logging
from collections import Counter
from contextvars import ContextVar, Token
from functools import lru_cache
from threading import Lock
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)
_current: ContextVar["ProviderCallCounts | None"] = ContextVar(
    "market_provider_calls", default=None
)


class ProviderCallCounts:
    def __init__(self) -> None:
        self._counts: Counter[str] = Counter()
        self.degraded_resources: set[str] = set()
        self._lock = Lock()

    def record(self, host: str) -> None:
        with self._lock:
            self._counts[host] += 1

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return dict(self._counts)

    def mark_degraded(self, resource: str) -> None:
        with self._lock:
            self.degraded_resources.add(resource)


def start_provider_call_counts() -> Token:
    return _current.set(ProviderCallCounts())


def finish_provider_call_counts(token: Token) -> dict[str, int]:
    counter = _current.get()
    result = counter.snapshot() if counter else {}
    logger.info("kai_provider_calls total=%s by_host=%s", sum(result.values()), result)
    _current.reset(token)
    return result


def record_provider_url(url: str) -> None:
    counter = _current.get()
    if counter is not None:
        counter.record(urlsplit(url).hostname or "unknown")


def record_provider_degradation(resource: str) -> None:
    counter = _current.get()
    if counter is not None:
        counter.mark_degraded(resource)


def degraded_provider_resources() -> set[str]:
    counter = _current.get()
    return set(counter.degraded_resources) if counter else set()


async def record_provider_request(request: httpx.Request) -> None:
    record_provider_url(str(request.url))


@lru_cache(maxsize=1)
def yahoo_counted_session():
    from curl_cffi.requests import Session

    class CountedSession(Session):
        def request(self, method, url, *args, **kwargs):
            record_provider_url(str(url))
            return super().request(method, url, *args, **kwargs)

    return CountedSession(impersonate="chrome")
