"""HTTP proof: consent center endpoints cap page at le=1_000.

Before this fix both endpoints had page: int = Query(default=1, ge=1) with
no upper bound, allowing callers to trigger arbitrarily large DB offsets.
After the fix page > 1_000 returns 422 before the handler runs.
"""

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import consent as consent_module

_UID_STUB = "test-firebase-uid"


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent_module.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _UID_STUB
    return app


def test_center_list_page_above_cap_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/consent/center/list?page=1001")
    assert resp.status_code == 422


def test_center_list_page_at_cap_passes():
    fake = {"items": [], "total": 0}
    with patch(
        "hushh_mcp.services.consent_center_service.ConsentCenterService.list_center",
        new=AsyncMock(return_value=fake),
    ):
        app = _make_app()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/consent/center/list?page=1000")
    assert resp.status_code == 200


def test_handshake_history_page_above_cap_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/consent/handshake/history?counterpart_id=uid123&page=1001")
    assert resp.status_code == 422


def test_handshake_history_counterpart_id_too_long_returns_422():
    """counterpart_id has max_length=128."""
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    oversized = "X" * 129
    resp = client.get(f"/api/consent/handshake/history?counterpart_id={oversized}")
    assert resp.status_code == 422


def test_handshake_history_page_at_cap_passes():
    fake = {"history": []}
    with patch(
        "hushh_mcp.services.consent_center_service.ConsentCenterService.get_handshake_history",
        new=AsyncMock(return_value=fake),
    ):
        app = _make_app()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/consent/handshake/history?counterpart_id=uid123&page=1000")
    assert resp.status_code == 200
