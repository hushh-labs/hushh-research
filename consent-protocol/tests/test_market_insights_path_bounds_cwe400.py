"""Verify CWE-400: market-insights route user_id path params are bounded.

Mounts the real market_insights.router so the actual route declarations are
exercised. FastAPI validates the Path(max_length=...) constraint before
dependencies and the handler body run, so an oversized user_id is rejected
with 422 ahead of any auth check.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.kai import market_insights

_TOO_LONG = "x" * 129


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(market_insights.router)
    # Override auth so each request proceeds to path-parameter validation; the
    # oversized user_id must be rejected by the bound, not short-circuited by auth.
    app.dependency_overrides[require_firebase_auth] = lambda: "test_user_123"
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "test_user_123",
        "token": "test",
    }
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "path",
    [
        f"/market/insights/baseline/{_TOO_LONG}",
        f"/market/insights/{_TOO_LONG}",
        f"/stock-preview/{_TOO_LONG}",
    ],
)
def test_market_insights_rejects_oversized_user_id(path: str) -> None:
    """Each market-insights route must reject a 129-char user_id with 422."""
    resp = _client().get(path)
    assert resp.status_code == 422
