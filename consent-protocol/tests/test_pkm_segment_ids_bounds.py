"""Tests proving PKM segment_ids list query parameter bounds (CWE-400)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import pkm


def _build_pkm_app() -> FastAPI:
    app = FastAPI()

    def _mock_require_vault_owner_token():
        return {"user_id": "user_123", "token": "valid_token"}

    app.dependency_overrides[require_vault_owner_token] = _mock_require_vault_owner_token
    app.include_router(pkm.router)
    return app


def test_pkm_domain_data_rejects_oversized_segment_ids_list():
    client = TestClient(_build_pkm_app())
    segment_ids = [f"seg_{i}" for i in range(101)]
    response = client.get(
        "/api/pkm/domain-data/user_123/financial",
        params={"segment_ids": segment_ids},
    )

    assert response.status_code == 422
