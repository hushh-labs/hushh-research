from __future__ import annotations

import asyncio
import logging
import pathlib
import re

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


def test_named_circle_tables_are_required_runtime_dependencies():
    assert {
        "one_location_circles",
        "one_location_circle_memberships",
        "one_location_circle_invite_codes",
        "connection_origins",
        "one_location_circle_member_invites",
    } <= set(server.REQUIRED_RUNTIME_TABLES)


def test_required_runtime_tables_are_live_in_migrations():
    """Every guarded table must still exist after the last migration runs.

    Regression: a long-lived branch merge resurrected `ria_pick_uploads` and
    `ria_pick_upload_rows` here after migration 129 had dropped them. Nothing
    caught it -- both tables are absent from the DB contract, so the predeploy
    schema gate had no opinion -- and the guard raises on startup, so the
    deployed revision never became ready. UAT answered 503 on /health, every
    downstream check failed, and the release rolled itself back.

    A guarded table that no migration creates, or that a later migration drops,
    is not a failing check: it is a backend that cannot boot at all.
    """

    db_dir = pathlib.Path(server.__file__).resolve().parent / "db"
    # Base schema files seed tables that predate the numbered series, so they
    # count as version 0 -- `consent_audit` is created there, not by a migration.
    sources = [
        (0, path.read_text(encoding="utf-8", errors="ignore"))
        for path in (db_dir / "offline_schema.sql", db_dir / "legacy" / "init_legacy_schema.sql")
        if path.exists()
    ]
    migrations = [
        (int(path.name[:3]), path.read_text(encoding="utf-8", errors="ignore"))
        for path in sorted((db_dir / "migrations").glob("[0-9][0-9][0-9]_*.sql"))
    ]
    assert migrations, "no migrations found; this test cannot verify the guard"

    problems: list[str] = []
    for table in server.REQUIRED_RUNTIME_TABLES:
        created = [
            version
            for version, sql in sources + migrations
            if re.search(
                rf"CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?{table}\b",
                sql,
                re.IGNORECASE,
            )
        ]
        # Only numbered migrations can retire a table; a drop in a base schema
        # file is part of that file rebuilding itself, not a retirement.
        dropped = [
            version
            for version, sql in migrations
            if re.search(
                rf"DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?{table}\b",
                sql,
                re.IGNORECASE,
            )
        ]
        if not created:
            problems.append(f"{table}: nothing under db/ creates it")
        elif dropped and max(dropped) > max(created):
            problems.append(
                f"{table}: dropped by migration {max(dropped):03d} after being "
                f"created by migration {max(created):03d}"
            )

    assert not problems, (
        "REQUIRED_RUNTIME_TABLES names tables the schema no longer has, so the "
        "server will refuse to start:\n  " + "\n  ".join(problems)
    )


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
