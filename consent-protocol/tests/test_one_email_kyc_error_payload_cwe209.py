"""
Regression tests: OneEmailKycError.payload must not reach HTTP clients.

CWE-209 - Information Exposure Through Error Messages.

_to_http_exception() in api/routes/one/email.py previously forwarded the full
OneEmailKycError.payload dict into the HTTP response body:

    if exc.payload:
        detail["payload"] = exc.payload

Two raise sites in one_email_kyc_service.py pass provider-internal data as
payload:

    ONE_EMAIL_GMAIL_READ_FAILED:
        payload={"status": response.status_code, "payload": <raw Gmail API response>}

    ONE_EMAIL_GMAIL_WRITE_FAILED:
        payload={"status": response.status_code, "payload": <raw Gmail API response>}

The raw Gmail API response body can contain internal Google service error
details and message metadata.

Additionally, the ONE_EMAIL_KYC_NOT_CONFIGURED error message included
environment variable names in its str() representation:
    "One email KYC is not configured. Provide ONE_EMAIL_SERVICE_ACCOUNT_JSON
     or FIREBASE_ADMIN_CREDENTIALS_JSON and ONE_EMAIL_ADDRESS."

Fix: strip payload from all OneEmailKycError HTTP responses; log it
server-side. Replace the NOT_CONFIGURED message with a static opaque string.

Attach point: _to_http_exception() is called by all route handlers in
api/routes/one/email.py that delegate to _service() calls, including the
POST /api/one/email/webhook and all /api/one/email/workflows routes.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

SENTINEL = "XK9_ONE_EMAIL_KYC_PAYLOAD_SENTINEL_XK9"

_FAKE_FIREBASE_UID = "test-one-email-cwe209"
_FAKE_TOKEN_DATA = {
    "user_id": _FAKE_FIREBASE_UID,
    "token_type": "VAULT_OWNER",
    "scope": "vault.owner",
}


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from api.middleware import require_vault_owner_token
    from server import app

    app.dependency_overrides[require_vault_owner_token] = lambda: _FAKE_TOKEN_DATA
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        app.dependency_overrides.pop(require_vault_owner_token, None)


def _make_kyc_error(sentinel: str, code: str = "ONE_EMAIL_GMAIL_READ_FAILED"):
    from hushh_mcp.services.one_email_kyc_service import OneEmailKycError

    return OneEmailKycError(
        "Gmail read failed.",
        status_code=502,
        code=code,
        payload={
            "status": 401,
            "payload": {
                "error": f"internal gmail error: {sentinel}",
                "error_description": f"detail with {sentinel}",
            },
        },
    )


def _make_not_configured_error(sentinel: str):
    from hushh_mcp.services.one_email_kyc_service import OneEmailKycError

    return OneEmailKycError(
        f"One email KYC is not configured. Provide {sentinel}_SERVICE_ACCOUNT_JSON "
        "or FIREBASE_ADMIN_CREDENTIALS_JSON and ONE_EMAIL_ADDRESS.",
        status_code=503,
        code="ONE_EMAIL_KYC_NOT_CONFIGURED",
    )


# ---------------------------------------------------------------------------
# Unit tests: _to_http_exception directly
# ---------------------------------------------------------------------------


def test_kyc_error_payload_not_in_exception_detail() -> None:
    """OneEmailKycError.payload must not appear in the HTTPException detail."""
    from api.routes.one.email import _to_http_exception

    exc = _make_kyc_error(SENTINEL)
    http_exc = _to_http_exception(exc, operation="test")

    detail_str = str(http_exc.detail)
    assert SENTINEL not in detail_str, (
        f"KYC payload sentinel leaked into detail: {detail_str}"
    )
    assert "payload" not in http_exc.detail, (
        "OneEmailKycError.payload forwarded to HTTP response"
    )


def test_kyc_error_code_is_preserved() -> None:
    """Error code must still be returned for client routing."""
    from api.routes.one.email import _to_http_exception

    exc = _make_kyc_error(SENTINEL)
    http_exc = _to_http_exception(exc, operation="test")

    assert http_exc.detail.get("code") == "ONE_EMAIL_GMAIL_READ_FAILED"
    assert SENTINEL not in str(http_exc.detail)


def test_kyc_error_write_failed_payload_not_in_detail() -> None:
    """Gmail write failed payload must also be stripped."""
    from api.routes.one.email import _to_http_exception
    from hushh_mcp.services.one_email_kyc_service import OneEmailKycError

    exc = OneEmailKycError(
        "Gmail write failed.",
        status_code=502,
        code="ONE_EMAIL_GMAIL_WRITE_FAILED",
        payload={
            "status": 403,
            "payload": {"error": f"forbidden: {SENTINEL}"},
        },
    )
    http_exc = _to_http_exception(exc, operation="test")

    assert SENTINEL not in str(http_exc.detail)
    assert "payload" not in http_exc.detail
    assert http_exc.detail.get("code") == "ONE_EMAIL_GMAIL_WRITE_FAILED"


def test_not_configured_message_is_static() -> None:
    """NOT_CONFIGURED error must use an opaque message, not the env-var-laden str(exc)."""
    from api.routes.one.email import _to_http_exception

    exc = _make_not_configured_error(SENTINEL)
    http_exc = _to_http_exception(exc, operation="test")

    detail_str = str(http_exc.detail)
    assert SENTINEL not in detail_str, (
        f"NOT_CONFIGURED env-var sentinel leaked into detail: {detail_str}"
    )
    assert "SERVICE_ACCOUNT_JSON" not in detail_str
    assert "FIREBASE_ADMIN_CREDENTIALS_JSON" not in detail_str
    assert http_exc.status_code == 503


def test_kyc_error_without_payload_is_unchanged() -> None:
    """Errors without payload must pass through the message unchanged."""
    from api.routes.one.email import _to_http_exception
    from hushh_mcp.services.one_email_kyc_service import OneEmailKycError

    exc = OneEmailKycError(
        "Email request cursor is invalid.",
        status_code=400,
        code="ONE_KYC_CURSOR_INVALID",
    )
    http_exc = _to_http_exception(exc, operation="test")

    assert http_exc.detail.get("message") == "Email request cursor is invalid."
    assert http_exc.detail.get("code") == "ONE_KYC_CURSOR_INVALID"
    assert http_exc.status_code == 400


# ---------------------------------------------------------------------------
# HTTP proof: TestClient sentinel-injection
# ---------------------------------------------------------------------------


def test_http_gmail_read_error_payload_not_in_response(client) -> None:
    """
    GET /api/one/kyc/workflows with a mocked Gmail read failure must not
    return the raw Gmail API payload in the HTTP response body.

    Attach point: one_kyc_list_workflows -> _service().list_workflows ->
    (internally may call Gmail APIs) -> OneEmailKycError with payload ->
    _to_http_exception.
    """
    from hushh_mcp.services.one_email_kyc_service import OneEmailKycError

    leak_error = OneEmailKycError(
        "Gmail read failed.",
        status_code=502,
        code="ONE_EMAIL_GMAIL_READ_FAILED",
        payload={
            "status": 401,
            "payload": {"error": f"gmail internal: {SENTINEL}"},
        },
    )

    mock_svc = MagicMock()
    mock_svc.list_workflows = AsyncMock(side_effect=leak_error)

    with patch("api.routes.one.email._service", return_value=mock_svc):
        resp = client.get(
            "/api/one/kyc/workflows",
            params={"user_id": _FAKE_FIREBASE_UID},
        )

    assert resp.status_code == 502
    body = resp.text
    assert SENTINEL not in body, f"Gmail payload sentinel leaked into HTTP response: {body}"
    detail = resp.json().get("detail", {})
    assert "payload" not in detail, f"payload field forwarded to HTTP response: {detail}"
