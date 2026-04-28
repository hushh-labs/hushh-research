from unittest.mock import MagicMock

import pytest

from hushh_mcp.services.account_service import AccountService


def test_delete_user_rows_if_table_exists_supports_pkm_data(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    params = {"user_id": "user_123"}

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    service._delete_user_rows_if_table_exists(conn, table_name="pkm_data", params=params)

    conn.execute.assert_called_once_with(service._delete_by_user_queries["pkm_data"], params)


def test_delete_user_rows_if_table_exists_skips_missing_table(monkeypatch):
    service = AccountService()
    conn = MagicMock()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: False)

    service._delete_user_rows_if_table_exists(
        conn,
        table_name="pkm_data",
        params={"user_id": "user_123"},
    )

    conn.execute.assert_not_called()


def test_delete_user_rows_if_table_exists_rejects_unsupported_table(monkeypatch):
    service = AccountService()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with pytest.raises(ValueError, match="Unsafe or unsupported cleanup table requested"):
        service._delete_user_rows_if_table_exists(
            MagicMock(),
            table_name="unsafe_table",
            params={"user_id": "user_123"},
        )


def test_fetch_optional_many_rows_returns_empty_when_table_missing(monkeypatch):
    service = AccountService()
    conn = MagicMock()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: False)

    rows = service._fetch_optional_many_rows(
        conn,
        table_name="pkm_blobs",
        query_name="encrypted_pkm_blobs",
        params={"user_id": "user_123"},
    )

    assert rows == []
    conn.execute.assert_not_called()


def test_fetch_optional_single_row_returns_none_when_table_missing(monkeypatch):
    service = AccountService()
    conn = MagicMock()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: False)

    row = service._fetch_optional_single_row(
        conn,
        table_name="actor_profiles",
        query_name="actor_profile",
        params={"user_id": "user_123"},
    )

    assert row is None
    conn.execute.assert_not_called()
