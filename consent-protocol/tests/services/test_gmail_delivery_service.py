from __future__ import annotations

import base64
from dataclasses import dataclass
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services.gmail_delivery_service import (
    _EMAIL_AGENT_INTRO_BODY,
    GmailDeliveryError,
    GmailDeliveryService,
    _is_email_agent_intro_instruction,
    _message_for,
    normalize_draft,
)


def _envelope() -> dict[str, object]:
    return {
        "to": ["recipient@example.com"],
        "cc": [],
        "bcc": [],
        "subject": "Hello",
        "body": "Message",
    }


def test_normalized_delivery_envelope_rejects_header_injection_and_deduplicates():
    draft = normalize_draft(
        {
            "to": ["Owner <OWNER@example.com>"],
            "cc": ["owner@example.com", "cc@example.com"],
            "bcc": ["cc@example.com", "bcc@example.com"],
            "subject": "A subject",
            "body": "A body",
        }
    )

    assert draft.to == ("owner@example.com",)
    assert draft.cc == ("cc@example.com",)
    assert draft.bcc == ("bcc@example.com",)
    assert "From:" not in _message_for(draft).as_string()

    with pytest.raises(GmailDeliveryError, match="Subject cannot contain newlines"):
        normalize_draft(
            {"to": ["to@example.com"], "subject": "safe\r\nBcc: x@example.com", "body": ""}
        )


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _Pool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        return self

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _PrepareConn:
    def __init__(self):
        self.calls = []

    def transaction(self):
        return _Transaction()

    async def execute(self, query, *args):
        self.calls.append((query, args))

    async def fetchrow(self, query, *args):
        self.calls.append((query, args))
        return None


class _ActionConn(_PrepareConn):
    def __init__(self, rows):
        super().__init__()
        self.rows = list(rows)

    async def fetchrow(self, query, *args):
        self.calls.append((query, args))
        return self.rows.pop(0) if self.rows else None


@dataclass
class _Gmail:
    ready_calls: int = 0

    async def assert_send_ready(self, *, user_id):
        self.ready_calls += 1


@pytest.mark.asyncio
async def test_prepare_persists_only_hmac_metadata(monkeypatch):
    from hushh_mcp.services import gmail_delivery_service as module

    gmail = _Gmail()
    service = GmailDeliveryService(gmail_service=gmail)
    conn = _PrepareConn()
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    monkeypatch.setattr(
        module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    raw_email = "recipient@example.com"
    raw_subject = "private subject"
    raw_body = "private body"
    raw_html = "<p><strong>private body</strong></p>"

    result = await service.prepare(
        user_id="owner",
        draft_payload={
            "to": [raw_email],
            "cc": [],
            "bcc": [],
            "subject": raw_subject,
            "body": raw_body,
            "html_body": raw_html,
        },
        idempotency_key="client-request-id-123",
    )

    assert result["state"] == "prepared"
    persisted_values = repr(conn.calls)
    assert raw_email not in persisted_values
    assert raw_subject not in persisted_values
    assert raw_body not in persisted_values
    assert raw_html not in persisted_values
    assert gmail.ready_calls == 1


def test_delivery_migration_has_metadata_only_contract():
    from pathlib import Path

    migration = Path(__file__).parents[2] / "db/migrations/173_gmail_owner_approved_delivery.sql"
    content = migration.read_text()
    assert "envelope_hmac" in content
    assert "idempotency_hmac" in content
    assert "recipient_count" in content
    assert "subject TEXT" not in content
    assert "body TEXT" not in content
    assert "recipient TEXT" not in content


def test_rich_email_html_is_sanitized_and_sent_as_multipart_alternative():
    draft = normalize_draft(
        {
            **_envelope(),
            "html_body": (
                "<h2>Welcome</h2><p><strong>Hello</strong> <em>there</em> "
                '<a href="https://example.com">Learn more</a></p>'
                '<blockquote>Remember this</blockquote><p style="text-align:center">Centered</p>'
                '<script>do-not-keep</script><img src=x onerror="bad()">'
                '<a href="javascript:bad()">unsafe</a>'
            ),
        }
    )

    assert draft.html_body == (
        "<h2>Welcome</h2><p><strong>Hello</strong> <em>there</em> "
        '<a href="https://example.com">Learn more</a></p>'
        '<blockquote>Remember this</blockquote><p style="text-align:center">Centered</p><a>unsafe</a>'
    )
    rendered = _message_for(draft)
    assert rendered.get_content_type() == "multipart/alternative"
    assert rendered.get_body(preferencelist=("plain",)).get_content().strip() == "Message"
    assert rendered.get_body(preferencelist=("html",)).get_content().strip() == draft.html_body


def test_delivery_keeps_only_the_reviewed_email_block_styles():
    draft = normalize_draft(
        {
            **_envelope(),
            "html_body": (
                '<h2 style="margin: 0 0 14px; font-size: 20px; line-height: 1.3">Welcome</h2>'
                '<ul style="margin:0 0 16px;padding-left:24px"><li style="margin:0 0 8px">First</li></ul>'
                '<p style="margin:0 0 16px;line-height:1.6;text-align:center">Centered</p>'
                '<p style="color:red">discarded style</p>'
            ),
        }
    )

    assert draft.html_body == (
        '<h2 style="margin:0 0 14px;font-size:20px;line-height:1.3">Welcome</h2>'
        '<ul style="margin:0 0 16px;padding-left:24px"><li style="margin:0 0 8px">First</li></ul>'
        '<p style="margin:0 0 16px;line-height:1.6;text-align:center">Centered</p>'
        "<p>discarded style</p>"
    )


def test_email_agent_intro_template_has_real_email_structure():
    assert _is_email_agent_intro_instruction(
        "Can you send an email to 'person@example.com', In the email explain features of the email agent."
    )
    assert not _is_email_agent_intro_instruction("Explain email agent features in a chat reply.")
    assert "\n\n- **Draft polished emails**" in _EMAIL_AGENT_INTRO_BODY
    assert _EMAIL_AGENT_INTRO_BODY.endswith("Best,\nHushh")


def test_html_only_edit_changes_the_reviewed_envelope_hmac(monkeypatch):
    _signing_key(monkeypatch)
    service = GmailDeliveryService(gmail_service=_Gmail())
    base = normalize_draft({**_envelope(), "html_body": "<p>Message</p>"})
    edited = normalize_draft({**_envelope(), "html_body": "<p><strong>Message</strong></p>"})

    assert service._envelope_hmac(base) != service._envelope_hmac(edited)


def _signing_key(monkeypatch):
    from hushh_mcp.services import gmail_delivery_service as module

    monkeypatch.setattr(
        module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    return module


@pytest.mark.asyncio
async def test_prepare_reuses_matching_idempotency_action(monkeypatch):
    module = _signing_key(monkeypatch)
    service = GmailDeliveryService(gmail_service=_Gmail())
    draft = normalize_draft(_envelope())
    envelope_hmac = service._envelope_hmac(draft)
    conn = _ActionConn(
        [
            {
                "action_id": "existing",
                "state": "prepared",
                "expires_at": "later",
                "sent_at": None,
                "envelope_hmac": envelope_hmac,
            }
        ]
    )
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )

    result = await service.prepare(
        user_id="owner", draft_payload=_envelope(), idempotency_key="x" * 16
    )

    assert result["action_id"] == "existing"
    assert not any("INSERT INTO gmail_owner_send_actions" in query for query, _ in conn.calls)


@pytest.mark.asyncio
async def test_execute_rejects_edited_draft_before_provider_call(monkeypatch):
    module = _signing_key(monkeypatch)
    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock()
    service = GmailDeliveryService(gmail_service=gmail)
    conn = _ActionConn(
        [
            {
                "action_id": "action",
                "state": "prepared",
                "expires_at": "later",
                "sent_at": None,
                "envelope_hmac": "wrong",
            }
        ]
    )
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )

    with pytest.raises(GmailDeliveryError, match="draft changed") as exc_info:
        await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert exc_info.value.code == "DRAFT_CHANGED"
    gmail.get_send_access_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_is_single_use_after_sent_action(monkeypatch):
    module = _signing_key(monkeypatch)
    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock()
    service = GmailDeliveryService(gmail_service=gmail)
    envelope_hmac = service._envelope_hmac(normalize_draft(_envelope()))
    conn = _ActionConn(
        [
            {
                "action_id": "action",
                "state": "sent",
                "expires_at": "later",
                "sent_at": "now",
                "envelope_hmac": envelope_hmac,
            }
        ]
    )
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )

    result = await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert result["state"] == "sent"
    gmail.get_send_access_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_execute_expired_action_cannot_transition_to_sending(monkeypatch):
    module = _signing_key(monkeypatch)
    service = GmailDeliveryService(gmail_service=_Gmail())
    envelope_hmac = service._envelope_hmac(normalize_draft(_envelope()))
    conn = _ActionConn(
        [
            {
                "action_id": "action",
                "state": "expired",
                "expires_at": "past",
                "sent_at": None,
                "envelope_hmac": envelope_hmac,
            }
        ]
    )
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )

    with pytest.raises(GmailDeliveryError) as exc_info:
        await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert exc_info.value.code == "ACTION_NOT_SENDABLE"
    assert not any("SET state = 'sending'" in query for query, _ in conn.calls)


@pytest.mark.asyncio
async def test_execute_sends_rfc_message_as_gmail_me_without_a_from_header(monkeypatch):
    module = _signing_key(monkeypatch)
    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock(return_value="canonical-connector-token")
    service = GmailDeliveryService(gmail_service=gmail)
    draft = normalize_draft(_envelope())
    envelope_hmac = service._envelope_hmac(draft)
    conn = _ActionConn(
        [
            {
                "action_id": "action",
                "state": "prepared",
                "expires_at": "later",
                "sent_at": None,
                "envelope_hmac": envelope_hmac,
            },
            {"action_id": "action", "state": "sending", "expires_at": "later", "sent_at": None},
        ]
    )
    calls: list[tuple[str, dict[str, object]]] = []

    class _Response:
        status_code = 200
        content = b'{"id":"gmail-message-1","threadId":"gmail-thread-1"}'

        @staticmethod
        def json():
            return {"id": "gmail-message-1", "threadId": "gmail-thread-1"}

    class _Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, *, headers, json):
            calls.append((url, {"headers": headers, "json": json}))
            return _Response()

    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    monkeypatch.setattr(module.httpx, "AsyncClient", _Client)

    result = await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert result == {"action_id": "action", "state": "sent", "outcome_unknown": False}
    gmail.get_send_access_token.assert_awaited_once_with(user_id="owner")
    assert calls[0][0].endswith("/users/me/messages/send")
    assert calls[0][1]["headers"] == {"Authorization": "Bearer canonical-connector-token"}
    rendered = base64.urlsafe_b64decode(str(calls[0][1]["json"]["raw"]).encode("ascii")).decode(
        "utf-8"
    )
    assert "To: recipient@example.com" in rendered
    assert "From:" not in rendered


@pytest.mark.asyncio
async def test_provider_timeout_becomes_outcome_unknown_without_retry(monkeypatch):
    module = _signing_key(monkeypatch)

    class _TimeoutClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            raise httpx.TimeoutException("timeout")

    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock(return_value="token")
    service = GmailDeliveryService(gmail_service=gmail)
    envelope_hmac = service._envelope_hmac(normalize_draft(_envelope()))
    conn = _ActionConn(
        [
            {
                "action_id": "action",
                "state": "prepared",
                "expires_at": "later",
                "sent_at": None,
                "envelope_hmac": envelope_hmac,
            },
            {"action_id": "action", "state": "sending", "expires_at": "later", "sent_at": None},
        ]
    )
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    monkeypatch.setattr(module.httpx, "AsyncClient", _TimeoutClient)

    result = await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert result == {"action_id": "action", "state": "outcome_unknown", "outcome_unknown": True}
    assert any(
        args[1] == "outcome_unknown"
        for query, args in conn.calls
        if "UPDATE gmail_owner_send_actions" in query and args
    )
