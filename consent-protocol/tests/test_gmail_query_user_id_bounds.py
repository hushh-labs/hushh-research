"""
Tests for user_id max_length on Gmail route Query parameters.

Two GET endpoints used Query(..., min_length=1) with no upper bound on
user_id.  Both pass user_id to service calls that write audit records and
perform database lookups (CWE-400).  FastAPI validates Query constraints
before the handler body runs, so these tests confirm 422 for oversized
values without requiring real Firebase or Gmail credentials.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.kai import gmail

_USER_ID_MAX = 128


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(gmail.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid_test"
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "uid_test"}
    return app


_CLIENT = TestClient(_build_app(), raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# GET /gmail/sync/{run_id}
# ---------------------------------------------------------------------------


def test_gmail_sync_run_user_id_over_max_returns_422():
    response = _CLIENT.get(
        "/gmail/sync/some-run-id",
        params={"user_id": "u" * (_USER_ID_MAX + 1)},
    )
    assert response.status_code == 422


def test_gmail_sync_run_user_id_at_max_passes_validation():
    """Exactly 128 chars must not produce a 422 from the Query validator."""
    response = _CLIENT.get(
        "/gmail/sync/some-run-id",
        params={"user_id": "u" * _USER_ID_MAX},
    )
    # Handler will return 403 or 404 depending on service state -- not 422.
    assert response.status_code != 422


def test_gmail_sync_run_user_id_empty_returns_422():
    response = _CLIENT.get(
        "/gmail/sync/some-run-id",
        params={"user_id": ""},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# GET /gmail/receipts-memory/artifacts/{artifact_id}
# ---------------------------------------------------------------------------


def test_gmail_artifact_user_id_over_max_returns_422():
    response = _CLIENT.get(
        "/gmail/receipts-memory/artifacts/some-artifact-id",
        params={"user_id": "u" * (_USER_ID_MAX + 1)},
    )
    assert response.status_code == 422


def test_gmail_artifact_user_id_at_max_passes_validation():
    response = _CLIENT.get(
        "/gmail/receipts-memory/artifacts/some-artifact-id",
        params={"user_id": "u" * _USER_ID_MAX},
    )
    assert response.status_code != 422


def test_gmail_artifact_user_id_empty_returns_422():
    response = _CLIENT.get(
        "/gmail/receipts-memory/artifacts/some-artifact-id",
        params={"user_id": ""},
    )
    assert response.status_code == 422
