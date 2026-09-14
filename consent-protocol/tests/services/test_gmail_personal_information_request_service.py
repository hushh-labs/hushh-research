from __future__ import annotations

import json
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
async def test_personal_monitor_inbox_page_retries_a_transient_message_fetch_failure(monkeypatch):
    service = GmailReceiptsService()

    async def ensure_access_token(*, user_id: str):
        assert user_id == "owner"
        return "access-token", {}

    async def list_messages(**_kwargs):
        return {"messages": [{"id": "one"}]}

    async def get_full(*, access_token: str, gmail_message_id: str):
        raise GmailApiError("temporary provider failure", status_code=503)

    monkeypatch.setattr(service, "_ensure_access_token", ensure_access_token)
    monkeypatch.setattr(service, "_list_messages", list_messages)
    monkeypatch.setattr(service, "_get_message_full", get_full)

    with pytest.raises(GmailApiError) as error:
        await service.list_personal_inbox_monitor_page(user_id="owner")

    assert error.value.code == "GMAIL_MONITOR_MESSAGE_FETCH_FAILED"


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

    assert [message["id"] for message in messages] == ["inbox-message", "read-message"]
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
    assert manifest["ordered_migrations"][-1] == migration_path.name
    assert migration_path.name in manifest["groups"]["iam"]
    assert sum(name.startswith("220_") for name in manifest["ordered_migrations"]) == 1


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
    assert "list_personal_inbox_messages_for_monitoring" in source


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
async def test_missing_history_checkpoint_only_establishes_a_baseline(monkeypatch):
    class GmailService:
        async def capture_personal_inbox_monitor_history_id(self, *, user_id: str):
            assert user_id == "owner"
            return "history-at-opt-in"

        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            raise AssertionError("existing inbox mail must not be listed at opt-in")

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    checkpoints: list[dict[str, object]] = []

    async def monitor_state(*, user_id: str):
        assert user_id == "owner"
        return {
            "monitor_history_id": None,
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "monitoring_generation": 1,
        }

    async def set_checkpoint(**kwargs):
        checkpoints.append(kwargs)
        return True

    monkeypatch.setattr(service, "_monitor_state", monitor_state)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)

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


@pytest.mark.asyncio
async def test_pending_initial_inbox_scan_runs_before_incremental_history(monkeypatch):
    class GmailService:
        async def list_personal_inbox_messages_for_monitoring(self, **_kwargs):
            return [_message()]

        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())
    marks: list[dict[str, object]] = []

    async def monitor_state(**_kwargs):
        return {
            "monitor_history_id": "history-at-opt-in",
            "monitor_cursor": None,
            "monitor_message_offset": 0,
            "monitoring_generation": 7,
            "initial_inbox_scan_completed": False,
        }

    async def scan_state(**_kwargs):
        return {}

    async def classify_and_record(**_kwargs):
        return "workflow-1"

    async def record_scan_state(**_kwargs):
        return True

    async def mark_initial(**kwargs):
        marks.append(kwargs)
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
    monkeypatch.setattr(service, "_mark_initial_inbox_scan_complete", mark_initial)
    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)

    result = await service.scan_recent(user_id="owner")

    assert result["workflow_ids"] == ["workflow-1"]
    assert result["scanned_count"] == 1
    assert result["matched_count"] == 1
    assert marks == [{"user_id": "owner", "expected_generation": 7}]


@pytest.mark.asyncio
async def test_owner_confirmed_recent_unread_scan_classifies_preexisting_inbox_mail(monkeypatch):
    class GmailService:
        async def list_personal_inbox_messages_for_monitoring(self, *, user_id: str, limit: int):
            assert user_id == "owner"
            assert limit == 12
            return [_message()]

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
        async def list_personal_inbox_messages_for_monitoring(self, **_kwargs):
            return [_message()]

        async def list_personal_inbox_monitor_history_page(self, **_kwargs):
            return [], None, "history-high-water", None

    service = PersonalGmailInformationRequestService(gmail_service=GmailService())

    async def monitor_state(**_kwargs):
        return {"monitoring_generation": 7, "monitor_history_id": "history-at-opt-in"}

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

    monkeypatch.setattr(service, "_set_monitor_checkpoint", set_checkpoint)

    result = await service.scan_recent(user_id="owner", include_recent_inbox=True)

    assert result["scanned_count"] == 0
    assert result["unchanged_count"] == 1
    assert result["workflow_ids"] == []


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
                "requested_field_labels": ["name", "age", "education information"],
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
