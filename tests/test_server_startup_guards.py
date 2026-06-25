from __future__ import annotations

import asyncio
import logging

import pytest

import server


class _FakeConn:
    def __init__(self, rows: list[dict[str, str]]) -> None:
        self._rows = rows

    async def fetch(self, *_args, **_kwargs):
        return self._rows


class _AcquireContext:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False


class _FakePool:
    def __init__(self, rows: list[dict[str, str]]) -> None:
        self._rows = rows

    def acquire(self) -> _AcquireContext:
        return _AcquireContext(_FakeConn(self._rows))


def test_schema_guard_warns_and_continues_when_db_is_offline_in_development(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    async def _failing_get_pool():
        raise ConnectionRefusedError("db offline")

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("REQUIRE_DATABASE_ON_STARTUP", raising=False)
    monkeypatch.setattr("db.connection.get_pool", _failing_get_pool)

    with caplog.at_level(logging.WARNING):
        asyncio.run(server.startup_required_schema_guard())

    assert "startup.required_schema_guard_skipped" in caplog.text


def test_schema_guard_still_fails_when_db_is_offline_in_production(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    async def _failing_get_pool():
        raise ConnectionRefusedError("db offline")

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("REQUIRE_DATABASE_ON_STARTUP", raising=False)
    monkeypatch.setattr("db.connection.get_pool", _failing_get_pool)

    with caplog.at_level(logging.CRITICAL):
        with pytest.raises(ConnectionRefusedError, match="db offline"):
            asyncio.run(server.startup_required_schema_guard())

    assert "startup.required_schema_guard_db_unavailable" in caplog.text


def test_schema_guard_override_can_force_strict_startup_in_development(
    monkeypatch: pytest.MonkeyPatch,
):
    async def _failing_get_pool():
        raise ConnectionRefusedError("db offline")

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("REQUIRE_DATABASE_ON_STARTUP", "true")
    monkeypatch.setattr("db.connection.get_pool", _failing_get_pool)

    with pytest.raises(ConnectionRefusedError, match="db offline"):
        asyncio.run(server.startup_required_schema_guard())


def test_schema_guard_still_fails_when_required_tables_are_missing(
    monkeypatch: pytest.MonkeyPatch,
):
    available_tables = [
        {"table_name": table_name}
        for table_name in server.REQUIRED_RUNTIME_TABLES
        if table_name != "runtime_persona_state"
    ]

    async def _fake_get_pool():
        return _FakePool(available_tables)

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("REQUIRE_DATABASE_ON_STARTUP", "false")
    monkeypatch.setattr("db.connection.get_pool", _fake_get_pool)

    with pytest.raises(
        RuntimeError, match="Required runtime tables are missing: runtime_persona_state"
    ):
        asyncio.run(server.startup_required_schema_guard())


def test_market_cache_table_startup_warns_and_continues_in_development(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    class _FailingMarketCacheStore:
        async def ensure_table(self):
            raise ConnectionRefusedError("db offline")

    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.delenv("REQUIRE_DATABASE_ON_STARTUP", raising=False)
    monkeypatch.setattr(
        "hushh_mcp.services.market_cache_store.get_market_cache_store_service",
        lambda: _FailingMarketCacheStore(),
    )

    with caplog.at_level(logging.WARNING):
        asyncio.run(server.startup_market_cache_store_table())

    assert "startup.market_cache_store_table_skipped" in caplog.text


def test_market_cache_table_startup_fails_when_database_required(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    class _FailingMarketCacheStore:
        async def ensure_table(self):
            raise ConnectionRefusedError("db offline")

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("REQUIRE_DATABASE_ON_STARTUP", raising=False)
    monkeypatch.setattr(
        "hushh_mcp.services.market_cache_store.get_market_cache_store_service",
        lambda: _FailingMarketCacheStore(),
    )

    with caplog.at_level(logging.CRITICAL):
        with pytest.raises(ConnectionRefusedError, match="db offline"):
            asyncio.run(server.startup_market_cache_store_table())

    assert "startup.market_cache_store_table_failed" in caplog.text


def test_pkm_scope_validator_warmup_runs_during_startup(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    calls: list[str] = []

    class _FakeScopeGenerator:
        async def prewarm_validator(self):
            calls.append("prewarmed")

    monkeypatch.setattr(
        "hushh_mcp.consent.scope_generator.get_scope_generator",
        lambda: _FakeScopeGenerator(),
    )

    with caplog.at_level(logging.INFO):
        asyncio.run(server.startup_pkm_scope_validator_warmup())

    assert calls == ["prewarmed"]
    assert "startup.pkm_scope_validator_warmed" in caplog.text


def test_pkm_scope_validator_warmup_warns_and_continues(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    class _FailingScopeGenerator:
        async def prewarm_validator(self):
            raise RuntimeError("scope bootstrap failed")

    monkeypatch.setattr(
        "hushh_mcp.consent.scope_generator.get_scope_generator",
        lambda: _FailingScopeGenerator(),
    )

    with caplog.at_level(logging.WARNING):
        asyncio.run(server.startup_pkm_scope_validator_warmup())

    assert "startup.pkm_scope_validator_warmup_failed" in caplog.text


def test_consent_token_verifier_prewarm_runs_during_startup(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    calls: list[str] = []

    monkeypatch.setattr(
        "hushh_mcp.consent.token.prewarm_consent_token_verifier",
        lambda: calls.append("prewarmed"),
    )

    with caplog.at_level(logging.INFO):
        asyncio.run(server.startup_consent_token_verifier_prewarm())

    assert calls == ["prewarmed"]
    assert "startup.consent_token_verifier_prewarmed" in caplog.text


def test_consent_token_verifier_prewarm_warns_and_continues(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
):
    def _failing_prewarm():
        raise RuntimeError("token verifier bootstrap failed")

    monkeypatch.setattr(
        "hushh_mcp.consent.token.prewarm_consent_token_verifier",
        _failing_prewarm,
    )

    with caplog.at_level(logging.WARNING):
        asyncio.run(server.startup_consent_token_verifier_prewarm())

    assert "startup.consent_token_verifier_prewarm_failed" in caplog.text
