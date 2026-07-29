"""
Tests for user_id max_length on portfolio import multipart-form endpoints.

Three file-upload endpoints accept user_id as a Form field with no upper
bound.  An arbitrarily long user_id causes oversized log lines, inflated
audit records, and can trigger database index overflow errors (CWE-400).

FastAPI validates Form constraints before the handler body executes, so
these tests confirm the 422 response without mocking the file-upload
infrastructure.
"""

from __future__ import annotations

import io

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import portfolio


def _build_app() -> FastAPI:
    # portfolio.router declares no prefix of its own; production only gets
    # /api/kai/portfolio/... because kai_router mounts it with prefix="/api/kai"
    # (api/routes/kai/__init__.py). Mount it the same way here.
    app = FastAPI()
    app.include_router(portfolio.router, prefix="/api/kai")
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "uid_test"}
    return app


_USER_ID_MAX = 128
_CLIENT = _build_app()


def _csv_file():
    return ("portfolio.csv", io.BytesIO(b"symbol,qty\nAAPL,10"), "text/csv")


# ---------------------------------------------------------------------------
# /portfolio/import
# ---------------------------------------------------------------------------


def test_import_user_id_over_max_returns_422():
    client = TestClient(_CLIENT, raise_server_exceptions=False)
    response = client.post(
        "/api/kai/portfolio/import",
        data={"user_id": "u" * (_USER_ID_MAX + 1)},
        files={"file": _csv_file()},
    )
    assert response.status_code == 422


def test_import_user_id_at_max_passes_validation():
    """A user_id exactly at the limit must not be rejected by the model layer."""
    client = TestClient(_CLIENT, raise_server_exceptions=False)
    response = client.post(
        "/api/kai/portfolio/import",
        data={"user_id": "u" * _USER_ID_MAX},
        files={"file": _csv_file()},
    )
    # The handler will 403 because the overridden token returns "uid_test",
    # not the 128-char user_id, which is expected. What matters is that we
    # do NOT get 422 (validation rejection).
    assert response.status_code != 422


# ---------------------------------------------------------------------------
# /portfolio/import/run/start
# ---------------------------------------------------------------------------


def test_import_run_start_user_id_over_max_returns_422():
    client = TestClient(_CLIENT, raise_server_exceptions=False)
    response = client.post(
        "/api/kai/portfolio/import/run/start",
        data={"user_id": "u" * (_USER_ID_MAX + 1)},
        files={"file": _csv_file()},
    )
    assert response.status_code == 422


def test_import_run_start_user_id_at_max_passes_validation():
    client = TestClient(_CLIENT, raise_server_exceptions=False)
    response = client.post(
        "/api/kai/portfolio/import/run/start",
        data={"user_id": "u" * _USER_ID_MAX},
        files={"file": _csv_file()},
    )
    assert response.status_code != 422


# ---------------------------------------------------------------------------
# /portfolio/import/stream
# ---------------------------------------------------------------------------


def test_import_stream_user_id_over_max_returns_422():
    client = TestClient(_CLIENT, raise_server_exceptions=False)
    response = client.post(
        "/api/kai/portfolio/import/stream",
        data={"user_id": "u" * (_USER_ID_MAX + 1)},
        files={"file": _csv_file()},
    )
    assert response.status_code == 422


def test_import_stream_user_id_at_max_passes_validation():
    client = TestClient(_CLIENT, raise_server_exceptions=False)
    response = client.post(
        "/api/kai/portfolio/import/stream",
        data={"user_id": "u" * _USER_ID_MAX},
        files={"file": _csv_file()},
    )
    assert response.status_code != 422
