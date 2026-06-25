"""
HTTP proof tests for PKM route path-parameter bounds (CWE-400).

Canonical attach points (via pkm_routes_shared.router, prefix /api/pkm):
  GET  /api/pkm/data/{user_id}
  GET  /api/pkm/domain-data/{user_id}/{domain}
  GET  /api/pkm/manifest/{user_id}/{domain}
  GET  /api/pkm/metadata/{user_id}
  DELETE /api/pkm/domain-data/{user_id}/{domain}
  POST /api/pkm/reconcile/{user_id}

Each route now enforces:
  _UserId:       max_length=128
  _Domain:       max_length=128
  _AttributeKey: max_length=256

Tests mount pkm_routes_shared.router directly (where the Path bounds live)
and override require_vault_owner_token to avoid DB or Firebase calls.
Valid-path cases use the same user_id as the token so the identity check
inside each handler passes. Oversized-path cases must return 422 from
FastAPI path validation before auth or service code runs.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.pkm_routes_shared as pkm_shared
from api.middleware import require_vault_owner_token

_USER_ID = "test-user-id"
_TOKEN_DATA = {"user_id": _USER_ID, "token": "stub-tok", "scope": "vault.owner"}
_VALID_DOMAIN = "financial"
_OVERLONG_USER_ID = "u" * 129
_OVERLONG_DOMAIN = "d" * 129


@pytest.fixture(scope="module")
def client() -> TestClient:
    """Minimal app mounting pkm_routes_shared.router with stubbed vault auth."""
    app = FastAPI()
    app.include_router(pkm_shared.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN_DATA
    return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# /api/pkm/data/{user_id}
# ---------------------------------------------------------------------------


def test_get_data_overlong_user_id_returns_422(client: TestClient) -> None:
    resp = client.get(f"/api/pkm/data/{_OVERLONG_USER_ID}")
    assert resp.status_code == 422, (
        f"Oversized user_id must be rejected with 422 by path validation; got {resp.status_code}"
    )


def test_get_data_valid_user_id_passes_path_guard(client: TestClient) -> None:
    with patch.object(pkm_shared, "get_pkm_service") as mock_svc_factory:
        svc = MagicMock()
        svc.get_encrypted_data = AsyncMock(return_value=None)
        mock_svc_factory.return_value = svc
        resp = client.get(f"/api/pkm/data/{_USER_ID}")
    assert resp.status_code != 422, "Valid user_id must pass path guard and reach the handler"


# ---------------------------------------------------------------------------
# /api/pkm/domain-data/{user_id}/{domain}
# ---------------------------------------------------------------------------


def test_get_domain_data_overlong_user_id_returns_422(client: TestClient) -> None:
    resp = client.get(f"/api/pkm/domain-data/{_OVERLONG_USER_ID}/{_VALID_DOMAIN}")
    assert resp.status_code == 422


def test_get_domain_data_overlong_domain_returns_422(client: TestClient) -> None:
    resp = client.get(f"/api/pkm/domain-data/{_USER_ID}/{'d' * 129}")
    assert resp.status_code == 422


def test_get_domain_data_valid_params_pass_path_guard(client: TestClient) -> None:
    with patch.object(pkm_shared, "get_pkm_service") as mock_svc_factory:
        svc = MagicMock()
        svc.get_domain_data = AsyncMock(return_value=None)
        mock_svc_factory.return_value = svc
        resp = client.get(f"/api/pkm/domain-data/{_USER_ID}/{_VALID_DOMAIN}")
    assert resp.status_code != 422


# ---------------------------------------------------------------------------
# /api/pkm/manifest/{user_id}/{domain}
# ---------------------------------------------------------------------------


def test_get_manifest_overlong_user_id_returns_422(client: TestClient) -> None:
    resp = client.get(f"/api/pkm/manifest/{_OVERLONG_USER_ID}/{_VALID_DOMAIN}")
    assert resp.status_code == 422


def test_get_manifest_overlong_domain_returns_422(client: TestClient) -> None:
    resp = client.get(f"/api/pkm/manifest/{_USER_ID}/{'d' * 129}")
    assert resp.status_code == 422


def test_get_manifest_valid_params_pass_path_guard(client: TestClient) -> None:
    with patch.object(pkm_shared, "get_pkm_service") as mock_svc_factory:
        svc = MagicMock()
        svc.get_domain_manifest = AsyncMock(return_value=None)
        mock_svc_factory.return_value = svc
        resp = client.get(f"/api/pkm/manifest/{_USER_ID}/{_VALID_DOMAIN}")
    assert resp.status_code != 422


# ---------------------------------------------------------------------------
# /api/pkm/domain-data/{user_id}/{domain}  DELETE
# ---------------------------------------------------------------------------


def test_delete_domain_data_overlong_user_id_returns_422(client: TestClient) -> None:
    resp = client.delete(f"/api/pkm/domain-data/{_OVERLONG_USER_ID}/{_VALID_DOMAIN}")
    assert resp.status_code == 422


def test_delete_domain_data_overlong_domain_returns_422(client: TestClient) -> None:
    resp = client.delete(f"/api/pkm/domain-data/{_USER_ID}/{'d' * 129}")
    assert resp.status_code == 422


def test_delete_domain_data_valid_params_pass_path_guard(client: TestClient) -> None:
    with patch.object(pkm_shared, "get_pkm_service") as mock_svc_factory:
        svc = MagicMock()
        svc.delete_domain_data = AsyncMock(return_value=True)
        mock_svc_factory.return_value = svc
        resp = client.delete(f"/api/pkm/domain-data/{_USER_ID}/{_VALID_DOMAIN}")
    assert resp.status_code != 422


# ---------------------------------------------------------------------------
# /api/pkm/reconcile/{user_id}
# ---------------------------------------------------------------------------


def test_reconcile_overlong_user_id_returns_422(client: TestClient) -> None:
    resp = client.post(f"/api/pkm/reconcile/{_OVERLONG_USER_ID}")
    assert resp.status_code == 422


def test_reconcile_valid_user_id_passes_path_guard(client: TestClient) -> None:
    with patch.object(pkm_shared, "get_pkm_service") as mock_svc_factory:
        svc = MagicMock()
        svc.reconcile_pkm_index = AsyncMock(return_value={"reconciled": True})
        mock_svc_factory.return_value = svc
        resp = client.post(f"/api/pkm/reconcile/{_USER_ID}")
    assert resp.status_code != 422
