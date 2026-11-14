"""Unit contracts for Cloud SQL scheduled data-health observability checks."""

from __future__ import annotations

import json

import pytest

from scripts.observability import db_data_health


class _FakeConn:
    def __init__(self, *, blob_only_user: bool = True, empty_index_domains: bool = True) -> None:
        self.blob_only_user = blob_only_user
        self.empty_index_domains = empty_index_domains
        self.queries: list[str] = []

    async def fetch(self, query: str, *args: object) -> list[dict[str, object]]:
        self.queries.append(query)
        if "information_schema.columns" in query:
            table = args[0] if args else ""
            if table == "vault_keys":
                return [{"column_name": "primary_method"}]
            if table == "kai_market_cache_entries":
                return [{"column_name": "updated_at"}]
            return []
        if "FROM vault_keys" in query:
            return [{"primary_method": "passkey", "row_count": 3}]
        return []

    async def fetchval(self, query: str, *args: object) -> int:
        _ = args
        self.queries.append(query)
        normalized = " ".join(query.split())
        if 'FROM "' in normalized:
            return 4
        if "FROM kai_market_cache_entries WHERE" in normalized:
            # All 4 lazy cache entries are older than 24h (100% stale ratio).
            return 4
        if "FROM consent_audit" in normalized:
            return 2
        if "pkm_blobs" in normalized:
            if "COUNT(DISTINCT user_id)" in normalized:
                return 2
            if "LEFT JOIN pkm_index" in normalized:
                return 0
            if "array_length(i.available_domains, 1)" in normalized:
                return 0 if self.empty_index_domains else 1
        # Legacy pkm_data-only queries fail when users store encrypted domains in pkm_blobs
        # or hold an initialized pkm_index row with available_domains = [].
        if "SELECT COUNT(DISTINCT user_id)::bigint FROM pkm_data" in normalized:
            return 1 if self.blob_only_user else 2
        if "SELECT COUNT(DISTINCT user_id)::bigint FROM pkm_index" in normalized:
            return 3
        if "FROM pkm_index i LEFT JOIN pkm_data d" in normalized:
            return 2
        return 0


class _AcquireCtx:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, *_: object) -> None:
        return None


class _FakePool:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    def acquire(self) -> _AcquireCtx:
        return _AcquireCtx(self._conn)


@pytest.mark.asyncio
async def test_data_health_includes_pkm_blobs_and_treats_lazy_market_cache_as_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    conn = _FakeConn(blob_only_user=True, empty_index_domains=True)

    async def _get_pool() -> _FakePool:
        return _FakePool(conn)

    async def _close_pool() -> None:
        return None

    monkeypatch.setattr(db_data_health, "get_pool", _get_pool)
    monkeypatch.setattr(db_data_health, "close_pool", _close_pool)
    monkeypatch.setenv("ENVIRONMENT", "uat")

    rc = await db_data_health.run_checks()
    payload = json.loads(capsys.readouterr().out.strip())

    assert rc == 0
    assert payload["status"] == "ok"
    assert payload["anomalies"] == []
    assert "pkm_blobs" in payload["table_counts"]
    assert payload["pkm"]["index_without_data"] == 0
    assert payload["market_cache"]["stale_ratio"] == 1.0


@pytest.mark.asyncio
async def test_data_health_flags_non_empty_pkm_index_missing_ciphertext_storage(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    conn = _FakeConn(blob_only_user=True, empty_index_domains=False)

    async def _get_pool() -> _FakePool:
        return _FakePool(conn)

    async def _close_pool() -> None:
        return None

    monkeypatch.setattr(db_data_health, "get_pool", _get_pool)
    monkeypatch.setattr(db_data_health, "close_pool", _close_pool)

    rc = await db_data_health.run_checks()
    payload = json.loads(capsys.readouterr().out.strip())

    assert rc == 1
    assert payload["status"] == "error"
    assert payload["anomalies"] == ["pkm_coherence_mismatch"]
