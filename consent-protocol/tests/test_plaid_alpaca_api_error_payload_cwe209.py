"""
Regression tests: Plaid and Alpaca API error payloads must not reach HTTP clients.

CWE-209 - Information Exposure Through Error Messages.

_to_http_exception() in api/routes/kai/plaid.py previously forwarded raw
provider API response payloads and raw error strings into HTTP response bodies:

  PlaidApiError  -- detail["payload"] = error.payload  (full Plaid error response)
                 -- detail["message"] = str(error)     (may include raw Plaid error_message
                                                        or response.text as fallback)
  AlpacaApiError -- detail["payload"] = error.payload  (full Alpaca error response)
                 -- detail["message"] = str(error)
  Generic catch  -- detail["message"] = str(error)     (raw exception string)

The PlaidApiError.payload can contain:
  - error.base_url / path: internal Plaid endpoint configuration
  - request_id: Plaid's internal tracking identifier
  - documentation_url: exact Plaid error category URL

The AlpacaApiError.payload can contain the full Alpaca error body.

For both, the raw response.text fallback in error.message can expose unparsed
provider HTTP responses. The generic catch-all forwarded str(error) for any
exception type not matched by earlier isinstance checks.

Fix: strip payload from both PlaidApiError and AlpacaApiError responses.
Use error.display_message (user-facing, already vetted by Plaid) for Plaid
and a static opaque message for Alpaca. Replace generic str(error) with opaque.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

SENTINEL = "XK9_PROVIDER_PAYLOAD_SENTINEL_XK9"

_FAKE_FIREBASE_UID = "test-plaid-user-cwe209"
_FAKE_TOKEN_DATA = {
    "user_id": _FAKE_FIREBASE_UID,
    "token_type": "VAULT_OWNER",
    "scope": "vault.owner",
}

_PLAID_LINK_BODY = {
    "userId": _FAKE_FIREBASE_UID,
    "institutionId": "ins_109508",
    "publicToken": "fake-public-token",
}


@pytest.fixture()
def client():
    from server import app

    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _patch_auth(uid: str = _FAKE_FIREBASE_UID):
    return patch(
        "api.middleware.require_firebase_auth",
        return_value=uid,
    )


def _patch_vault_token():
    return patch(
        "api.middleware.require_vault_owner_token",
        return_value=_FAKE_TOKEN_DATA,
    )


def _make_plaid_api_error(sentinel: str, display_message: str | None = None):
    from hushh_mcp.integrations.plaid.client import PlaidApiError

    return PlaidApiError(
        message=f"Plaid error_message containing {sentinel}",
        status_code=400,
        error_code="INVALID_FIELD",
        error_type="INVALID_INPUT",
        display_message=display_message,
        payload={
            "request_id": f"req_{sentinel}",
            "base_url": f"https://internal.plaid.com/{sentinel}",
            "error_code": "INVALID_FIELD",
            "causes": [sentinel],
        },
    )


def _make_alpaca_api_error(sentinel: str):
    from hushh_mcp.integrations.alpaca.client import AlpacaApiError

    return AlpacaApiError(
        message=f"Alpaca message containing {sentinel}",
        status_code=400,
        error_code="INSUFFICIENT_FUNDS",
        payload={
            "message": f"internal alpaca payload: {sentinel}",
            "code": 40310000,
        },
    )


# ---------------------------------------------------------------------------
# Test _to_http_exception directly (unit tests)
# ---------------------------------------------------------------------------


def test_plaid_api_error_payload_not_in_exception_detail() -> None:
    """PlaidApiError.payload must not appear in the HTTPException detail."""
    from api.routes.kai.plaid import _to_http_exception

    exc = _make_plaid_api_error(SENTINEL)
    http_exc = _to_http_exception(exc)

    detail_str = str(http_exc.detail)
    assert SENTINEL not in detail_str, (
        f"Plaid payload sentinel leaked into detail: {detail_str}"
    )
    assert "payload" not in http_exc.detail, (
        "PlaidApiError.payload forwarded to HTTP response"
    )


def test_plaid_api_error_display_message_used_when_available() -> None:
    """display_message is user-facing and safe to forward."""
    from api.routes.kai.plaid import _to_http_exception

    exc = _make_plaid_api_error(SENTINEL, display_message="Your bank login expired.")
    http_exc = _to_http_exception(exc)

    assert http_exc.detail["message"] == "Your bank login expired."
    assert SENTINEL not in str(http_exc.detail)


def test_plaid_api_error_fallback_message_is_static_when_no_display_message() -> None:
    """When display_message is absent, response uses a static opaque string."""
    from api.routes.kai.plaid import _to_http_exception

    exc = _make_plaid_api_error(SENTINEL, display_message=None)
    http_exc = _to_http_exception(exc)

    assert SENTINEL not in str(http_exc.detail)
    assert "Plaid" in http_exc.detail["message"] or "error" in http_exc.detail["message"].lower()


def test_plaid_api_error_code_is_preserved() -> None:
    """Error code classification must still be returned for client routing."""
    from api.routes.kai.plaid import _to_http_exception

    exc = _make_plaid_api_error(SENTINEL)
    http_exc = _to_http_exception(exc)

    assert http_exc.detail.get("code") == "INVALID_FIELD"
    assert SENTINEL not in str(http_exc.detail)


def test_alpaca_api_error_payload_not_in_exception_detail() -> None:
    """AlpacaApiError.payload must not appear in the HTTPException detail."""
    from api.routes.kai.plaid import _to_http_exception

    exc = _make_alpaca_api_error(SENTINEL)
    http_exc = _to_http_exception(exc)

    detail_str = str(http_exc.detail)
    assert SENTINEL not in detail_str, (
        f"Alpaca payload sentinel leaked into detail: {detail_str}"
    )
    assert "payload" not in http_exc.detail, (
        "AlpacaApiError.payload forwarded to HTTP response"
    )


def test_alpaca_api_error_code_is_preserved() -> None:
    """Alpaca error code must still be returned for client routing."""
    from api.routes.kai.plaid import _to_http_exception

    exc = _make_alpaca_api_error(SENTINEL)
    http_exc = _to_http_exception(exc)

    assert http_exc.detail.get("code") == "INSUFFICIENT_FUNDS"
    assert SENTINEL not in str(http_exc.detail)


def test_generic_runtime_error_uses_opaque_message() -> None:
    """Generic exceptions must not forward str(error) to clients."""
    from api.routes.kai.plaid import _to_http_exception

    class _InternalError(Exception):
        pass

    exc = _InternalError(f"internal table=plaid_items detail={SENTINEL}")
    http_exc = _to_http_exception(exc)

    assert SENTINEL not in str(http_exc.detail)
    assert http_exc.status_code == 500
