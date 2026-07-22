from __future__ import annotations

from db.query_telemetry import (
    begin_query_telemetry,
    query_telemetry_snapshot,
    record_query,
    reset_query_telemetry,
)


def test_query_telemetry_counts_repeated_signatures_without_values():
    token = begin_query_telemetry()
    try:
        record_query("location.select", sql_duration_ms=4.5, pool_wait_ms=1.0)
        record_query("location.select", sql_duration_ms=2.5, pool_wait_ms=0.5)
        record_query("consent.select", sql_duration_ms=3.0, pool_wait_ms=0.0)
        assert query_telemetry_snapshot() == {
            "sql_count": 3,
            "sql_duration_ms": 10.0,
            "db_pool_wait_ms": 1.5,
            "repeated_sql_count": 1,
        }
    finally:
        reset_query_telemetry(token)


def test_query_telemetry_is_empty_outside_request_context():
    assert query_telemetry_snapshot()["sql_count"] == 0
