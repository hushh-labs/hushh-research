from __future__ import annotations

import asyncio
import base64
from types import SimpleNamespace

import pytest

import hushh_mcp.services.google_email_delivery_service as delivery_module
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_email_delivery_service import GoogleEmailDeliveryService


class _Db:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict | None]] = []

    def execute_raw(self, sql: str, params: dict | None = None):  # noqa: ANN001
        self.calls.append((sql, params))
        return SimpleNamespace(data=[])


class _Gmail:
    async def send_access_token(self, **_: object) -> str:
        return "access-token"


def test_gmail_send_scope_is_distinct_from_read_scope() -> None:
    assert GoogleConnectionService.scopes("gmail", "send") == (
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
    )
    assert GoogleConnectionService.scopes("gmail", "read") == (
        "https://www.googleapis.com/auth/gmail.readonly",
    )


def test_email_draft_rejects_header_injection_and_requires_to() -> None:
    with pytest.raises(GoogleConnectionError, match="To recipient"):
        GoogleEmailDeliveryService.normalize_draft(
            {"to": [], "cc": [], "bcc": [], "subject": "Hi", "body": "Hello"}
        )
    with pytest.raises(GoogleConnectionError, match="line breaks"):
        GoogleEmailDeliveryService.normalize_draft(
            {
                "to": ["person@example.com\r\nBcc: attacker@example.com"],
                "subject": "Hi",
                "body": "Hello",
            }
        )


def test_email_draft_canonicalization_deduplicates_recipients_and_mime_includes_bcc_transiently() -> (
    None
):
    draft = GoogleEmailDeliveryService.normalize_draft(
        {
            "to": ["PERSON@example.com"],
            "cc": ["person@example.com", "copy@example.com"],
            "bcc": ["copy@example.com", "blind@example.com"],
            "subject": "Hello",
            "body": "Body",
        }
    )
    raw, recipients = GoogleEmailDeliveryService._mime(draft)
    rendered = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode()
    assert draft["to"] == ["person@example.com"]
    assert draft["cc"] == ["copy@example.com"]
    assert draft["bcc"] == ["blind@example.com"]
    assert recipients == ["person@example.com", "copy@example.com", "blind@example.com"]
    assert "Bcc: blind@example.com" in rendered


def test_prepare_persists_only_hmacs_not_email_content(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        delivery_module,
        "get_core_security_settings",
        lambda: SimpleNamespace(app_signing_key="test-signing-key"),
    )
    db = _Db()
    service = GoogleEmailDeliveryService(db=db, gmail=_Gmail())
    asyncio.run(
        service.prepare(
            user_id="user-1",
            idempotency_key="a" * 16,
            draft={
                "to": ["private.person@example.com"],
                "subject": "Sensitive subject",
                "body": "Sensitive draft body",
            },
        )
    )
    insert_params = next(
        params for sql, params in db.calls if "INSERT INTO google_email_send_actions" in sql
    )
    assert insert_params is not None
    assert "Sensitive subject" not in str(insert_params)
    assert "Sensitive draft body" not in str(insert_params)
    assert "private.person@example.com" not in str(insert_params)
    assert "payload_hmac" in insert_params
