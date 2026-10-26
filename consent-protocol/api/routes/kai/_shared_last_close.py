"""Shared last-close quote entries: the four US indices and each public pick list.

Index levels and pick-list prices are public and identical for every viewer, so they
live in shared entries instead of inside each viewer's own bundle. An entry is
refreshed only during the regular session, kept for at least seven days, and served
unchanged while the exchange is closed, so the quote time shown is the provider's
original one.

Collaborators arrive as ports so the route module keeps late binding of its own
cache and provider functions.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ._market_presentation import resolve_public_module

INDEX_SYMBOLS: tuple[str, ...] = ("^GSPC", "^IXIC", "^DJI", "^RUT")
INDEX_LAST_CLOSE_KEY = "indices:us:last-close:v1"
LAST_CLOSE_PREFIXES: tuple[str, ...] = ("indices:", "picks:")
PUBLIC_USER = "market-public"

ModuleRead = tuple[Any, bool, int, str, bool]


class QuotesUnavailable(RuntimeError):
    """No quote resolved, so the previous last-close snapshot must be kept."""


def picks_key(symbols: Iterable[str]) -> str:
    """One shared key per pick list, whoever asks: a pure function of the public symbols."""
    digest = hashlib.sha256(",".join(sorted(set(symbols))).encode()).hexdigest()
    return f"picks:us:{digest[:16]}:v1"


def closed_view(bundle: Any) -> Any:
    """Label saved quotes as closed without touching any quoted value or time."""
    quotes = bundle.get("quotes") if isinstance(bundle, dict) else None
    if not isinstance(quotes, dict):
        return bundle
    return {
        **bundle,
        "quotes": {
            symbol: {**quote, "market_state": "closed"}
            if isinstance(quote, dict) and quote
            else quote
            for symbol, quote in quotes.items()
        },
    }


def merge_quote_bundles(*bundles: Any) -> dict[str, Any]:
    """Union quotes and provider status; an empty quote never replaces a real one."""
    quotes: dict[str, Any] = {}
    status: dict[str, Any] = {}
    for bundle in bundles:
        if not isinstance(bundle, dict):
            continue
        found = bundle.get("quotes")
        quotes.update({s: q for s, q in found.items() if q} if isinstance(found, dict) else {})
        status.update(bundle.get("provider_status") or {})
    return {"quotes": quotes, "provider_status": status}


@dataclass(frozen=True)
class SharedLastClose:
    read_module: Callable[..., Awaitable[ModuleRead]]
    fetch_batch: Callable[..., Awaitable[dict[str, Any]]]
    fetch_one: Callable[..., Awaitable[dict[str, Any]]]
    safe_float: Callable[[Any], float | None]
    now_iso: Callable[[], str]
    status_from_exception: Callable[[Exception], str]
    is_open: Callable[[], bool]
    pick_symbols: Callable[[], Awaitable[list[str]]]
    fresh_ttl_seconds: int
    stale_ttl_seconds: int
    fanout: int
    logger: logging.Logger

    async def nothing_to_read(self) -> ModuleRead:
        return {"quotes": {}, "provider_status": {}}, False, 0, "memory", True

    async def fetch_bundle(
        self,
        symbols: Sequence[str],
        user_id: str = PUBLIC_USER,
        consent_token: str | None = None,
        *,
        fallbacks: bool = True,
        require_any: bool = False,
    ) -> dict[str, Any]:
        """One keyless batch, then per-symbol fallbacks for what the batch missed.

        The viewer's own bundle and a pick list opened by a viewer take the fallbacks;
        indices and the warmer pass ``fallbacks=False``. ``require_any`` makes a shared
        entry raise on an empty result, so the cache keeps its last snapshot instead of
        replacing it with nothing; a partial result is stored and retried in session.
        """
        symbols = list(symbols)
        quotes: dict[str, Any] = {}
        statuses: dict[str, str] = {}
        try:
            batch = await self.fetch_batch(symbols, user_id, consent_token) if symbols else {}
        except Exception as exc:
            self.logger.debug("[Kai Market] quote batch failed: %s", type(exc).__name__)
            batch = {}
        unresolved: list[str] = []
        for symbol in symbols:
            quote = batch.get(symbol) if isinstance(batch, dict) else None
            if self.safe_float((quote or {}).get("price")) is None:
                unresolved.append(symbol)
                continue
            quotes[symbol] = quote
            statuses[f"quote:{symbol}"] = "ok"
        gate = asyncio.Semaphore(self.fanout)
        results = (
            await asyncio.gather(
                *(self._fetch_one(symbol, user_id, consent_token, gate) for symbol in unresolved)
            )
            if fallbacks
            else [(symbol, {}, "unavailable") for symbol in unresolved]
        )
        degraded: list[str] = []
        for symbol, quote, status in results:
            quotes[symbol] = quote
            statuses[f"quote:{symbol}"] = status
            if status != "ok":
                degraded.append(f"{symbol}:{status}")
        if degraded:
            self.logger.warning(
                "[Kai Market] quote bundle degraded for %s symbols: %s",
                len(degraded),
                ", ".join(degraded[:6]),
            )
        if require_any and not any(quotes.values()):
            raise QuotesUnavailable("quotes_unavailable")
        return {"quotes": quotes, "provider_status": statuses, "generated_at": self.now_iso()}

    async def _fetch_one(
        self, symbol: str, user_id: str, consent_token: str | None, gate: asyncio.Semaphore
    ) -> tuple[str, dict[str, Any], str]:
        if symbol.startswith("^"):
            # The batch already tried this index. Leave it unavailable rather than
            # retrying through equity plans and their global cooldowns.
            return symbol, {}, "unavailable"
        async with gate:
            last_exc: Exception | None = None
            for allow_slow_fallbacks in (False, True):
                try:
                    quote = await self.fetch_one(
                        symbol, user_id, consent_token, allow_slow_fallbacks=allow_slow_fallbacks
                    )
                    payload = quote or {}
                    if self.safe_float(payload.get("price")) is None:
                        continue
                    return symbol, payload, "ok"
                except Exception as exc:
                    last_exc = exc
                    self.logger.debug(
                        "[Kai Market] quote failed for %s (allow_slow=%s): %s",
                        symbol,
                        allow_slow_fallbacks,
                        type(exc).__name__,
                    )
            return symbol, {}, self.status_from_exception(last_exc or RuntimeError())

    async def load(
        self, name: str, key: str, symbols: Sequence[str], warm_source: str, *, fallbacks: bool
    ) -> ModuleRead:
        """A shared entry for one page; a closed exchange replays the saved last close."""
        value, stale, age, tier, hit = await resolve_public_module(
            name,
            self.read_module(
                key=key,
                fresh_ttl_seconds=self.fresh_ttl_seconds,
                stale_ttl_seconds=self.stale_ttl_seconds,
                fetcher=lambda: self.fetch_bundle(symbols, fallbacks=fallbacks, require_any=True),
                warm_source=warm_source,
            ),
            lambda status: {
                "quotes": {},
                "provider_status": {f"quote:{symbol}": status for symbol in symbols},
                "generated_at": self.now_iso(),
            },
            self.status_from_exception,
            self.logger,
        )
        return (value if self.is_open() else closed_view(value)), stale, age, tier, hit

    async def load_indices(self, warm_source: str) -> ModuleRead:
        return await self.load(
            "indices", INDEX_LAST_CLOSE_KEY, INDEX_SYMBOLS, warm_source, fallbacks=False
        )

    async def load_picks(self, symbols: Sequence[str], warm_source: str) -> ModuleRead:
        if not symbols:
            return await self.nothing_to_read()
        return await self.load("picks", picks_key(symbols), symbols, warm_source, fallbacks=True)

    async def warm(self) -> str | None:
        """Refresh each entry once during a session with one keyless batch, no fallbacks.

        Returns a one-line summary of what refreshed, or None when nothing did.
        """
        entries: list[tuple[str, str, Sequence[str]]] = [
            ("indices", INDEX_LAST_CLOSE_KEY, INDEX_SYMBOLS)
        ]
        try:
            picks = await self.pick_symbols()
        except Exception as exc:
            self.logger.warning("[Kai Market] pick list unavailable: %s", type(exc).__name__)
            picks = []
        if picks:
            entries.append(("picks", picks_key(picks), picks))
        summaries: list[str] = []
        for name, key, symbols in entries:
            try:
                _, stale, age, tier, hit = await self.read_module(
                    key=key,
                    fresh_ttl_seconds=self.fresh_ttl_seconds,
                    stale_ttl_seconds=self.stale_ttl_seconds,
                    fetcher=lambda s=symbols: self.fetch_bundle(
                        s, fallbacks=False, require_any=True
                    ),
                    warm_source="startup",
                    serve_stale_while_revalidate=False,
                )
            except Exception as exc:
                self.logger.warning(
                    "[Kai Market] background %s refresh failed: %s", name, type(exc).__name__
                )
                continue
            summaries.append(
                f"{name}:tier={tier},hit={str(hit).lower()},stale={str(stale).lower()},age={age}s"
            )
        return " | ".join(summaries) or None
