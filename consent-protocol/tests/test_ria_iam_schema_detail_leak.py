"""
RIA IAMSchemaNotReadyError detail-leak tests.

Verifies that 503 responses returned when the IAM schema is not initialised
do not expose internal database migration commands to API clients (CWE-209).

Issue: #1542
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

INTERNAL_STRINGS = [
    "db/migrate.py",
    "db/verify",
    "verify_iam_schema",
    "--iam",
    "Run `python",
    "python db/",
]


class _FakeIAMSchemaNotReadyError(Exception):
    """Minimal stand-in that carries the default internal message."""

    def __init__(self) -> None:
        super().__init__(
            "IAM schema is not ready. Run `python db/migrate.py --iam` and "
            "`python db/verify/verify_iam_schema.py`."
        )
        self.code = "IAM_SCHEMA_NOT_READY"


def _make_ria_app(route_path: str, exc: Exception):
    """Build a minimal FastAPI app that raises *exc* on GET *route_path*."""
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    app = FastAPI()

    def _iam_schema_not_ready_response() -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "error": "RIA verification service is temporarily unavailable",
                "code": "IAM_SCHEMA_NOT_READY",
            },
        )

    @app.get(route_path)
    async def _handler():
        try:
            raise exc
        except type(exc):
            return _iam_schema_not_ready_response()

    return app


@pytest.mark.parametrize(
    "path",
    [
        "/api/ria/onboarding/status",
        "/api/ria/requests",
        "/api/ria/invites",
        "/api/ria/picks",
    ],
)
def test_iam_schema_not_ready_hides_internal_details(path: str) -> None:
    exc = _FakeIAMSchemaNotReadyError()
    app = _make_ria_app(path, exc)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(path)

    assert resp.status_code == 503
    body = resp.text
    for fragment in INTERNAL_STRINGS:
        assert fragment not in body, (
            f"Internal string {fragment!r} leaked in 503 body for {path}"
        )


def test_iam_schema_not_ready_returns_safe_code() -> None:
    exc = _FakeIAMSchemaNotReadyError()
    app = _make_ria_app("/api/ria/test", exc)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/ria/test")

    assert resp.status_code == 503
    data = resp.json()
    assert data.get("code") == "IAM_SCHEMA_NOT_READY"
    assert "temporarily unavailable" in data.get("error", "")


def test_iam_schema_exception_message_not_in_response() -> None:
    exc = _FakeIAMSchemaNotReadyError()
    app = _make_ria_app("/api/ria/test", exc)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/ria/test")

    assert str(exc) not in resp.text
