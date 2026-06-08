"""Hermetic tests for pagination bounds on Kai chat history/conversation endpoints.

All tests run without DB, network, or LLM.
Covers that out-of-range limit/offset values are rejected with 422 before any
auth or service call is made.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai.chat import router

# App fixture with auth override

_TOKEN_STUB = {"user_id": "user_abc"}


async def _stub_auth() -> dict:
    return _TOKEN_STUB


app = FastAPI()
app.include_router(router, prefix="/api")
app.dependency_overrides[require_vault_owner_token] = _stub_auth
client = TestClient(app, raise_server_exceptions=False)


def _patch_history_service(messages=None):
    svc = MagicMock()
    svc.get_conversation_history = AsyncMock(return_value=messages or [])
    db = MagicMock()
    conv = MagicMock()
    conv.user_id = "user_abc"
    db.get_conversation = AsyncMock(return_value=conv)
    svc.chat_db = db
    return patch("api.routes.kai.chat.get_kai_chat_service", return_value=svc)


def _patch_conv_service(conversations=None):
    svc = MagicMock()
    svc.chat_db = MagicMock()
    svc.chat_db.list_conversations = AsyncMock(return_value=conversations or [])
    return patch("api.routes.kai.chat.get_kai_chat_service", return_value=svc)


# /chat/history/{conversation_id} - limit bounds


class TestHistoryLimitBounds:
    def test_default_limit_returns_200(self):
        with _patch_history_service():
            resp = client.get("/api/chat/history/conv_abc")
        assert resp.status_code == 200

    def test_limit_1_is_valid(self):
        with _patch_history_service():
            resp = client.get("/api/chat/history/conv_abc?limit=1")
        assert resp.status_code == 200

    def test_limit_500_is_valid(self):
        with _patch_history_service():
            resp = client.get("/api/chat/history/conv_abc?limit=500")
        assert resp.status_code == 200

    def test_limit_0_returns_422(self):
        resp = client.get("/api/chat/history/conv_abc?limit=0")
        assert resp.status_code == 422

    def test_limit_negative_returns_422(self):
        resp = client.get("/api/chat/history/conv_abc?limit=-1")
        assert resp.status_code == 422

    def test_limit_501_returns_422(self):
        resp = client.get("/api/chat/history/conv_abc?limit=501")
        assert resp.status_code == 422

    def test_limit_9999_returns_422(self):
        resp = client.get("/api/chat/history/conv_abc?limit=9999")
        assert resp.status_code == 422

    def test_limit_non_integer_returns_422(self):
        resp = client.get("/api/chat/history/conv_abc?limit=abc")
        assert resp.status_code == 422


# /chat/conversations/{user_id} - limit and offset bounds


class TestConversationLimitBounds:
    def test_default_params_return_200(self):
        with _patch_conv_service():
            resp = client.get("/api/chat/conversations/user_abc")
        assert resp.status_code == 200

    def test_limit_1_is_valid(self):
        with _patch_conv_service():
            resp = client.get("/api/chat/conversations/user_abc?limit=1")
        assert resp.status_code == 200

    def test_limit_200_is_valid(self):
        with _patch_conv_service():
            resp = client.get("/api/chat/conversations/user_abc?limit=200")
        assert resp.status_code == 200

    def test_limit_0_returns_422(self):
        resp = client.get("/api/chat/conversations/user_abc?limit=0")
        assert resp.status_code == 422

    def test_limit_negative_returns_422(self):
        resp = client.get("/api/chat/conversations/user_abc?limit=-5")
        assert resp.status_code == 422

    def test_limit_201_returns_422(self):
        resp = client.get("/api/chat/conversations/user_abc?limit=201")
        assert resp.status_code == 422

    def test_limit_10000_returns_422(self):
        resp = client.get("/api/chat/conversations/user_abc?limit=10000")
        assert resp.status_code == 422


class TestConversationOffsetBounds:
    def test_offset_0_is_valid(self):
        with _patch_conv_service():
            resp = client.get("/api/chat/conversations/user_abc?offset=0")
        assert resp.status_code == 200

    def test_offset_large_positive_is_valid(self):
        with _patch_conv_service():
            resp = client.get("/api/chat/conversations/user_abc?offset=99999")
        assert resp.status_code == 200

    def test_offset_negative_returns_422(self):
        resp = client.get("/api/chat/conversations/user_abc?offset=-1")
        assert resp.status_code == 422

    def test_both_out_of_range_returns_422(self):
        resp = client.get("/api/chat/conversations/user_abc?limit=0&offset=-1")
        assert resp.status_code == 422
