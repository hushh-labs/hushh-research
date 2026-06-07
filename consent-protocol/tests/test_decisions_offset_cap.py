"""
HTTP proof tests for offset cap + user_id Path bounds on the decisions endpoint.

Canonical attach point
----------------------
api.routes.kai.decisions.get_decision_history -> GET /kai/decisions/{user_id}

Two bugs fixed:
1. offset had no upper bound (ge=0 only) — a caller could send offset=1_000_000,
   causing the service to be asked for limit+offset=1_000_100 records, then
   discard all but `limit` of them in Python (O(N) amplification).
2. user_id path param had no max_length — arbitrary-length strings reached the DB.

Fix: offset now has le=10_000; user_id has min_length=1, max_length=128.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.kai.decisions as decisions_mod
from api.middleware import require_vault_owner_token

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(decisions_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": VALID_UID,
        "token": "fake-token",
        "scope": "vault.owner",
    }
    return TestClient(app, raise_server_exceptions=False)


def test_decisions_endpoint_reachable(client: TestClient) -> None:
    """GET /decisions/{user_id} must reach the handler."""
    resp = client.get(f"/decisions/{VALID_UID}")
    assert resp.status_code in {200, 400, 403, 422, 500, 503}


def test_decisions_offset_over_cap_returns_422(client: TestClient) -> None:
    """offset > 10_000 must be rejected with 422."""
    resp = client.get(f"/decisions/{VALID_UID}", params={"offset": 10_001})
    assert resp.status_code == 422


def test_decisions_offset_at_cap_accepted(client: TestClient) -> None:
    """offset == 10_000 must pass validation (may fail for other reasons)."""
    resp = client.get(f"/decisions/{VALID_UID}", params={"offset": 10_000})
    assert resp.status_code != 422


def test_decisions_overlong_user_id_returns_422(client: TestClient) -> None:
    """user_id longer than 128 chars must be rejected with 422."""
    resp = client.get(f"/decisions/{'x' * 129}")
    assert resp.status_code == 422


def test_decisions_valid_params_reach_handler(client: TestClient) -> None:
    """limit=10, offset=5 must reach the handler."""
    resp = client.get(f"/decisions/{VALID_UID}", params={"limit": 10, "offset": 5})
    assert resp.status_code in {200, 400, 403, 500, 503}
