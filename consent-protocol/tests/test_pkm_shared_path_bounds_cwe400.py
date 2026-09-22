"""Verify CWE-400: canonical PKM shared route path params are bounded.

Goes through the real `server.app`, because `pkm.router` and
`pkm_routes_shared.router` share the /api/pkm prefix and FastAPI serves
first-registered-wins: mounting the shared router alone exercises handlers no
request reaches. FastAPI validates the Path(max_length=...) constraints before
the dependencies and handler body run, so oversized path segments are rejected
with 422 ahead of any auth check.
"""

import pytest
from fastapi.testclient import TestClient

import server
from api.middleware import require_vault_owner_token
from api.routes.pkm import require_pkm_metadata_access

_TOO_LONG = "x" * 257  # exceeds every bound (user_id 128, domain 128, attribute_key 256)
_OK = "ok"


def _client() -> TestClient:
    stub = {"user_id": "test_user_123", "token": "test"}
    server.app.dependency_overrides[require_vault_owner_token] = lambda: stub
    server.app.dependency_overrides[require_pkm_metadata_access] = lambda: stub
    return TestClient(server.app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", f"/api/pkm/data/{_TOO_LONG}"),
        ("get", f"/api/pkm/domain-data/{_TOO_LONG}/{_OK}"),
        ("get", f"/api/pkm/manifest/{_TOO_LONG}/{_OK}"),
        ("post", f"/api/pkm/domains/{_TOO_LONG}/repair-manifest-paths"),
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
