from __future__ import annotations

import importlib
from unittest.mock import AsyncMock, patch

import pytest


def test_local_database_unavailable_hint_is_present_for_proxy_backed_local_env(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_PORT", "6543")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
        "hushh-pda-uat:us-central1:hushh-uat-pg",
    )

    db_connection = importlib.import_module("db.connection")
    hint = db_connection.local_database_unavailable_hint()

    assert hint is not None
    assert "./bin/hushh terminal backend --mode local --reload" in hint
    assert "127.0.0.1:6543" in hint


def test_local_cloud_sql_proxy_explicitly_disables_asyncpg_tls(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME", "hushh-pda-uat:us-central1:hushh-uat-pg"
    )
    monkeypatch.setenv("DB_SSLMODE", "require")

    db_connection = importlib.import_module("db.connection")

    assert db_connection.get_database_ssl() is False


def test_format_database_unavailable_details_appends_local_hint(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_PORT", "6543")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
        "hushh-pda-uat:us-central1:hushh-uat-pg",
    )

    db_connection = importlib.import_module("db.connection")
    message = db_connection.format_database_unavailable_details("connection refused")

    assert message.startswith("connection refused")
    assert "Hint:" in message
    assert "run_backend_local.sh local --reload" in message


def test_connection_capacity_error_does_not_blame_the_local_proxy(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
        "hushh-pda-uat:us-central1:hushh-uat-pg",
    )

    db_connection = importlib.import_module("db.connection")
    details = (
        "FATAL: remaining connection slots are reserved for non-replication superuser connections"
    )

    assert db_connection._is_connection_unavailable_error(RuntimeError(details)) is True
    assert "connection capacity" in db_connection.database_unavailable_hint(details)
    assert "tunnel is unavailable" not in db_connection.format_database_unavailable_details(details)


def test_database_execution_error_marks_connection_failures_as_service_unavailable(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_PORT", "6543")
    monkeypatch.setenv(
        "CLOUDSQL_INSTANCE_CONNECTION_NAME",
        "hushh-pda-uat:us-central1:hushh-uat-pg",
    )

    db_client = importlib.import_module("db.db_client")
    error = db_client.DatabaseExecutionError(
        table_name="vault_keys",
        operation="select",
        details=db_client.format_database_unavailable_details("connection refused"),
        status_code=503,
        code="DATABASE_UNAVAILABLE",
        hint=db_client.database_unavailable_hint("connection refused"),
    )

    assert error.status_code == 503
    assert error.code == "DATABASE_UNAVAILABLE"
    assert error.hint is not None


@pytest.mark.asyncio
async def test_dedicated_connection_uses_unix_socket_and_literal_credentials(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("DB_USER", "user:@/")
    monkeypatch.setenv("DB_PASSWORD", "p@ss:/?#")
    monkeypatch.setenv("DB_HOST", "ignored.example")
    monkeypatch.setenv("DB_UNIX_SOCKET", "/cloudsql/project:region:instance")
    monkeypatch.setenv("DB_NAME", "market_db")
    monkeypatch.setenv("DB_PORT", "5432")
    db_connection = importlib.import_module("db.connection")
    fake_connection = object()

    with patch.object(
        db_connection.asyncpg, "connect", AsyncMock(return_value=fake_connection)
    ) as connect:
        result = await db_connection.open_dedicated_connection()

    assert result is fake_connection
    assert connect.await_args.args == ()
    options = connect.await_args.kwargs
    assert options["user"] == "user:@/"
    assert options["password"] == "p@ss:/?#"
    assert options["database"] == "market_db"
    assert options["host"] == "/cloudsql/project:region:instance"
    assert options["port"] == 5432
    assert "ssl" not in options


@pytest.mark.asyncio
async def test_dedicated_connection_uses_tcp_pool_ssl_settings(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("DB_USER", "uat_user")
    monkeypatch.setenv("DB_PASSWORD", "p@ss:/?#")
    monkeypatch.setenv("DB_HOST", "127.0.0.1")
    monkeypatch.setenv("DB_PORT", "6543")
    monkeypatch.delenv("DB_UNIX_SOCKET", raising=False)
    monkeypatch.setenv("CLOUDSQL_INSTANCE_CONNECTION_NAME", "project:region:instance")
    db_connection = importlib.import_module("db.connection")

    with patch.object(db_connection.asyncpg, "connect", AsyncMock()) as connect:
        await db_connection.open_dedicated_connection()

    assert connect.await_args.args == ()
    assert connect.await_args.kwargs["host"] == "127.0.0.1"
    assert connect.await_args.kwargs["port"] == 6543
    assert connect.await_args.kwargs["password"] == "p@ss:/?#"
    assert connect.await_args.kwargs["ssl"] is False
