from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import world_model

_TOKEN_STUB = {
    "user_id": "test-user",
    "token": "fake-token",
    "scope": "vault.owner",
}


def _make_app():
    app = FastAPI()
    app.include_router(world_model.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN_STUB
    return app


def test_world_model_routes_include_deprecation_headers():
    fake_meta = MagicMock()
    fake_meta.domains = []
    fake_meta.total_attributes = 0
    fake_meta.last_updated = None

    with patch(
        "api.routes.world_model._get_metadata",
        new=AsyncMock(return_value=fake_meta),
    ):
        client = TestClient(_make_app())

        response = client.get(
            "/api/world-model/domains/test-user"
        )

    assert response.status_code == 200

    assert response.headers["Deprecation"] == "true"
    assert response.headers["Sunset"] == "2026-06-30T00:00:00Z"

    assert (
        response.headers["X-Migrate-To"]
        == "/api/pkm/domains/test-user"
    )