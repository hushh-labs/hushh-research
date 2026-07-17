"""
Regression tests: agent chat path parameters must be bounded.

CWE-400 - Uncontrolled Resource Consumption.

Four GET/PATCH/DELETE routes in api/routes/kai/agent_chat.py accepted bare
string path parameters with no length constraint:

    GET    /api/kai/agent/chat/conversations/{user_id}
    PATCH  /api/kai/agent/chat/conversations/{conversation_id}
    DELETE /api/kai/agent/chat/conversations/{conversation_id}
    GET    /api/kai/agent/chat/history/{conversation_id}

An arbitrarily long string (e.g. 10,000 characters) passed as a path segment
propagates into DB lookups and service calls without any HTTP-layer rejection.
This can cause excessive memory allocation and processing work before any auth
check short-circuits it.

Fix: annotate all four path parameters with Path(min_length=1, max_length=128)
using the _UserId and _ConversationId aliases defined at module level.

Attach points:
  list_agent_chat_conversations  -> GET  /api/kai/agent/chat/conversations/{user_id}
  rename_agent_chat_conversation -> PATCH /api/kai/agent/chat/conversations/{conversation_id}
  delete_agent_chat_conversation -> DELETE /api/kai/agent/chat/conversations/{conversation_id}
  get_agent_chat_history         -> GET  /api/kai/agent/chat/history/{conversation_id}
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

_FAKE_TOKEN_DATA = {
    "user_id": "test-agent-chat-user",
    "token_type": "VAULT_OWNER",
    "scope": "vault.owner",
}

_TOO_LONG = "x" * 129
_VALID_ID = "valid-agent-chat-id-1"


@pytest.fixture(scope="module")
def client():
    from api.middleware import require_vault_owner_token
    from server import app

    app.dependency_overrides[require_vault_owner_token] = lambda: _FAKE_TOKEN_DATA
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        app.dependency_overrides.pop(require_vault_owner_token, None)


def test_list_conversations_rejects_oversized_user_id(client) -> None:
    """GET /conversations/{user_id} with a 129-char user_id must return 422."""
    resp = client.get(f"/api/kai/agent/chat/conversations/{_TOO_LONG}")
    assert resp.status_code == 422, (
        f"Expected 422 for oversized user_id, got {resp.status_code}"
    )


def test_list_conversations_accepts_128_char_user_id(client) -> None:
    """GET /conversations/{user_id} with a 128-char user_id must not be rejected."""
    boundary = "a" * 128
    resp = client.get(f"/api/kai/agent/chat/conversations/{boundary}")
    # 422 would mean the bounds check rejected it; any other status is OK here
    assert resp.status_code != 422, (
        "128-char user_id incorrectly rejected with 422"
    )


def test_rename_conversation_rejects_oversized_conversation_id(client) -> None:
    """PATCH /conversations/{conversation_id} with a 129-char id must return 422."""
    resp = client.patch(
        f"/api/kai/agent/chat/conversations/{_TOO_LONG}",
        json={"title": "New title"},
    )
    assert resp.status_code == 422, (
        f"Expected 422 for oversized conversation_id, got {resp.status_code}"
    )


def test_delete_conversation_rejects_oversized_conversation_id(client) -> None:
    """DELETE /conversations/{conversation_id} with a 129-char id must return 422."""
    resp = client.delete(f"/api/kai/agent/chat/conversations/{_TOO_LONG}")
    assert resp.status_code == 422, (
        f"Expected 422 for oversized conversation_id, got {resp.status_code}"
    )


def test_get_history_rejects_oversized_conversation_id(client) -> None:
    """GET /history/{conversation_id} with a 129-char id must return 422."""
    resp = client.get(f"/api/kai/agent/chat/history/{_TOO_LONG}")
    assert resp.status_code == 422, (
        f"Expected 422 for oversized conversation_id, got {resp.status_code}"
    )


def test_get_history_accepts_128_char_conversation_id(client) -> None:
    """GET /history/{conversation_id} with a 128-char id must not be rejected at bounds."""
    boundary = "b" * 128
    resp = client.get(f"/api/kai/agent/chat/history/{boundary}")
    assert resp.status_code != 422, (
        "128-char conversation_id incorrectly rejected with 422"
    )
