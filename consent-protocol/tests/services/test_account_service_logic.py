# tests/services/test_account_service_logic.py
"""
Account Service Logic Tests
============================

Tests for pure logic helpers in AccountService that handle
account deletion target normalization and validation.

The account deletion flow is safety-critical -- an incorrect target
resolution could delete more data than the user intended.
"""

import pytest

from hushh_mcp.services.account_service import AccountService


# ============================================================================
# _normalized_target
# ============================================================================


class TestNormalizedTarget:
    """Tests for deletion target normalization.

    This method determines whether a delete request should target
    'investor' persona, 'ria' persona, or 'both' (full account).
    Incorrect normalization could lead to unintended data loss.
    """

    def test_investor_target_preserved(self):
        assert AccountService._normalized_target("investor") == "investor"

    def test_ria_target_preserved(self):
        assert AccountService._normalized_target("ria") == "ria"

    def test_both_defaults_to_both(self):
        assert AccountService._normalized_target("both") == "both"

    def test_none_defaults_to_both(self):
        assert AccountService._normalized_target(None) == "both"

    def test_empty_string_defaults_to_both(self):
        assert AccountService._normalized_target("") == "both"

    def test_unknown_string_defaults_to_both(self):
        assert AccountService._normalized_target("unknown") == "both"

    def test_admin_string_defaults_to_both(self):
        """Arbitrary strings should not be treated as valid targets."""
        assert AccountService._normalized_target("admin") == "both"

    def test_case_sensitive_investor(self):
        """Target matching is case-sensitive -- 'Investor' is not 'investor'."""
        result = AccountService._normalized_target("Investor")
        assert result == "both"  # uppercase is not a valid target

    def test_case_sensitive_ria(self):
        result = AccountService._normalized_target("RIA")
        assert result == "both"  # uppercase is not a valid target


# ============================================================================
# AccountService Initialization
# ============================================================================


class TestAccountServiceInit:
    """Tests for AccountService initialization state."""

    def test_initial_supabase_is_none(self):
        service = AccountService()
        assert service._supabase is None

    def test_initial_cache_is_empty(self):
        service = AccountService()
        assert service._table_exists_cache == {}

    def test_delete_queries_registered(self):
        service = AccountService()
        assert "pkm_data" in service._delete_by_user_queries
        assert "kai_plaid_user_profile_cache" in service._delete_by_user_queries

    def test_no_unsafe_tables_in_queries(self):
        """Ensure only whitelisted tables have delete queries."""
        service = AccountService()
        allowed_tables = {"pkm_data", "kai_plaid_user_profile_cache"}
        assert set(service._delete_by_user_queries.keys()) == allowed_tables


# ============================================================================
# _delete_user_rows_if_table_exists (error path)
# ============================================================================


class TestDeleteUserRowsIfTableExists:
    """Tests for the safety guard in row deletion."""

    def test_raises_for_unsupported_table(self):
        """Requesting cleanup of an unregistered table must raise ValueError."""
        from unittest.mock import MagicMock

        service = AccountService()
        mock_conn = MagicMock()
        # Pretend the table exists
        service._table_exists_cache["dangerous_table"] = True

        with pytest.raises(ValueError, match="Unsafe or unsupported"):
            service._delete_user_rows_if_table_exists(
                mock_conn,
                table_name="dangerous_table",
                params={"user_id": "test_user"},
            )

    def test_skips_missing_table(self):
        """If a table doesn't exist, cleanup should be silently skipped."""
        from unittest.mock import MagicMock

        service = AccountService()
        mock_conn = MagicMock()
        # Pretend the table does not exist
        service._table_exists_cache["pkm_data"] = False

        # Should not raise, should not call execute
        service._delete_user_rows_if_table_exists(
            mock_conn,
            table_name="pkm_data",
            params={"user_id": "test_user"},
        )
        mock_conn.execute.assert_not_called()


# ============================================================================
# export_data stub
# ============================================================================


class TestExportData:
    """Tests for the data export stub."""

    @pytest.mark.asyncio
    async def test_export_returns_none(self):
        """export_data is currently a stub (NOT_IN_SCOPE) and should return None."""
        service = AccountService()
        result = await service.export_data("test_user")
        assert result is None
