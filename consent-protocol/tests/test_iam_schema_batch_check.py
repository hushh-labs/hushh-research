# tests/test_iam_schema_batch_check.py
"""
Unit tests for the batch IAM schema-readiness check introduced to replace
the previous N+1 serial ``to_regclass()`` loop.

These tests are fully offline — no database required.  They use a fake
asyncpg connection that records which queries were issued so we can assert
that exactly ONE query is fired instead of 11.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

import hushh_mcp.services.ria_iam_service as _mod
from hushh_mcp.services.ria_iam_service import _IAM_REQUIRED_TABLES, RIAIAMService

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_fake_conn(present_tables: list[str]) -> AsyncMock:
    """Return a fake asyncpg connection that answers pg_catalog queries."""
    conn = AsyncMock()

    async def _fetch(query: str, table_list: list[str]) -> list[dict]:
        assert "pg_catalog.pg_tables" in query, "Expected a single pg_catalog query, got: " + query
        return [{"tablename": t} for t in table_list if t in present_tables]

    conn.fetch.side_effect = _fetch
    return conn


def _clear_caches() -> None:
    """Reset module-level caches between tests."""
    _mod._TABLE_EXISTS_CACHE.clear()
    _mod._IAM_SCHEMA_READY_CACHE = False


# ---------------------------------------------------------------------------
# _batch_tables_exist
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_batch_tables_exist_issues_single_query_for_all_tables():
    """11 required tables must be checked with exactly ONE DB round-trip."""
    _clear_caches()
    conn = _make_fake_conn(present_tables=list(_IAM_REQUIRED_TABLES))

    result = await RIAIAMService._batch_tables_exist(conn, _IAM_REQUIRED_TABLES)

    assert result == set(_IAM_REQUIRED_TABLES)
    assert conn.fetch.call_count == 1, f"Expected 1 DB query, got {conn.fetch.call_count}"


@pytest.mark.asyncio
async def test_batch_tables_exist_returns_only_present_tables():
    """When some tables are missing, only the present ones are returned."""
    _clear_caches()
    present = list(_IAM_REQUIRED_TABLES[:5])
    conn = _make_fake_conn(present_tables=present)

    result = await RIAIAMService._batch_tables_exist(conn, _IAM_REQUIRED_TABLES)

    assert result == set(present)


@pytest.mark.asyncio
async def test_batch_tables_exist_skips_db_when_all_cached():
    """A second call within the TTL window must not hit the DB at all."""
    _clear_caches()
    conn = _make_fake_conn(present_tables=list(_IAM_REQUIRED_TABLES))

    # First call populates the TTL cache.
    await RIAIAMService._batch_tables_exist(conn, _IAM_REQUIRED_TABLES)
    first_call_count = conn.fetch.call_count

    # Second call — everything is cached and unexpired.
    await RIAIAMService._batch_tables_exist(conn, _IAM_REQUIRED_TABLES)

    assert conn.fetch.call_count == first_call_count, (
        "Second call within TTL should not issue additional DB queries"
    )


@pytest.mark.asyncio
async def test_batch_tables_exist_re_queries_after_ttl_expiry():
    """After TTL expiry the cache is stale and the DB must be queried again."""
    _clear_caches()
    conn = _make_fake_conn(present_tables=list(_IAM_REQUIRED_TABLES))

    # Warm the cache with an already-expired expiry timestamp.
    past = datetime.now(tz=timezone.utc) - timedelta(seconds=1)
    for t in _IAM_REQUIRED_TABLES:
        _mod._TABLE_EXISTS_CACHE[t] = past

    await RIAIAMService._batch_tables_exist(conn, _IAM_REQUIRED_TABLES)

    assert conn.fetch.call_count == 1, "Expired cache entries must trigger a fresh DB query"


@pytest.mark.asyncio
async def test_batch_tables_exist_does_not_cache_missing_tables():
    """Missing tables must NOT be cached so a pending migration is detected promptly."""
    _clear_caches()
    # First call: only half the tables exist.
    present_first = list(_IAM_REQUIRED_TABLES[:5])
    conn = _make_fake_conn(present_tables=present_first)
    await RIAIAMService._batch_tables_exist(conn, _IAM_REQUIRED_TABLES)

    # Second call: now all tables exist (migration ran between calls).
    conn2 = _make_fake_conn(present_tables=list(_IAM_REQUIRED_TABLES))
    result = await RIAIAMService._batch_tables_exist(conn2, _IAM_REQUIRED_TABLES)

    assert set(_IAM_REQUIRED_TABLES[:5]).issubset(result), (
        "Previously-present tables should remain in result"
    )
    assert conn2.fetch.call_count == 1, (
        "Missing tables from first call should trigger a DB query on second call"
    )


# ---------------------------------------------------------------------------
# _is_iam_schema_ready
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_is_iam_schema_ready_returns_true_when_all_tables_present():
    _clear_caches()
    conn = _make_fake_conn(present_tables=list(_IAM_REQUIRED_TABLES))
    service = RIAIAMService.__new__(RIAIAMService)

    result = await service._is_iam_schema_ready(conn)

    assert result is True


@pytest.mark.asyncio
async def test_is_iam_schema_ready_returns_false_when_table_missing():
    """Schema is NOT ready if even one required table is absent."""
    _clear_caches()
    # All tables except the last one.
    present = list(_IAM_REQUIRED_TABLES[:-1])
    conn = _make_fake_conn(present_tables=present)
    service = RIAIAMService.__new__(RIAIAMService)

    result = await service._is_iam_schema_ready(conn)

    assert result is False


@pytest.mark.asyncio
async def test_is_iam_schema_ready_sets_global_cache_on_success():
    """Once all tables are confirmed present the global flag must be set."""
    _clear_caches()
    conn = _make_fake_conn(present_tables=list(_IAM_REQUIRED_TABLES))
    service = RIAIAMService.__new__(RIAIAMService)

    await service._is_iam_schema_ready(conn)

    assert _mod._IAM_SCHEMA_READY_CACHE is True


@pytest.mark.asyncio
async def test_is_iam_schema_ready_does_not_set_cache_when_partial():
    """Global cache must NOT be set if any table is missing."""
    _clear_caches()
    conn = _make_fake_conn(present_tables=list(_IAM_REQUIRED_TABLES[:-1]))
    service = RIAIAMService.__new__(RIAIAMService)

    await service._is_iam_schema_ready(conn)

    assert _mod._IAM_SCHEMA_READY_CACHE is False


@pytest.mark.asyncio
async def test_is_iam_schema_ready_short_circuits_when_global_cache_set():
    """If _IAM_SCHEMA_READY_CACHE is True, no DB query should be issued."""
    _clear_caches()
    _mod._IAM_SCHEMA_READY_CACHE = True
    conn = _make_fake_conn(present_tables=[])  # DB would return empty — irrelevant.
    service = RIAIAMService.__new__(RIAIAMService)

    result = await service._is_iam_schema_ready(conn)

    assert result is True
    conn.fetch.assert_not_called()
