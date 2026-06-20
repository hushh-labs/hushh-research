from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import ria
from hushh_mcp.services.ria_iam_service import RIAIAMService


def test_role_list_page_size_cap_rejects_oversized_limit(monkeypatch):
    async def _mock_require(self, user_id: str):
        assert user_id == "user_test_123"

    async def _unexpected_list(self, *_args, **_kwargs):
        raise AssertionError("oversized role list page size should be rejected")

    monkeypatch.setattr(RIAIAMService, "require_ria_verified", _mock_require)
    monkeypatch.setattr(RIAIAMService, "list_ria_clients", _unexpected_list)

    app = FastAPI()
    app.include_router(ria.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user_test_123"

    client = TestClient(app)
    response = client.get("/api/ria/clients", params={"limit": "101"})

    assert response.status_code == 422
