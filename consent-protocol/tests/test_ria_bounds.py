"""Test resource exhaustion bounds (CWE-400) on RIA routes."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import ria


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(ria.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "test_user_123"
    return app


def test_renaissance_universe_rejects_oversized_tier():
    """Verify /ria/universe tier parameter enforces max_length=64."""
    app = _build_app()
    client = TestClient(app)

    oversized_tier = "x" * 65
    response = client.get(
        "/api/ria/universe",
        params={"tier": oversized_tier},
    )
    assert response.status_code == 422


def test_renaissance_universe_within_bounds_accepts_request():
    """Verify /ria/universe with valid bounds passes validation."""
    app = _build_app()
    client = TestClient(app)

    response = client.get(
        "/api/ria/universe",
        params={"tier": "alpha"},
    )
    assert response.status_code in [200, 500, 503]
