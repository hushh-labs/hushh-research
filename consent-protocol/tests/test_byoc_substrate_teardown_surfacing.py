"""Unverified external erasure blocks account deletion before authority is removed.

Historical behavior returned a successful account deletion with surviving substrate.
The current contract refuses that cascade and preserves the pod for recovery, under
both values of the legacy delete-order flag.
"""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import account
from hushh_mcp.services.account_service import AccountService


@pytest.mark.parametrize("delete_order", ["0", "1"])
def test_unverified_erasure_refuses_deletion_before_cloud_or_identity_cleanup(
    monkeypatch, delete_order
):
    monkeypatch.setenv("PERSONAL_AGENT_DELETE_ORDER_V2", delete_order)
    service_delete = AsyncMock(
        return_value={
            "success": False,
            "error_code": account.PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE,
        }
    )
    cloud_delete = AsyncMock()
    identity_delete = AsyncMock()
    monkeypatch.setattr(AccountService, "delete_account", service_delete)
    monkeypatch.setattr(account, "_deprovision_personal_agent", cloud_delete)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", identity_delete)
    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "synthetic-owner"}

    response = TestClient(app).delete("/api/account/delete")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == account.PERSONAL_AGENT_DEPROVISION_REQUIRED_CODE
    service_delete.assert_awaited_once_with("synthetic-owner", target="both")
    cloud_delete.assert_not_awaited()
    identity_delete.assert_not_awaited()
