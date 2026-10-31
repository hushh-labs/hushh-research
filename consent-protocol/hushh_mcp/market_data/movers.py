"""Observed mover selection shared by the producer and its cache admission check."""

import math
from typing import Any

MIN_MOVERS = 3
MOVERS_COVERAGE_VERSION = 1
MOVERS_REFRESH_SECONDS = 120


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def select_movers(rows: Any, bucket: str, limit: int = 8) -> list[dict]:
    if not isinstance(rows, (list, tuple)):
        return []
    selected: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "").strip().upper()
        price, change = number(row.get("price")), number(row.get("change_pct"))
        if not symbol or symbol.startswith("^") or price is None or price <= 0:
            continue
        if change is None or (bucket == "gainers" and change <= 0):
            continue
        if bucket == "losers" and change >= 0:
            continue
        if row.get("isEtf") or row.get("isFund"):
            continue
        selected.setdefault(symbol, {**row, "symbol": symbol})
    return sorted(
        selected.values(),
        key=lambda row: (
            number(row.get("volume")) or 0
            if bucket == "active"
            else number(row.get("change_pct")) or 0
        ),
        reverse=bucket != "losers",
    )[:limit]


def mover_payload(value: Any) -> dict:
    if isinstance(value, (tuple, list)) and value:
        value = value[0]
    return value if isinstance(value, dict) else {}


def complete_movers(value: Any) -> bool:
    payload = mover_payload(value)
    if payload.get("universe") == "tracked_watchlist" or "Watchlist Fallback" in (
        payload.get("source_tags") or []
    ):
        return False
    return all(
        len(select_movers(payload.get(bucket) or [], bucket)) >= MIN_MOVERS
        for bucket in ("gainers", "losers")
    )


def stale_movers(value: Any) -> dict:
    """Annotate a retained snapshot without mutating its observations or cache entry."""
    payload = mover_payload(value)
    return {
        **payload,
        "stale": True,
        "degraded": True,
        **{
            bucket: [
                {**row, "is_stale": True, "degraded": True}
                for row in payload.get(bucket, [])
                if isinstance(row, dict)
            ]
            for bucket in ("gainers", "losers", "active")
        },
    }


def assemble_movers(primary: dict, fallback: dict, retrieved_at: str) -> tuple[dict, dict]:
    buckets = {
        bucket: select_movers((primary.get(bucket) or []) + (fallback.get(bucket) or []), bucket)
        for bucket in ("gainers", "losers", "active")
    }
    payload = {
        **buckets,
        "as_of": retrieved_at,
        "coverage_version": MOVERS_COVERAGE_VERSION,
        "source_tags": sorted(
            {tag for rows in buckets.values() for row in rows for tag in row.get("source_tags", [])}
        ),
        "degraded": not complete_movers(buckets),
    }
    statuses = {
        f"movers:{bucket}": "ok"
        if len(rows) >= (1 if bucket == "active" else MIN_MOVERS)
        else "partial"
        for bucket, rows in buckets.items()
    }
    return payload, statuses
