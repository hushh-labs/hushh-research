"""
Tests for counterpart_id max_length on the handshake history endpoint.

GET /api/consent/handshake/history passes counterpart_id to
ConsentCenterService.get_handshake_history() as a database query key.
With only min_length=1 and no upper bound, an arbitrarily long value
flows into the query (CWE-400).

FastAPI validates Query constraints before the handler executes, so these
tests confirm 422 is returned for oversized values without requiring a
real database connection.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes import consent

_COUNTERPART_ID_MAX = 128


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid_test"
    return app


_CLIENT = TestClient(_build_app(), raise_server_exceptions=False)


def test_counterpart_id_over_max_returns_422():
    response = _CLIENT.get(
        "/api/consent/handshake/history",
        params={"counterpart_id": "c" * (_COUNTERPART_ID_MAX + 1)},
    )
    assert response.status_code == 422


def test_counterpart_id_at_max_passes_validation():
    """Exactly 128 chars must not be rejected by the Query validator."""
    response = _CLIENT.get(
        "/api/consent/handshake/history",
        params={"counterpart_id": "c" * _COUNTERPART_ID_MAX},
    )
    # Handler proceeds past validation; it may return 500 if the DB is
    # unavailable in the test environment -- that is acceptable.
    # What matters is that we do NOT get a 422 validation error.
    assert response.status_code != 422


def test_counterpart_id_empty_returns_422():
    response = _CLIENT.get(
        "/api/consent/handshake/history",
        params={"counterpart_id": ""},
    )
    assert response.status_code == 422


def test_counterpart_id_missing_returns_422():
    response = _CLIENT.get("/api/consent/handshake/history")
    assert response.status_code == 422


def test_counterpart_id_typical_value_passes_validation():
    response = _CLIENT.get(
        "/api/consent/handshake/history",
        params={"counterpart_id": "user_abc123"},
    )
    assert response.status_code != 422
