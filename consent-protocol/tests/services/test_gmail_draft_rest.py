"""Gmail drafts use the GA REST API (Workspace MCP preview is not enrolled)."""

from __future__ import annotations

import base64
import email
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hushh_mcp.services import gmail_delivery_service as delivery
from hushh_mcp.services.gmail_receipts_service import GmailApiError


def _draft():
    return {"to": ["friend@example.com"], "subject": "Hello", "body": "Plain body"}


class _Client:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self.calls.append((url, headers, json))
        return self.response


def _response(status: int, payload):
    response = MagicMock()
    response.status_code = status
    response.content = b"x" if payload is not None else b""
    response.json = MagicMock(return_value=payload)
    return response


@pytest.mark.asyncio
async def test_draft_posts_raw_message_to_rest_drafts_and_returns_only_the_id():
    connections = MagicMock()
    connections.get_compose_access_token = AsyncMock(return_value="compose-token")
    client = _Client(_response(200, {"id": "r-123", "message": {"id": "m", "threadId": "t"}}))
    with patch.object(delivery.httpx, "AsyncClient", return_value=client):
        result = await delivery.create_reviewed_gmail_draft(
            user_id="owner", draft_payload=_draft(), connections=connections
        )
    assert result == {"status": "saved", "draft_id": "r-123"}
    url, headers, body = client.calls[0]
    assert url == "https://gmail.googleapis.com/gmail/v1/users/me/drafts"
    assert headers == {"Authorization": "Bearer compose-token"}
    parsed = email.message_from_bytes(base64.urlsafe_b64decode(body["message"]["raw"]))
    assert parsed["To"] == "friend@example.com" and parsed["Subject"] == "Hello"
    connections.get_compose_access_token.assert_awaited_once_with(user_id="owner")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "payload", "code"),
    [(403, {}, 403), (500, {}, 502), (200, {}, 502), (200, {"id": ""}, 502)],
)
async def test_draft_failures_never_claim_success(status, payload, code):
    connections = MagicMock()
    connections.get_compose_access_token = AsyncMock(return_value="compose-token")
    with patch.object(
        delivery.httpx, "AsyncClient", return_value=_Client(_response(status, payload))
    ):
        with pytest.raises(GmailApiError) as caught:
            await delivery.create_reviewed_gmail_draft(
                user_id="owner", draft_payload=_draft(), connections=connections
            )
    assert caught.value.status_code == code
