"""HTTP proof: GET /api/ria/clients enforces page le=1_000.

Before this fix, page had no upper bound (ge=1 only).  A caller could
supply page=10_000_000 and trigger a 10M-row offset in the DB query.
After the fix FastAPI rejects page > 1_000 with 422 before the handler runs.
"""

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import ria as ria_module

_UID_STUB = "test-firebase-uid"


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ria_module.router)
    # Stub both firebase auth AND the _require_ria_verified dependency
    app.dependency_overrides[require_firebase_auth] = lambda: _UID_STUB
    app.dependency_overrides[ria_module._require_ria_verified] = lambda: _UID_STUB
    return app


def test_page_above_cap_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/ria/clients?page=1001")
    assert resp.status_code == 422


def test_page_at_cap_passes_validation():
    """page=1_000 is the maximum allowed; the handler is reached."""
    fake_result = {"clients": [], "total": 0}
    with patch(
        "hushh_mcp.services.ria_iam_service.RIAIAMService.list_ria_clients",
        new=AsyncMock(return_value=fake_result),
    ):
        app = _make_app()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/ria/clients?page=1000")

    assert resp.status_code == 200


def test_page_zero_returns_422():
    """page < 1 rejected by ge=1."""
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/ria/clients?page=0")
    assert resp.status_code == 422
