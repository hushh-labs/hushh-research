"""
TestClient HTTP proof for path-param bounds on Kai chat GET routes.

Canonical attach points
------------------------
api.routes.kai.chat.get_conversation_history -> GET /chat/history/{conversation_id}
api.routes.kai.chat.list_user_conversations  -> GET /chat/conversations/{user_id}
api.routes.kai.chat.get_initial_chat_state   -> GET /chat/initial-state/{user_id}

Before this fix, get_initial_chat_state took a bare `user_id: str` path
param with no size constraint, and get_conversation_history's
conversation_id Path had max_length but no min_length. Oversized or empty
path segments would reach the service/DB layer unbounded.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.kai.chat as chat_mod
from api.middleware import require_vault_owner_token

VALID_UID = "test-uid"
_TOKEN_DATA = {"user_id": VALID_UID, "token": "fake-token", "scope": "vault.owner"}


def make_client() -> TestClient:
    app = FastAPI()
    app.include_router(chat_mod.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN_DATA
    return TestClient(app, raise_server_exceptions=False)


def test_conversation_history_oversized_conversation_id_rejected() -> None:
    client = make_client()
    resp = client.get(f"/chat/history/{'c' * 129}")
    assert resp.status_code == 422


def test_list_conversations_oversized_user_id_rejected() -> None:
    client = make_client()
    resp = client.get(f"/chat/conversations/{'u' * 129}")
    assert resp.status_code == 422


def test_initial_state_oversized_user_id_rejected() -> None:
    client = make_client()
    resp = client.get(f"/chat/initial-state/{'u' * 129}")
    assert resp.status_code == 422
