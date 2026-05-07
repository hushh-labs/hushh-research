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


def _message(
    *,
    body: str,
    sender: str = "broker@example.com",
    cc: str = "User <verified@example.com>",
    subject: str = "Broker API KYC questionnaire",
) -> dict:
    return {
        "id": "gmail_msg_1",
        "threadId": "gmail_thread_1",
        "snippet": "raw snippet should not be stored",
        "payload": {
            "headers": [
                {"name": "From", "value": f"Broker Ops <{sender}>"},
                {"name": "To", "value": "one@hushh.ai"},
                {"name": "Cc", "value": cc},
                {"name": "Subject", "value": subject},
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


def test_config_enables_webhook_auth_from_deploy_environment(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("ONE_EMAIL_WEBHOOK_AUTH_ENABLED", raising=False)
    monkeypatch.delenv("GMAIL_WEBHOOK_AUTH_ENABLED", raising=False)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")

    config = OneEmailKycConfig.from_env()

    assert config.webhook_auth_enabled is True


class _FakeDb:
    def __init__(
        self,
        *,
        user_id: str | None = "user_123",
        connector: bool = True,
        alias_rows: list[dict] | None = None,
        identity_rows: list[dict] | None = None,
    ) -> None:
        self.user_id = user_id
        self.workflows: list[dict] = []
        self.connectors: list[dict] = []
        self.alias_rows = alias_rows or []
        self.identity_rows = identity_rows
        if user_id and connector:
            self.connectors.append(
                {
                    "connector_id": "connector_1",
                    "user_id": user_id,
                    "connector_key_id": "one-kyc-key",
                    "connector_public_key": _CONNECTOR_PUBLIC_B64,
                    "connector_wrapping_alg": "X25519-AES256-GCM",
                    "public_key_fingerprint": "fp_1",
                    "status": "active",
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "rotated_at": None,
                    "revoked_at": None,
                }
            )

    def execute_raw(self, sql: str, params: dict | None = None):
        params = params or {}
        normalized = " ".join(sql.lower().split())
        if "from actor_identity_cache" in normalized:
            emails = set(params.get("emails") or [])
            if self.identity_rows is not None:
                return SimpleNamespace(
                    data=[row for row in self.identity_rows if row.get("email") in emails]
                )
            if not self.user_id or "verified@example.com" not in emails:
                return SimpleNamespace(data=[])
            return SimpleNamespace(
                data=[{"user_id": self.user_id, "email": "verified@example.com"}]
            )
        if "from actor_verified_email_aliases" in normalized:
            emails = set(params.get("emails") or [])
            return SimpleNamespace(
                data=[
                    row
                    for row in self.alias_rows
                    if row.get("verification_status", "verified") == "verified"
                    and row.get("revoked_at") is None
                    and row.get("email_normalized") in emails
                ]
            )
        if "from one_kyc_workflows" in normalized and "where gmail_message_id" in normalized:
            message_id = params.get("gmail_message_id")
            rows = [row for row in self.workflows if row.get("gmail_message_id") == message_id]
            return SimpleNamespace(data=rows[:1])
        if "from one_kyc_client_connectors" in normalized:
            rows = [
                row
                for row in self.connectors
                if row.get("user_id") == params.get("user_id") and row.get("status") == "active"
            ]
            return SimpleNamespace(data=rows[:1])
        if "update one_kyc_client_connectors" in normalized:
            for row in self.connectors:
                if (
                    row.get("user_id") == params.get("user_id")
                    and row.get("connector_key_id") != params.get("connector_key_id")
                    and row.get("status") == "active"
                ):
                    row["status"] = "rotated"
                    row["rotated_at"] = datetime.now(timezone.utc)
                    row["updated_at"] = datetime.now(timezone.utc)
            return SimpleNamespace(data=[])
        if "insert into one_kyc_client_connectors" in normalized:
            existing = next(
                (
                    row
                    for row in self.connectors
                    if row.get("user_id") == params.get("user_id")
                    and row.get("connector_key_id") == params.get("connector_key_id")
                ),
                None,
            )
            if existing is None:
                existing = {
                    "connector_id": f"connector_{len(self.connectors) + 1}",
                    "created_at": datetime.now(timezone.utc),
                    "rotated_at": None,
                    "revoked_at": None,
                }
                self.connectors.append(existing)
            existing.update(
                {
                    "user_id": params.get("user_id"),
                    "connector_key_id": params.get("connector_key_id"),
                    "connector_public_key": params.get("connector_public_key"),
                    "connector_wrapping_alg": params.get("connector_wrapping_alg"),
                    "public_key_fingerprint": params.get("public_key_fingerprint"),
                    "status": "active",
                    "updated_at": datetime.now(timezone.utc),
                    "revoked_at": None,
                }
            )
            return SimpleNamespace(data=[existing])
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
            row.setdefault("send_attempt_id", None)
            row.setdefault("send_status", "not_started")
            row.setdefault("sent_message_id", None)
            row.setdefault("sent_at", None)
            row.setdefault("client_draft_hash", None)
            row.setdefault("approved_send_hash", None)
            row.setdefault("pkm_writeback_status", "not_started")
            row.setdefault("pkm_writeback_artifact_hash", None)
            row.setdefault("pkm_writeback_attempt_count", 0)
            row.setdefault("pkm_writeback_last_error", None)
            row.setdefault("pkm_writeback_completed_at", None)
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
        default_kyc_scope="attr.identity.*",
        strict_client_zk_enabled=True,
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
async def test_process_message_waits_for_client_connector_before_consent():
    db = _FakeDb(connector=False)
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    result = await service._process_message(
        _message(body="Please complete KYC for our broker API. Required: full name."),
        history_id="100",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "needs_client_connector"
    assert workflow["last_error_code"] == "kyc_client_connector_missing"
    assert consent_db.events == []


@pytest.mark.asyncio
async def test_register_client_connector_repairs_waiting_workflow():
    db = _FakeDb(connector=False)
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    result = await service._process_message(
        _message(body="Please complete KYC for our broker API. Required: full name."),
        history_id="100",
    )
    assert result["workflow"]["status"] == "needs_client_connector"

    registered = await service.register_client_connector(
        user_id="user_123",
        connector_public_key=_CONNECTOR_PUBLIC_B64,
        connector_key_id="one-kyc-key",
        connector_wrapping_alg="X25519-AES256-GCM",
    )
    assert registered["configured"] is True

    refreshed = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    assert refreshed["status"] == "needs_scope"
    assert refreshed["consent_request_id"].startswith("okyc_")
    assert consent_db.events[0]["metadata"]["connector_public_key"] == _CONNECTOR_PUBLIC_B64
    assert consent_db.events[0]["metadata"]["connector_key_id"] == "one-kyc-key"


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
    assert "/consents?tab=incoming" in result["workflow"]["consent_request_url"]
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
async def test_process_message_matches_verified_email_alias_without_relay_inference():
    db = _FakeDb(
        user_id="user_123",
        alias_rows=[
            {
                "user_id": "user_123",
                "email": "original@example.com",
                "email_normalized": "original@example.com",
                "verification_status": "verified",
                "revoked_at": None,
            }
        ],
    )
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    result = await service._process_message(
        _message(
            body="KYC questionnaire for broker onboarding. Required: full name.",
            cc="Original User <original@example.com>",
        ),
        history_id="101a",
    )

    assert result["workflow"]["user_id"] == "user_123"
    assert result["workflow"]["status"] == "needs_scope"
    assert result["workflow"]["consent_request_id"].startswith("okyc_")
    assert consent_db.events


@pytest.mark.asyncio
async def test_process_message_prefers_verified_recipient_identity_over_sender_identity():
    db = _FakeDb(
        user_id="relay_user",
        identity_rows=[
            {
                "user_id": "gmail_user",
                "email": "kushaltrivedi1711@gmail.com",
                "email_verified": True,
            },
            {
                "user_id": "relay_user",
                "email": "jd77v9k4nx@privaterelay.appleid.com",
                "email_verified": True,
            },
        ],
    )
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    result = await service._process_message(
        _message(
            sender="kushaltrivedi1711@gmail.com",
            cc="Kushal Relay <jd77v9k4nx@privaterelay.appleid.com>",
            subject="KYC check",
            body="Hey One, can you draft an email that has all my financial information",
        ),
        history_id="101relay",
    )

    workflow = result["workflow"]
    assert workflow["user_id"] == "relay_user"
    assert workflow["status"] == "needs_scope"
    assert workflow["metadata"]["identity_match_source"] == "recipients"
    assert workflow["metadata"]["identity_matched_by"] == "actor_identity_cache"
    assert workflow["consent_request_id"].startswith("okyc_")
    assert consent_db.events


@pytest.mark.asyncio
async def test_process_message_blocks_ambiguous_verified_aliases():
    db = _FakeDb(
        user_id=None,
        alias_rows=[
            {
                "user_id": "user_123",
                "email": "original@example.com",
                "email_normalized": "original@example.com",
                "verification_status": "verified",
                "revoked_at": None,
            },
            {
                "user_id": "user_456",
                "email": "original@example.com",
                "email_normalized": "original@example.com",
                "verification_status": "verified",
                "revoked_at": None,
            },
        ],
    )
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    service._find_firebase_users_by_email = lambda emails: []

    result = await service._process_message(
        _message(
            body="KYC questionnaire for broker onboarding.",
            cc="Original User <original@example.com>",
        ),
        history_id="101b",
    )

    assert result["workflow"]["status"] == "blocked"
    assert result["workflow"]["last_error_code"] == "ambiguous_identity_resolution"
    assert consent_db.events == []


@pytest.mark.asyncio
async def test_refresh_workflow_marks_client_draft_ready_without_decrypting_export():
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

    service._decrypt_scoped_export = None  # type: ignore[attr-defined]

    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    assert workflow["status"] == "waiting_on_user"
    assert workflow["draft_status"] == "ready"
    assert workflow["draft_body"] is None
    assert "consent_token" not in workflow
    assert "consent_token" not in workflow["metadata"]
    assert workflow["metadata"]["client_draft_required"] is True
    assert workflow["metadata"]["consent_export"]["connector_key_id"] == "one-kyc-key"

    export_package = await service.get_workflow_consent_export(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )
    assert export_package["status"] == "success"
    assert export_package["encrypted_data"]
    assert export_package["wrapped_key_bundle"]["connector_key_id"] == "one-kyc-key"
    assert "token_123" not in json.dumps(export_package, default=str)


@pytest.mark.asyncio
async def test_refresh_workflow_rejects_export_for_wrong_client_connector_key():
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
        },
        export_revision=1,
    )

    consent_db.export_by_token["token_missing"]["connector_key_id"] = "other-key"
    consent_db.export_by_token["token_missing"]["wrapped_key_bundle"]["connector_key_id"] = (
        "other-key"
    )

    with pytest.raises(OneEmailKycError) as exc:
        await service.refresh_workflow(
            user_id="user_123",
            workflow_id=result["workflow"]["workflow_id"],
        )

    assert exc.value.code == "ONE_KYC_CONNECTOR_KEY_MISMATCH"


@pytest.mark.asyncio
async def test_redraft_records_instruction_hash_without_storing_plaintext():
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
    assert redrafted["draft_body"] is None
    assert redrafted["metadata"]["draft_revision"] == 2
    assert redrafted["metadata"]["last_redraft_source"] == "voice"
    assert "last_redraft_instruction_hash" in redrafted["metadata"]
    assert "Make this shorter." not in json.dumps(db.workflows, default=str)


@pytest.mark.asyncio
async def test_send_approved_reply_revalidates_consent_and_sends_transient_body():
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

    sent = await service.send_approved_reply(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        approved_subject=workflow["draft_subject"],
        approved_body="Approved KYC reply body",
        client_draft_hash="draft_hash_1",
        consent_export_revision=1,
        pkm_writeback_artifact_hash="a" * 64,
    )

    assert sent["status"] == "waiting_on_counterparty"
    assert sent["draft_status"] == "sent"
    assert sent["send_status"] == "sent"
    assert sent["draft_body"] is None
    raw = sent_payloads[0]["raw"]
    parsed = email.message_from_bytes(
        base64.urlsafe_b64decode((raw + ("=" * (-len(raw) % 4))).encode("utf-8"))
    )
    assert parsed["From"] == "One <one@hushh.ai>"
    assert parsed.get_payload() == "Approved KYC reply body\n"
    assert "Approved KYC reply body" not in json.dumps(db.workflows, default=str)


@pytest.mark.asyncio
async def test_send_approved_reply_rejects_when_bound_export_revision_changes():
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
        await service.send_approved_reply(
            user_id="user_123",
            workflow_id=workflow["workflow_id"],
            approved_subject=workflow["draft_subject"],
            approved_body="Approved KYC reply body",
            consent_export_revision=1,
            pkm_writeback_artifact_hash="a" * 64,
        )

    assert exc.value.code == "ONE_KYC_DRAFT_EXPORT_STALE"


@pytest.mark.asyncio
async def test_send_approved_reply_clears_writeback_pending_when_gmail_send_fails():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="106a",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_send_failed",
    }
    consent_db.export_by_token["token_send_failed"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    def _fail_send(url, *, json_payload, scopes):
        raise RuntimeError("gmail unavailable")

    service._post_json_sync = _fail_send

    with pytest.raises(RuntimeError):
        await service.send_approved_reply(
            user_id="user_123",
            workflow_id=workflow["workflow_id"],
            approved_subject=workflow["draft_subject"],
            approved_body="Approved KYC reply body",
            consent_export_revision=1,
            pkm_writeback_artifact_hash="a" * 64,
        )

    failed = await service.get_workflow(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
    )
    assert failed["send_status"] == "failed"
    assert failed["pkm_writeback_status"] == "not_started"


@pytest.mark.asyncio
async def test_writeback_complete_updates_metadata_without_plaintext():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="106b",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_writeback",
    }
    consent_db.export_by_token["token_writeback"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )
    service._post_json_sync = lambda url, *, json_payload, scopes: {"id": "gmail_sent_writeback"}
    sent = await service.send_approved_reply(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        approved_subject=workflow["draft_subject"],
        approved_body="Approved KYC reply body",
        consent_export_revision=1,
        pkm_writeback_artifact_hash="b" * 64,
    )

    updated = await service.mark_writeback_complete(
        user_id="user_123",
        workflow_id=sent["workflow_id"],
        artifact_hash="b" * 64,
        status="succeeded",
    )

    assert updated["pkm_writeback_status"] == "succeeded"
    assert updated["pkm_writeback_artifact_hash"] == "b" * 64
    assert updated["pkm_writeback_attempt_count"] == 1
    assert "b" * 64 in json.dumps(db.workflows, default=str)
    assert "Approved KYC reply body" not in json.dumps(db.workflows, default=str)


@pytest.mark.asyncio
async def test_writeback_complete_requires_declared_artifact_hash_match():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="106bb",
    )
    request_id = result["workflow"]["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_writeback_mismatch",
    }
    consent_db.export_by_token["token_writeback_mismatch"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )
    service._post_json_sync = lambda url, *, json_payload, scopes: {"id": "gmail_sent_writeback"}
    sent = await service.send_approved_reply(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        approved_subject=workflow["draft_subject"],
        approved_body="Approved KYC reply body",
        consent_export_revision=1,
        pkm_writeback_artifact_hash="a" * 64,
    )

    with pytest.raises(OneEmailKycError) as exc:
        await service.mark_writeback_complete(
            user_id="user_123",
            workflow_id=sent["workflow_id"],
            artifact_hash="b" * 64,
            status="succeeded",
        )

    assert exc.value.code == "ONE_KYC_WRITEBACK_ARTIFACT_HASH_MISMATCH"


@pytest.mark.asyncio
async def test_writeback_complete_requires_sent_reply():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="106c",
    )

    with pytest.raises(OneEmailKycError) as exc:
        await service.mark_writeback_complete(
            user_id="user_123",
            workflow_id=result["workflow"]["workflow_id"],
            artifact_hash="b" * 64,
            status="succeeded",
        )

    assert exc.value.code == "ONE_KYC_WRITEBACK_NOT_READY"


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
