# consent-protocol/tests/test_token_reason_leak_remaining.py
"""
Regression tests: token validation reason strings must not appear in HTTP
response bodies from db_proxy.py, consent.py, or kai/stream.py.

CWE-209: Internal validation reason strings (e.g. "expired", "revoked",
"invalid_signature") could reveal internal token structure to callers.
"""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

INTERNAL_REASON_STRINGS = [
    "expired",
    "revoked",
    "invalid_signature",
    "malformed",
    "db_error",
    "bad_payload",
]


def _assert_no_reason_leak(response_body: bytes) -> None:
    text = response_body.decode("utf-8", errors="replace").lower()
    for reason in INTERNAL_REASON_STRINGS:
        assert reason not in text, (
            f"Token validation reason '{reason}' leaked into HTTP response body"
        )


# ---------------------------------------------------------------------------
# kai/stream.py
# ---------------------------------------------------------------------------


def _make_stream_app():
    from fastapi import FastAPI

    from api.routes.kai import stream as stream_mod

    app = FastAPI()
    app.include_router(stream_mod.router, prefix="/api/kai")
    return app


@pytest.mark.parametrize("reason", INTERNAL_REASON_STRINGS)
def test_stream_token_reason_not_leaked(reason):
    """stream.py must return an opaque 401 regardless of internal reason."""
    app = _make_stream_app()
    client = TestClient(app, raise_server_exceptions=False)

    with patch(
        "api.routes.kai.stream.validate_token_with_db",
        new=AsyncMock(return_value=(False, reason, None)),
    ):
        resp = client.get(
            "/api/kai/analyze/stream",
            params={"user_id": "test-user", "ticker": "AAPL"},
            headers={"Authorization": "Bearer HCT:fake"},
        )

    assert resp.status_code == 401
    _assert_no_reason_leak(resp.content)


# ---------------------------------------------------------------------------
# consent.py export-refresh
# ---------------------------------------------------------------------------


def _make_consent_app():
    from fastapi import FastAPI

    from api.routes import consent as consent_mod

    app = FastAPI()
    app.include_router(consent_mod.router)
    return app


@pytest.mark.parametrize("reason", INTERNAL_REASON_STRINGS)
def test_consent_export_refresh_reason_not_leaked(reason):
    """consent.py upload_refreshed_export must return an opaque 401."""
    app = _make_consent_app()
    client = TestClient(app, raise_server_exceptions=False)

    with (
        patch(
            "api.routes.consent.require_vault_owner_token",
            new=AsyncMock(return_value={"user_id": "uid123"}),
        ),
        patch(
            "api.routes.consent.validate_token_with_db",
            new=AsyncMock(return_value=(False, reason, None)),
        ),
    ):
        resp = client.post(
            "/api/consent/export-refresh/upload",
            json={
                "userId": "uid123",
                "consentToken": "HCT:fake_token",
                "exportData": {},
            },
        )

    assert resp.status_code == 401
    _assert_no_reason_leak(resp.content)
