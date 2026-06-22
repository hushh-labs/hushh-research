from __future__ import annotations

from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import agents


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(agents.router)
    return app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_VALID_CHAT_PAYLOAD = {
    "userId": "user_abc123",
    "message": "Analyze AAPL for me",
    "sessionState": None,
}

_LEAKED_ERROR_TEXT = (
    "projects/my-gcp-project/locations/us-central1/publishers/google/models/gemini-2.0-flash"  # noqa: S105
)


# ---------------------------------------------------------------------------
# Security: exception detail must NOT leak into the response
# ---------------------------------------------------------------------------


def test_kai_chat_does_not_expose_exception_detail_on_error(monkeypatch):
    """
    When get_kai_agent().handle_message raises, the HTTP 500 detail must be a
    fixed generic string — never str(e), which can contain internal secrets.
    """

    def _raise(*args, **kwargs):
        raise RuntimeError(_LEAKED_ERROR_TEXT)

    mock_agent = MagicMock()
    mock_agent.handle_message.side_effect = _raise

    with patch("api.routes.agents.get_kai_agent", return_value=mock_agent):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.post("/api/agents/kai/chat", json=_VALID_CHAT_PAYLOAD)

    assert response.status_code == 500

    body = response.text
    # The internal error string must not appear anywhere in the response body.
    assert _LEAKED_ERROR_TEXT not in body, (
        f"Internal exception detail leaked into HTTP response: {body!r}"
    )


def test_kai_chat_returns_generic_detail_on_error(monkeypatch):
    """The fixed detail string must be the expected generic message."""

    def _raise(*args, **kwargs):
        raise ValueError("db column 'user_vault_keys' does not exist")

    mock_agent = MagicMock()
    mock_agent.handle_message.side_effect = _raise

    with patch("api.routes.agents.get_kai_agent", return_value=mock_agent):
        client = TestClient(_build_app(), raise_server_exceptions=False)
        response = client.post("/api/agents/kai/chat", json=_VALID_CHAT_PAYLOAD)

    assert response.status_code == 500
    assert response.json()["detail"] == "Internal error processing chat"


def test_kai_chat_returns_200_on_success(monkeypatch):
    """Happy path: a successful agent call returns 200 with the response."""

    mock_agent = MagicMock()
    mock_agent.handle_message.return_value = {
        "response": "AAPL looks strong.",
        "is_complete": True,
    }

    with patch("api.routes.agents.get_kai_agent", return_value=mock_agent):
        client = TestClient(_build_app())
        response = client.post("/api/agents/kai/chat", json=_VALID_CHAT_PAYLOAD)

    assert response.status_code == 200
    payload = response.json()
    assert payload["response"] == "AAPL looks strong."
    assert payload["isComplete"] is True
