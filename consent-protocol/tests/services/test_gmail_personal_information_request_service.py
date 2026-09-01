from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

import hushh_mcp.services.gmail_personal_information_request_service as monitor_module
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryService,
    GmailReplyContext,
    _message_for,
    normalize_draft,
)
from hushh_mcp.services.gmail_personal_information_request_service import (
    PersonalGmailInformationRequestService,
    _classification_from,
    _message_text,
    _public_candidate_scope,
    _source_fingerprint,
)
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService


def _message(*, body: str = "Please provide your passport number.") -> dict[str, object]:
    import base64

    encoded = base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")
    return {
        "id": "message-1",
        "threadId": "thread-1",
        "internalDate": "1770000000000",
        "payload": {
            "headers": [
                {"name": "From", "value": "Verifier <verify@example.com>"},
                {"name": "Subject", "value": "KYC details"},
                {"name": "Message-ID", "value": "<source@example.com>"},
            ],
            "mimeType": "text/plain",
            "body": {"data": encoded},
        },
    }


def test_classifier_result_requires_high_confidence_and_normalizes_domains():
    classification = _classification_from(
        {
            "is_information_request": True,
            "confidence": 0.83,
            "requested_field_labels": ["Passport number", "Passport number", "Address"],
            "requested_domains": ["identity", "UNTRUSTED_DOMAIN", "financial"],
        }
    )

    assert classification.is_information_request is True
    assert classification.requested_field_labels == ("Passport number", "Address")
    assert classification.requested_domains == ("identity", "financial")
    assert (
        _classification_from(
            {"is_information_request": True, "confidence": 0.59}
        ).is_information_request
        is False
    )


def test_monitor_source_content_is_transient_and_fingerprinted(monkeypatch):
    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    message = _message()

    assert _message_text(message) == "Please provide your passport number."
    fingerprint = _source_fingerprint(message)
    assert len(fingerprint) == 64
    assert "passport" not in fingerprint
    assert _source_fingerprint(_message(body="A changed email.")) != fingerprint


@pytest.mark.asyncio
async def test_personal_monitor_inbox_read_is_bounded_and_not_a_receipt_query(monkeypatch):
    service = GmailReceiptsService()
    captured: dict[str, object] = {}

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_messages(**kwargs):
        captured.update(kwargs)
        return {"messages": [{"id": "one"}, {"id": "two"}]}

    async def get_full(*, access_token: str, gmail_message_id: str):
        return {"id": gmail_message_id, "threadId": f"thread-{gmail_message_id}"}

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    messages = await service.list_personal_inbox_messages_for_monitoring(user_id="owner", limit=99)

    assert [message["id"] for message in messages] == ["one", "two"]
    assert captured["max_results"] == 25
    assert "category:purchases" not in str(captured["query_text"])
    assert "in:inbox" in str(captured["query_text"])


@pytest.mark.asyncio
async def test_personal_monitor_inbox_page_keeps_gmail_cursor_server_side(monkeypatch):
    service = GmailReceiptsService()
    captured: dict[str, object] = {}

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_messages(**kwargs):
        captured.update(kwargs)
        return {"messages": [{"id": "one"}], "nextPageToken": "opaque-cursor"}

    async def get_full(*, access_token: str, gmail_message_id: str):
        return {"id": gmail_message_id, "threadId": "thread-one"}

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    previous_cursor = "cursor-token-for-test"
    messages, next_page_token = await service.list_personal_inbox_monitor_page(
        user_id="owner",
        page_token=previous_cursor,
        limit=12,
    )

    assert [message["id"] for message in messages] == ["one"]
    assert next_page_token == "opaque-cursor"
    assert captured["page_token"] == previous_cursor


@pytest.mark.asyncio
async def test_gmail_send_requires_the_owner_local_send_toggle(monkeypatch):
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "is_configured", lambda: True)
    monkeypatch.setattr(
        service,
        "_fetch_connection_row",
        lambda user_id: {
            "status": "connected",
            "revoked": False,
            "scope_csv": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            "send_enabled": False,
        },
    )

    with pytest.raises(GmailApiError) as error:
        await service.assert_send_ready(user_id="owner")

    assert error.value.code == "GMAIL_SEND_DISABLED"


def test_threaded_reply_context_is_part_of_the_reviewed_envelope(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_delivery_service.get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    service = GmailDeliveryService()
    draft = {
        "to": ["verifier@example.com"],
        "cc": [],
        "bcc": [],
        "subject": "Re: KYC request",
        "body": "Here are my approved details.",
    }
    normalized = normalize_draft(draft)
    reply = GmailReplyContext("thread-1", "<source@example.com>", "<root@example.com>")

    message = _message_for(normalized, reply_context=reply)

    assert message["In-Reply-To"] == "<source@example.com>"
    assert message["References"] == "<root@example.com>"
    assert service._envelope_hmac(normalized, reply_context=reply) != service._envelope_hmac(
        normalized
    )


def test_personal_monitor_migration_is_metadata_only():
    migration = (
        Path(__file__).parents[2]
        / "db/migrations/189_gmail_personal_information_request_monitor.sql"
    ).read_text()

    assert "gmail_personal_information_request_preferences" in migration
    assert "gmail_personal_information_request_scan_states" in migration
    assert "gmail_personal_information_requests" in migration
    assert "subject TEXT" not in migration
    assert "body TEXT" not in migration
    assert "sender_email TEXT" not in migration
    assert "source_hmac" in migration
    assert "sender_hmac" in migration


def test_personal_monitor_scan_deduplication_is_metadata_only():
    source = Path(monitor_module.__file__).read_text()

    assert "gmail_personal_information_request_scan_states" in source
    assert "unchanged_count" in source
    assert "_purge_expired_metadata" in source


def test_public_workflow_exposes_no_source_content():
    created_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
    workflow = monitor_module.PersonalGmailInformationRequestService._public_workflow(
        {
            "workflow_id": "workflow",
            "status": "detected",
            "gmail_thread_id": "thread",
            "classification_confidence": 0.9,
            "requested_field_labels": ["Passport number"],
            "candidate_scopes": [
                {
                    "scope": "attr.identity.passport_number",
                    "domain": "identity",
                    "label": "Passport number",
                    "segment_ids": ["passport_number"],
                },
                {"scope": "attr.identity.*", "domain": "identity", "label": "Identity"},
            ],
            "created_at": created_at,
            "updated_at": created_at,
            "subject": "Do not expose",
            "body": "Do not expose",
            "sender_email": "do-not-expose@example.com",
        }
    )

    assert workflow["workflow_id"] == "workflow"
    assert "subject" not in workflow
    assert "body" not in workflow
    assert "sender_email" not in workflow
    assert workflow["candidate_scopes"] == [
        {
            "scope": "attr.identity.passport_number",
            "domain": "identity",
            "label": "Passport number",
            "segment_ids": ["passport_number"],
        }
    ]


def test_public_candidate_scope_rejects_wildcards_and_missing_manifest_segments():
    assert (
        _public_candidate_scope(
            {
                "scope": "attr.identity.*",
                "domain": "identity",
                "label": "Identity",
                "segment_ids": ["identity"],
            }
        )
        is None
    )
    assert (
        _public_candidate_scope(
            {
                "scope": "attr.identity.address.postal_code",
                "domain": "identity",
                "label": "Postal code",
                "segment_ids": [],
            }
        )
        is None
    )


@pytest.mark.asyncio
async def test_candidate_scopes_accept_only_exact_manifest_leaves(monkeypatch):
    class ScopeGenerator:
        async def get_available_scope_entries(self, user_id: str):
            assert user_id == "owner"
            return [
                {
                    "scope": "attr.identity.*",
                    "domain": "identity",
                    "path": None,
                    "wildcard": True,
                    "source_kind": "pkm_index",
                    "consumer_visible": True,
                },
                {
                    "scope": "attr.identity.address",
                    "domain": "identity",
                    "path": "address",
                    "path_type": "object",
                    "segment_id": "address",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "consumer_visible": True,
                },
                {
                    "scope": "attr.identity.address.postal_code",
                    "domain": "identity",
                    "path": "address.postal_code",
                    "path_type": "leaf",
                    "segment_id": "address",
                    "label": "Postal code",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "consumer_visible": True,
                },
            ]

    monkeypatch.setattr(monitor_module, "get_scope_generator", lambda: ScopeGenerator())

    candidates = await PersonalGmailInformationRequestService()._candidate_scopes(
        user_id="owner",
        field_labels=("Postal code",),
        domains=("identity",),
    )

    assert candidates == [
        {
            "scope": "attr.identity.address.postal_code",
            "domain": "identity",
            "label": "Postal code",
            "segment_ids": ["address"],
        }
    ]
