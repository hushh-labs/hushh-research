"""
Regression tests: OpenAI Realtime API error messages must not reach HTTP clients.

CWE-209 - Information Exposure Through Error Messages.

create_agent_realtime_session() in api/routes/kai/agent_realtime.py previously
forwarded raw OpenAI API error message strings directly into 502 response bodies:

    result = response.json() if response.content else {}
    if response.status_code >= 400:
        detail = _extract_openai_error(result) or "Realtime client secret creation failed"
        raise HTTPException(status_code=502, detail=detail)

_extract_openai_error() extracts the "error.message" or "error.code" field from
the raw OpenAI API JSON response. OpenAI error messages can include:

  - Account-specific plan restriction details
    ("The model is restricted to your current subscription plan")
  - Rate limit specifics with internal quota identifiers
  - Internal model names or endpoint policy details

These messages originate from a third-party provider and must not be forwarded
to API clients, as they expose internal infrastructure and account configuration.

Fix: log the extracted OpenAI error server-side at WARNING level (for operator
diagnostics) and always raise HTTPException with a static opaque detail string.

Attach point: create_agent_realtime_session -> POST /api/kai/agent/realtime/session
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

SENTINEL = "XK9_OPENAI_REALTIME_ERROR_SENTINEL_XK9"

_FAKE_FIREBASE_UID = "test-agent-realtime-cwe209"
_FAKE_TOKEN_DATA = {
    "user_id": _FAKE_FIREBASE_UID,
    "token_type": "VAULT_OWNER",
    "scope": "vault.owner",
}
_FAKE_API_KEY = "openai-placeholder-for-cwe209-sentinel-test"

_REQUEST_BODY = {
    "user_id": _FAKE_FIREBASE_UID,
}


# ---------------------------------------------------------------------------
# Unit tests: _extract_openai_error directly
# ---------------------------------------------------------------------------


def test_extract_openai_error_reads_message_field() -> None:
    """_extract_openai_error returns the error.message field when present."""
    from api.routes.kai.agent_realtime import _extract_openai_error

    payload = {"error": {"message": SENTINEL, "code": "some_code"}}
    result = _extract_openai_error(payload)
    assert result == SENTINEL


def test_extract_openai_error_falls_back_to_code() -> None:
    """_extract_openai_error falls back to error.code when message is absent."""
    from api.routes.kai.agent_realtime import _extract_openai_error

    payload = {"error": {"code": SENTINEL}}
    result = _extract_openai_error(payload)
    assert result == SENTINEL


def test_extract_openai_error_returns_none_for_empty() -> None:
    """_extract_openai_error returns None for non-error payloads."""
    from api.routes.kai.agent_realtime import _extract_openai_error

    assert _extract_openai_error({}) is None
    assert _extract_openai_error(None) is None
    assert _extract_openai_error({"error": {}}) is None


# ---------------------------------------------------------------------------
# HTTP proof: TestClient sentinel-injection
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.middleware import require_vault_owner_token
    from api.routes.kai.agent_realtime import router as agent_realtime_router

    app = FastAPI()
    app.include_router(agent_realtime_router, prefix="/api/kai")
    app.dependency_overrides[require_vault_owner_token] = lambda: _FAKE_TOKEN_DATA
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _mock_openai_error_response(sentinel: str):
    """Build a mock httpx.Response that simulates an OpenAI 400 error with sentinel."""
    mock_response = MagicMock()
    mock_response.status_code = 400
    mock_response.content = b'{"error": {"message": "' + sentinel.encode() + b'"}}'
    mock_response.json.return_value = {
        "error": {
            "message": f"OpenAI internal error: {sentinel}",
            "code": f"plan_restriction_{sentinel}",
        }
    }
    return mock_response


def test_openai_error_message_not_in_response(client) -> None:
    """
    POST /api/kai/agent/realtime/session with a mocked OpenAI 400 error must not
    return the raw OpenAI error message in the HTTP response body.
    """
    mock_response = _mock_openai_error_response(SENTINEL)

    with (
        patch.dict("os.environ", {"OPENAI_API_KEY": _FAKE_API_KEY}),
        patch("httpx.AsyncClient") as MockClient,
    ):
        mock_http_client = AsyncMock()
        mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
        mock_http_client.__aexit__ = AsyncMock(return_value=False)
        mock_http_client.post = AsyncMock(return_value=mock_response)
        MockClient.return_value = mock_http_client

        resp = client.post(
            "/api/kai/agent/realtime/session",
            json=_REQUEST_BODY,
        )

    assert resp.status_code == 502
    body = resp.text
    assert SENTINEL not in body, (
        f"OpenAI error sentinel leaked into HTTP response: {body}"
    )
    assert resp.json()["detail"] == "Realtime client secret creation failed", (
        f"Expected static opaque message, got: {resp.json().get('detail')}"
    )


def test_openai_error_code_not_in_response(client) -> None:
    """
    OpenAI error.code must not appear in the 502 response body.
    """
    mock_response = MagicMock()
    mock_response.status_code = 403
    mock_response.content = b"{}"
    mock_response.json.return_value = {
        "error": {"code": f"restricted_model_{SENTINEL}"}
    }

    with (
        patch.dict("os.environ", {"OPENAI_API_KEY": _FAKE_API_KEY}),
        patch("httpx.AsyncClient") as MockClient,
    ):
        mock_http_client = AsyncMock()
        mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
        mock_http_client.__aexit__ = AsyncMock(return_value=False)
        mock_http_client.post = AsyncMock(return_value=mock_response)
        MockClient.return_value = mock_http_client

        resp = client.post(
            "/api/kai/agent/realtime/session",
            json=_REQUEST_BODY,
        )

    assert resp.status_code == 502
    assert SENTINEL not in resp.text
