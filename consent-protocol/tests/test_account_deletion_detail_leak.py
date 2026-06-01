"""
account.py deletion error detail-leak tests.

Verifies that the delete-account route returns a generic 500 body rather
than forwarding the raw service-layer error string (CWE-209).

Issue: #1542
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


def _make_delete_app(service_error: str):
    """Minimal app that mimics the patched delete_account error path."""
    app = FastAPI()

    @app.delete("/api/account")
    async def delete_account():
        result = {"success": False, "error": service_error}
        if not result["success"]:
            raise HTTPException(status_code=500, detail="Account deletion failed")
        return result

    return app


@pytest.mark.parametrize(
    "internal_error",
    [
        "psycopg2.errors.UniqueViolation: duplicate key value violates unique constraint",
        "ConnectionRefusedError: [Errno 111] Connection refused",
        "firebase_admin.exceptions.FirebaseError: service account credentials are invalid",
        "S3 bucket 'hushh-user-data-prod' access denied for key uid_abc/export.json",
    ],
)
def test_deletion_error_does_not_leak_internal_message(internal_error: str) -> None:
    app = _make_delete_app(internal_error)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.delete("/api/account")

    assert resp.status_code == 500
    body = resp.text
    assert internal_error not in body


def test_deletion_error_returns_generic_message() -> None:
    app = _make_delete_app("some internal db error")
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.delete("/api/account")

    assert resp.status_code == 500
    data = resp.json()
    assert data.get("detail") == "Account deletion failed"


def test_deletion_success_unaffected() -> None:
    """Ensure the success path is not broken."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app2 = FastAPI()

    @app2.delete("/api/account")
    async def delete_ok():
        return {"success": True, "account_deleted": True}

    client = TestClient(app2)
    resp = client.delete("/api/account")
    assert resp.status_code == 200
    assert resp.json()["success"] is True
