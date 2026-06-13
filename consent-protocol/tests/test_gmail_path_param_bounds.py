"""HTTP proof: Gmail routes enforce user_id max_length and page le=1_000.

Canonical attach points:
  api.routes.kai.gmail.gmail_status   -> GET /gmail/status/{user_id}
  api.routes.kai.gmail.gmail_receipts -> GET /gmail/receipts/{user_id}

Before this fix both routes had unbounded user_id path params and
gmail_receipts had page: int = Query(1, ge=1) with no upper bound.
"""

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token, verify_user_id_match
from api.routes.kai import gmail as gmail_module

_UID = "test-uid"
_TOKEN_STUB = {"user_id": _UID, "token": "tok", "scope": "vault.owner"}


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(gmail_module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID
    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN_STUB
    # verify_user_id_match is a sync callable dependency, stub it to no-op
    app.dependency_overrides[verify_user_id_match] = lambda: None
    return app


# ---------------------------------------------------------------------------
# GET /gmail/status/{user_id}  -- unbounded user_id
# ---------------------------------------------------------------------------

def test_status_user_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(f"/gmail/status/{'U' * 129}")
    assert resp.status_code == 422


def test_status_valid_user_id_reaches_handler():
    fake_status = {"connected": True}
    with patch(
        "hushh_mcp.services.gmail_receipts_service.get_gmail_receipts_service",
    ) as mock_factory:
        svc = MagicMock()
        svc.get_status = AsyncMock(return_value=fake_status)
        mock_factory.return_value = svc

        app = _make_app()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(f"/gmail/status/{_UID}")

    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# GET /gmail/receipts/{user_id}  -- unbounded user_id + page cap
# ---------------------------------------------------------------------------

def test_receipts_user_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(f"/gmail/receipts/{'U' * 129}?page=1")
    assert resp.status_code == 422


def test_receipts_page_above_cap_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(f"/gmail/receipts/{_UID}?page=1001")
    assert resp.status_code == 422


def test_receipts_page_at_cap_passes():
    fake_receipts = {"items": [], "total": 0}
    with patch(
        "hushh_mcp.services.gmail_receipts_service.get_gmail_receipts_service",
    ) as mock_factory:
        svc = MagicMock()
        svc.list_receipts = AsyncMock(return_value=fake_receipts)
        mock_factory.return_value = svc

        app = _make_app()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(f"/gmail/receipts/{_UID}?page=1000")

    assert resp.status_code == 200
