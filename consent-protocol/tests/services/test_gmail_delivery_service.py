from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from email import message_from_bytes
from email.policy import default
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services.gmail_delivery_service import (
    _EMAIL_AGENT_INTRO_BODY,
    GmailDeliveryError,
    GmailDeliveryService,
    GmailReplyContext,
    _is_email_agent_intro_instruction,
    _message_for,
    get_owner_send_action,
    normalize_draft,
)
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.google_drive_blob_attachment_service import (
    DriveBlobDescriptor,
    DriveGrantIdentity,
    GoogleDriveBlobAttachmentService,
    ResolvedDriveBlob,
)


@pytest.fixture(autouse=True)
def shared_placement(monkeypatch):
    from hushh_mcp.services import owner_placement_guard as guard

    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value="shared"))


_BLOB = b"private attachment\n"
_BINDING = "b" * 64
_ACCOUNT_LABEL = "owner@example.com"
_DESCRIPTOR = DriveBlobDescriptor(
    file_id="drive-file-1",
    filename="note.txt",
    mime_type="text/plain",
    size=len(_BLOB),
    revision="revision-1",
    sha256=hashlib.sha256(_BLOB).hexdigest(),
)


def _drive(*, descriptor=_DESCRIPTOR, content=_BLOB, error=None, binding=_BINDING):
    return SimpleNamespace(
        grant_identity=AsyncMock(
            return_value=DriveGrantIdentity(binding=binding, account_label=_ACCOUNT_LABEL)
        ),
        resolve=AsyncMock(
            side_effect=error if error is not None else None,
            return_value=ResolvedDriveBlob(descriptor=descriptor, content=content),
        ),
    )


def _attachment_ref():
    return {"file_id": _DESCRIPTOR.file_id}


def _reviewed_attachment():
    return {
        **asdict(_DESCRIPTOR),
        "grant_binding": _BINDING,
        "source_account_label": _ACCOUNT_LABEL,
    }


def _attachment_token(service):
    return service._seal_attachment(
        user_id="owner",
        action_id="action",
        descriptor=_DESCRIPTOR,
        grant_binding=_BINDING,
        source_account_label=_ACCOUNT_LABEL,
    )


def _prepared_attachment_row(service, *, state="prepared", descriptor=_DESCRIPTOR):
    return {
        "action_id": "action",
        "state": state,
        "expires_at": "later",
        "sent_at": "now" if state == "sent" else None,
        "envelope_hmac": service._envelope_hmac(
            normalize_draft(_envelope()),
            attachment=descriptor,
            owner_user_id="owner",
            grant_binding=_BINDING,
            source_account_label=_ACCOUNT_LABEL,
        ),
    }


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
@pytest.mark.parametrize("environment", ["test", "uat"])
async def test_execute_sends_rfc_message_as_gmail_me_without_a_from_header(
    monkeypatch, environment
):
    monkeypatch.setenv("ENVIRONMENT", environment)
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
    # A fresh compose is never threaded into an existing conversation.
    assert set(calls[0][1]["json"]) == {"raw"}


@pytest.mark.asyncio
async def test_uat_rejects_legacy_drive_attachment_before_provider_or_action(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "uat")
    drive = _drive()
    gmail = _Gmail()
    service = GmailDeliveryService(gmail_service=gmail, drive_blobs=drive)

    with pytest.raises(GmailDeliveryError) as error:
        await service.prepare(
            user_id="owner",
            draft_payload={**_envelope(), "drive_attachment": _attachment_ref()},
            idempotency_key="client-request-id-123",
        )
    assert error.value.code == "DRIVE_ATTACHMENT_UNAVAILABLE"
    drive.grant_identity.assert_not_awaited()
    drive.resolve.assert_not_awaited()


@pytest.mark.asyncio
async def test_uat_rejects_pending_legacy_attachment_send_before_claim(monkeypatch):
    module = _signing_key(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "uat")
    drive = _drive()
    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock(return_value="unused")
    service = GmailDeliveryService(gmail_service=gmail, drive_blobs=drive)
    conn = _ActionConn([_prepared_attachment_row(service)])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )

    with pytest.raises(GmailDeliveryError) as error:
        await service.execute(
            user_id="owner",
            action_id="action",
            draft_payload={**_envelope(), "attachment_token": _attachment_token(service)},
        )
    assert error.value.code == "DRIVE_ATTACHMENT_UNAVAILABLE"
    assert not any("SET state = 'sending'" in query for query, _ in conn.calls)
    drive.grant_identity.assert_not_awaited()
    drive.resolve.assert_not_awaited()
    gmail.get_send_access_token.assert_not_awaited()


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


@pytest.mark.asyncio
async def test_provider_transport_failure_becomes_outcome_unknown_without_retry(monkeypatch):
    module = _signing_key(monkeypatch)

    class _TransportFailureClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            raise httpx.ReadError("connection reset")

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
    monkeypatch.setattr(module.httpx, "AsyncClient", _TransportFailureClient)

    result = await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert result == {"action_id": "action", "state": "outcome_unknown", "outcome_unknown": True}
    assert any(
        args[1] == "outcome_unknown"
        for query, args in conn.calls
        if "UPDATE gmail_owner_send_actions" in query and args
    )


def _status_send_harness(
    monkeypatch,
    status_code: int,
    *,
    later_state: str,
    reply_context: GmailReplyContext | None = None,
    provider_payload: dict[str, object] | None = None,
):
    """One prepared action whose Gmail send POST answers with ``status_code``.

    ``provider_payload`` is the JSON body Gmail answers with, when it has one.
    """
    module = _signing_key(monkeypatch)
    posts: list[object] = []

    class _Response:
        content = b"" if provider_payload is None else b"provider-response"

        def __init__(self):
            self.status_code = status_code

        @staticmethod
        def json():
            return provider_payload

    class _StatusClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, *args, **kwargs):
            posts.append(kwargs.get("json"))
            return _Response()

    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock(return_value="token")
    service = GmailDeliveryService(gmail_service=gmail)
    envelope_hmac = service._envelope_hmac(
        normalize_draft(_envelope()), reply_context=reply_context
    )
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
            # What a second execute of the same action reads after the first.
            {
                "action_id": "action",
                "state": later_state,
                "expires_at": "later",
                "sent_at": None,
                "envelope_hmac": envelope_hmac,
            },
        ]
    )
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    monkeypatch.setattr(module.httpx, "AsyncClient", _StatusClient)
    return service, conn, posts


def _recorded_states(conn) -> list[str]:
    return [
        args[1]
        for query, args in conn.calls
        if "UPDATE gmail_owner_send_actions" in query and "SET state = $2" in query
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [500, 502, 503])
async def test_gmail_5xx_after_send_post_is_outcome_unknown_and_never_resent(
    monkeypatch, status_code
):
    # Gmail may have delivered the message before answering 5xx, so the
    # action must become the non-retryable unknown outcome, not a failure
    # the owner is invited to send again.
    service, conn, posts = _status_send_harness(
        monkeypatch, status_code, later_state="outcome_unknown"
    )

    result = await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert result == {"action_id": "action", "state": "outcome_unknown", "outcome_unknown": True}
    assert _recorded_states(conn) == ["outcome_unknown"]
    assert len(posts) == 1

    with pytest.raises(GmailDeliveryError) as second:
        await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())
    assert second.value.code == "ACTION_NOT_SENDABLE"
    assert len(posts) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [400, 429])
async def test_gmail_4xx_send_rejection_stays_a_definite_failure(monkeypatch, status_code):
    # Negative control: Gmail refused the request, nothing was delivered, and
    # the owner may review the draft and send it again.
    service, conn, posts = _status_send_harness(monkeypatch, status_code, later_state="failed")

    with pytest.raises(GmailDeliveryError) as error:
        await service.execute(user_id="owner", action_id="action", draft_payload=_envelope())

    assert error.value.code == "GMAIL_SEND_FAILED"
    assert _recorded_states(conn) == ["failed"]
    assert len(posts) == 1


_REPLY = GmailReplyContext(
    thread_id="thread-1",
    in_reply_to="<source@example.com>",
    references="<root@example.com> <source@example.com>",
)


def _terminal_writes(conn) -> list[tuple[object, ...]]:
    """(state, safe_error_code, gmail_thread_id) of each terminal ledger write."""
    return [
        (args[1], args[2], args[4])
        for query, args in conn.calls
        if "UPDATE gmail_owner_send_actions" in query and "SET state = $2" in query
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("provider_payload", "state", "safe_error_code"),
    [
        pytest.param(
            {"id": "gmail-message-1", "threadId": "thread-1"}, "sent", None, id="kept-thread"
        ),
        pytest.param(
            {"id": "gmail-message-1", "threadId": "thread-2"},
            "outcome_unknown",
            "reply_thread_mismatch",
            id="other-thread",
        ),
        pytest.param(
            {"id": "gmail-message-1"},
            "outcome_unknown",
            "reply_thread_mismatch",
            id="no-thread",
        ),
    ],
)
async def test_reply_send_is_threaded_and_reported_sent_only_inside_its_thread(
    monkeypatch, provider_payload, state, safe_error_code
):
    service, conn, posts = _status_send_harness(
        monkeypatch,
        200,
        later_state=state,
        reply_context=_REPLY,
        provider_payload=provider_payload,
    )

    result = await service.execute(
        user_id="owner", action_id="action", draft_payload=_envelope(), reply_context=_REPLY
    )

    # Gmail accepted the POST every time. A reply it did not confirm inside the
    # reviewed thread is never "sent", and is not an error inviting a resend.
    assert result == {"action_id": "action", "state": state, "outcome_unknown": state != "sent"}
    assert len(posts) == 1
    assert posts[0]["threadId"] == "thread-1"
    message = message_from_bytes(
        base64.urlsafe_b64decode(posts[0]["raw"].encode("ascii")), policy=default
    )
    assert message["In-Reply-To"] == "<source@example.com>"
    assert message["References"] == "<root@example.com> <source@example.com>"
    # The row the voice relay re-reads: a sent reply names its thread, and an
    # unconfirmed one carries the code it reports as "thread unconfirmed".
    assert _terminal_writes(conn) == [(state, safe_error_code, provider_payload.get("threadId"))]


@pytest.mark.asyncio
async def test_owner_send_action_is_read_only_through_its_owner(monkeypatch):
    from hushh_mcp.services import gmail_delivery_service as module

    row = {
        "state": "sent",
        "created_at": datetime(2026, 10, 5, tzinfo=timezone.utc),
        "gmail_thread_id": "thread-1",
        "safe_error_code": None,
    }
    conn = _ActionConn([row])
    pool_requests: list[None] = []

    async def _get_pool():
        pool_requests.append(None)
        return _Pool(conn)

    monkeypatch.setattr(module, "get_pool", _get_pool)

    assert await get_owner_send_action(user_id="owner", action_id="action") == row
    assert await get_owner_send_action(user_id="owner", action_id="unknown") is None
    for user_id, action_id in (("", "action"), (" ", "action"), ("owner", ""), ("owner", " ")):
        assert await get_owner_send_action(user_id=user_id, action_id=action_id) is None
    # A blank owner or action never reaches the ledger.
    assert len(pool_requests) == 2

    query, args = conn.calls[0]
    assert "WHERE action_id = $1 AND user_id = $2" in " ".join(query.split())
    assert args == ("action", "owner")
    assert conn.calls[1][1] == ("unknown", "owner")
    # What the relay's outcome is decided from: state, freshness, thread, failure code.
    selected = set(re.findall(r"\w+", query.split("FROM")[0]))
    assert {"state", "created_at", "gmail_thread_id", "safe_error_code"} <= selected


@pytest.mark.asyncio
async def test_prepare_binds_server_verified_attachment_without_persisting_bytes(monkeypatch):
    module = _signing_key(monkeypatch)
    drive = _drive()
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=drive)
    conn = _PrepareConn()
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )

    result = await service.prepare(
        user_id="owner",
        draft_payload={**_envelope(), "drive_attachment": _attachment_ref()},
        idempotency_key="client-request-id-123",
    )

    assert result["drive_attachment"] == {
        "filename": "note.txt",
        "mime_type": "text/plain",
        "size": len(_BLOB),
        "source_account_label": _ACCOUNT_LABEL,
        "revision": _DESCRIPTOR.revision,
        "sha256": _DESCRIPTOR.sha256,
    }
    assert result["attachment_token"]
    assert _DESCRIPTOR.file_id not in repr(result)
    assert _BLOB.decode().strip() not in repr(result)
    drive.resolve.assert_awaited_once_with(
        file_id=_DESCRIPTOR.file_id,
        authenticated_owner_user_id="owner",
        expected_revision=None,
        expected_sha256=None,
    )
    persisted = repr(conn.calls)
    assert _BLOB.decode().strip() not in persisted
    assert _DESCRIPTOR.filename not in persisted
    assert _DESCRIPTOR.sha256 not in persisted


@pytest.mark.asyncio
async def test_attachment_metadata_change_breaks_prepare_idempotency(monkeypatch):
    module = _signing_key(monkeypatch)
    original = GmailDeliveryService(gmail_service=_Gmail())
    changed = DriveBlobDescriptor(**{**asdict(_DESCRIPTOR), "filename": "changed.txt"})
    drive = _drive(descriptor=changed)
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=drive)
    conn = _ActionConn([_prepared_attachment_row(original)])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )

    with pytest.raises(GmailDeliveryError) as error:
        await service.prepare(
            user_id="owner",
            draft_payload={**_envelope(), "drive_attachment": _attachment_ref()},
            idempotency_key="client-request-id-123",
        )
    assert error.value.code == "IDEMPOTENCY_PAYLOAD_MISMATCH"
    assert not any("INSERT INTO gmail_owner_send_actions" in query for query, _ in conn.calls)


@pytest.mark.asyncio
async def test_matching_attachment_prepare_reuses_action_and_returns_safe_review(monkeypatch):
    module = _signing_key(monkeypatch)
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=_drive())
    conn = _ActionConn([_prepared_attachment_row(service)])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    result = await service.prepare(
        user_id="owner",
        draft_payload={**_envelope(), "drive_attachment": _attachment_ref()},
        idempotency_key="client-request-id-123",
    )
    assert result["action_id"] == "action"
    assert result["drive_attachment"]["source_account_label"] == _ACCOUNT_LABEL
    assert (
        service._open_attachment(result["attachment_token"], user_id="owner", action_id="action")[0]
        == _DESCRIPTOR
    )
    assert not any("INSERT INTO gmail_owner_send_actions" in query for query, _ in conn.calls)


@pytest.mark.asyncio
async def test_attachment_send_rejects_changed_or_revoked_drive_before_claim(monkeypatch):
    module = _signing_key(monkeypatch)
    for drive in (
        _drive(error=GoogleConnectionError("revoked", status_code=403)),
        _drive(descriptor=DriveBlobDescriptor(**{**asdict(_DESCRIPTOR), "filename": "new.txt"})),
    ):
        service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=drive)
        conn = _ActionConn([_prepared_attachment_row(service)])
        monkeypatch.setattr(
            module, "get_pool", lambda conn=conn: __import__("asyncio").sleep(0, result=_Pool(conn))
        )
        with pytest.raises(GmailDeliveryError) as error:
            await service.execute(
                user_id="owner",
                action_id="action",
                draft_payload={**_envelope(), "attachment_token": _attachment_token(service)},
            )
        assert error.value.code in {"DRIVE_ATTACHMENT_UNAVAILABLE", "DRIVE_ATTACHMENT_CHANGED"}
        assert not any("SET state = 'sending'" in query for query, _ in conn.calls)


@pytest.mark.asyncio
async def test_account_or_grant_swap_blocks_send_before_claim(monkeypatch):
    module = _signing_key(monkeypatch)
    drive = _drive(binding="c" * 64)
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=drive)
    conn = _ActionConn([_prepared_attachment_row(service)])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    with pytest.raises(GmailDeliveryError) as error:
        await service.execute(
            user_id="owner",
            action_id="action",
            draft_payload={**_envelope(), "attachment_token": _attachment_token(service)},
        )
    assert error.value.code == "DRIVE_ATTACHMENT_CHANGED"
    assert not any("SET state = 'sending'" in query for query, _ in conn.calls)


@pytest.mark.asyncio
async def test_grant_swap_during_resolve_is_rejected(monkeypatch):
    module = _signing_key(monkeypatch)
    drive = _drive()
    drive.grant_identity = AsyncMock(
        side_effect=[
            DriveGrantIdentity(binding=_BINDING, account_label=_ACCOUNT_LABEL),
            DriveGrantIdentity(binding="c" * 64, account_label=_ACCOUNT_LABEL),
        ]
    )
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=drive)
    conn = _PrepareConn()
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    with pytest.raises(GmailDeliveryError) as error:
        await service.prepare(
            user_id="owner",
            draft_payload={**_envelope(), "drive_attachment": _attachment_ref()},
            idempotency_key="client-request-id-123",
        )
    assert error.value.code == "DRIVE_ATTACHMENT_CHANGED"
    assert conn.calls == []


@pytest.mark.asyncio
async def test_binding_tracks_account_and_grant_generation_without_exposing_identity(monkeypatch):
    from hushh_mcp.services import google_drive_blob_attachment_service as blob_module

    monkeypatch.setattr(
        blob_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    row = {
        "provider_subject": "private-google-subject",
        "provider_email": _ACCOUNT_LABEL,
        "refresh_token_ciphertext": "private-ciphertext",
        "connection_status": "connected",
        "grant_status": "connected",
        "scope_csv": "https://www.googleapis.com/auth/drive.readonly",
        "grant_updated_at": "2026-09-23T12:00:00Z",
    }
    connections = SimpleNamespace(
        _execute_raw_async=AsyncMock(return_value=SimpleNamespace(data=[row]))
    )
    resolver = GoogleDriveBlobAttachmentService(connections=connections)
    first = await resolver.grant_binding(authenticated_owner_user_id="owner")
    assert len(first) == 64
    assert row["provider_subject"] not in first
    identity = await resolver.grant_identity(authenticated_owner_user_id="owner")
    assert identity.account_label == _ACCOUNT_LABEL
    connections._execute_raw_async.return_value = SimpleNamespace(
        data=[{**row, "provider_subject": "another-google-subject"}]
    )
    assert await resolver.grant_binding(authenticated_owner_user_id="owner") != first
    connections._execute_raw_async.return_value = SimpleNamespace(
        data=[{**row, "grant_updated_at": "2026-09-23T12:01:00Z"}]
    )
    assert await resolver.grant_binding(authenticated_owner_user_id="owner") != first
    connections._execute_raw_async.return_value = SimpleNamespace(
        data=[{**row, "grant_status": "disconnected"}]
    )
    with pytest.raises(GoogleConnectionError) as error:
        await resolver.grant_identity(authenticated_owner_user_id="owner")
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_attachment_send_rejects_tampered_token_before_drive_read(monkeypatch):
    module = _signing_key(monkeypatch)
    drive = _drive()
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=drive)
    conn = _ActionConn([_prepared_attachment_row(service)])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    token = _attachment_token(service)
    tampered = ("A" if token[0] != "A" else "B") + token[1:]
    with pytest.raises(GmailDeliveryError) as error:
        await service.execute(
            user_id="owner",
            action_id="action",
            draft_payload={**_envelope(), "attachment_token": tampered},
        )
    assert error.value.code == "INVALID_ATTACHMENT"
    drive.resolve.assert_not_awaited()


def test_attachment_token_is_bound_to_owner_and_action(monkeypatch):
    _signing_key(monkeypatch)
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=_drive())
    token = _attachment_token(service)
    for owner, action in (("another-owner", "action"), ("owner", "another-action")):
        with pytest.raises(GmailDeliveryError) as error:
            service._open_attachment(token, user_id=owner, action_id=action)
        assert error.value.code == "INVALID_ATTACHMENT"


@pytest.mark.asyncio
async def test_sent_attachment_retry_is_idempotent_without_drive_read(monkeypatch):
    module = _signing_key(monkeypatch)
    drive = _drive(error=GoogleConnectionError("revoked", status_code=403))
    service = GmailDeliveryService(gmail_service=_Gmail(), drive_blobs=drive)
    conn = _ActionConn([_prepared_attachment_row(service, state="sent")])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    result = await service.execute(
        user_id="owner",
        action_id="action",
        draft_payload={**_envelope(), "attachment_token": _attachment_token(service)},
    )
    assert result["state"] == "sent"
    drive.resolve.assert_not_awaited()


@pytest.mark.asyncio
async def test_verified_attachment_is_added_to_mime_only_after_claim(monkeypatch):
    module = _signing_key(monkeypatch)
    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock(return_value="canonical-connector-token")
    drive = _drive()
    service = GmailDeliveryService(gmail_service=gmail, drive_blobs=drive)
    conn = _ActionConn(
        [
            _prepared_attachment_row(service),
            _prepared_attachment_row(service),
            {"action_id": "action", "state": "sending", "expires_at": "later", "sent_at": None},
        ]
    )
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    sent = []

    class _Response:
        status_code = 200
        content = b"legacy-provider-response"

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
            sent.append(json)
            return _Response()

    monkeypatch.setattr(module.httpx, "AsyncClient", _Client)
    result = await service.execute(
        user_id="owner",
        action_id="action",
        draft_payload={**_envelope(), "attachment_token": _attachment_token(service)},
    )
    assert result == {"action_id": "action", "state": "sent", "outcome_unknown": False}
    assert len(sent) == 1
    raw = base64.urlsafe_b64decode(sent[0]["raw"].encode("ascii"))
    message = message_from_bytes(raw, policy=default)
    attachments = list(message.iter_attachments())
    assert len(attachments) == 1
    assert attachments[0].get_filename() == "note.txt"
    assert attachments[0].get_content_type() == "text/plain"
    assert attachments[0].get_payload(decode=True) == _BLOB
    assert _BLOB.decode().strip() not in repr(conn.calls)


# -- scheduled sends (migration 275) ------------------------------------------------------

_SCHEDULE_PAYLOAD = {
    "to": "Priya.Sharma@Example.com",
    "subject": "Diwali plans",
    "body": "Private scheduled body: see you on Saturday.",
    "recipient_user_id": "u-priya",
    "sender_sub": "google-sub-owner",
}
_SCHEDULE_NOW = datetime(2026, 10, 5, 14, 6, 55, tzinfo=timezone.utc)
_SEND_AT = datetime(2026, 10, 6, 3, 30, tzinfo=timezone.utc)


class _LedgerTransaction:
    """Rolls the ledger back when the block raises, as PostgreSQL does: a write
    made inside a transaction that then refuses is not durable. Restored in
    place, so a test holding a row dict sees the rolled-back values."""

    def __init__(self, conn):
        self.conn = conn
        self.saved: dict[str, dict[str, object]] = {}

    async def __aenter__(self):
        self.saved = {key: dict(row) for key, row in self.conn.rows.items()}
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if exc_type is not None:
            for key in list(self.conn.rows):
                if key not in self.saved:
                    del self.conn.rows[key]
            for key, row in self.saved.items():
                self.conn.rows.setdefault(key, {}).clear()
                self.conn.rows[key].update(row)
        return False


class ScheduleLedgerConn(_PrepareConn):
    """Just enough of gmail_owner_send_actions for the schedule SQL, keyed by
    (user, idempotency HMAC) like the table's UNIQUE constraint. Shared with the
    voice tool tests, so both exercise the real service against one ledger."""

    def __init__(self):
        super().__init__()
        self.rows: dict[str, dict[str, object]] = {}
        self.fail_with: Exception | None = None
        self.now = _SCHEDULE_NOW

    def transaction(self):
        return _LedgerTransaction(self)

    async def execute(self, query, *args):
        """The two expiry sweeps, predicate by predicate as the SQL states them."""
        self.calls.append((query, args))
        if "SET state = 'expired'" not in query:
            return
        by_action = "WHERE action_id = $1 AND user_id = $2" in query
        user_id = args[1] if by_action else args[0]
        for row in self.rows.values():
            if row["user_id"] != user_id or (by_action and row["action_id"] != args[0]):
                continue
            if row["state"] != "prepared" or row["expires_at"] > self.now:
                continue
            if "send_at IS NULL" in query and row["send_at"] is not None:
                continue
            row["state"] = "expired"
            for column in ("payload_sealed", "subject"):
                if f"{column} = NULL" in query:
                    row[column] = None

    def _by_key(self, user_id, idempotency_hmac):
        return next(
            (
                row
                for row in self.rows.values()
                if (row["user_id"], row["idempotency_hmac"]) == (user_id, idempotency_hmac)
            ),
            None,
        )

    def _owned(self, action_id, user_id):
        row = self.rows.get(action_id)
        return row if row is not None and row["user_id"] == user_id else None

    async def fetch(self, query, *args):
        self.calls.append((query, args))
        if self.fail_with is not None:
            raise self.fail_with
        assert "WHERE user_id = $1 AND state = 'scheduled'" in query, query
        assert "payload_sealed" not in query
        waiting = sorted(
            (
                r
                for r in self.rows.values()
                if r["user_id"] == args[0] and r["state"] == "scheduled"
            ),
            key=lambda r: (r["send_at"], r["action_id"]),
        )
        return [
            {key: row[key] for key in ("action_id", "recipient_display", "subject", "send_at")}
            | {"created_at": row["send_at"]}
            for row in waiting[: args[1]]
        ]

    async def fetchrow(self, query, *args):
        self.calls.append((query, args))
        if self.fail_with is not None:
            raise self.fail_with
        if "SELECT action_id, state, send_at, sent_at, recipient_display" in query:
            return self._owned(*args)
        if "FOR UPDATE" in query and "idempotency_hmac = $2" in query:
            return self._by_key(*args)
        if "FOR UPDATE" in query and "WHERE action_id = $1 AND user_id = $2" in query:
            return self._owned(*args)
        if "SET state = 'sending'" in query:
            row = self._owned(args[0], args[1])
            if (
                row is None
                or row["state"] != "prepared"
                or row["expires_at"] <= self.now
                or row["envelope_hmac"] != args[2]
            ):
                return None
            row.update(state="sending")
            return {key: row[key] for key in ("action_id", "state", "expires_at", "sent_at")}
        if "INSERT INTO gmail_owner_send_actions" in query:
            (action_id, user_id, envelope, idem, expires_at, send_at, sealed, display, subject) = (
                args
            )
            if self._by_key(user_id, idem) is not None:
                return None
            self.rows[action_id] = {
                "action_id": action_id,
                "user_id": user_id,
                "envelope_hmac": envelope,
                "idempotency_hmac": idem,
                "state": "scheduled",
                "expires_at": expires_at,
                "send_at": send_at,
                "sent_at": None,
                "payload_sealed": sealed,
                "recipient_display": display,
                "subject": subject,
            }
            return {"action_id": action_id, "state": "scheduled", "send_at": send_at}
        if "SET state = 'cancelled'" in query:
            row = self._owned(args[0], args[1])
            if row is None or row["state"] != "scheduled":
                return None
            row.update(state="cancelled", payload_sealed=None)
            if "subject = NULL" in query:
                row["subject"] = None
            # Renamed only when the SQL renames it, so a cancel that keeps its
            # key keeps blocking the same schedule here exactly as in Postgres.
            if "idempotency_hmac = idempotency_hmac || $3 || action_id" in query:
                row["idempotency_hmac"] = f"{row['idempotency_hmac']}{args[2]}{row['action_id']}"
            return {"action_id": row["action_id"], "state": "cancelled", "sent_at": None}
        if "SELECT state, sent_at" in query:
            return self._owned(*args)
        raise AssertionError(f"unexpected query: {query}")


def _schedule_service(monkeypatch, conn):
    module = _signing_key(monkeypatch)
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(conn))
    )
    monkeypatch.setattr(module, "_utcnow", lambda: _SCHEDULE_NOW)
    return GmailDeliveryService(gmail_service=_Gmail())


async def _schedule(service, **overrides):
    kwargs = {
        "user_id": "owner",
        "payload": dict(_SCHEDULE_PAYLOAD),
        "send_at": _SEND_AT,
        "recipient_display": "Priya Sharma",
    }
    kwargs.update(overrides)
    return await service.schedule_send(**kwargs)


def test_schedule_payload_opens_only_for_its_owner_and_action(monkeypatch):
    _signing_key(monkeypatch)
    service = GmailDeliveryService(gmail_service=_Gmail())
    sealed = service.seal_schedule_payload(
        user_id="owner", action_id="action-1", payload=_SCHEDULE_PAYLOAD
    )

    for secret in ("Priya.Sharma", "Diwali", "Private scheduled body", "u-priya"):
        assert secret not in sealed
    assert service.open_schedule_payload(
        user_id="owner", action_id="action-1", sealed=sealed
    ) == dict(_SCHEDULE_PAYLOAD)
    flipped = sealed[:-6] + ("A" if sealed[-6] != "A" else "B") + sealed[-5:]
    for owner, action, value in (
        ("another-owner", "action-1", sealed),
        ("owner", "action-2", sealed),
        ("owner", "action-1", flipped),
        ("owner", "action-1", "v1:" + sealed),
    ):
        with pytest.raises(ValueError, match="scheduled payload is unavailable"):
            service.open_schedule_payload(user_id=owner, action_id=action, sealed=value)
    # Only the exact five-field shape seals: never without the sending account.
    unbound = {key: value for key, value in _SCHEDULE_PAYLOAD.items() if key != "sender_sub"}
    for payload in (
        {**_SCHEDULE_PAYLOAD, "cc": "x"},
        unbound,
        {**_SCHEDULE_PAYLOAD, "sender_sub": " "},
    ):
        with pytest.raises(ValueError):
            service.seal_schedule_payload(user_id="owner", action_id="action-1", payload=payload)


@pytest.mark.asyncio
async def test_current_sender_sub_names_only_a_usable_connection(monkeypatch):
    """The account a scheduled send is bound to, read from the connection row."""
    row = {"status": "connected", "revoked": False, "google_sub": "google-sub-owner"}
    gmail = _Gmail()
    gmail._fetch_connection_row = lambda *, user_id: row if user_id == "owner" else None
    service = GmailDeliveryService(gmail_service=gmail)

    assert await service.current_sender_sub(user_id="owner") == "google-sub-owner"
    assert await service.current_sender_sub(user_id="someone-else") is None
    for change in ({"revoked": True}, {"status": "disconnected"}, {"google_sub": None}):
        row = {"status": "connected", "revoked": False, "google_sub": "google-sub-owner", **change}
        assert await service.current_sender_sub(user_id="owner") is None, change


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "send_at",
    [
        _SCHEDULE_NOW - timedelta(minutes=5),
        _SCHEDULE_NOW + timedelta(seconds=30),
        _SCHEDULE_NOW + timedelta(days=30, seconds=1),
    ],
)
async def test_schedule_send_refuses_a_time_the_drain_could_not_honour(monkeypatch, send_at):
    """The ledger checks the time itself; a caller that skipped the voice
    tool's validation still cannot store a past, imminent or far-off send."""
    conn = ScheduleLedgerConn()
    service = _schedule_service(monkeypatch, conn)

    with pytest.raises(GmailDeliveryError) as refused:
        await _schedule(service, send_at=send_at)

    assert refused.value.code == "INVALID_SEND_AT"
    assert conn.rows == {} and conn.calls == []
    # The horizon itself is inside it.
    edge = await _schedule(service, send_at=_SCHEDULE_NOW + timedelta(days=30))
    assert edge["created"] is True


@pytest.mark.asyncio
async def test_schedule_send_is_idempotent_and_persists_no_plaintext_envelope(monkeypatch):
    conn = ScheduleLedgerConn()
    service = _schedule_service(monkeypatch, conn)

    first = await _schedule(service)
    again = await _schedule(service)

    assert first["created"] is True and first["state"] == "scheduled"
    assert again == {**first, "created": False}
    assert len(conn.rows) == 1
    row = conn.rows[first["action_id"]]
    assert row["expires_at"] == _SEND_AT + timedelta(hours=24)
    assert (row["recipient_display"], row["subject"]) == ("Priya Sharma", "Diwali plans")
    # The body, the address, the recipient and the sending account reach the
    # table only sealed.
    persisted = repr(conn.calls)
    for secret in (
        "priya.sharma@example.com",
        "Priya.Sharma",
        "Private scheduled body",
        "u-priya",
        "google-sub-owner",
    ):
        assert secret not in persisted
    opened = service.open_schedule_payload(
        user_id="owner", action_id=first["action_id"], sealed=row["payload_sealed"]
    )
    assert opened["to"] == "priya.sharma@example.com"
    assert opened["sender_sub"] == "google-sub-owner"
    # A different time is a different scheduled send, not a replay.
    later = await _schedule(service, send_at=_SEND_AT + timedelta(hours=1))
    assert later["created"] is True and later["action_id"] != first["action_id"]


@pytest.mark.asyncio
async def test_scheduled_row_is_sendable_by_the_unchanged_execute_path(monkeypatch):
    """The envelope a schedule stores is the one prepare() computes for an
    immediate send of the same draft, so execute() verifies the drained payload
    with zero changes -- and still refuses a payload that was altered."""
    from hushh_mcp.services import gmail_delivery_service as module

    conn = ScheduleLedgerConn()
    service = _schedule_service(monkeypatch, conn)
    scheduled = await _schedule(service)
    row = conn.rows[scheduled["action_id"]]
    draft_payload = GmailDeliveryService.scheduled_draft_payload(
        service.open_schedule_payload(
            user_id="owner", action_id=scheduled["action_id"], sealed=row["payload_sealed"]
        )
    )

    prepare_conn = _PrepareConn()
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(prepare_conn))
    )
    await service.prepare(user_id="owner", draft_payload=draft_payload, idempotency_key="k" * 16)
    prepared_envelope = next(
        args[2] for query, args in prepare_conn.calls if "INSERT INTO" in query
    )
    assert prepared_envelope == row["envelope_hmac"]

    gmail = _Gmail()
    gmail.get_send_access_token = AsyncMock(return_value="token")
    sender = GmailDeliveryService(gmail_service=gmail)
    armed = {**row, "state": "prepared"}
    execute_conn = _ActionConn([armed, {**armed, "state": "sending"}])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(execute_conn))
    )

    class _Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, *, headers, json):
            return SimpleNamespace(
                status_code=200,
                content=b"{}",
                json=lambda: {"id": "gmail-message-1", "threadId": "t-1"},
            )

    monkeypatch.setattr(module.httpx, "AsyncClient", _Client)
    result = await sender.execute(
        user_id="owner", action_id=scheduled["action_id"], draft_payload=draft_payload
    )
    assert result["state"] == "sent"

    # Negative control: a tampered body no longer matches the stored envelope.
    execute_conn = _ActionConn([armed])
    monkeypatch.setattr(
        module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(execute_conn))
    )
    with pytest.raises(GmailDeliveryError) as changed:
        await sender.execute(
            user_id="owner",
            action_id=scheduled["action_id"],
            draft_payload={**draft_payload, "body": "Send the money now."},
        )
    assert changed.value.code == "DRAFT_CHANGED"


@pytest.mark.asyncio
async def test_cancel_is_a_compare_and_set_that_reports_the_state_it_lost_to(monkeypatch):
    conn = ScheduleLedgerConn()
    service = _schedule_service(monkeypatch, conn)
    scheduled = await _schedule(service)
    action_id = scheduled["action_id"]

    # Another owner cannot cancel it, and learns nothing about it.
    assert await service.cancel_scheduled_send(user_id="intruder", action_id=action_id) == {
        "cancelled": False,
        "state": None,
        "sent_at": None,
    }
    assert conn.rows[action_id]["state"] == "scheduled"

    first = await service.cancel_scheduled_send(user_id="owner", action_id=action_id)
    assert first == {"cancelled": True, "state": "cancelled", "sent_at": None}
    # The sealed mail and the plaintext subject (display-only, for the waiting
    # list) leave with the cancel; the name stays for the honest replies.
    assert conn.rows[action_id]["payload_sealed"] is None
    assert conn.rows[action_id]["subject"] is None
    assert conn.rows[action_id]["recipient_display"] == "Priya Sharma"
    again = await service.cancel_scheduled_send(user_id="owner", action_id=action_id)
    assert (again["cancelled"], again["state"]) == (False, "cancelled")

    # "Cancel it -- actually, schedule it again for the same time": the cancel
    # freed its key, so the same email, person and time is a new send.
    rescheduled = await _schedule(service)
    assert rescheduled["created"] is True and rescheduled["action_id"] != action_id
    assert conn.rows[rescheduled["action_id"]]["state"] == "scheduled"
    assert conn.rows[action_id]["state"] == "cancelled"
    # A live schedule still answers its own replay.
    replay = await _schedule(service)
    assert replay == {**rescheduled, "created": False}

    # The drain armed it first: the cancel loses and says to what.
    raced = await _schedule(service, send_at=_SEND_AT + timedelta(hours=2))
    conn.rows[raced["action_id"]]["state"] = "sent"
    lost = await service.cancel_scheduled_send(user_id="owner", action_id=raced["action_id"])
    assert (lost["cancelled"], lost["state"]) == (False, "sent")


@pytest.mark.asyncio
async def test_an_immediate_prepare_never_expires_a_scheduled_send(monkeypatch):
    """prepare()'s per-owner sweep is for its own ten-minute confirmations. An
    armed scheduled row (drained, not yet executed) belongs to the drain, which
    alone decides when it is past its window."""
    conn = ScheduleLedgerConn()
    service = _schedule_service(monkeypatch, conn)
    scheduled = await _schedule(service)
    armed = conn.rows[scheduled["action_id"]]
    armed.update(state="prepared")
    # Negative control: an abandoned immediate send of the same owner is swept.
    conn.rows["immediate"] = {
        **armed,
        "action_id": "immediate",
        "idempotency_hmac": "other",
        "send_at": None,
        "payload_sealed": None,
        "subject": None,
    }
    conn.now = armed["expires_at"] + timedelta(minutes=1)
    for row in (armed, conn.rows["immediate"]):
        assert row["expires_at"] <= conn.now

    await service.prepare(
        user_id="owner", draft_payload=_envelope(), idempotency_key="immediate-send-key"
    )

    assert conn.rows["immediate"]["state"] == "expired"
    assert armed["state"] == "prepared"
    assert armed["payload_sealed"] is not None


@pytest.mark.asyncio
async def test_execute_persists_an_immediate_expiry_and_leaves_a_late_scheduled_send_to_the_drain(
    monkeypatch,
):
    """The expiry write is durable for an immediate confirmation (a refusal
    rolls back the claim's transaction, never this write), while a scheduled
    send past its window stays armed: the drain records it as failed, which is
    what puts the unsent email in the Feed. Both are refused."""
    conn = ScheduleLedgerConn()
    service = _schedule_service(monkeypatch, conn)
    scheduled = await _schedule(service)
    row = conn.rows[scheduled["action_id"]]
    draft_payload = GmailDeliveryService.scheduled_draft_payload(
        service.open_schedule_payload(
            user_id="owner", action_id=scheduled["action_id"], sealed=row["payload_sealed"]
        )
    )
    row.update(state="prepared")
    # Same draft, so the same envelope HMAC: an immediate confirmation of it.
    conn.rows["immediate"] = {
        **row,
        "action_id": "immediate",
        "idempotency_hmac": "other",
        "send_at": None,
        "payload_sealed": None,
        "subject": None,
    }
    conn.now = row["expires_at"]

    for action_id in ("immediate", scheduled["action_id"]):
        with pytest.raises(GmailDeliveryError) as refused:
            await service.execute(user_id="owner", action_id=action_id, draft_payload=draft_payload)
        assert refused.value.code == "ACTION_NOT_SENDABLE"

    assert conn.rows["immediate"]["state"] == "expired"
    assert row["state"] == "prepared"
    assert row["payload_sealed"] is not None
