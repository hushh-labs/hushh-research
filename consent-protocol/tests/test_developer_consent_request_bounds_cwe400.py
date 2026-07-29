"""CWE-400 route-level proof for DeveloperConsentRequest and DeveloperScopedExportRequest.

Canonical attach points
-----------------------
api.routes.developer.request_consent
  -> POST /api/v1/request-consent  ->  payload: DeveloperConsentRequest
  -> FastAPI returns HTTP 422 when scope, expiry_hours, approval_timeout_minutes,
     or connector_public_key exceed the bounds below.

api.routes.developer.get_scoped_export
  -> POST /api/v1/scoped-export  ->  payload: DeveloperScopedExportRequest
  -> FastAPI returns HTTP 422 when consent_token or expected_scope exceed bounds.

These routes are mounted via developer.router (the exact object server.py
passes to app.include_router), so hitting them here through that router
proves the bounds fire on the path the shipped backend actually serves.

Pydantic validates the request body before the handler runs, so these
oversized-field requests never reach the developer-key authentication
inside the handler -- matching the existing
test_request_consent_rejects_oversized_query_token_before_auth pattern in
tests/test_developer_api_routes.py.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import developer

_CONNECTOR_PUBLIC_KEY = "U29tZUNvbm5lY3RvclB1YmxpY0tleURhdGE="
_CONNECTOR_KEY_ID = "connector_demo"
_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(developer.router)
    return app


def _client() -> TestClient:
    return TestClient(_build_app())


class TestRequestConsentRouteBounds:
    """POST /api/v1/request-consent -- DeveloperConsentRequest field bounds."""

    _URL = "/api/v1/request-consent"

    def _base_payload(self, **overrides) -> dict:
        payload = {
            "user_id": "user_123",
            "scope": "attr.financial.*",
            "connector_public_key": _CONNECTOR_PUBLIC_KEY,
            "connector_key_id": _CONNECTOR_KEY_ID,
            "connector_wrapping_alg": _CONNECTOR_WRAPPING_ALG,
        }
        payload.update(overrides)
        return payload

    def test_scope_over_max_returns_422(self):
        resp = _client().post(self._URL, json=self._base_payload(scope="a" * 257))
        assert resp.status_code == 422

    def test_expiry_hours_below_min_returns_422(self):
        resp = _client().post(self._URL, json=self._base_payload(expiry_hours=23))
        assert resp.status_code == 422

    def test_expiry_hours_above_max_returns_422(self):
        resp = _client().post(self._URL, json=self._base_payload(expiry_hours=2161))
        assert resp.status_code == 422

    def test_approval_timeout_minutes_below_min_returns_422(self):
        resp = _client().post(
            self._URL, json=self._base_payload(approval_timeout_minutes=4)
        )
        assert resp.status_code == 422

    def test_approval_timeout_minutes_above_max_returns_422(self):
        resp = _client().post(
            self._URL, json=self._base_payload(approval_timeout_minutes=1441)
        )
        assert resp.status_code == 422

    def test_connector_public_key_over_max_returns_422(self):
        resp = _client().post(
            self._URL, json=self._base_payload(connector_public_key="A" * 8193)
        )
        assert resp.status_code == 422


class TestScopedExportRouteBounds:
    """POST /api/v1/scoped-export -- DeveloperScopedExportRequest field bounds."""

    _URL = "/api/v1/scoped-export"

    def _base_payload(self, **overrides) -> dict:
        payload = {
            "user_id": "user_123",
            "consent_token": "v" * 32,
        }
        payload.update(overrides)
        return payload

    def test_consent_token_over_max_returns_422(self):
        resp = _client().post(self._URL, json=self._base_payload(consent_token="t" * 1025))
        assert resp.status_code == 422

    def test_expected_scope_over_max_returns_422(self):
        resp = _client().post(self._URL, json=self._base_payload(expected_scope="s" * 257))
        assert resp.status_code == 422
