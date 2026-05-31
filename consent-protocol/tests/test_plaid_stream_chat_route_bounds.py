"""
Route-level bounds proof for the Plaid, stream-analyze, and chat surfaces.

The Pydantic-only tests in test_plaid_stream_chat_request_bounds.py confirm
model validation in isolation. These tests exercise each touched KAI route
through FastAPI's TestClient, proving two things per surface:

  1. Oversized payloads are rejected with 422 before business logic runs.
  2. Properly bounded payloads reach the auth layer (not a 422), confirming
     the existing caller contract is intact.

Stream and the two canonical Plaid connection endpoints resolve auth inside
the handler body (authorization: str | None = Header(None)), so FastAPI
validates the request body before any auth logic executes. Chat uses
Depends(require_vault_owner_token); the dependency is overridden here so
body validation runs without a real auth call.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_PROTO_ROOT = Path(__file__).resolve().parents[1]


def _load_router(rel_path: str, module_name: str):
    path = _PROTO_ROOT / rel_path
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Stream  (POST /analyze/stream)
# Auth is resolved inside the handler body via _require_vault_owner_token(),
# not as a FastAPI Depends, so the body is validated before any auth call.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def stream_client():
    mod = _load_router("api/routes/kai/stream.py", "api.routes.kai.stream")
    app = FastAPI()
    app.include_router(mod.router)
    return TestClient(app, raise_server_exceptions=False)


class TestStreamRouteOversizedPayload:
    def test_oversized_user_id_rejected(self, stream_client):
        resp = stream_client.post(
            "/analyze/stream",
            json={"user_id": "u" * 129, "ticker": "AAPL"},
        )
        assert resp.status_code == 422

    def test_oversized_ticker_rejected(self, stream_client):
        resp = stream_client.post(
            "/analyze/stream",
            json={"user_id": "u1", "ticker": "A" * 21},
        )
        assert resp.status_code == 422

    def test_oversized_risk_profile_rejected(self, stream_client):
        resp = stream_client.post(
            "/analyze/stream",
            json={"user_id": "u1", "ticker": "AAPL", "risk_profile": "r" * 65},
        )
        assert resp.status_code == 422

    def test_oversized_run_id_rejected(self, stream_client):
        resp = stream_client.post(
            "/analyze/stream",
            json={"user_id": "u1", "ticker": "AAPL", "run_id": "r" * 129},
        )
        assert resp.status_code == 422


class TestStreamRouteValidCallerShape:
    def test_valid_body_reaches_auth_layer(self, stream_client):
        resp = stream_client.post(
            "/analyze/stream",
            json={"user_id": "u1", "ticker": "AAPL"},
        )
        assert resp.status_code != 422, (
            f"Valid body must not fail body validation. Got {resp.status_code}: {resp.text[:200]}"
        )

    def test_valid_body_with_optional_fields_reaches_auth_layer(self, stream_client):
        resp = stream_client.post(
            "/analyze/stream",
            json={
                "user_id": "u1",
                "ticker": "AAPL",
                "risk_profile": "aggressive",
                "resume_cursor": 0,
            },
        )
        assert resp.status_code != 422, (
            f"Valid body with optional fields must not fail body validation. "
            f"Got {resp.status_code}: {resp.text[:200]}"
        )


# ---------------------------------------------------------------------------
# Plaid  (POST /plaid/link-token and POST /plaid/exchange-public-token)
# Both endpoints resolve auth inside the handler body (Header, not Depends),
# so the request body is validated by FastAPI before _resolve_plaid_connection_user
# is called.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def plaid_client():
    mod = _load_router("api/routes/kai/plaid.py", "api.routes.kai.plaid")
    app = FastAPI()
    app.include_router(mod.router)
    return TestClient(app, raise_server_exceptions=False)


class TestPlaidRouteOversizedPayload:
    def test_link_token_oversized_user_id_rejected(self, plaid_client):
        resp = plaid_client.post(
            "/plaid/link-token",
            json={"user_id": "u" * 129},
        )
        assert resp.status_code == 422

    def test_link_token_oversized_redirect_uri_rejected(self, plaid_client):
        resp = plaid_client.post(
            "/plaid/link-token",
            json={"user_id": "u1", "redirect_uri": "h" * 2049},
        )
        assert resp.status_code == 422

    def test_exchange_token_oversized_user_id_rejected(self, plaid_client):
        resp = plaid_client.post(
            "/plaid/exchange-public-token",
            json={"user_id": "u" * 129, "public_token": "tok"},
        )
        assert resp.status_code == 422

    def test_exchange_token_oversized_public_token_rejected(self, plaid_client):
        resp = plaid_client.post(
            "/plaid/exchange-public-token",
            json={"user_id": "u1", "public_token": "t" * 513},
        )
        assert resp.status_code == 422


class TestPlaidRouteValidCallerShape:
    def test_valid_link_token_body_not_422(self, plaid_client):
        resp = plaid_client.post(
            "/plaid/link-token",
            json={"user_id": "u1"},
        )
        assert resp.status_code != 422, (
            f"Valid link-token body must not fail body validation. "
            f"Got {resp.status_code}: {resp.text[:200]}"
        )

    def test_valid_exchange_token_body_not_422(self, plaid_client):
        resp = plaid_client.post(
            "/plaid/exchange-public-token",
            json={"user_id": "u1", "public_token": "public-sandbox-token"},
        )
        assert resp.status_code != 422, (
            f"Valid exchange-public-token body must not fail body validation. "
            f"Got {resp.status_code}: {resp.text[:200]}"
        )


# ---------------------------------------------------------------------------
# Chat  (POST /chat)
# Uses Depends(require_vault_owner_token). The dependency is overridden so
# FastAPI validates the request body without making a real auth call.
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def chat_client():
    mod = _load_router("api/routes/kai/chat.py", "api.routes.kai.chat")
    from api.middleware import require_vault_owner_token

    app = FastAPI()
    app.include_router(mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "u1"}
    return TestClient(app, raise_server_exceptions=False)


class TestChatRouteOversizedPayload:
    def test_oversized_user_id_rejected(self, chat_client):
        resp = chat_client.post(
            "/chat",
            json={"user_id": "u" * 129, "message": "hello"},
        )
        assert resp.status_code == 422

    def test_empty_user_id_rejected(self, chat_client):
        resp = chat_client.post(
            "/chat",
            json={"user_id": "", "message": "hello"},
        )
        assert resp.status_code == 422

    def test_oversized_message_rejected(self, chat_client):
        resp = chat_client.post(
            "/chat",
            json={"user_id": "u1", "message": "m" * 4001},
        )
        assert resp.status_code == 422

    def test_empty_message_rejected(self, chat_client):
        resp = chat_client.post(
            "/chat",
            json={"user_id": "u1", "message": ""},
        )
        assert resp.status_code == 422

    def test_oversized_conversation_id_rejected(self, chat_client):
        resp = chat_client.post(
            "/chat",
            json={"user_id": "u1", "message": "hello", "conversation_id": "c" * 129},
        )
        assert resp.status_code == 422


class TestChatRouteValidCallerShape:
    def test_valid_chat_body_not_422(self, chat_client):
        resp = chat_client.post(
            "/chat",
            json={"user_id": "u1", "message": "Hello Kai"},
        )
        assert resp.status_code != 422, (
            f"Valid chat body must not fail body validation. "
            f"Got {resp.status_code}: {resp.text[:200]}"
        )

    def test_valid_chat_body_with_conversation_id_not_422(self, chat_client):
        resp = chat_client.post(
            "/chat",
            json={"user_id": "u1", "message": "Hello", "conversation_id": "conv-123"},
        )
        assert resp.status_code != 422, (
            f"Valid chat body with conversation_id must not fail body validation. "
            f"Got {resp.status_code}: {resp.text[:200]}"
        )
