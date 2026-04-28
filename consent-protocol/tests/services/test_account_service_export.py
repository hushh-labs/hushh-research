from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from api.routes.account import export_account_data
from hushh_mcp.services.account_service import AccountService

USER_ID = "user_export_123"
NOW = datetime(2026, 4, 27, tzinfo=timezone.utc)


class _QueryRows:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return self._rows


@contextmanager
def _db(conn):
    yield conn


def _conn_with_schema_rows():
    rows_by_table = {
        "actor_profiles": [
            {
                "user_id": USER_ID,
                "personas": ["investor"],
                "last_active_persona": "investor",
                "investor_marketplace_opt_in": True,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "runtime_persona_state": [
            {"user_id": USER_ID, "last_active_persona": "investor", "updated_at": NOW}
        ],
        "vault_keys": [
            {
                "user_id": USER_ID,
                "vault_status": "active",
                "primary_method": "passkey",
                "primary_wrapper_id": "wrapper_123",
                "recovery_encrypted_vault_key": "ciphertext",
                "recovery_salt": "salt",
                "recovery_iv": "iv",
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "pkm_manifests": [
            {
                "user_id": USER_ID,
                "domain": "finance",
                "manifest_version": 1,
                "structure_decision": {"layout": "domain"},
                "summary_projection": {"summary": "encrypted"},
                "top_level_scope_paths": ["attr.financial.*"],
                "domain_contract_version": 1,
                "readable_summary_version": 1,
                "upgraded_at": NOW,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "pkm_index": [
            {
                "user_id": USER_ID,
                "available_domains": ["finance"],
                "domain_summaries": {"finance": "ready"},
                "computed_tags": ["investor"],
                "total_attributes": 4,
                "model_version": 2,
                "last_upgraded_at": NOW,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "pkm_blobs": [
            {
                "user_id": USER_ID,
                "domain": "finance",
                "segment_id": "holdings",
                "ciphertext": "encrypted-payload",
                "iv": "iv",
                "tag": "tag",
                "content_revision": 3,
                "manifest_revision": 2,
                "created_at": NOW,
                "updated_at": NOW,
            }
        ],
        "consent_audit": [
            {
                "id": "audit_123",
                "token_id": "token_123",
                "user_id": USER_ID,
                "agent_id": "kai",
                "scope": "VAULT_OWNER",
                "action": "issued",
                "issued_at": NOW,
                "poll_timeout_at": NOW,
            }
        ],
    }

    def execute(query, _params):
        sql = str(query)
        for table, rows in rows_by_table.items():
            if f"FROM {table}" in sql:
                return _QueryRows(rows)
        return _QueryRows([])

    conn = MagicMock()
    conn.execute.side_effect = execute
    return conn


@pytest.mark.asyncio
async def test_export_data_uses_current_schema_contract_columns(monkeypatch):
    service = AccountService()
    conn = _conn_with_schema_rows()

    monkeypatch.setattr(service, "_table_exists", lambda _conn, _table: True)

    with patch("hushh_mcp.services.account_service.get_db_connection", return_value=_db(conn)):
        result = await service.export_data(USER_ID)

    assert result["success"] is True
    assert result["requested_target"] == "account"
    assert result["data"]["actor_profile"]["user_id"] == USER_ID
    assert result["data"]["encrypted_pkm_index"][0]["available_domains"] == ["finance"]
    assert result["data"]["encrypted_pkm_blobs"][0]["ciphertext"] == "encrypted-payload"
    assert result["data"]["encrypted_pkm_manifests"][0]["manifest_version"] == 1
    assert result["data"]["consent_audit"][0]["issued_at"] == NOW

    executed_sql = "\n".join(str(call.args[0]) for call in conn.execute.call_args_list)
    assert "activity_score" not in executed_sql
    assert "encrypted_blob" not in executed_sql
    assert "blob_size" not in executed_sql
    assert "stored_version" not in executed_sql
    assert "storage_layout" not in executed_sql
    assert "occurred_at" not in executed_sql
    assert "vault_key_wrappers" not in executed_sql


@pytest.mark.asyncio
async def test_export_data_hides_raw_database_error():
    service = AccountService()

    with patch(
        "hushh_mcp.services.account_service.get_db_connection",
        side_effect=RuntimeError("database password leaked in stack"),
    ):
        result = await service.export_data(USER_ID)

    assert result == {"success": False, "error": "Account export failed"}


@pytest.mark.asyncio
async def test_export_route_hides_raw_export_failure(monkeypatch):
    class FailingAccountService:
        async def export_data(self, _user_id):
            return {"success": False, "error": "raw database failure detail"}

    monkeypatch.setattr("api.routes.account.AccountService", FailingAccountService)

    with pytest.raises(HTTPException) as exc_info:
        await export_account_data({"user_id": USER_ID})

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Account export failed"
