from __future__ import annotations

import importlib

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
        hint=db_client.local_database_unavailable_hint(),
    )

    assert error.status_code == 503
    assert error.code == "DATABASE_UNAVAILABLE"
    assert error.hint is not None
