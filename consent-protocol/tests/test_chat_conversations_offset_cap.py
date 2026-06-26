# tests/test_chat_conversations_offset_cap.py
"""
PR attach point: GET /chat/conversations/{user_id}  (api/routes/kai/chat.py)

Verifies:
1. offset > 10_000 is rejected with 422 (unbounded offset is a DB-scan DOS vector)
2. user_id longer than 128 chars is rejected with 422 (unbounded path param)
3. limit < 1 is rejected with 422
4. Valid request with offset at cap boundary (10_000) returns 200
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.kai import kai_router

_UID = "test-uid"
_TOKEN = {"user_id": _UID, "token": "fake-token", "scope": "vault.owner"}


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(kai_router)

    app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN

    mock_service = MagicMock()
    mock_service.chat_db = MagicMock()
    mock_service.chat_db.list_conversations = AsyncMock(return_value=[])

    with patch(
        "api.routes.kai.chat.get_kai_chat_service",
        return_value=mock_service,
    ):
        yield TestClient(app, raise_server_exceptions=False)

    app.dependency_overrides.clear()


def test_offset_over_cap_rejected(client: TestClient) -> None:
    """offset=10_001 must be rejected with 422 Unprocessable Entity."""
    resp = client.get(f"/api/kai/chat/conversations/{_UID}?offset=10001")
    assert resp.status_code == 422, resp.text


def test_offset_at_cap_accepted(client: TestClient) -> None:
    """offset=10_000 is exactly at the cap and must succeed."""
    resp = client.get(f"/api/kai/chat/conversations/{_UID}?offset=10000")
    assert resp.status_code == 200, resp.text


def test_negative_offset_rejected(client: TestClient) -> None:
    """offset=-1 must be rejected with 422."""
    resp = client.get(f"/api/kai/chat/conversations/{_UID}?offset=-1")
    assert resp.status_code == 422, resp.text


def test_user_id_too_long_rejected(client: TestClient) -> None:
    """user_id > 128 chars must be rejected with 422."""
    long_uid = "x" * 129
    resp = client.get(f"/api/kai/chat/conversations/{long_uid}")
    assert resp.status_code == 422, resp.text


def test_limit_zero_rejected(client: TestClient) -> None:
    """limit=0 violates ge=1 and must be rejected with 422."""
    resp = client.get(f"/api/kai/chat/conversations/{_UID}?limit=0")
    assert resp.status_code == 422, resp.text


def test_valid_request_returns_200(client: TestClient) -> None:
    """Baseline: valid params return 200 with conversations list."""
    resp = client.get(f"/api/kai/chat/conversations/{_UID}?limit=20&offset=0")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "conversations" in body
    assert body["user_id"] == _UID
