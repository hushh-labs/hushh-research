from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from hushh_mcp.services.account_service import AccountService


@contextmanager
def _db(conn):
    yield conn


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


@pytest.mark.asyncio
async def test_full_account_deletion_covers_account_owned_tables(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    user_id = "user_delete_123"

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service._delete_full_account(user_id, requested_target="both")

    assert result["success"] is True
    assert result["account_deleted"] is True

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    expected_fragments = [
        "DELETE FROM kai_funding_trade_events",
        "DELETE FROM kai_funding_trade_intents",
        "DELETE FROM kai_funding_transfer_events",
        "DELETE FROM kai_funding_transfers",
        "DELETE FROM kai_funding_ach_relationships",
        "DELETE FROM kai_funding_plaid_accounts",
        "DELETE FROM kai_funding_plaid_items",
        "DELETE FROM kai_funding_brokerage_accounts",
        "DELETE FROM kai_funding_alpaca_connect_sessions",
        "DELETE FROM kai_gmail_receipts",
        "DELETE FROM kai_gmail_sync_runs",
        "DELETE FROM kai_gmail_connections",
        "DELETE FROM consent_export_refresh_jobs",
        "DELETE FROM consent_exports",
        "DELETE FROM pkm_upgrade_runs",
        "DELETE FROM kai_receipt_memory_artifacts",
        "DELETE FROM kai_portfolio_source_preferences",
        "DELETE FROM relationship_share_events",
        "DELETE FROM relationship_share_grants",
        "DELETE FROM ria_pick_share_artifacts",
        "DELETE FROM ria_pick_uploads",
        "DELETE FROM advisor_investor_relationships",
        "DELETE FROM marketplace_public_profiles",
        "DELETE FROM one_kyc_workflows",
        "DELETE FROM actor_identity_cache",
        "DELETE FROM runtime_persona_state",
        "DELETE FROM actor_profiles",
        "DELETE FROM vault_keys",
    ]
    for fragment in expected_fragments:
        assert fragment in executed_sql

    assert executed_sql.index("DELETE FROM actor_profiles") < executed_sql.index(
        "DELETE FROM vault_keys"
    )
    assert executed_sql.index("DELETE FROM consent_export_refresh_jobs") < executed_sql.index(
        "DELETE FROM consent_exports"
    )
    assert executed_sql.index("DELETE FROM relationship_share_events") < executed_sql.index(
        "DELETE FROM relationship_share_grants"
    )
    assert executed_sql.index("DELETE FROM relationship_share_grants") < executed_sql.index(
        "DELETE FROM advisor_investor_relationships"
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
