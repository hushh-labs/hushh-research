"""Proof that the consent SSE backfill window uses UTC, not naive local time.

issued_at in the consent_audit table is stored as a UTC epoch-millisecond
value. consent_event_generator computed connection_start_ms via
datetime.now().timestamp(), which interprets the naive local time as if it
were UTC, shifting the backfill window by the server's UTC offset on any
host not running in UTC.

Canonical attach point: api/routes/sse.py::consent_event_generator
"""

from __future__ import annotations

from pathlib import Path

_SSE_PY = Path(__file__).resolve().parents[1] / "api" / "routes" / "sse.py"


def test_connection_start_ms_uses_utc():
    """connection_start_ms must be derived from a UTC-aware datetime."""
    source = _SSE_PY.read_text(encoding="utf-8")

    idx = source.find("connection_start_ms = int(")
    assert idx != -1, "connection_start_ms assignment not found in sse.py"
    snippet = source[idx : idx + 80]

    assert "datetime.now(UTC)" in snippet, (
        "connection_start_ms must use datetime.now(UTC), not naive datetime.now()"
    )
    assert "datetime.now().timestamp" not in snippet, (
        "connection_start_ms still uses naive local time, not UTC"
    )
