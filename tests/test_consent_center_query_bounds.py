"""Route-level proof for consent center and export query parameter bounds.

Canonical attach points:
  GET  /api/consent/center/summary   actor, mode           max_length=50
  GET  /api/consent/center/list      actor, surface, mode  max_length=50, q max_length=200
  GET  /api/consent/handshake/history  counterpart_id      max_length=128
  GET  /api/consent/data             consent_token         max_length=500

Tests drive the actual consent router through TestClient with auth deps
overridden, then assert 422 for one-over-limit and non-422 for at-limit.
counterpart_id is tested at 128 to match the already-merged bound.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes import consent as consent_routes

_UID = "test-user-uid"
_FIREBASE_DEP = lambda: _UID  # noqa: E731
_VAULT_DEP = lambda: {"user_id": _UID, "token": "stub"}  # noqa: E731


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(consent_routes.router)
    app.dependency_overrides[require_firebase_auth] = _FIREBASE_DEP
    app.dependency_overrides[require_vault_owner_token] = _VAULT_DEP
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# GET /api/consent/center/summary -- actor, mode
# ---------------------------------------------------------------------------


def test_center_summary_actor_too_long_rejected(client: TestClient) -> None:
    resp = client.get(f"/api/consent/center/summary?actor={'x' * 51}")
    assert resp.status_code == 422, resp.text


def test_center_summary_mode_too_long_rejected(client: TestClient) -> None:
    resp = client.get(f"/api/consent/center/summary?mode={'x' * 51}")
    assert resp.status_code == 422, resp.text


def test_center_summary_actor_at_cap_accepted(client: TestClient) -> None:
    with patch.object(consent_routes, "ConsentCenterService") as mock_svc:
        mock_svc.return_value.get_center_summary = AsyncMock(return_value={})
        resp = client.get(f"/api/consent/center/summary?actor={'x' * 50}")
    assert resp.status_code != 422, resp.text


# ---------------------------------------------------------------------------
# GET /api/consent/center/list -- actor, surface, mode, q
# ---------------------------------------------------------------------------


def test_center_list_q_too_long_rejected(client: TestClient) -> None:
    resp = client.get(f"/api/consent/center/list?q={'x' * 201}")
    assert resp.status_code == 422, resp.text


def test_center_list_actor_at_cap_accepted(client: TestClient) -> None:
    with patch.object(consent_routes, "ConsentCenterService") as mock_svc:
        mock_svc.return_value.list_center = AsyncMock(return_value=[])
        resp = client.get(f"/api/consent/center/list?actor={'x' * 50}")
    assert resp.status_code != 422, resp.text


# ---------------------------------------------------------------------------
# GET /api/consent/handshake/history -- counterpart_id (128 = merged bound)
# ---------------------------------------------------------------------------


def test_counterpart_id_too_long_rejected(client: TestClient) -> None:
    """129-char counterpart_id must be rejected with 422."""
    resp = client.get(f"/api/consent/handshake/history?counterpart_id={'c' * 129}")
    assert resp.status_code == 422, resp.text


def test_counterpart_id_at_cap_accepted(client: TestClient) -> None:
    """Exactly 128 chars must pass the bound (matches the already-merged 128 limit)."""
    with patch.object(consent_routes, "ConsentCenterService") as mock_svc:
        mock_svc.return_value.get_handshake_history = AsyncMock(return_value=[])
        resp = client.get(f"/api/consent/handshake/history?counterpart_id={'c' * 128}")
    assert resp.status_code != 422, resp.text


# ---------------------------------------------------------------------------
# GET /api/consent/data -- consent_token (max_length=500)
# ---------------------------------------------------------------------------


def test_data_consent_token_too_long_rejected(client: TestClient) -> None:
    """501-char token must be rejected before any backend I/O."""
    resp = client.get(f"/api/consent/data?consent_token={'t' * 501}")
    assert resp.status_code == 422, resp.text


def test_data_consent_token_at_cap_accepted(client: TestClient) -> None:
    """Exactly 500-char token passes the bound (token itself will be invalid, not 422)."""
    with patch.object(consent_routes, "ConsentDBService") as mock_svc:
        mock_svc.return_value.get_export_payload = AsyncMock(return_value=None)
        resp = client.get(f"/api/consent/data?consent_token={'t' * 500}")
    assert resp.status_code != 422, resp.text
