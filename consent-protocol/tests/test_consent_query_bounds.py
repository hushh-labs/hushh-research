"""Verify CWE-400: consent handshake/history actor query parameter is bounded.

Canonical attach point:
  GET /api/consent/handshake/history
    actor: str = Query(default="investor", max_length=50)

This supplements test_consent_center_query_bounds.py which covers
counterpart_id on the same endpoint but does not test actor.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import consent as consent_routes

_UID = "test-user-uid"
_FIREBASE_DEP = lambda: _UID  # noqa: E731
_VAULT_DEP = lambda: {"user_id": _UID, "token": "stub"}  # noqa: E731


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent_routes.router)
    app.dependency_overrides[require_firebase_auth] = _FIREBASE_DEP
    app.dependency_overrides[require_vault_owner_token] = _VAULT_DEP
    return app


def test_handshake_history_rejects_oversized_actor():
    """GET /consent/handshake/history must reject actor > 50 characters."""
    client = TestClient(_build_app(), raise_server_exceptions=False)
    response = client.get(
        "/api/consent/handshake/history",
        params={"counterpart_id": "cid_abc", "actor": "x" * 51},
    )
    assert response.status_code == 422, response.text


def test_handshake_history_actor_at_cap_accepted():
    """GET /consent/handshake/history must accept actor at exactly 50 characters."""
    client = TestClient(_build_app(), raise_server_exceptions=False)
    with patch.object(consent_routes, "ConsentCenterService") as mock_svc:
        mock_svc.return_value.get_handshake_history = AsyncMock(return_value=[])
        response = client.get(
            "/api/consent/handshake/history",
            params={"counterpart_id": "cid_abc", "actor": "x" * 50},
        )
    assert response.status_code != 422, response.text
