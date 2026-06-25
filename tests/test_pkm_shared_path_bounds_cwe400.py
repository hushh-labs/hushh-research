"""Verify CWE-400: canonical PKM shared route path params are bounded.

Mounts the real pkm_routes_shared.router so the actual route declarations are
exercised. FastAPI validates the Path(max_length=...) constraints before the
dependencies and handler body run, so oversized path segments are rejected
with 422 ahead of any auth check.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import pkm_routes_shared

_TOO_LONG = "x" * 257  # exceeds every bound (user_id 128, domain 200, attribute_key 256)
_OK = "ok"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(pkm_routes_shared.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "test_user_123",
        "token": "test",
    }
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", f"/api/pkm/data/{_TOO_LONG}"),
        ("get", f"/api/pkm/domain-data/{_TOO_LONG}/{_OK}"),
        ("get", f"/api/pkm/manifest/{_TOO_LONG}/{_OK}"),
        ("delete", f"/api/pkm/domain-data/{_TOO_LONG}/{_OK}"),
        ("post", f"/api/pkm/reconcile/{_TOO_LONG}"),
        ("delete", f"/api/pkm/attributes/{_TOO_LONG}/{_OK}/{_OK}"),
    ],
)
def test_pkm_routes_reject_oversized_user_id(method: str, path: str) -> None:
    """Each PKM route must reject an oversized user_id path segment with 422."""
    resp = getattr(_client(), method)(path)
    assert resp.status_code == 422


def test_domain_data_rejects_oversized_domain() -> None:
    """domain segment beyond 200 chars must be rejected with 422."""
    resp = _client().get(f"/api/pkm/domain-data/{_OK}/{'d' * 201}")
    assert resp.status_code == 422
