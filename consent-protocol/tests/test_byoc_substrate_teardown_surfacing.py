"""Substrate incompleteness must reach the deletion response on BOTH order paths.

The compute teardown can be clean (host gone, nothing unreclaimed) while resources
survive in the person's own project. Before this, only the compute result could set
personal_agent_teardown_incomplete -- the substrate summary's incomplete flag was
computed and then dropped. These drive the real /api/account/delete endpoint with a
mocked deprovision whose substrate_teardown reports survivors, and assert the
response names them on the delete-order-V2 path and the legacy path alike.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import account
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.actor_identity_service import ActorIdentityService

_SUBSTRATE_INCOMPLETE = {
    "executed": True,
    "actions": 9,
    "incomplete": True,
    "failed": [{"type": "gcs_bucket", "id": "one-pod-x-blobs", "reason": "bucket http=403"}],
}


def _delete_app(monkeypatch, *, deprov_result):
    async def _mock_delete(self, user_id: str, target: str = "both"):
        return {"success": True, "deleted_target": "both", "account_deleted": True}

    async def _mock_deprov(user_id, *, revoke=False, defer_row_delete=False):
        return dict(deprov_result)

    async def _mock_finalize(user_id):
        return None

    async def _mock_get_many(self, user_ids):
        return {"user_123": {"phone_number": "+16505550101", "phone_verified": True}}

    async def _mock_fb(user_id):
        return "deleted"

    async def _mock_orphan(*, phone_number=None, protected_uid=None):
        return "deleted"

    app = FastAPI()
    app.include_router(account.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(AccountService, "delete_account", _mock_delete)
    monkeypatch.setattr(ActorIdentityService, "get_many", _mock_get_many)
    monkeypatch.setattr(account, "_delete_firebase_auth_user", _mock_fb)
    monkeypatch.setattr(account, "_delete_safe_phone_only_firebase_user_by_phone", _mock_orphan)
    monkeypatch.setattr(account, "_deprovision_personal_agent", _mock_deprov)
    monkeypatch.setattr(account, "_finalize_personal_agent_row_delete", _mock_finalize)
    return app


def test_delete_account_v2_surfaces_incomplete_substrate_teardown(monkeypatch):
    monkeypatch.setenv("PERSONAL_AGENT_DELETE_ORDER_V2", "1")
    app = _delete_app(
        monkeypatch,
        deprov_result={
            # the COMPUTE result is clean -- only the substrate summary carries the gap
            "status": "deprovisioned",
            "teardownReachedHost": True,
            "unreclaimed": False,
            "substrate_teardown": dict(_SUBSTRATE_INCOMPLETE),
        },
    )
    resp = TestClient(app).delete("/api/account/delete")
    assert resp.status_code == 200
    details = resp.json()["details"]
    assert details["personal_agent_teardown_incomplete"] is True
    assert details["substrate_teardown_failed"] == _SUBSTRATE_INCOMPLETE["failed"]


def test_delete_account_legacy_surfaces_incomplete_substrate_teardown(monkeypatch):
    monkeypatch.delenv("PERSONAL_AGENT_DELETE_ORDER_V2", raising=False)
    app = _delete_app(
        monkeypatch,
        deprov_result={
            "status": "deprovisioned",
            "substrate_teardown": dict(_SUBSTRATE_INCOMPLETE),
        },
    )
    resp = TestClient(app).delete("/api/account/delete")
    assert resp.status_code == 200
    details = resp.json()["details"]
    assert details["personal_agent_teardown_incomplete"] is True
    assert details["substrate_teardown_failed"] == _SUBSTRATE_INCOMPLETE["failed"]
