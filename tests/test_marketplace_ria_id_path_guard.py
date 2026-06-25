"""HTTP proof: GET /api/marketplace/ria/{ria_id} rejects overlong ids.

Canonical attach point:
  api.routes.marketplace.get_marketplace_ria -> GET /api/marketplace/ria/{ria_id}

FastAPI enforces Path(max_length=128) before the handler is reached, so
oversized ids return 422 without any DB round-trip.
"""

from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import marketplace


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(marketplace.router)
    return app


def test_ria_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    oversized = "A" * 129
    resp = client.get(f"/api/marketplace/ria/{oversized}")
    assert resp.status_code == 422


def test_ria_id_empty_segment_not_routed():
    """An empty path segment is not routed to the handler (404 from router)."""
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/marketplace/ria/")
    assert resp.status_code in {404, 405}


def test_ria_id_valid_length_passes_validation():
    """A valid-length id reaches the handler (mocked to return a profile)."""
    app = _make_app()

    fake_profile = {"ria_id": "abc123", "name": "Test RIA"}

    with patch(
        "hushh_mcp.services.ria_iam_service.RIAIAMService.get_marketplace_ria_profile",
        new=AsyncMock(return_value=fake_profile),
    ):
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/marketplace/ria/abc123")

    assert resp.status_code == 200
    assert resp.json()["ria_id"] == "abc123"
