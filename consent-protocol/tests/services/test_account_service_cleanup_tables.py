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
        "DELETE FROM connected_system_audit_events",
        "DELETE FROM connected_system_record_bindings",
        "DELETE FROM connected_system_intents",
        "DELETE FROM pkm_default_available_projections",
        "DELETE FROM pkm_upgrade_steps",
        "DELETE FROM pkm_upgrade_runs",
        "DELETE FROM world_model_index_v2",
        "DELETE FROM pkm_migration_state",
        "DELETE FROM kai_receipt_memory_artifacts",
        "DELETE FROM kai_portfolio_source_preferences",
        "DELETE FROM relationship_share_events",
        "DELETE FROM relationship_share_grants",
        "DELETE FROM ria_pick_share_artifacts",
        "DELETE FROM ria_pick_uploads",
        "DELETE FROM advisor_investor_relationships",
        "DELETE FROM marketplace_investor_actions",
        "DELETE FROM marketplace_public_profiles",
        "DELETE FROM one_kyc_workflows",
        "DELETE FROM one_location_events",
        "DELETE FROM one_location_referrals",
        "DELETE FROM one_location_public_invite_submissions",
        "DELETE FROM one_location_public_invites",
        "DELETE FROM one_location_circle_invites",
        "DELETE FROM one_location_network_connections",
        "DELETE FROM one_location_access_requests",
        "DELETE FROM one_location_envelopes",
        "DELETE FROM one_location_share_grants",
        "DELETE FROM one_location_recipient_keys",
        "DELETE FROM actor_verified_email_aliases",
        "DELETE FROM actor_identity_cache",
        "DELETE FROM runtime_persona_state",
        "DELETE FROM actor_profiles",
        "DELETE FROM vault_key_wrappers",
        "DELETE FROM vault_keys",
    ]
    for fragment in expected_fragments:
        assert fragment in executed_sql

    assert executed_sql.index("DELETE FROM actor_profiles") < executed_sql.index(
        "DELETE FROM vault_key_wrappers"
    )
    assert executed_sql.index("DELETE FROM vault_key_wrappers") < executed_sql.index(
        "DELETE FROM vault_keys"
    )
    assert executed_sql.index("DELETE FROM consent_export_refresh_jobs") < executed_sql.index(
        "DELETE FROM consent_exports"
    )
    assert executed_sql.index("DELETE FROM pkm_upgrade_steps") < executed_sql.index(
        "DELETE FROM pkm_upgrade_runs"
    )
    assert executed_sql.index("DELETE FROM connected_system_record_bindings") < executed_sql.index(
        "DELETE FROM connected_system_intents"
    )
    assert executed_sql.index("DELETE FROM relationship_share_events") < executed_sql.index(
        "DELETE FROM relationship_share_grants"
    )
    assert executed_sql.index("DELETE FROM relationship_share_grants") < executed_sql.index(
        "DELETE FROM advisor_investor_relationships"
    )
    assert executed_sql.index("DELETE FROM one_location_events") < executed_sql.index(
        "DELETE FROM one_location_share_grants"
    )
    assert executed_sql.index("DELETE FROM one_location_share_grants") < executed_sql.index(
        "DELETE FROM actor_identity_cache"
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


@pytest.mark.asyncio
async def test_reset_account_clears_data_but_keeps_account_spine(monkeypatch):
    service = AccountService()
    conn = MagicMock()
    user_id = "user_reset_123"

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service.reset_account(user_id)

    assert result["success"] is True
    assert result["account_deleted"] is False
    assert result["account_reset"] is True

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)

    # Personal data is cleared.
    cleared_fragments = [
        "DELETE FROM kai_funding_trade_events",
        "DELETE FROM kai_gmail_receipts",
        "DELETE FROM pkm_events",
        "DELETE FROM pkm_blobs",
        "DELETE FROM connected_system_intents",
        "DELETE FROM consent_audit",
        "DELETE FROM one_kyc_workflows",
        "DELETE FROM one_location_events",
    ]
    for fragment in cleared_fragments:
        assert fragment in executed_sql

    # The account spine survives a reset: no DELETE touches identity or vault.
    spine_fragments = [
        "DELETE FROM actor_profiles",
        "DELETE FROM actor_identity_cache",
        "DELETE FROM actor_verified_email_aliases",
        "DELETE FROM runtime_persona_state",
        "DELETE FROM vault_key_wrappers",
        "DELETE FROM vault_keys",
    ]
    for fragment in spine_fragments:
        assert fragment not in executed_sql

    # The spine is re-seeded to a clean One default, and setup flags reset.
    assert "UPDATE actor_profiles" in executed_sql
    assert "UPDATE runtime_persona_state" in executed_sql
    assert "UPDATE vault_keys" in executed_sql
    assert "setup_completed = NULL" in executed_sql


@pytest.mark.asyncio
async def test_reset_account_returns_failure_on_error(monkeypatch):
    service = AccountService()

    def _boom(_conn, _user_id, _results):
        raise RuntimeError("db down")

    monkeypatch.setattr(service, "_clear_user_data_tables", _boom)

    conn = MagicMock()
    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service.reset_account("user_reset_err")

    assert result["success"] is False
    assert result["account_reset"] is False
    assert result["error"] == "account_reset_failed"
