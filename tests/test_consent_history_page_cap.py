"""
Tests: GET /api/session/consent/history enforces a page upper bound.

Canonical attach point: api.routes.session.get_consent_history -> GET /api/session/consent/history

Before this fix the page query parameter accepted values up to 10_000.
With limit=200 that creates a DB offset of 10_000 * 200 = 2_000_000,
causing a full-table scan on the consent_audit table for every request
at the high-page boundary - a denial-of-service vector.

Fix: page is now capped at 1_000 (max offset = 1_000 * 200 = 200_000).
FastAPI returns HTTP 422 for page > 1_000 before any DB call is made.

Route-level proof: TestClient hits the route with page=1_001 and asserts
HTTP 422 is returned, and with page=1_000 asserts it is not 422.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.session as session_module
from api.middleware import require_vault_owner_token


def _stub_vault_owner():
    return {"user_id": "test-uid", "token": "fake-token", "scope": "vault.owner"}


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(session_module.router)
    app.dependency_overrides[require_vault_owner_token] = _stub_vault_owner
    return TestClient(app, raise_server_exceptions=False)


class TestConsentHistoryPageCap:
    """
    Canonical attach point: api.routes.session.get_consent_history
    GET /api/session/consent/history

    Proves FastAPI rejects page > 1_000 with HTTP 422 at the framework
    layer, before any DB offset computation.
    """

    _URL = "/api/consent/history"

    def test_page_above_cap_returns_422(self):
        """page=1_001 must be rejected with 422 - no DB query fires."""
        resp = _client().get(self._URL, params={"userId": "test-uid", "page": 1001})
        assert resp.status_code == 422

    def test_page_at_old_max_returns_422(self):
        """page=10_000 (old allowed max) must now return 422."""
        resp = _client().get(self._URL, params={"userId": "test-uid", "page": 10_000})
        assert resp.status_code == 422

    def test_page_at_new_cap_does_not_return_422(self):
        """page=1_000 is within the new cap and must pass validation."""
        resp = _client().get(self._URL, params={"userId": "test-uid", "page": 1_000})
        assert resp.status_code != 422

    def test_page_one_does_not_return_422(self):
        """page=1 (default) must always pass validation."""
        resp = _client().get(self._URL, params={"userId": "test-uid", "page": 1})
        assert resp.status_code != 422

    def test_page_zero_returns_422(self):
        """page=0 violates ge=1 and must be rejected with 422."""
        resp = _client().get(self._URL, params={"userId": "test-uid", "page": 0})
        assert resp.status_code == 422

    def test_limit_above_max_returns_422(self):
        """limit=201 exceeds le=200 and must be rejected with 422."""
        resp = _client().get(self._URL, params={"userId": "test-uid", "limit": 201})
        assert resp.status_code == 422

    def test_limit_at_max_does_not_return_422(self):
        """limit=200 is at the cap and must pass validation."""
        resp = _client().get(self._URL, params={"userId": "test-uid", "limit": 200})
        assert resp.status_code != 422
