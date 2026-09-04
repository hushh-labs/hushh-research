"""Redacted per-request database timing and repetition telemetry."""

from __future__ import annotations

from collections import Counter
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from threading import Lock


@dataclass
class QueryTelemetry:
    sql_count: int = 0
    sql_duration_ms: float = 0.0
    pool_wait_ms: float = 0.0
    signatures: Counter[str] = field(default_factory=Counter)
    _lock: Lock = field(default_factory=Lock, repr=False)

    def record(self, signature: str, *, sql_duration_ms: float, pool_wait_ms: float) -> None:
        with self._lock:
            self.sql_count += 1
            self.sql_duration_ms += max(0.0, sql_duration_ms)
            self.pool_wait_ms += max(0.0, pool_wait_ms)
            self.signatures[signature] += 1

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            repeated = sum(count - 1 for count in self.signatures.values() if count > 1)
            return {
                "sql_count": self.sql_count,
                "sql_duration_ms": round(self.sql_duration_ms, 2),
                "db_pool_wait_ms": round(self.pool_wait_ms, 2),
                "repeated_sql_count": repeated,
            }


_query_telemetry: ContextVar[QueryTelemetry | None] = ContextVar("query_telemetry", default=None)


def begin_query_telemetry() -> Token[QueryTelemetry | None]:
    return _query_telemetry.set(QueryTelemetry())


def record_query(signature: str, *, sql_duration_ms: float, pool_wait_ms: float) -> None:
    telemetry = _query_telemetry.get()
    if telemetry is not None:
        telemetry.record(
            signature,
            sql_duration_ms=sql_duration_ms,
            pool_wait_ms=pool_wait_ms,
        )


def query_telemetry_snapshot() -> dict[str, object]:
    telemetry = _query_telemetry.get()
    return (
        telemetry.snapshot()
        if telemetry is not None
        else {
            "sql_count": 0,
            "sql_duration_ms": 0.0,
            "db_pool_wait_ms": 0.0,
            "repeated_sql_count": 0,
        }
    )


def reset_query_telemetry(token: Token[QueryTelemetry | None]) -> None:
    _query_telemetry.reset(token)
