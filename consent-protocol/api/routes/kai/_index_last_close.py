"""Shared last-close snapshot of the four US index quotes.

The benchmark indices are public and identical for every viewer, so they live in
one entry instead of inside each viewer's quote bundle. The entry is refreshed
only during the regular session, kept for at least seven days, and served
unchanged while the exchange is closed, so the quote time shown is the
provider's original one.

Collaborators arrive as ports so the route module keeps late binding of its own
cache and provider functions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ._market_presentation import resolve_public_module

INDEX_SYMBOLS: tuple[str, ...] = ("^GSPC", "^IXIC", "^DJI", "^RUT")
INDEX_LAST_CLOSE_KEY = "indices:us:last-close:v1"
LAST_CLOSE_PREFIXES: tuple[str, ...] = ("indices:",)
INDEX_PUBLIC_USER = "market-public"

ModuleRead = tuple[Any, bool, int, str, bool]


class IndexQuotesUnavailable(RuntimeError):
    """No index quote resolved, so the previous last-close snapshot must be kept."""


def closed_index_view(bundle: Any) -> Any:
    """Label saved quotes as closed without touching any quoted value or time."""
    quotes = bundle.get("quotes") if isinstance(bundle, dict) else None
    if not isinstance(quotes, dict):
        return bundle
    return {
        **bundle,
        "quotes": {
            symbol: {**quote, "market_state": "closed"} if isinstance(quote, dict) else quote
            for symbol, quote in quotes.items()
        },
    }


def merge_quote_bundles(*bundles: Any) -> dict[str, Any]:
    """Union the quotes and provider status of bundles; later bundles win a shared symbol."""
    quotes: dict[str, Any] = {}
    status: dict[str, Any] = {}
    for bundle in bundles:
        if not isinstance(bundle, dict):
            continue
        quotes.update(bundle["quotes"] if isinstance(bundle.get("quotes"), dict) else {})
        status.update(bundle.get("provider_status") or {})
    return {"quotes": quotes, "provider_status": status}


@dataclass(frozen=True)
class IndexLastClose:
    read_module: Callable[..., Awaitable[ModuleRead]]
    fetch_batch: Callable[..., Awaitable[dict[str, Any]]]
    safe_float: Callable[[Any], float | None]
    now_iso: Callable[[], str]
    status_from_exception: Callable[[Exception], str]
    is_open: Callable[[], bool]
    fresh_ttl_seconds: int
    stale_ttl_seconds: int
    logger: logging.Logger

    async def fetch(self) -> dict[str, Any]:
        """Read the indices in one keyless batch and refuse an empty result.

        Raising on an empty result stops the cache from replacing a good snapshot
        with nothing; a partial result is stored and retried during the session.
        """
        batch = await self.fetch_batch(list(INDEX_SYMBOLS), INDEX_PUBLIC_USER, None)
        quotes: dict[str, Any] = {}
        statuses: dict[str, str] = {}
        for symbol in INDEX_SYMBOLS:
            quote = batch.get(symbol) if isinstance(batch, dict) else None
            ok = self.safe_float((quote or {}).get("price")) is not None
            statuses[f"quote:{symbol}"] = "ok" if ok else "unavailable"
            if ok:
                quotes[symbol] = quote
        if not quotes:
            raise IndexQuotesUnavailable("index_quotes_unavailable")
        return {"quotes": quotes, "provider_status": statuses, "generated_at": self.now_iso()}

    async def load(self, warm_source: str) -> ModuleRead:
        """Indices for one page; a closed exchange replays the saved last close."""
        value, stale, age, tier, hit = await resolve_public_module(
            "indices",
            self.read_module(
                key=INDEX_LAST_CLOSE_KEY,
                fresh_ttl_seconds=self.fresh_ttl_seconds,
                stale_ttl_seconds=self.stale_ttl_seconds,
                fetcher=self.fetch,
                warm_source=warm_source,
            ),
            lambda status: {
                "quotes": {},
                "provider_status": {f"quote:{symbol}": status for symbol in INDEX_SYMBOLS},
                "generated_at": self.now_iso(),
            },
            self.status_from_exception,
            self.logger,
        )
        return (value if self.is_open() else closed_index_view(value)), stale, age, tier, hit

    async def warm(self) -> str | None:
        """Refresh during a session; returns a one-line summary, or None when it failed."""
        try:
            _, stale, age, tier, hit = await self.read_module(
                key=INDEX_LAST_CLOSE_KEY,
                fresh_ttl_seconds=self.fresh_ttl_seconds,
                stale_ttl_seconds=self.stale_ttl_seconds,
                fetcher=self.fetch,
                warm_source="startup",
                serve_stale_while_revalidate=False,
            )
        except Exception as exc:
            self.logger.warning(
                "[Kai Market] background indices refresh failed: %s", type(exc).__name__
            )
            return None
        return f"indices:tier={tier},hit={str(hit).lower()},stale={str(stale).lower()},age={age}s"
