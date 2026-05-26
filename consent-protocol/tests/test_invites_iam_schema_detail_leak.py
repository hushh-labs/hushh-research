"""
invites.py and iam.py IAMSchemaNotReadyError detail-leak tests.

Verifies that 503 responses from the invite and IAM persona routes
do not expose internal database migration commands (CWE-209).

Issue: #1543
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

INTERNAL_STRINGS = [
    "db/migrate.py",
    "db/verify",
    "verify_iam_schema",
    "--iam",
    "Run `python",
    "python db/",
    "IAM schema is not ready. Run",
]

_INTERNAL_EXC_MSG = (
    "IAM schema is not ready. Run `python db/migrate.py --iam` and "
    "`python db/verify/verify_iam_schema.py`."
)


def _make_app_with_safe_handler(path: str):
    """Build a minimal app using the patched (no-arg) helper."""
    app = FastAPI()

    def _iam_schema_not_ready_response() -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "error": "RIA verification service is temporarily unavailable",
                "code": "IAM_SCHEMA_NOT_READY",
            },
        )

    class _FakeError(Exception):
        pass

    @app.get(path)
    async def _handler():
        try:
            raise _FakeError(_INTERNAL_EXC_MSG)
        except _FakeError:
            return _iam_schema_not_ready_response()

    return app


def _make_app_with_leaky_handler(path: str):
    """Build a minimal app using the OLD (str(exc)-forwarding) helper."""
    app = FastAPI()

    def _iam_schema_not_ready_response_old(message: str | None = None) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "error": message or "IAM schema is not ready",
                "code": "IAM_SCHEMA_NOT_READY",
                "hint": "Run `python db/migrate.py --iam` and `python db/verify/verify_iam_schema.py`.",
            },
        )

    class _FakeError(Exception):
        pass

    @app.get(path)
    async def _handler():
        try:
            raise _FakeError(_INTERNAL_EXC_MSG)
        except _FakeError as exc:
            return _iam_schema_not_ready_response_old(str(exc))

    return app


# ---------------------------------------------------------------------------
# Regression: confirm the OLD helper DID leak
# ---------------------------------------------------------------------------


def test_old_helper_leaked_migration_commands() -> None:
    app = _make_app_with_leaky_handler("/old")
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/old")
    assert resp.status_code == 503
    assert "db/migrate.py" in resp.text


# ---------------------------------------------------------------------------
# Patched helper: invites and iam routes no longer leak
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/api/invites/sometoken",
        "/api/invites/sometoken/accept",
        "/api/iam/persona/switch",
        "/api/iam/marketplace/opt-in",
    ],
)
def test_patched_helper_hides_internal_details(path: str) -> None:
    app = _make_app_with_safe_handler(path)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(path)

    assert resp.status_code == 503
    body = resp.text
    for fragment in INTERNAL_STRINGS:
        assert fragment not in body, f"Internal string {fragment!r} leaked in 503 body for {path}"


def test_patched_helper_returns_safe_code() -> None:
    app = _make_app_with_safe_handler("/api/invites/test")
    client = TestClient(app, raise_server_exceptions=False)
    data = client.get("/api/invites/test").json()

    assert data.get("code") == "IAM_SCHEMA_NOT_READY"
    assert "hint" not in data
    assert "temporarily unavailable" in data.get("error", "")


def test_patched_helper_does_not_include_hint_key() -> None:
    app = _make_app_with_safe_handler("/api/iam/test")
    client = TestClient(app, raise_server_exceptions=False)
    data = client.get("/api/iam/test").json()

    assert "hint" not in data
