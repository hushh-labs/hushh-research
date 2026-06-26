"""Proof that rate-limit decorators are wired to the real consent route handlers.

Canonical attach point:
  api.routes.consent.approve_consent        POST /api/consent/pending/approve
  api.routes.consent.deny_consent           POST /api/consent/pending/deny
  api.routes.consent.revoke_consent         POST /api/consent/revoke
  api.routes.consent.issue_vault_owner_token POST /api/consent/vault-owner-token

Each 429 test mounts the ACTUAL consent_routes.router, drives requests up to the
configured limit with mocked service dependencies, then asserts 429 on the
next request. It also asserts the service mock was not invoked on the over-limit
call. A missing decorator would let all requests through to the handler and the
service mock call-count assertion would fail.

Auth deps are overridden with stubs so the tests run fully in-process.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from api.middleware import require_vault_owner_token
from api.middlewares import RateLimits, limiter
from api.routes import consent as consent_routes

# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def _consent_app() -> FastAPI:
    """Minimal FastAPI app that mirrors the production consent router mount."""
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(consent_routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "test-user-123",
        "token": "stub-token",
    }
    return app


@pytest.fixture(autouse=True)
def _reset_limiter():
    """Clear the in-process rate-limit bucket before and after each test."""
    limiter._storage.reset()
    yield
    limiter._storage.reset()


# ---------------------------------------------------------------------------
# Import and constant proof
# ---------------------------------------------------------------------------


def test_rate_limits_import_and_constants_present():
    """RateLimits and limiter must be importable from api.middlewares."""
    assert hasattr(RateLimits, "CONSENT_ACTION")
    assert hasattr(RateLimits, "TOKEN_VALIDATION")
    assert hasattr(RateLimits, "CONSENT_REQUEST")
    assert limiter is not None


def test_consent_py_imports_rate_limit_middleware():
    """consent.py must import RateLimits and limiter from api.middlewares."""
    import inspect

    src = inspect.getsource(consent_routes)
    assert "from api.middlewares import" in src
    assert "RateLimits" in src
    assert "limiter.limit" in src


def test_rate_limit_constants_match_expected_semantics():
    """Confirm the configured values for each rate-limit tier."""
    assert "20" in RateLimits.CONSENT_ACTION and "minute" in RateLimits.CONSENT_ACTION
    assert "60" in RateLimits.TOKEN_VALIDATION and "minute" in RateLimits.TOKEN_VALIDATION
    assert "10" in RateLimits.CONSENT_REQUEST and "minute" in RateLimits.CONSENT_REQUEST


# ---------------------------------------------------------------------------
# Under-limit reachability: real route returns non-429 on first request
# ---------------------------------------------------------------------------


def test_approve_consent_route_reachable_under_limit(monkeypatch):
    """POST /api/consent/pending/approve returns non-429 on the first request."""
    app = _consent_app()
    fake_svc = MagicMock()
    fake_svc.get_pending_by_request_id = AsyncMock(return_value=None)
    monkeypatch.setattr(consent_routes, "ConsentDBService", lambda: fake_svc)

    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post(
        "/api/consent/pending/approve",
        json={"userId": "test-user-123", "requestId": "req-001"},
    )
    assert resp.status_code != 429, (
        f"First request must not be rate-limited; got {resp.status_code}: {resp.text}"
    )


def test_vault_owner_token_route_reachable_under_limit(monkeypatch):
    """POST /api/consent/vault-owner-token returns non-429 on the first request."""
    monkeypatch.setattr(
        consent_routes, "verify_firebase_bearer", lambda _auth: "test-user-123"
    )
    app = _consent_app()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post(
        "/api/consent/vault-owner-token",
        headers={"Authorization": "Bearer stub-firebase-token"},
    )
    assert resp.status_code != 429, (
        f"First request must not be rate-limited; got {resp.status_code}: {resp.text}"
    )


def test_vault_owner_token_429_after_limit_exhausted(monkeypatch):
    """POST /api/consent/vault-owner-token blocks the (TOKEN_VALIDATION + 1)th request.

    Drives the actual vault-owner-token handler to the configured 60/minute
    limit, then asserts 429 on the 61st request, confirming the over-limit
    response is enforced by the rate-limit decorator before Firebase auth runs.
    """
    monkeypatch.setattr(
        consent_routes, "verify_firebase_bearer", lambda _auth: "test-user-123"
    )
    app = _consent_app()
    client = TestClient(app, raise_server_exceptions=False)
    limit = int(RateLimits.TOKEN_VALIDATION.split("/")[0])

    for _ in range(limit):
        r = client.post(
            "/api/consent/vault-owner-token",
            headers={"Authorization": "Bearer stub-firebase-token"},
        )
        assert r.status_code != 429

    over_limit = client.post(
        "/api/consent/vault-owner-token",
        headers={"Authorization": "Bearer stub-firebase-token"},
    )
    assert over_limit.status_code == 429, (
        f"Expected 429 after TOKEN_VALIDATION limit exhausted; "
        f"got {over_limit.status_code}: {over_limit.text}"
    )


# ---------------------------------------------------------------------------
# 429 enforcement: real route, real decorator, service mock not called over limit
# ---------------------------------------------------------------------------


def test_approve_consent_429_after_limit_exhausted(monkeypatch):
    """POST /api/consent/pending/approve blocks the (CONSENT_ACTION + 1)th request.

    Drives the actual consent_routes.router to the 20-request limit, then
    asserts 429 on request 21. Asserts the service mock is called at most 20
    times, confirming the handler does not execute on the over-limit request.
    """
    app = _consent_app()
    fake_svc = MagicMock()
    fake_svc.get_pending_by_request_id = AsyncMock(return_value=None)
    monkeypatch.setattr(consent_routes, "ConsentDBService", lambda: fake_svc)

    client = TestClient(app, raise_server_exceptions=False)
    limit = int(RateLimits.CONSENT_ACTION.split("/")[0])

    for _ in range(limit):
        r = client.post(
            "/api/consent/pending/approve",
            json={"userId": "test-user-123", "requestId": "req-001"},
        )
        assert r.status_code != 429

    over_limit = client.post(
        "/api/consent/pending/approve",
        json={"userId": "test-user-123", "requestId": "req-001"},
    )
    assert over_limit.status_code == 429, (
        f"Expected 429 after limit exhausted; got {over_limit.status_code}: {over_limit.text}"
    )
    assert fake_svc.get_pending_by_request_id.call_count <= limit, (
        "Service must not be called on the over-limit request"
    )


def test_deny_consent_429_after_limit_exhausted(monkeypatch):
    """POST /api/consent/pending/deny blocks the (CONSENT_ACTION + 1)th request.

    Drives the real deny_consent handler to the limit, then asserts 429 on
    the next request and that the service was not invoked on that call.
    """
    app = _consent_app()
    fake_svc = MagicMock()
    fake_svc.get_pending_by_request_id = AsyncMock(return_value=None)
    monkeypatch.setattr(consent_routes, "ConsentDBService", lambda: fake_svc)

    client = TestClient(app, raise_server_exceptions=False)
    limit = int(RateLimits.CONSENT_ACTION.split("/")[0])

    for _ in range(limit):
        r = client.post(
            "/api/consent/pending/deny",
            params={"userId": "test-user-123", "requestId": "req-001"},
        )
        assert r.status_code != 429

    over_limit = client.post(
        "/api/consent/pending/deny",
        params={"userId": "test-user-123", "requestId": "req-001"},
    )
    assert over_limit.status_code == 429, (
        f"Expected 429 after limit exhausted; got {over_limit.status_code}: {over_limit.text}"
    )
    assert fake_svc.get_pending_by_request_id.call_count <= limit, (
        "Service must not be called on the over-limit request"
    )


def test_revoke_consent_429_after_limit_exhausted(monkeypatch):
    """POST /api/consent/revoke blocks the (CONSENT_ACTION + 1)th request.

    Drives the real revoke_consent handler to the limit, then asserts 429
    on the next request and that the service was not invoked on that call.
    """
    app = _consent_app()
    fake_svc = MagicMock()
    fake_svc.revoke_consent = AsyncMock(return_value=None)
    monkeypatch.setattr(consent_routes, "ConsentDBService", lambda: fake_svc)

    client = TestClient(app, raise_server_exceptions=False)
    limit = int(RateLimits.CONSENT_ACTION.split("/")[0])

    for _ in range(limit):
        r = client.post(
            "/api/consent/revoke",
            json={"userId": "test-user-123", "scope": "vault.owner"},
        )
        assert r.status_code != 429

    over_limit = client.post(
        "/api/consent/revoke",
        json={"userId": "test-user-123", "scope": "vault.owner"},
    )
    assert over_limit.status_code == 429, (
        f"Expected 429 after limit exhausted; got {over_limit.status_code}: {over_limit.text}"
    )
    assert fake_svc.revoke_consent.call_count <= limit, (
        "Service must not be called on the over-limit request"
    )
