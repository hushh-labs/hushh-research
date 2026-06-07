"""HTTP proof: world-model routes enforce max_length on user_id and domain.

Canonical attach points:
  api.routes.world_model.get_user_world_model_domains -> GET /api/world-model/domains/{user_id}
  api.routes.world_model.get_world_model_domain_data  -> GET /api/world-model/domain-data/{user_id}/{domain}

Before this fix every path parameter was a bare `str` with no size limit.
After the fix FastAPI rejects overlong ids with 422 before the handler runs.
"""

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import world_model

_TOKEN_STUB = {"user_id": "test-uid", "token": "fake-token", "scope": "vault.owner"}


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(world_model.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN_STUB
    return app


# ---------------------------------------------------------------------------
# user_id path param bounds
# ---------------------------------------------------------------------------

def test_domains_user_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    oversized_uid = "U" * 129
    resp = client.get(f"/api/world-model/domains/{oversized_uid}")
    assert resp.status_code == 422


def test_metadata_user_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(f"/api/world-model/metadata/{'X' * 129}")
    assert resp.status_code == 422


def test_scopes_user_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(f"/api/world-model/scopes/{'X' * 129}")
    assert resp.status_code == 422


def test_data_user_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(f"/api/world-model/data/{'X' * 129}")
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# domain path param bounds
# ---------------------------------------------------------------------------

def test_domain_data_domain_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    oversized_domain = "d" * 201
    resp = client.get(f"/api/world-model/domain-data/uid123/{oversized_domain}")
    assert resp.status_code == 422


def test_domain_data_user_id_too_long_returns_422():
    app = _make_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(f"/api/world-model/domain-data/{'U' * 129}/finance")
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Valid lengths pass validation and reach the handler
# ---------------------------------------------------------------------------

def test_domains_valid_uid_reaches_handler():
    """A valid user_id passes Path validation and delegates to _get_metadata."""
    fake_meta = MagicMock()
    fake_meta.domains = []
    fake_meta.total_attributes = 0
    fake_meta.last_updated = None

    with patch(
        "api.routes.world_model._get_metadata",
        new=AsyncMock(return_value=fake_meta),
    ):
        app = _make_app()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/world-model/domains/valid-uid-123")

    assert resp.status_code == 200
    body = resp.json()
    assert body["user_id"] == "valid-uid-123"
