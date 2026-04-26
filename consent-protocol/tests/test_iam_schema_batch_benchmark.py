# tests/test_iam_schema_batch_benchmark.py
"""
Benchmark: batch IAM schema check vs the previous N+1 serial approach.

This test does NOT require a real database.  It uses an in-process fake
connection with a configurable artificial delay (default 60 ms, matching
the ~50-80 ms Cloud SQL proxy round-trip documented in performance notes)
to produce wall-clock numbers that reflect real-world conditions.

Run with:
    pytest tests/test_iam_schema_batch_benchmark.py -v -s
"""

import asyncio
import time
from unittest.mock import AsyncMock

import pytest

import hushh_mcp.services.ria_iam_service as _mod
from hushh_mcp.services.ria_iam_service import _IAM_REQUIRED_TABLES, RIAIAMService

# Simulated network latency per DB round-trip (ms).
# Cloud SQL proxy UAT latency from performance_notes_20260331.md: 50-80 ms.
SIMULATED_LATENCY_MS = 60
TABLE_COUNT = len(_IAM_REQUIRED_TABLES)


def _clear_caches() -> None:
    _mod._TABLE_EXISTS_CACHE.clear()
    _mod._IAM_SCHEMA_READY_CACHE = False


# ---------------------------------------------------------------------------
# Fake connections
# ---------------------------------------------------------------------------


def _make_serial_conn(present_tables: list[str]) -> AsyncMock:
    """Simulates the OLD approach: one fetchval() call per table."""
    conn = AsyncMock()

    async def _fetchval(query: str, table_qualified: str) -> str | None:
        await asyncio.sleep(SIMULATED_LATENCY_MS / 1000)
        # table_qualified is "public.<name>"
        name = table_qualified.split(".")[-1]
        return table_qualified if name in present_tables else None

    conn.fetchval.side_effect = _fetchval
    return conn


def _make_batch_conn(present_tables: list[str]) -> AsyncMock:
    """Simulates the NEW approach: one fetch() call for all tables."""
    conn = AsyncMock()

    async def _fetch(query: str, table_list: list[str]) -> list[dict]:
        await asyncio.sleep(SIMULATED_LATENCY_MS / 1000)
        return [{"tablename": t} for t in table_list if t in present_tables]

    conn.fetch.side_effect = _fetch
    return conn


# ---------------------------------------------------------------------------
# Old approach re-implemented inline for comparison
# ---------------------------------------------------------------------------


async def _old_is_iam_schema_ready(conn: AsyncMock) -> tuple[bool, int]:
    """Mirrors the pre-fix implementation exactly."""
    query_count = 0
    for table_name in _IAM_REQUIRED_TABLES:
        exists = bool(await conn.fetchval("SELECT to_regclass($1)", f"public.{table_name}"))
        query_count += 1
        if not exists:
            return False, query_count
    return True, query_count


# ---------------------------------------------------------------------------
# Benchmark tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_benchmark_query_count():
    """
    Core correctness assertion: new approach uses 1 query, old uses N.
    No timing involved — pure call-count check.
    """
    _clear_caches()

    # --- Old approach ---
    serial_conn = _make_serial_conn(list(_IAM_REQUIRED_TABLES))
    _, old_query_count = await _old_is_iam_schema_ready(serial_conn)

    # --- New approach ---
    batch_conn = _make_batch_conn(list(_IAM_REQUIRED_TABLES))
    service = RIAIAMService.__new__(RIAIAMService)
    await service._is_iam_schema_ready(batch_conn)
    new_query_count = batch_conn.fetch.call_count

    print(f"\n  Query count  — old: {old_query_count}  new: {new_query_count}")

    assert old_query_count == TABLE_COUNT, (
        f"Old approach should issue {TABLE_COUNT} queries, issued {old_query_count}"
    )
    assert new_query_count == 1, f"New approach should issue 1 query, issued {new_query_count}"


@pytest.mark.asyncio
async def test_benchmark_wall_clock_with_simulated_latency():
    """
    Wall-clock comparison using {SIMULATED_LATENCY_MS} ms artificial delay
    per round-trip (matches Cloud SQL proxy latency from performance notes).

    Expected:
      old ≈ {TABLE_COUNT} × {SIMULATED_LATENCY_MS} ms  (~{TABLE_COUNT * SIMULATED_LATENCY_MS} ms)
      new ≈ 1 × {SIMULATED_LATENCY_MS} ms              (~{SIMULATED_LATENCY_MS} ms)
    """
    _clear_caches()

    # --- Old approach ---
    serial_conn = _make_serial_conn(list(_IAM_REQUIRED_TABLES))
    t0 = time.perf_counter()
    await _old_is_iam_schema_ready(serial_conn)
    old_ms = (time.perf_counter() - t0) * 1000

    # --- New approach ---
    _clear_caches()
    batch_conn = _make_batch_conn(list(_IAM_REQUIRED_TABLES))
    t1 = time.perf_counter()
    service = RIAIAMService.__new__(RIAIAMService)
    await service._is_iam_schema_ready(batch_conn)
    new_ms = (time.perf_counter() - t1) * 1000

    speedup = old_ms / new_ms if new_ms > 0 else float("inf")

    print(
        f"\n  Simulated latency : {SIMULATED_LATENCY_MS} ms/query"
        f"\n  Table count       : {TABLE_COUNT}"
        f"\n  Old (N+1) time    : {old_ms:.1f} ms  ({serial_conn.fetchval.call_count} queries)"
        f"\n  New (batch) time  : {new_ms:.1f} ms  ({batch_conn.fetch.call_count} query)"
        f"\n  Speedup           : {speedup:.1f}×"
    )

    # New must be at least 5× faster (conservatively — real gain is ~11×).
    assert speedup >= 5, (
        f"Expected ≥5× speedup, got {speedup:.1f}×. old={old_ms:.1f}ms new={new_ms:.1f}ms"
    )


@pytest.mark.asyncio
async def test_benchmark_ttl_cache_eliminates_db_on_repeat_calls():
    """
    Second call within TTL window should cost ~0 ms (pure memory lookup).
    Demonstrates why the TTL cache matters for repeated API requests.
    """
    _clear_caches()
    batch_conn = _make_batch_conn(list(_IAM_REQUIRED_TABLES))
    service = RIAIAMService.__new__(RIAIAMService)

    # First call — hits DB.
    t0 = time.perf_counter()
    await service._is_iam_schema_ready(batch_conn)
    first_ms = (time.perf_counter() - t0) * 1000

    # Reset the global schema cache but keep the TTL table cache.
    _mod._IAM_SCHEMA_READY_CACHE = False

    # Second call — everything in TTL cache, no DB.
    batch_conn2 = _make_batch_conn(list(_IAM_REQUIRED_TABLES))
    t1 = time.perf_counter()
    await service._is_iam_schema_ready(batch_conn2)
    second_ms = (time.perf_counter() - t1) * 1000

    print(
        f"\n  First call  : {first_ms:.1f} ms (DB hit)"
        f"\n  Second call : {second_ms:.1f} ms (TTL cache)"
        f"\n  DB queries on second call: {batch_conn2.fetch.call_count}"
    )

    assert batch_conn2.fetch.call_count == 0, "Second call within TTL should issue zero DB queries"
    assert second_ms < first_ms / 5, (
        f"Cached call should be much faster than first call. "
        f"first={first_ms:.1f}ms second={second_ms:.1f}ms"
    )
