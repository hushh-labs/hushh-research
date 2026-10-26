"""Shared last-close snapshot of the four US index quotes.

The benchmark indices are public and identical for every viewer, so they live in
one entry instead of inside each viewer's quote bundle. The entry is refreshed
only during the regular session, kept for at least seven days, and served
unchanged while the exchange is closed, so the quote time shown is the
provider's original one.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

INDEX_SYMBOLS: tuple[str, ...] = ("^GSPC", "^IXIC", "^DJI", "^RUT")
INDEX_LAST_CLOSE_KEY = "indices:us:last-close:v1"
INDEX_PUBLIC_USER = "market-public"


class IndexQuotesUnavailable(RuntimeError):
    """No index quote resolved, so the previous last-close snapshot must be kept."""


async def fetch_index_quotes_bundle(
    fetch_batch: Callable[..., Awaitable[dict[str, Any]]],
    safe_float: Callable[[Any], float | None],
    now_iso: Callable[[], str],
) -> dict[str, Any]:
    """Read the indices in one keyless batch and refuse an empty result.

    Raising on an empty result stops the cache from replacing a good snapshot
    with nothing; a partial result is stored and retried during the session.
    """
    batch = await fetch_batch(list(INDEX_SYMBOLS), INDEX_PUBLIC_USER, None)
    quotes: dict[str, Any] = {}
    statuses: dict[str, str] = {}
    for symbol in INDEX_SYMBOLS:
        quote = batch.get(symbol) if isinstance(batch, dict) else None
        if safe_float((quote or {}).get("price")) is None:
            statuses[f"quote:{symbol}"] = "unavailable"
            continue
        quotes[symbol] = quote
        statuses[f"quote:{symbol}"] = "ok"
    if not quotes:
        raise IndexQuotesUnavailable("index_quotes_unavailable")
    return {"quotes": quotes, "provider_status": statuses, "generated_at": now_iso()}


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
