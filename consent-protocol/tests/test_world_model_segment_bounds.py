"""Verify CWE-400: segment_ids query parameter is bounded in world-model routes."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import world_model


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(world_model.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "test_user_123",
        "token": "test",
    }
    return app


def test_world_model_domain_data_rejects_oversized_segment_id():
    """GET /world-model/domain-data must reject segment_ids item > 128 characters (CWE-400)."""
    client = TestClient(_build_app())
    response = client.get(
        "/api/world-model/domain-data/test_user_123/financial",
        params={"segment_ids": "x" * 129},
    )
    assert response.status_code == 422


def test_world_model_domain_data_accepts_valid_segment_ids():
    """GET /world-model/domain-data must accept segment_ids within 128 characters."""
    client = TestClient(_build_app())
    response = client.get(
        "/api/world-model/domain-data/test_user_123/financial",
        params={"segment_ids": "seg_abc"},
    )
    assert response.status_code in {200, 400, 404, 500, 503}
