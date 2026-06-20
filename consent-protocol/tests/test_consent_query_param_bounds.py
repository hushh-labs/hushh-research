"""
Tests that Query bounds are enforced on userId and requestId query parameters.

Canonical attach points:
    api.routes.consent.get_pending_consents -> GET /api/consent/pending
    api.routes.consent.deny_consent -> POST /api/consent/pending/deny
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.consent as consent_module
from api.routes.consent import router


def _build_app(user_id: str = "user_abc") -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    from api.middleware import require_vault_owner_token

    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": user_id,
        "scope": "vault.owner",
    }
    return app


class TestConsentQueryParamBounds:
    """Verifies that userId and requestId query params enforce min/max length constraints."""

    def test_get_pending_rejects_oversized_user_id(self):
        oversized = "u" * 200
        client = TestClient(_build_app(user_id=oversized), raise_server_exceptions=False)

        resp = client.get(f"/api/consent/pending?userId={oversized}")

        assert resp.status_code == 422

    def test_get_pending_rejects_empty_user_id(self):
        client = TestClient(_build_app(), raise_server_exceptions=False)

        resp = client.get("/api/consent/pending?userId=")

        assert resp.status_code == 422

    def test_get_pending_accepts_valid_user_id(self, monkeypatch):
        class _FakeService:
            async def get_pending_requests(self, uid):
                return []

        monkeypatch.setattr(consent_module, "ConsentDBService", _FakeService)

        # Patch hydration helper to be a no-op
        async def _noop_hydrate(items):
            return items

        monkeypatch.setattr(consent_module, "_hydrate_pending_requester_labels", _noop_hydrate)

        client = TestClient(_build_app(user_id="valid_user"), raise_server_exceptions=False)
        resp = client.get("/api/consent/pending?userId=valid_user")

        assert resp.status_code != 422

    def test_deny_rejects_oversized_user_id(self):
        oversized = "u" * 200
        client = TestClient(_build_app(user_id=oversized), raise_server_exceptions=False)

        resp = client.post(f"/api/consent/pending/deny?userId={oversized}&requestId=req_001")

        assert resp.status_code == 422

    def test_deny_rejects_oversized_request_id(self):
        oversized_rid = "r" * 200
        client = TestClient(_build_app(user_id="user_abc"), raise_server_exceptions=False)

        resp = client.post(
            f"/api/consent/pending/deny?userId=user_abc&requestId={oversized_rid}"
        )

        assert resp.status_code == 422

    def test_deny_rejects_empty_request_id(self):
        client = TestClient(_build_app(user_id="user_abc"), raise_server_exceptions=False)

        resp = client.post("/api/consent/pending/deny?userId=user_abc&requestId=")

        assert resp.status_code == 422
