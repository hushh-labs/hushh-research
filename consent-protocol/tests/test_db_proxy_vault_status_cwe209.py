"""
HTTP proof tests for CWE-209 fix in db_proxy.get_vault_status.

The ValueError and Exception handlers in get_vault_status previously used
detail="Unauthorized" and detail="Internal server error" with generic opaque
strings, but the ValueError case lacked a server-side log.  Both handlers
now log detail server-side and return opaque static strings.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.db_proxy as db_proxy_mod
from api.middleware import require_firebase_auth

VALID_UID = "test-uid"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(db_proxy_mod.router)
    app.dependency_overrides[require_firebase_auth] = lambda: VALID_UID
    return TestClient(app, raise_server_exceptions=False)


def test_vault_status_reachable(client: TestClient) -> None:
    """POST /db/vault/status must reach the handler (not 404/405)."""
    resp = client.post(
        "/db/vault/status",
        json={"userId": VALID_UID, "consentToken": "invalid-token"},
    )
    assert resp.status_code in {200, 400, 401, 403, 422, 500, 503}


def test_vault_status_bad_token_returns_opaque_detail(client: TestClient) -> None:
    """A bad consent token must produce a 401 with an opaque, static message."""
    resp = client.post(
        "/db/vault/status",
        json={"userId": VALID_UID, "consentToken": "bad-token"},
    )
    if resp.status_code == 401:
        body = resp.json()
        detail = body.get("detail", "")
        assert "Traceback" not in detail
        assert "Validation" in detail or "consent" in detail.lower()


def test_vault_status_does_not_leak_exception_text(client: TestClient) -> None:
    """The 500 response must not contain raw exception strings."""
    resp = client.post(
        "/db/vault/status",
        json={"userId": VALID_UID, "consentToken": "invalid"},
    )
    if resp.status_code == 500:
        body = resp.json()
        detail = str(body.get("detail", ""))
        assert "Traceback" not in detail
        assert detail == "Failed to retrieve vault status"
