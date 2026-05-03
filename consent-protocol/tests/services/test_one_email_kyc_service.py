import base64
import email
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.services.one_email_kyc_service import (
    OneEmailKycConfig,
    OneEmailKycError,
    OneEmailKycService,
)


def _b64url(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("utf-8").rstrip("=")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("utf-8").rstrip("=")


_CONNECTOR_PRIVATE = X25519PrivateKey.generate()
_CONNECTOR_PRIVATE_B64 = _b64(
    _CONNECTOR_PRIVATE.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
)
_CONNECTOR_PUBLIC_B64 = _b64(
    _CONNECTOR_PRIVATE.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
)


def _encrypted_export(
    payload: dict,
    *,
    scope: str = "attr.identity.*",
    export_revision: int = 1,
) -> dict:
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    export_key = os.urandom(32)
    export_iv = os.urandom(12)
    export_ciphertext = AESGCM(export_key).encrypt(export_iv, plaintext, None)

    sender_private = X25519PrivateKey.generate()
    connector_public = X25519PublicKey.from_public_bytes(
        base64.urlsafe_b64decode(_CONNECTOR_PUBLIC_B64 + "==")
    )
    shared_secret = sender_private.exchange(connector_public)
    digest = hashes.Hash(hashes.SHA256())
    digest.update(shared_secret)
    wrapping_key = digest.finalize()
    wrapped_iv = os.urandom(12)
    wrapped = AESGCM(wrapping_key).encrypt(wrapped_iv, export_key, None)
    sender_public = sender_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return {
        "scope": scope,
        "encrypted_data": _b64(export_ciphertext[:-16]),
        "iv": _b64(export_iv),
        "tag": _b64(export_ciphertext[-16:]),
        "wrapped_key_bundle": {
            "wrapped_export_key": _b64(wrapped[:-16]),
            "wrapped_key_iv": _b64(wrapped_iv),
            "wrapped_key_tag": _b64(wrapped[-16:]),
            "sender_public_key": _b64(sender_public),
            "wrapping_alg": "X25519-AES256-GCM",
            "connector_key_id": "one-kyc-key",
        },
        "connector_key_id": "one-kyc-key",
        "connector_wrapping_alg": "X25519-AES256-GCM",
        "export_revision": export_revision,
        "export_generated_at": datetime(2026, 4, 28, tzinfo=timezone.utc),
        "refresh_status": "current",
        "is_strict_zero_knowledge": True,
    }


def _message(*, body: str, sender: str = "broker@example.com") -> dict:
    return {
        "id": "gmail_msg_1",
        "threadId": "gmail_thread_1",
        "snippet": "raw snippet should not be stored",
        "payload": {
            "headers": [
                {"name": "From", "value": f"Broker Ops <{sender}>"},
                {"name": "To", "value": "one@hushh.ai"},
                {"name": "Cc", "value": "User <verified@example.com>"},
                {"name": "Subject", "value": "Broker API KYC questionnaire"},
                {"name": "Message-ID", "value": "<m1@example.com>"},
            ],
            "mimeType": "multipart/mixed",
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {"data": _b64url(body)},
                }
            ],
        },
    }


class _FakeDb:
    def __init__(self, *, user_id: str | None = "user_123") -> None:
        self.user_id = user_id
        self.workflows: list[dict] = []

    def execute_raw(self, sql: str, params: dict | None = None):
        params = params or {}
        normalized = " ".join(sql.lower().split())
        if "from actor_identity_cache" in normalized:
            if not self.user_id:
                return SimpleNamespace(data=[])
            return SimpleNamespace(
                data=[{"user_id": self.user_id, "email": "verified@example.com"}]
            )
        if "from one_kyc_workflows" in normalized and "where gmail_message_id" in normalized:
            message_id = params.get("gmail_message_id")
            rows = [row for row in self.workflows if row.get("gmail_message_id") == message_id]
            return SimpleNamespace(data=rows[:1])
        if "insert into one_kyc_workflows" in normalized:
            row = dict(params)
            row["participant_emails"] = json.loads(row["participant_emails"])
            row["required_fields"] = json.loads(row["required_fields"])
            row["metadata"] = json.loads(row["metadata"])
            row.setdefault("draft_status", "not_ready")
            row.setdefault("created_at", datetime.now(timezone.utc))
            row.setdefault("updated_at", datetime.now(timezone.utc))
            row.setdefault("consent_request_id", None)
            row.setdefault("draft_subject", None)
            row.setdefault("draft_body", None)
            self.workflows.append(row)
            return SimpleNamespace(data=[row])
        if "update one_kyc_workflows" in normalized:
            workflow_id = params["workflow_id"]
            row = next(item for item in self.workflows if item["workflow_id"] == workflow_id)
            for key, value in params.items():
                if key == "workflow_id" or key.startswith("set_"):
                    continue
                if not params.get(f"set_{key}", True):
                    continue
                row[key] = json.loads(value) if key == "metadata" else value
            row["updated_at"] = datetime.now(timezone.utc)
            return SimpleNamespace(data=[row])
        if "from one_kyc_workflows" in normalized and "where user_id" in normalized:
            rows = [row for row in self.workflows if row.get("user_id") == params.get("user_id")]
            return SimpleNamespace(data=rows)
        return SimpleNamespace(data=[])


class _FakeConsentDb:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.status_by_request: dict[str, dict] = {}
        self.export_metadata_by_token: dict[str, dict] = {}
        self.export_by_token: dict[str, dict] = {}

    async def insert_event(self, **kwargs):
        self.events.append(kwargs)
        return 1

    async def get_request_status(self, user_id: str, request_id: str):
        return self.status_by_request.get(request_id)

    async def get_consent_export_metadata(self, consent_token: str):
        if consent_token in self.export_by_token:
            export = self.export_by_token[consent_token]
            return {
                "scope": export.get("scope"),
                "export_revision": export.get("export_revision"),
                "export_generated_at": export.get("export_generated_at"),
                "refresh_status": export.get("refresh_status"),
                "wrapped_key_bundle": export.get("wrapped_key_bundle"),
                "connector_key_id": export.get("connector_key_id"),
                "connector_wrapping_alg": export.get("connector_wrapping_alg"),
                "is_strict_zero_knowledge": export.get("is_strict_zero_knowledge"),
            }
        return self.export_metadata_by_token.get(consent_token)

    async def get_consent_export(self, consent_token: str):
        return self.export_by_token.get(consent_token)


def _service(db: _FakeDb, consent_db: _FakeConsentDb) -> OneEmailKycService:
    service = OneEmailKycService(db=db, consent_db=consent_db)
    service._config = OneEmailKycConfig(
        service_account_info={"type": "service_account"},
        service_account_email="svc@project.iam.gserviceaccount.com",
        private_key="private",
        project_id="project",
        client_id="109021324828349644970",
        delegated_user="one@hushh.ai",
        mailbox_email="one@hushh.ai",
        pubsub_topic="projects/project/topics/one-email",
        webhook_audience=None,
        webhook_service_account_email=None,
        webhook_auth_enabled=False,
        watch_label_ids=("INBOX",),
        connector_public_key=_CONNECTOR_PUBLIC_B64,
        connector_key_id="one-kyc-key",
        connector_private_key=_CONNECTOR_PRIVATE_B64,
        default_kyc_scope="attr.identity.*",
        configured=True,
    )
    return service


def test_decode_pubsub_notification_normalizes_numeric_history_id():
    service = _service(_FakeDb(), _FakeConsentDb())
    payload = {
        "message": {
            "data": base64.b64encode(json.dumps({"historyId": 1681}).encode("utf-8")).decode(
                "utf-8"
            )
        }
    }

    notification = service._decode_pubsub_notification(payload)

    assert notification["historyId"] == "1681"


def test_from_env_rejects_unapproved_kyc_scope(monkeypatch):
    monkeypatch.setenv("ONE_EMAIL_KYC_DEFAULT_SCOPE", "attr.financial.*")

    with pytest.raises(OneEmailKycError) as exc:
        OneEmailKycConfig.from_env()

    assert exc.value.code == "ONE_KYC_SCOPE_NOT_ALLOWED"


@pytest.mark.asyncio
async def test_process_message_creates_scoped_kyc_consent_without_storing_raw_body():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    raw_body_marker = "SECRET_RAW_BODY_MARKER"

    result = await service._process_message(
        _message(
            body=(
                "Please complete KYC for our broker API. "
                "Required: full name, date of birth, address. "
                f"{raw_body_marker}"
            )
        ),
        history_id="100",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "needs_scope"
    assert workflow["requested_scope"] == "attr.identity.*"
    assert workflow["consent_request_id"].startswith("okyc_")
    assert len(workflow["consent_request_id"]) <= 32
    assert workflow["required_fields"] == ["full_name", "date_of_birth", "address"]
    assert consent_db.events[0]["agent_id"] == "agent_kyc"
    assert consent_db.events[0]["scope"] == "attr.identity.*"
    assert consent_db.events[0]["request_id"] == workflow["consent_request_id"]
    assert consent_db.events[0]["metadata"]["requester_actor_type"] == "developer"
    assert consent_db.events[0]["metadata"]["connector_public_key"] == _CONNECTOR_PUBLIC_B64
    assert raw_body_marker not in json.dumps(db.workflows, default=str)


@pytest.mark.asyncio
async def test_duplicate_message_repairs_missing_consent_request():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    row = {
        "workflow_id": "a" * 32,
        "user_id": "user_123",
        "status": "needs_scope",
        "gmail_message_id": "gmail_msg_1",
        "gmail_thread_id": "gmail_thread_1",
        "gmail_history_id": "100",
        "sender_email": "broker@example.com",
        "sender_name": "Broker Ops",
        "participant_emails": ["broker@example.com", "verified@example.com"],
        "subject": "Broker API KYC questionnaire",
        "snippet": None,
        "counterparty_label": "Broker Ops",
        "rfc_message_id": "<m1@example.com>",
        "required_fields": ["full_name"],
        "requested_scope": "attr.identity.*",
        "last_error_code": None,
        "last_error_message": None,
        "metadata": {"source": "one_email_kyc_v1"},
        "consent_request_id": None,
        "draft_subject": None,
        "draft_body": None,
        "draft_status": "not_ready",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    db.workflows.append(row)

    result = await service.process_message_id("gmail_msg_1", history_id="101")

    assert result["reason"] == "consent_request_repaired"
    assert result["workflow"]["consent_request_id"] == "okyc_" + ("a" * 27)
    assert len(result["workflow"]["consent_request_id"]) == 32
    assert consent_db.events[0]["request_id"] == result["workflow"]["consent_request_id"]


@pytest.mark.asyncio
async def test_duplicate_message_repairs_legacy_consent_url():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    request_id = "okyc_" + ("b" * 27)
    row = {
        "workflow_id": "b" * 32,
        "user_id": "user_123",
        "status": "needs_scope",
        "gmail_message_id": "gmail_msg_1",
        "gmail_thread_id": "gmail_thread_1",
        "gmail_history_id": "100",
        "sender_email": "broker@example.com",
        "sender_name": "Broker Ops",
        "participant_emails": ["broker@example.com", "verified@example.com"],
        "subject": "Broker API KYC questionnaire",
        "snippet": None,
        "counterparty_label": "Broker Ops",
        "rfc_message_id": "<m1@example.com>",
        "required_fields": ["full_name"],
        "requested_scope": "attr.identity.*",
        "last_error_code": None,
        "last_error_message": None,
        "metadata": {
            "source": "one_email_kyc_v1",
            "consent_request_url": (
                "https://uat.kai.hushh.ai/profile?tab=privacy&sheet=consents"
                f"&consentView=pending&requestId={request_id}"
            ),
        },
        "consent_request_id": request_id,
        "draft_subject": None,
        "draft_body": None,
        "draft_status": "not_ready",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    db.workflows.append(row)

    result = await service.process_message_id("gmail_msg_1", history_id="101")

    assert result["reason"] == "consent_request_repaired"
    assert "/consents?tab=pending" in result["workflow"]["consent_request_url"]
    assert "/profile?" not in result["workflow"]["consent_request_url"]
    assert consent_db.events == []


@pytest.mark.asyncio
async def test_process_message_blocks_unknown_user_without_creating_consent():
    db = _FakeDb(user_id=None)
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    service._find_firebase_users_by_email = lambda emails: []

    result = await service._process_message(
        _message(body="KYC questionnaire for broker onboarding."),
        history_id="101",
    )

    assert result["workflow"]["status"] == "blocked"
    assert result["workflow"]["last_error_code"] == "user_not_found"
    assert consent_db.events == []


@pytest.mark.asyncio
async def test_refresh_workflow_generates_review_draft_after_consent_granted():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="102",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_123",
    }
    consent_db.export_by_token["token_123"] = _encrypted_export(
        {
            "identity": {
                "full_name": "Test Reviewer",
            }
        }
    )

    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    assert workflow["status"] == "waiting_on_user"
    assert workflow["draft_status"] == "ready"
    assert "through One" in workflow["draft_body"]
    assert "full name: Test Reviewer" in workflow["draft_body"]


@pytest.mark.asyncio
async def test_refresh_workflow_moves_to_needs_documents_when_export_is_incomplete():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name and date of birth."),
        history_id="103",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_missing",
    }
    consent_db.export_by_token["token_missing"] = _encrypted_export(
        {
            "identity": {
                "full_name": "Test Reviewer",
            }
        }
    )

    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    assert workflow["status"] == "needs_documents"
    assert workflow["draft_status"] == "not_ready"
    assert workflow["last_error_code"] == "kyc_missing_approved_fields"
    assert "date of birth" in workflow["last_error_message"]

    consent_db.export_by_token["token_missing"] = _encrypted_export(
        {
            "identity": {
                "full_name": "Test Reviewer",
                "date_of_birth": "1990-01-01",
            }
        }
    )

    repaired = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    assert repaired["status"] == "waiting_on_user"
    assert "date of birth: 1990-01-01" in repaired["draft_body"]


@pytest.mark.asyncio
async def test_redraft_updates_review_draft_without_sending():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="104",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_redraft",
    }
    consent_db.export_by_token["token_redraft"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    redrafted = await service.redraft(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        instructions="Make this shorter.",
        source="voice",
    )

    assert redrafted["status"] == "waiting_on_user"
    assert redrafted["draft_status"] == "ready"
    assert "User requested adjustment: Make this shorter." in redrafted["draft_body"]
    assert redrafted["metadata"]["draft_revision"] == 2
    assert redrafted["metadata"]["last_redraft_source"] == "voice"


@pytest.mark.asyncio
async def test_approve_draft_revalidates_consent_and_sends_from_one_display_name():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="105",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_send",
    }
    consent_db.export_by_token["token_send"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )
    sent_payloads = []

    def _capture_send(url, *, json_payload, scopes):
        sent_payloads.append(json_payload)
        return {"id": "gmail_sent_1"}

    service._post_json_sync = _capture_send

    sent = await service.approve_draft(user_id="user_123", workflow_id=workflow["workflow_id"])

    assert sent["status"] == "waiting_on_counterparty"
    assert sent["draft_status"] == "sent"
    raw = sent_payloads[0]["raw"]
    parsed = email.message_from_bytes(
        base64.urlsafe_b64decode((raw + ("=" * (-len(raw) % 4))).encode("utf-8"))
    )
    assert parsed["From"] == "One <one@hushh.ai>"


@pytest.mark.asyncio
async def test_approve_draft_rejects_when_bound_export_revision_changes():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="106",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_revision",
    }
    consent_db.export_by_token["token_revision"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}},
        export_revision=1,
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )
    consent_db.export_by_token["token_revision"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}},
        export_revision=2,
    )

    with pytest.raises(OneEmailKycError) as exc:
        await service.approve_draft(user_id="user_123", workflow_id=workflow["workflow_id"])

    assert exc.value.code == "ONE_KYC_DRAFT_EXPORT_STALE"


@pytest.mark.asyncio
async def test_reject_draft_requires_ready_review_draft():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="107",
    )

    with pytest.raises(OneEmailKycError) as exc:
        await service.reject_draft(
            user_id="user_123",
            workflow_id=result["workflow"]["workflow_id"],
            reason="not ready",
        )

    assert exc.value.code == "ONE_KYC_DRAFT_NOT_READY"
