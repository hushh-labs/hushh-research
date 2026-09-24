from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

import hushh_mcp.services.gmail_personal_information_request_service as monitor_module
import hushh_mcp.services.gmail_receipts_service as receipts_module
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryService,
    GmailReplyContext,
    _message_for,
    normalize_draft,
)
from hushh_mcp.services.gmail_personal_information_request_service import (
    PersonalGmailInformationRequestError,
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


@pytest.mark.asyncio
async def test_source_preview_and_chat_context_refetch_the_verified_sender(
    monkeypatch,
):
    message = _message(body="Please provide your current education details.")
    message["payload"]["headers"].append(
        {"name": "Reply-To", "value": "Replies <replies@example.com>"}
    )

    class GmailService:
        async def get_personal_inbox_message_for_monitoring(
            self, *, user_id: str, gmail_message_id: str
        ):
            assert (user_id, gmail_message_id) == ("owner", "message-1")
            return message

    class Connection:
        async def fetchrow(self, query: str, *args):
            assert "gmail_message_id" in query
            assert args == ("workflow-1", "owner")
            return {
                "gmail_message_id": "message-1",
                "gmail_thread_id": "thread-1",
                "source_hmac": _source_fingerprint(message),
                "status": "detected",
            }

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def get_pool():
        return Pool()

    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    monkeypatch.setattr(monitor_module, "get_pool", get_pool)
    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    preview = await service.get_source_preview(user_id="owner", workflow_id="workflow-1")
    context = await service.get_chat_reply_context(user_id="owner", workflow_id="workflow-1")

    assert preview["from"] == "Verifier <verify@example.com>"
    assert preview["reply_to"] == "Replies <replies@example.com>"
    assert preview["subject"] == "KYC details"
    assert preview["body"] == "Please provide your current education details."
    assert "Subject: KYC details" in context
    assert "Please provide your current education details." in context
    assert "From: Verifier <verify@example.com>" in context


@pytest.mark.asyncio
async def test_workflow_list_orders_by_received_time_before_creation_time(monkeypatch):
    queries: list[str] = []

    class Connection:
        async def fetch(self, query: str, *_args):
            queries.append(query)
            return []

        async def fetchval(self, _query: str, *_args):
            return 0

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def get_pool():
        return Pool()

    monkeypatch.setattr(monitor_module, "get_pool", get_pool)

    await PersonalGmailInformationRequestService().list_workflows(user_id="owner")

    assert "ORDER BY received_at DESC NULLS LAST, created_at DESC, workflow_id DESC" in queries[0]


@pytest.mark.asyncio
async def test_classifier_uses_the_bounded_thirty_second_timeout(monkeypatch):
    service = PersonalGmailInformationRequestService()
    calls: dict[str, object] = {}

    async def classify(**kwargs):
        calls.update(kwargs)
        return {
            "is_information_request": False,
            "confidence": 0,
            "requested_field_labels": [],
            "requested_domains": [],
        }

    monkeypatch.setattr(monitor_module, "run_email_gene", classify)

    result = await service._classify(_message())

    assert result.is_information_request is False
    assert calls["timeout_seconds"] == 30.0


@pytest.mark.asyncio
async def test_classifier_prompt_marks_explicit_kyc_disclosure_requests_as_positive(monkeypatch):
    service = PersonalGmailInformationRequestService()
    calls: dict[str, object] = {}

    async def classify(**kwargs):
        calls.update(kwargs)
        return {
            "is_information_request": True,
            "confidence": 0.9,
            "requested_field_labels": ["Passport number"],
            "requested_domains": ["identity"],
        }

    monkeypatch.setattr(monitor_module, "run_email_gene", classify)

    result = await service._classify(_message())

    assert result.is_information_request is True
    assert "direct request to submit, provide, upload, confirm, or verify" in str(calls["prompt"])
    assert "self-delivered test email" in str(calls["prompt"])


@pytest.mark.asyncio
async def test_classifier_timeout_stays_retryable_and_does_not_classify_message(monkeypatch):
    async def classify(**_kwargs):
        raise TimeoutError("classifier turn timed out")

    monkeypatch.setattr(monitor_module, "run_email_gene", classify)

    with pytest.raises(PersonalGmailInformationRequestError) as error:
        await PersonalGmailInformationRequestService()._classify(_message())

    assert error.value.code == "PERSONAL_GMAIL_CLASSIFIER_UNAVAILABLE"
    assert error.value.status_code == 503


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
        return {
            "id": gmail_message_id,
            "threadId": f"thread-{gmail_message_id}",
            "labelIds": ["INBOX", "UNREAD"],
        }

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    messages = await service.list_personal_inbox_messages_for_monitoring(user_id="owner", limit=99)

    assert [message["id"] for message in messages] == ["one", "two"]
    assert captured["max_results"] == 30
    assert "category:purchases" not in str(captured["query_text"])
    assert "in:inbox" in str(captured["query_text"])
    assert "is:unread" not in str(captured["query_text"])


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
        return {
            "id": gmail_message_id,
            "threadId": "thread-one",
            "labelIds": ["INBOX", "UNREAD"],
        }

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
async def test_personal_monitor_inbox_page_keeps_self_delivered_inbox_mail(monkeypatch):
    service = GmailReceiptsService()

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_messages(**_kwargs):
        return {"messages": [{"id": "self-delivered"}]}

    async def get_full(*, access_token: str, gmail_message_id: str):
        assert access_token == "access-token"
        return {
            "id": gmail_message_id,
            "threadId": "thread-self-delivered",
            "labelIds": ["INBOX", "SENT"],
        }

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    messages, _next_page_token = await service.list_personal_inbox_monitor_page(user_id="owner")

    assert [message["id"] for message in messages] == ["self-delivered"]


@pytest.mark.asyncio
async def test_personal_monitor_inbox_page_returns_an_empty_page_tuple(monkeypatch):
    service = GmailReceiptsService()

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_messages(**_kwargs):
        return {}

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)

    messages, next_page_token = await service.list_personal_inbox_monitor_page(
        user_id="owner",
    )

    assert messages == []
    assert next_page_token is None


@pytest.mark.asyncio
async def test_personal_monitor_inbox_page_skips_a_transient_message_fetch_failure(monkeypatch):
    # This page has no checkpoint to protect (unlike the history page below):
    # it is a one-shot scan over Gmail's own pagination. A single message's
    # transient fetch failure (rate limit, a brief 5xx) must not discard the
    # other messages that fetched fine in the same concurrent batch, or the
    # mandatory initial scan could get stuck retrying forever against the
    # same odds.
    service = GmailReceiptsService()

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_messages(**_kwargs):
        return {"messages": [{"id": "one"}, {"id": "two"}]}

    async def get_full(*, access_token: str, gmail_message_id: str):
        if gmail_message_id == "one":
            raise GmailApiError("temporary provider failure", status_code=503)
        return {"id": "two", "labelIds": ["INBOX"]}

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    messages, next_page_token = await service.list_personal_inbox_monitor_page(user_id="owner")

    assert [message["id"] for message in messages] == ["two"]
    assert next_page_token is None


@pytest.mark.asyncio
async def test_personal_monitor_inbox_page_bounds_fetches_and_retries_google_rate_limits(
    monkeypatch,
):
    service = GmailReceiptsService()
    active_fetches = 0
    peak_fetches = 0
    attempts: dict[str, int] = {}

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_messages(**_kwargs):
        return {"messages": [{"id": f"message-{index}"} for index in range(8)]}

    async def get_full(*, access_token: str, gmail_message_id: str):
        nonlocal active_fetches, peak_fetches
        assert access_token == "access-token"
        attempts[gmail_message_id] = attempts.get(gmail_message_id, 0) + 1
        active_fetches += 1
        peak_fetches = max(peak_fetches, active_fetches)
        try:
            if gmail_message_id == "message-0" and attempts[gmail_message_id] == 1:
                raise GmailApiError(
                    "Google rate limited the request",
                    status_code=502,
                    provider_status_code=429,
                )
            return {"id": gmail_message_id, "labelIds": ["INBOX"]}
        finally:
            active_fetches -= 1

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)
    monkeypatch.setattr(service, "_get_message_full", get_full)
    monkeypatch.setattr(receipts_module, "_PERSONAL_MONITOR_FETCH_BACKOFF_SECONDS", 0)

    messages, next_page_token = await service.list_personal_inbox_monitor_page(user_id="owner")

    assert len(messages) == 8
    assert next_page_token is None
    assert attempts["message-0"] == 2
    assert peak_fetches <= receipts_module._PERSONAL_MONITOR_FETCH_CONCURRENCY


@pytest.mark.asyncio
async def test_personal_monitor_history_page_reads_new_inbox_messages_even_after_open(monkeypatch):
    service = GmailReceiptsService()
    captured: dict[str, object] = {}

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_history(**kwargs):
        captured.update(kwargs)
        return {
            "history": [
                {"messagesAdded": [{"message": {"id": "inbox-message"}}]},
                {"messagesAdded": [{"message": {"id": "read-message"}}]},
                {"messagesAdded": [{"message": {"id": "sent-message"}}]},
                {"messagesAdded": [{"message": {"id": "self-delivered-message"}}]},
            ],
            "nextPageToken": "next-history-page",
            "historyId": "history-high-water",
        }

    async def get_full(*, access_token: str, gmail_message_id: str):
        return {
            "id": gmail_message_id,
            "threadId": f"thread-{gmail_message_id}",
            "labelIds": (
                ["INBOX", "UNREAD"]
                if gmail_message_id == "inbox-message"
                else ["INBOX"]
                if gmail_message_id == "read-message"
                else ["SENT"]
                if gmail_message_id == "sent-message"
                else ["INBOX", "SENT"]
            ),
        }

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_history", list_history)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    history_page_token = "history-page-token"
    (
        messages,
        next_page_token,
        high_water,
        next_message_offset,
    ) = await service.list_personal_inbox_monitor_history_page(
        user_id="owner",
        start_history_id="history-at-opt-in",
        page_token=history_page_token,
        limit=99,
    )

    assert [message["id"] for message in messages] == [
        "inbox-message",
        "read-message",
        "self-delivered-message",
    ]
    assert next_page_token == "next-history-page"
    assert high_water == "history-high-water"
    assert next_message_offset is None
    assert captured["start_history_id"] == "history-at-opt-in"
    assert captured["page_token"] == "history-page-token"
    assert captured["max_results"] == 30
    assert captured["history_types"] == ("messageAdded",)


@pytest.mark.asyncio
async def test_personal_monitor_history_page_bounds_message_hydration_with_a_private_offset(
    monkeypatch,
):
    service = GmailReceiptsService()
    fetched: list[str] = []

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_history(**_kwargs):
        return {
            "history": [
                {"messagesAdded": [{"message": {"id": f"message-{index}"}} for index in range(5)]}
            ],
            "historyId": "history-high-water",
        }

    async def get_full(*, access_token: str, gmail_message_id: str):
        fetched.append(gmail_message_id)
        return {
            "id": gmail_message_id,
            "threadId": f"thread-{gmail_message_id}",
            "labelIds": ["INBOX", "UNREAD"],
        }

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_history", list_history)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    (
        messages,
        next_page_token,
        high_water,
        next_message_offset,
    ) = await service.list_personal_inbox_monitor_history_page(
        user_id="owner",
        start_history_id="history-at-opt-in",
        message_offset=2,
        limit=2,
    )

    assert [message["id"] for message in messages] == ["message-2", "message-3"]
    assert fetched == ["message-2", "message-3"]
    assert next_page_token is None
    assert high_water == "history-high-water"
    assert next_message_offset == 4


@pytest.mark.asyncio
async def test_personal_monitor_history_page_does_not_skip_a_failed_message_fetch(monkeypatch):
    service = GmailReceiptsService()

    async def ensure_access_token(*, user_id: str):
        return "access-token", {}

    async def list_history(**_kwargs):
        return {
            "history": [{"messagesAdded": [{"message": {"id": "message-1"}}]}],
            "historyId": "history-high-water",
        }

    async def get_full(**_kwargs):
        raise RuntimeError("provider timeout")

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_history", list_history)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    with pytest.raises(GmailApiError) as error:
        await service.list_personal_inbox_monitor_history_page(
            user_id="owner",
            start_history_id="history-at-opt-in",
        )

    assert error.value.code == "GMAIL_MONITOR_MESSAGE_FETCH_FAILED"


@pytest.mark.asyncio
async def test_personal_monitor_history_page_skips_a_message_deleted_before_hydration(
    monkeypatch,
):
    service = GmailReceiptsService()

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_history(**_kwargs):
        return {
            "history": [
                {
                    "messagesAdded": [
                        {"message": {"id": "deleted-message"}},
                        {"message": {"id": "unread-message"}},
                    ]
                }
            ],
            "historyId": "history-high-water",
        }

    async def get_full(*, access_token: str, gmail_message_id: str):
        if gmail_message_id == "deleted-message":
            raise GmailApiError(
                "message is gone",
                status_code=404,
                code="GMAIL_MESSAGE_NOT_FOUND",
            )
        return {
            "id": gmail_message_id,
            "threadId": "thread-unread-message",
            "labelIds": ["INBOX", "UNREAD"],
        }

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_history", list_history)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    (
        messages,
        next_page_token,
        high_water,
        next_message_offset,
    ) = await service.list_personal_inbox_monitor_history_page(
        user_id="owner",
        start_history_id="history-at-opt-in",
    )

    assert [message["id"] for message in messages] == ["unread-message"]
    assert next_page_token is None
    assert high_water == "history-high-water"
    assert next_message_offset is None


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
        / "db/migrations/192_gmail_personal_information_request_monitor.sql"
    ).read_text()

    assert "gmail_personal_information_request_preferences" in migration
    assert "gmail_personal_information_request_scan_states" in migration
    assert "gmail_personal_information_requests" in migration
    assert "subject TEXT" not in migration
    assert "body TEXT" not in migration
    assert "sender_email TEXT" not in migration
    assert "source_hmac" in migration
    assert "sender_hmac" in migration


def test_initial_inbox_scan_completion_is_generation_scoped_metadata():
    root = Path(__file__).parents[2]
    migration_path = (
        root / "db/migrations/220_gmail_personal_information_request_initial_inbox_scan.sql"
    )
    migration = migration_path.read_text()
    rollback = (
        root
        / "db/migrations/rollback/220_gmail_personal_information_request_initial_inbox_scan.rollback.sql"
    ).read_text()
    manifest = json.loads((root / "db/release_migration_manifest.json").read_text())

    assert "initial_inbox_scan_completed_at TIMESTAMPTZ" in migration
    assert "subject TEXT" not in migration
    assert "body TEXT" not in migration
    assert "DROP COLUMN IF EXISTS initial_inbox_scan_completed_at" in rollback
    ordered = manifest["ordered_migrations"]
    assert migration_path.name in ordered
    assert migration_path.name in manifest["groups"]["iam"]
    assert ordered.count(migration_path.name) == 1
    assert sum(name.startswith("220_") for name in ordered) == 1


def test_initial_inbox_backfill_cursor_is_persistent_metadata():
    root = Path(__file__).parents[2]
    migration_path = (
        root / "db/migrations/237_gmail_personal_information_request_incremental_backfill.sql"
    )
    rollback_path = (
        root
        / "db/migrations/rollback/237_gmail_personal_information_request_incremental_backfill.rollback.sql"
    )
    migration = migration_path.read_text()
    rollback = rollback_path.read_text()
    manifest = json.loads((root / "db/release_migration_manifest.json").read_text())

    assert "initial_inbox_cursor TEXT" in migration
    assert "initial_inbox_backfill_completed_at TIMESTAMPTZ" in migration
    assert "subject TEXT" not in migration
    assert "body TEXT" not in migration
    assert "DROP COLUMN IF EXISTS initial_inbox_backfill_completed_at" in rollback
    assert migration_path.name in manifest["ordered_migrations"]
    assert migration_path.name in manifest["groups"]["iam"]
    assert manifest["rollback_migrations"][migration_path.name] == str(
        rollback_path.relative_to(root / "db/migrations")
    )


def test_personal_monitor_keeps_scheduled_history_scans_separate_from_owner_catchup():
    migration = (
        Path(__file__).parents[2]
        / "db/migrations/194_gmail_personal_information_request_monitor_history_cursor.sql"
    ).read_text()
    source = Path(monitor_module.__file__).read_text()

    assert "monitor_history_id TEXT" in migration
    assert "prevents historical inbox backfill" in migration
    assert "list_personal_inbox_monitor_history_page" in source
    assert "include_recent_inbox" in source
    assert "list_personal_inbox_monitor_page" in source


@pytest.mark.asyncio
async def test_monitor_opt_in_requires_a_private_vault_before_any_gmail_baseline(monkeypatch):
    class Connection:
        async def fetchval(self, query: str, user_id: str):
            assert "vault_keys" in query
            assert user_id == "owner"
            return False

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def get_pool():
        return Pool()

    monkeypatch.setattr(monitor_module, "get_pool", get_pool)
    service = PersonalGmailInformationRequestService()

    with pytest.raises(PersonalGmailInformationRequestError) as error:
        await service._require_private_vault(user_id="owner")

    assert error.value.code == "PERSONAL_GMAIL_MONITOR_VAULT_REQUIRED"
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_missing_history_checkpoint_establishes_baseline_and_starts_backfill(monkeypatch):
    class GmailService:
        async def capture_personal_inbox_monitor_history_id(self, *, user_id: str):
            assert user_id == "owner"
            return "history-at-opt-in"

        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            raise AssertionError("History must begin after the opt-in high-water mark")

        async def list_personal_inbox_monitor_page(self, *, page_token, limit, **_kwargs):
            assert page_token is None
            assert limit == 30
            return [], None

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    checkpoints: list[dict[str, object]] = []

    async def monitor_state(*, user_id: str):
        assert user_id == "owner"
        return {
            "monitor_history_id": None,
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "monitoring_generation": 1,
            "initial_inbox_cursor": None,
            "initial_inbox_backfill_completed": False,
        }

    async def set_checkpoint(**kwargs):
        checkpoints.append(kwargs)
        return True

    backfill_checkpoints: list[dict[str, object]] = []

    async def set_backfill_checkpoint(**kwargs):
        backfill_checkpoints.append(kwargs)
        return True

    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)
    monkeypatch.setattr(service, "_set_initial_inbox_backfill_checkpoint", set_backfill_checkpoint)

    result = await service.scan_recent(user_id="owner")

    assert result["baseline_established"] is True
    assert result["scanned_count"] == 0
    assert checkpoints == [
        {
            "user_id": "owner",
            "monitor_history_id": "history-at-opt-in",
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "expected_generation": 1,
        }
    ]
    assert backfill_checkpoints == [
        {
            "user_id": "owner",
            "initial_inbox_cursor": None,
            "completed": True,
            "expected_generation": 1,
        }
    ]


@pytest.mark.asyncio
async def test_pending_initial_inbox_backfill_runs_after_incremental_history(monkeypatch):
    class GmailService:
        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

        async def list_personal_inbox_monitor_page(self, **_kwargs):
            return [_message()], None

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    checkpoints: list[dict[str, object]] = []

    async def monitor_state(**_kwargs):
        return {
            "monitor_history_id": "history-at-opt-in",
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "monitoring_generation": 7,
            "initial_inbox_scan_completed": False,
            "initial_inbox_backfill_completed": False,
            "initial_inbox_cursor": None,
        }

    async def scan_state(**_kwargs):
        return {}

    async def classify_and_record(**_kwargs):
        return "workflow-1"

    async def record_scan_state(**_kwargs):
        return True

    async def set_initial_checkpoint(**kwargs):
        checkpoints.append(kwargs)
        return True

    async def set_checkpoint(**_kwargs):
        return True

    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_scan_state_by_message", scan_state)
    monkeypatch.setattr(service, "_classify_and_record", classify_and_record)
    monkeypatch.setattr(service, "_record_scan_state", record_scan_state)
    monkeypatch.setattr(service, "_set_initial_inbox_backfill_checkpoint", set_initial_checkpoint)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)

    result = await service.scan_recent(user_id="owner")

    assert result["workflow_ids"] == ["workflow-1"]
    assert result["scanned_count"] == 1
    assert result["matched_count"] == 1
    assert checkpoints == [
        {
            "user_id": "owner",
            "initial_inbox_cursor": None,
            "completed": True,
            "expected_generation": 7,
        }
    ]


@pytest.mark.asyncio
async def test_initial_inbox_scan_stops_after_the_newest_page(monkeypatch):
    message = _message()
    requested_cursors: list[str | None] = []
    persisted_cursors: list[tuple[str | None, bool]] = []
    state = {
        "monitor_history_id": "history-at-opt-in",
        "monitor_cursor": None,
        "monitor_message_offset": 0,
        "monitoring_generation": 7,
        "initial_inbox_scan_completed": False,
        "initial_inbox_backfill_completed": False,
        "initial_inbox_cursor": None,
    }

    class GmailService:
        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

        async def list_personal_inbox_monitor_page(self, *, page_token, **_kwargs):
            requested_cursors.append(page_token)
            return [message], "older-page"

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())

    async def monitor_state(**_kwargs):
        return dict(state)

    async def scan_state(**_kwargs):
        return {}

    async def classify_and_record(**kwargs):
        return f"workflow-{kwargs['message']['id']}"

    async def record_scan_state(**_kwargs):
        return True

    async def set_monitor_checkpoint(**_kwargs):
        return True

    async def set_initial_checkpoint(*, initial_inbox_cursor, completed, **_kwargs):
        persisted_cursors.append((initial_inbox_cursor, completed))
        state["initial_inbox_scan_completed"] = True
        state["initial_inbox_cursor"] = initial_inbox_cursor
        state["initial_inbox_backfill_completed"] = completed
        return True

    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_scan_state_by_message", scan_state)
    monkeypatch.setattr(service, "_classify_and_record", classify_and_record)
    monkeypatch.setattr(service, "_record_scan_state", record_scan_state)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_monitor_checkpoint)
    monkeypatch.setattr(service, "_set_initial_inbox_backfill_checkpoint", set_initial_checkpoint)

    first = await service.scan_recent(user_id="owner", max_results=30)
    second = await service.scan_recent(user_id="owner", max_results=30)

    assert requested_cursors == [None]
    assert persisted_cursors == [(None, True)]
    assert first["workflow_ids"] == ["workflow-message-1"]
    assert second["workflow_ids"] == []


@pytest.mark.asyncio
async def test_legacy_initial_backfill_cursor_is_retired_without_fetching_old_mail(monkeypatch):
    state = {
        "monitor_history_id": "history-at-opt-in",
        "monitor_cursor": None,
        "monitor_message_offset": 0,
        "monitoring_generation": 7,
        "initial_inbox_scan_completed": True,
        "initial_inbox_backfill_completed": False,
        "initial_inbox_cursor": "older-page",
    }
    checkpoints: list[dict[str, object]] = []

    class GmailService:
        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

        async def list_personal_inbox_monitor_page(self, **_kwargs):
            raise AssertionError("legacy cursor must not fetch older Inbox mail")

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())

    async def monitor_state(**_kwargs):
        return dict(state)

    async def set_monitor_checkpoint(**_kwargs):
        return True

    async def set_initial_checkpoint(**kwargs):
        checkpoints.append(kwargs)
        return True

    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_monitor_checkpoint)
    monkeypatch.setattr(service, "_set_initial_inbox_backfill_checkpoint", set_initial_checkpoint)

    result = await service.scan_recent(user_id="owner")

    assert result["scanned_count"] == 0
    assert checkpoints == [
        {
            "user_id": "owner",
            "initial_inbox_cursor": None,
            "completed": True,
            "expected_generation": 7,
        }
    ]


@pytest.mark.asyncio
async def test_scan_state_is_not_expired_while_monitoring_remains_enabled(monkeypatch):
    queries: list[str] = []

    class Connection:
        async def fetchval(self, query: str, *_args):
            queries.append(query)
            return 2

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def get_pool():
        return Pool()

    monkeypatch.setattr(monitor_module, "get_pool", get_pool)

    result = await PersonalGmailInformationRequestService()._purge_expired_metadata()

    assert result == (2, 0)
    assert len(queries) == 1
    assert "status IN ('ignored', 'blocked', 'sent')" in queries[0]
    assert "gmail_personal_information_request_scan_states" not in queries[0]


@pytest.mark.asyncio
async def test_owner_confirmed_recent_unread_scan_classifies_preexisting_inbox_mail(monkeypatch):
    class GmailService:
        async def list_personal_inbox_monitor_page(self, *, user_id: str, page_token, limit: int):
            assert user_id == "owner"
            assert limit == 30
            assert page_token is None
            return [_message()], None

        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    recorded: list[dict[str, object]] = []

    async def monitor_state(*, user_id: str):
        assert user_id == "owner"
        return {
            "monitor_history_id": "history-at-opt-in",
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "monitoring_generation": 7,
            "initial_inbox_backfill_completed": False,
            "initial_inbox_cursor": None,
        }

    async def scan_state(**_kwargs):
        return {}

    async def classify_and_record(**kwargs):
        assert kwargs["message"] == _message()
        return "workflow-1"

    async def record_scan_state(**kwargs):
        recorded.append(kwargs)
        return True

    async def set_checkpoint(**_kwargs):
        return True

    async def set_initial_checkpoint(**_kwargs):
        return True

    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_scan_state_by_message", scan_state)
    monkeypatch.setattr(service, "_classify_and_record", classify_and_record)
    monkeypatch.setattr(service, "_record_scan_state", record_scan_state)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)
    monkeypatch.setattr(service, "_set_initial_inbox_backfill_checkpoint", set_initial_checkpoint)

    result = await service.scan_recent(user_id="owner", include_recent_inbox=True)

    assert result == {
        "accepted": True,
        "scanned_count": 1,
        "unchanged_count": 0,
        "matched_count": 1,
        "failed_count": 0,
        "workflow_ids": ["workflow-1"],
    }
    assert recorded[0]["gmail_message_id"] == "message-1"


@pytest.mark.asyncio
async def test_owner_confirmed_recent_unread_scan_deduplicates_existing_mail(monkeypatch):
    class GmailService:
        async def list_personal_inbox_monitor_page(self, **_kwargs):
            return [_message()], None

        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())

    async def monitor_state(**_kwargs):
        return {
            "monitoring_generation": 7,
            "monitor_history_id": "history-at-opt-in",
            "initial_inbox_backfill_completed": False,
            "initial_inbox_cursor": None,
        }

    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    monkeypatch.setattr(service, "_monitor_state", monitor_state)

    async def scan_state(**_kwargs):
        return {"message-1": _source_fingerprint(_message())}

    monkeypatch.setattr(service, "_scan_state_by_message", scan_state)

    async def set_checkpoint(**_kwargs):
        return True

    async def set_initial_checkpoint(**_kwargs):
        return True

    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)
    monkeypatch.setattr(service, "_set_initial_inbox_backfill_checkpoint", set_initial_checkpoint)

    result = await service.scan_recent(user_id="owner", include_recent_inbox=True)

    assert result["scanned_count"] == 0
    assert result["unchanged_count"] == 1
    assert result["workflow_ids"] == []


@pytest.mark.asyncio
async def test_classifier_policy_update_does_not_recheck_terminal_messages(monkeypatch):
    class GmailService:
        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

        async def list_personal_inbox_monitor_page(self, **_kwargs):
            raise AssertionError("policy updates must not fetch the Inbox")

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    policy_updates: list[dict[str, object]] = []

    async def monitor_state(**_kwargs):
        return {
            "monitor_history_id": "history-at-opt-in",
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "monitoring_generation": 7,
            "classifier_policy_version": 1,
            "initial_inbox_scan_completed": True,
            "initial_inbox_backfill_completed": True,
            "initial_inbox_cursor": None,
        }

    async def set_monitor_checkpoint(**_kwargs):
        return True

    async def set_classifier_policy_version(**kwargs):
        policy_updates.append(kwargs)
        return True

    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_monitor_checkpoint)
    monkeypatch.setattr(service, "_set_classifier_policy_version", set_classifier_policy_version)

    result = await service.scan_recent(user_id="owner")

    assert result["classifier_policy_updated"] is True
    assert result["scanned_count"] == 0
    assert policy_updates == [
        {
            "user_id": "owner",
            "expected_generation": 7,
        }
    ]


@pytest.mark.asyncio
async def test_incomplete_classification_does_not_advance_the_monitor_checkpoint(monkeypatch):
    class GmailService:
        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [_message()], None, "history-high-water", None

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    checkpoints: list[dict[str, object]] = []

    async def monitor_state(*, user_id: str):
        return {
            "monitor_history_id": "history-at-opt-in",
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "monitoring_generation": 7,
        }

    async def scan_state(**_kwargs):
        return {}

    async def classify_and_record(**_kwargs):
        raise monitor_module.PersonalGmailInformationRequestError(
            "temporary classifier failure",
            code="PERSONAL_GMAIL_CLASSIFIER_UNAVAILABLE",
            status_code=503,
        )

    async def set_checkpoint(**kwargs):
        checkpoints.append(kwargs)
        return True

    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_scan_state_by_message", scan_state)
    monkeypatch.setattr(service, "_classify_and_record", classify_and_record)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)

    result = await service.scan_recent(user_id="owner")

    assert result == {
        "accepted": True,
        "scanned_count": 0,
        "unchanged_count": 0,
        "matched_count": 0,
        "failed_count": 1,
        "workflow_ids": [],
        "retry_pending": True,
    }
    assert checkpoints == []


@pytest.mark.asyncio
async def test_classification_progress_emits_a_persisted_request_in_completion_order(monkeypatch):
    service = PersonalGmailInformationRequestService()
    first = _message()
    second = {**_message(), "id": "message-2", "threadId": "thread-2"}
    progress: list[tuple[int, str | None]] = []

    async def scan_state(**_kwargs):
        return {}

    async def classify_and_record(*, message, **_kwargs):
        if message["id"] == "message-1":
            await asyncio.sleep(0.01)
            return None
        return "workflow-2"

    async def record_scan_state(**_kwargs):
        return True

    async def public_workflow(*, workflow_id, **_kwargs):
        return {
            "workflow_id": workflow_id,
            "status": "detected",
            "requested_field_labels": ["Passport number"],
            "candidate_scopes": [],
            "attachment_review_required": False,
        }

    async def on_progress(scanned_count, workflow):
        progress.append((scanned_count, workflow and workflow["workflow_id"]))

    monkeypatch.setattr(
        monitor_module,
        "get_core_security_settings",
        lambda: type("Settings", (), {"app_signing_key": "test-signing-key"})(),
    )
    monkeypatch.setattr(service, "_scan_state_by_message", scan_state)
    monkeypatch.setattr(service, "_classify_and_record", classify_and_record)
    monkeypatch.setattr(service, "_record_scan_state", record_scan_state)
    monkeypatch.setattr(service, "_public_workflow_by_id", public_workflow)

    result = await service._classify_messages(
        user_id="owner",
        messages=[first, second],
        expected_generation=1,
        on_progress=on_progress,
    )

    assert result == (2, 0, 0, ["workflow-2"])
    assert progress == [(1, "workflow-2"), (2, None)]


@pytest.mark.asyncio
async def test_monitor_state_reports_a_missing_release_schema_column_safely(monkeypatch):
    class Connection:
        async def fetchrow(self, *_args, **_kwargs):
            raise monitor_module.asyncpg.UndefinedColumnError("initial_inbox_scan_completed_at")

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def get_pool():
        return Pool()

    monkeypatch.setattr(monitor_module, "get_pool", get_pool)

    with pytest.raises(PersonalGmailInformationRequestError) as error:
        await PersonalGmailInformationRequestService()._monitor_state(user_id="owner")

    assert error.value.code == "PERSONAL_GMAIL_MONITOR_SCHEMA_NOT_READY"
    assert error.value.status_code == 503


@pytest.mark.asyncio
async def test_positive_classification_records_a_source_metadata_workflow(monkeypatch):
    calls: list[str] = []

    class Transaction:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

    class Connection:
        def transaction(self):
            return Transaction()

        async def fetchrow(self, query, *_args):
            calls.append(query)
            if "FOR SHARE" in query:
                return {"monitoring_enabled": True, "monitoring_generation": 7}
            return {"workflow_id": "workflow-recorded"}

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def get_pool():
        return Pool()

    service = PersonalGmailInformationRequestService()

    async def classify(_message):
        return monitor_module._Classification(
            True,
            0.95,
            ("Passport number",),
            ("identity",),
        )

    async def candidates(**_kwargs):
        return [
            {
                "scope": "attr.identity.passport_number",
                "domain": "identity",
                "label": "Passport number",
                "segment_ids": ["passport_number"],
            }
        ]

    monkeypatch.setattr(monitor_module, "get_pool", get_pool)
    monkeypatch.setattr(service, "_classify", classify)
    monkeypatch.setattr(service, "_candidate_scopes", candidates)

    workflow_id = await service._classify_and_record(
        user_id="owner",
        message=_message(),
        expected_generation=7,
    )

    assert workflow_id == "workflow-recorded"
    assert sum("FOR SHARE" in query for query in calls) == 1
    assert calls[0].count("WHERE user_id = $1") == 1
    assert "INSERT INTO gmail_personal_information_requests" in calls[1]


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
                {
                    "scope": "attr.identity.identity_profile.full_name",
                    "domain": "identity",
                    "path": "identity_profile.full_name",
                    "path_type": "leaf",
                    "segment_id": "identity_profile",
                    "label": "Full name",
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


@pytest.mark.asyncio
async def test_candidate_scopes_share_kyc_aliases_with_identity_profile(monkeypatch):
    class ScopeGenerator:
        async def get_available_scope_entries(self, user_id: str):
            assert user_id == "owner"
            return [
                {
                    "scope": "attr.identity.identity_profile.full_name",
                    "domain": "identity",
                    "path": "identity_profile.full_name",
                    "path_type": "leaf",
                    "segment_id": "identity_profile",
                    "label": "Full name",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "consumer_visible": True,
                }
            ]

    monkeypatch.setattr(monitor_module, "get_scope_generator", lambda: ScopeGenerator())
    candidates = await PersonalGmailInformationRequestService()._candidate_scopes(
        user_id="owner",
        field_labels=("legal name",),
        domains=(),
    )

    assert candidates[0]["canonical_field_ids"] == ["identity.identity_profile.full_name"]


@pytest.mark.asyncio
async def test_refresh_candidate_scopes_uses_current_manifest_metadata(monkeypatch):
    class ScopeGenerator:
        async def get_available_scope_entries(self, user_id: str):
            assert user_id == "owner"
            return [
                {
                    "scope": "attr.identity.full_name",
                    "domain": "identity",
                    "path": "full_name",
                    "path_type": "leaf",
                    "segment_id": "identity",
                    "label": "Full name",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "consumer_visible": True,
                },
                {
                    "scope": "attr.identity.age",
                    "domain": "identity",
                    "path": "age",
                    "path_type": "leaf",
                    "segment_id": "identity",
                    "label": "Age",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "consumer_visible": True,
                },
                {
                    "scope": "attr.education.institution",
                    "domain": "education",
                    "path": "institution",
                    "path_type": "leaf",
                    "segment_id": "education",
                    "label": "Educational institution",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "consumer_visible": True,
                },
                {
                    "scope": "attr.financial.account_number",
                    "domain": "financial",
                    "path": "account_number",
                    "path_type": "leaf",
                    "segment_id": "financial",
                    "label": "Account number",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                    "consumer_visible": True,
                },
            ]

    writes: list[tuple[str, tuple[object, ...]]] = []

    class Connection:
        async def fetchrow(self, query: str, *args):
            assert "SELECT requested_field_labels" in query
            assert args == ("workflow-1", "owner")
            return {
                "requested_field_labels": ["name", "age", "college_information"],
                "candidate_scopes": [],
                "status": "detected",
            }

        async def execute(self, query: str, *args):
            writes.append((query, args))

    class Acquire:
        async def __aenter__(self):
            return Connection()

        async def __aexit__(self, *_args):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def get_pool():
        return Pool()

    monkeypatch.setattr(monitor_module, "get_pool", get_pool)
    monkeypatch.setattr(monitor_module, "get_scope_generator", lambda: ScopeGenerator())

    refreshed = await PersonalGmailInformationRequestService().refresh_candidate_scopes(
        user_id="owner",
        workflow_id="workflow-1",
    )

    assert refreshed == {
        "workflow_id": "workflow-1",
        "candidate_scopes": [
            {
                "scope": "attr.identity.full_name",
                "domain": "identity",
                "label": "Full name",
                "segment_ids": ["identity"],
                "canonical_field_ids": ["identity.identity_profile.full_name"],
            },
            {
                "scope": "attr.identity.age",
                "domain": "identity",
                "label": "Age",
                "segment_ids": ["identity"],
                "canonical_field_ids": ["identity.identity_profile.declared_age"],
            },
            {
                "scope": "attr.education.institution",
                "domain": "education",
                "label": "Educational institution",
                "segment_ids": ["education"],
                "canonical_field_ids": ["identity.identity_profile.education.institution"],
            },
        ],
    }
    assert len(writes) == 1
    assert "SET candidate_scopes" in writes[0][0]
