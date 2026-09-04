"""FMP (Financial Modeling Prep) daily call-budget tracking.

Purpose: give us a real, on-disk record of every outbound FMP call so we can
study actual usage against the plan's daily call limit (Basic plan = 250
calls/day) and drive an adaptive throttle instead of guessing.

- Every recorded call appends one JSON line to
  `consent-protocol/tmp/fmp_call_budget/<UTC-date>.jsonl` (gitignored `tmp/`,
  never committed - local/UAT-runtime study data only).
- An in-memory daily counter (reset at UTC midnight) backs cheap budget
  checks (`get_calls_used_today`, `is_budget_critical`) so hot request paths
  never have to read the snapshot file back.
- Day boundary is UTC. FMP does not publish a documented per-account reset
  timezone; UTC is the conservative, verifiable default (matches virtually
  every metered API convention) - if FMP's actual reset differs, this only
  affects when the in-memory counter rolls over, not correctness of the
  recorded snapshots themselves (each row carries its own UTC timestamp).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_DAILY_COUNTS: dict[str, int] = {}
_SNAPSHOT_DIR = Path(__file__).resolve().parents[2] / "tmp" / "fmp_call_budget"


def _default_daily_limit() -> int:
    raw = str(os.getenv("FMP_DAILY_CALL_LIMIT", "250")).strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 250


def _today_key(now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%d")


def _append_snapshot(
    *,
    now: datetime,
    day_key: str,
    endpoint: str,
    status_code: int | None,
    cache_key: str | None,
    running_count: int,
) -> None:
    try:
        _SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        row: dict[str, Any] = {
            "ts": now.isoformat(),
            "endpoint": endpoint,
            "status_code": status_code,
            "cache_key": cache_key,
            "running_count_today": running_count,
        }
        path = _SNAPSHOT_DIR / f"{day_key}.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row) + "\n")
    except Exception as exc:
        logger.debug("[FMP Budget] snapshot write skipped: %s", exc)


def record_fmp_call(
    *,
    endpoint: str,
    status_code: int | None = None,
    cache_key: str | None = None,
) -> int:
    """Record one real outbound FMP HTTP call. Returns today's running count.

    Call this exactly once per actual network request sent to FMP (not per
    cache hit) so the counter and snapshots reflect real quota consumption.
    """
    now = datetime.now(timezone.utc)
    day_key = _today_key(now)
    with _LOCK:
        count = _DAILY_COUNTS.get(day_key, 0) + 1
        _DAILY_COUNTS[day_key] = count
        # Bound memory: drop any counters for days other than today/yesterday.
        if len(_DAILY_COUNTS) > 4:
            for stale_key in [k for k in _DAILY_COUNTS if k < day_key][:-1]:
                _DAILY_COUNTS.pop(stale_key, None)

    _append_snapshot(
        now=now,
        day_key=day_key,
        endpoint=endpoint,
        status_code=status_code,
        cache_key=cache_key,
        running_count=count,
    )

    limit = _default_daily_limit()
    milestone = max(1, limit // 10)
    if count >= limit or count % milestone == 0:
        logger.warning(
            "[FMP Budget] %s/%s calls used today (%s) - last endpoint=%s",
            count,
            limit,
            day_key,
            endpoint,
        )
    return count


def get_calls_used_today() -> int:
    with _LOCK:
        return _DAILY_COUNTS.get(_today_key(), 0)


def get_daily_limit() -> int:
    return _default_daily_limit()


def get_calls_remaining_today() -> int:
    return max(0, get_daily_limit() - get_calls_used_today())


def is_budget_critical(*, reserve_ratio: float = 0.1) -> bool:
    """True once remaining calls drop to/below `reserve_ratio` of the daily
    limit (default: last 10%). Callers use this as a safety valve to skip
    non-essential background refreshes and preserve headroom for real user
    requests."""
    limit = get_daily_limit()
    if limit <= 0:
        return False
    return get_calls_remaining_today() <= max(1, int(limit * reserve_ratio))


def budget_status_snapshot() -> dict[str, Any]:
    """Cheap status dict for logging/diagnostics endpoints."""
    used = get_calls_used_today()
    limit = get_daily_limit()
    return {
        "date_utc": _today_key(),
        "calls_used_today": used,
        "daily_limit": limit,
        "calls_remaining_today": max(0, limit - used),
        "is_critical": is_budget_critical(),
    }
