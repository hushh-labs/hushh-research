import base64
import email
import email.policy
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from hushh_mcp.consent.scope_helpers import scope_matches
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
    sender: str = "verified@example.com",
    to: str = "one@hushh.ai",
    cc: str = "",
    subject: str = "Broker API KYC questionnaire",
) -> dict:
    return {
        "id": "gmail_msg_1",
        "threadId": "gmail_thread_1",
        "snippet": "raw snippet should not be stored",
        "payload": {
            "headers": [
                {"name": "From", "value": f"Broker Ops <{sender}>"},
                {"name": "To", "value": to},
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
        if (
            "from one_kyc_workflows" in normalized
            and "where user_id" in normalized
            and "workflow_id = :workflow_id" in normalized
        ):
            rows = [
                row
                for row in self.workflows
                if row.get("user_id") == params.get("user_id")
                and row.get("workflow_id") == params.get("workflow_id")
            ]
            return SimpleNamespace(data=rows[:1])
        if "from one_kyc_workflows" in normalized and "where user_id" in normalized:
            rows = [row for row in self.workflows if row.get("user_id") == params.get("user_id")]
            return SimpleNamespace(data=rows)
        return SimpleNamespace(data=[])


class _FakeConsentDb:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.status_by_request: dict[str, dict] = {}
        self.active_tokens: list[dict] = []
        self.export_metadata_by_token: dict[str, dict] = {}
        self.export_by_token: dict[str, dict] = {}

    async def insert_event(self, **kwargs):
        self.events.append(kwargs)
        request_id = kwargs.get("request_id")
        if request_id:
            self.status_by_request[request_id] = kwargs
        return 1

    async def get_request_status(self, user_id: str, request_id: str):
        return self.status_by_request.get(request_id)

    async def get_pending_by_request_id(self, user_id: str, request_id: str):
        status = self.status_by_request.get(request_id)
        if status and status.get("action") == "REQUESTED":
            return status
        return None

    async def get_covering_active_tokens(
        self,
        user_id: str,
        *,
        requested_scope: str,
        agent_id: str | None = None,
    ):
        return [
            token
            for token in self.active_tokens
            if token.get("user_id", user_id) == user_id
            and (agent_id is None or token.get("agent_id") == agent_id)
            and scope_matches(str(token.get("scope") or ""), requested_scope)
        ]

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


async def _select_identity_scope(service: OneEmailKycService, workflow: dict) -> dict:
    return await service.select_scopes(
        user_id=workflow["user_id"],
        workflow_id=workflow["workflow_id"],
        selected_scopes=["attr.identity.*"],
    )


def _workflow_row(
    workflow_id: str,
    *,
    user_id: str = "user_123",
    status: str = "needs_scope",
    created_at: datetime | None = None,
    metadata: dict | None = None,
) -> dict:
    timestamp = created_at or datetime.now(timezone.utc)
    return {
        "workflow_id": workflow_id,
        "user_id": user_id,
        "status": status,
        "gmail_message_id": f"gmail_msg_{workflow_id}",
        "gmail_thread_id": f"gmail_thread_{workflow_id}",
        "gmail_history_id": "100",
        "sender_email": "verified@example.com",
        "sender_name": "Verified Sender",
        "participant_emails": ["verified@example.com"],
        "subject": f"Request {workflow_id}",
        "snippet": None,
        "counterparty_label": "Verified Sender",
        "rfc_message_id": f"<{workflow_id}@example.com>",
        "required_fields": ["preferences"],
        "requested_scope": "attr.travel.*",
        "last_error_code": None,
        "last_error_message": None,
        "metadata": {"source": "one_email_kyc_v1", **(metadata or {})},
        "consent_request_id": None,
        "draft_subject": None,
        "draft_body": None,
        "draft_status": "not_ready",
        "send_attempt_id": None,
        "send_status": "not_started",
        "sent_message_id": None,
        "sent_at": None,
        "client_draft_hash": None,
        "approved_send_hash": None,
        "pkm_writeback_status": "not_started",
        "pkm_writeback_artifact_hash": None,
        "pkm_writeback_attempt_count": 0,
        "pkm_writeback_last_error": None,
        "pkm_writeback_completed_at": None,
        "created_at": timestamp,
        "updated_at": timestamp,
    }


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
async def test_list_workflows_paginates_and_excludes_archived_requests():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    db.workflows.extend(
        [
            _workflow_row(
                "wf_old",
                created_at=datetime(2026, 5, 18, 10, 0, tzinfo=timezone.utc),
            ),
            _workflow_row(
                "wf_archived",
                created_at=datetime(2026, 5, 18, 11, 0, tzinfo=timezone.utc),
                metadata={"archived_at": "2026-05-18T11:30:00+00:00"},
            ),
            _workflow_row(
                "wf_mid",
                created_at=datetime(2026, 5, 18, 12, 0, tzinfo=timezone.utc),
            ),
            _workflow_row(
                "wf_new",
                created_at=datetime(2026, 5, 18, 13, 0, tzinfo=timezone.utc),
            ),
        ]
    )

    first_page = await service.list_workflows(user_id="user_123", limit=2)

    assert [row["workflow_id"] for row in first_page["workflows"]] == [
        "wf_new",
        "wf_mid",
    ]
    assert first_page["has_more"] is True
    assert first_page["next_cursor"]

    second_page = await service.list_workflows(
        user_id="user_123",
        limit=2,
        cursor=first_page["next_cursor"],
    )

    assert [row["workflow_id"] for row in second_page["workflows"]] == ["wf_old"]
    assert second_page["has_more"] is False
    assert second_page["next_cursor"] is None


@pytest.mark.asyncio
async def test_archive_workflow_soft_hides_request_from_default_list():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    db.workflows.append(
        _workflow_row(
            "wf_remove",
            created_at=datetime(2026, 5, 18, 10, 0, tzinfo=timezone.utc),
        )
    )

    archived = await service.archive_workflow(
        user_id="user_123",
        workflow_id="wf_remove",
    )
    default_page = await service.list_workflows(user_id="user_123", limit=10)
    audit_page = await service.list_workflows(
        user_id="user_123",
        limit=10,
        include_archived=True,
    )

    assert archived["metadata"]["archived_at"]
    assert default_page["workflows"] == []
    assert [row["workflow_id"] for row in audit_page["workflows"]] == ["wf_remove"]


@pytest.mark.asyncio
async def test_select_scopes_can_change_data_before_reply_is_sent():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    db.workflows.append(
        _workflow_row(
            "wf_ready",
            status="waiting_on_user",
            metadata={
                "candidate_scopes": [
                    {
                        "scope": "attr.travel.*",
                        "domain": "travel",
                        "label": "Travel data",
                    },
                    {
                        "scope": "attr.shopping.*",
                        "domain": "shopping",
                        "label": "Shopping data",
                    },
                ],
                "selected_scopes": ["attr.travel.*"],
                "requested_scopes": ["attr.travel.*"],
            },
        )
    )

    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id="wf_ready",
        selected_scopes=["attr.shopping.*"],
    )

    assert selected["status"] == "needs_scope"
    assert selected["requested_scope"] == "attr.shopping.*"
    assert selected["selected_scopes"] == ["attr.shopping.*"]
    assert selected["draft_status"] == "not_ready"


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
    assert workflow["consent_request_id"] is None
    assert workflow["metadata"]["scope_selection_required"] is True
    assert workflow["metadata"]["candidate_scopes"][0]["scope"] == "attr.identity.*"
    assert workflow["required_fields"] == ["full_name", "date_of_birth", "address"]
    assert consent_db.events == []
    assert raw_body_marker not in json.dumps(db.workflows, default=str)

    selected = await _select_identity_scope(service, workflow)
    assert selected["consent_request_id"].startswith("okyc_")
    assert len(selected["consent_request_id"]) <= 32
    assert consent_db.events[0]["agent_id"] == "agent_kyc"
    assert consent_db.events[0]["scope"] == "attr.identity.*"
    assert consent_db.events[0]["request_id"] == selected["consent_request_id"]
    assert consent_db.events[0]["metadata"]["requester_actor_type"] == "developer"
    assert consent_db.events[0]["metadata"]["connector_public_key"] == _CONNECTOR_PUBLIC_B64


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
    assert refreshed["consent_request_id"] is None
    selected = await _select_identity_scope(service, refreshed)
    assert selected["consent_request_id"].startswith("okyc_")
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
    assert consent_db.events[0]["action"] == "REQUESTED"
    assert consent_db.events[0]["request_id"] == request_id


@pytest.mark.asyncio
async def test_refresh_workflow_reissues_missing_pending_consent_request():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="102-missing-consent",
    )
    selected = await _select_identity_scope(service, result["workflow"])
    request_id = selected["consent_request_id"]
    consent_db.events.clear()
    consent_db.status_by_request.pop(request_id, None)

    refreshed = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    assert refreshed["status"] == "needs_scope"
    assert refreshed["consent_request_id"] == request_id
    assert refreshed["metadata"]["consent_requests"][0]["request_id"] == request_id
    assert refreshed["metadata"]["consent_request_reissued_at"]
    assert consent_db.events
    assert consent_db.events[0]["action"] == "REQUESTED"
    assert consent_db.events[0]["request_id"] == request_id


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
async def test_process_message_matches_verified_sender_alias_without_relay_inference():
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
            sender="original@example.com",
            body="KYC questionnaire for broker onboarding. Required: full name.",
            cc="",
        ),
        history_id="101a",
    )

    assert result["workflow"]["user_id"] == "user_123"
    assert result["workflow"]["status"] == "needs_scope"
    assert result["workflow"]["metadata"]["identity_match_source"] == "sender"
    assert result["workflow"]["metadata"]["identity_matched_by"] == "actor_verified_email_alias"
    assert result["workflow"]["consent_request_id"] is None
    selected = await _select_identity_scope(service, result["workflow"])
    assert selected["consent_request_id"].startswith("okyc_")
    assert consent_db.events


@pytest.mark.asyncio
async def test_process_message_does_not_bind_recipient_distribution_list_to_user():
    db = _FakeDb(
        user_id=None,
        identity_rows=[
            {
                "user_id": "kushal_user",
                "email": "kushaltrivedi1711@gmail.com",
                "email_verified": True,
            }
        ],
    )
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    service._find_firebase_users_by_email = lambda emails: []

    result = await service._process_message(
        _message(
            sender="lars@example.com",
            to="One Distribution <one-team@hushh.ai>",
            cc="Kushal Trivedi <kushaltrivedi1711@gmail.com>",
            subject="Portfolio request",
            body="Can One get my portfolio information?",
        ),
        history_id="101distribution",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "blocked"
    assert workflow["user_id"] is None
    assert workflow["last_error_code"] == "user_not_found"
    assert workflow["metadata"]["identity_match_source"] == "sender"
    assert workflow["metadata"]["reply_thread"]["matched_user_emails"] == []
    assert consent_db.events == []


@pytest.mark.asyncio
async def test_process_message_prefers_verified_sender_identity_over_copied_recipient():
    db = _FakeDb(
        user_id="gmail_user",
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
            to="one@hushh.ai, Ankit <ankit@hushh.ai>",
            cc="Kushal Relay <jd77v9k4nx@privaterelay.appleid.com>",
            subject="KYC check",
            body="Hey One, can you draft an email that has all my financial information",
        ),
        history_id="101relay",
    )

    workflow = result["workflow"]
    assert workflow["user_id"] == "gmail_user"
    assert workflow["status"] == "needs_scope"
    assert workflow["metadata"]["identity_match_source"] == "sender"
    assert workflow["metadata"]["identity_matched_by"] == "actor_identity_cache"
    assert workflow["metadata"]["reply_thread"]["reply_all_to"] == ["kushaltrivedi1711@gmail.com"]
    assert workflow["metadata"]["reply_thread"]["reply_all_cc"] == [
        "ankit@hushh.ai",
        "jd77v9k4nx@privaterelay.appleid.com",
    ]
    assert workflow["consent_request_id"] is None
    assert "attr.financial.*" in [
        item["scope"] for item in workflow["metadata"]["candidate_scopes"]
    ]
    selected = await service.select_scopes(
        user_id=workflow["user_id"],
        workflow_id=workflow["workflow_id"],
        selected_scopes=["attr.financial.*"],
    )
    assert selected["consent_request_id"].startswith("okyc_")
    assert consent_db.events


@pytest.mark.asyncio
async def test_process_message_accepts_verified_sender_direct_to_one_with_copied_recipient():
    db = _FakeDb(
        user_id="sender_user",
        identity_rows=[
            {
                "user_id": "sender_user",
                "email": "kushaltrivedi1711@gmail.com",
                "email_verified": True,
            },
            {
                "user_id": "copied_user",
                "email": "kushal@hushh.ai",
                "email_verified": True,
            },
        ],
    )
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    result = await service._process_message(
        _message(
            sender="kushaltrivedi1711@gmail.com",
            to='"one@hushh.ai" <one@hushh.ai>',
            cc='"kushal@hushh.ai" <kushal@hushh.ai>',
            subject="Financial request",
            body="forward my financial information over here",
        ),
        history_id="101financialdirect",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "needs_scope"
    assert workflow["user_id"] == "sender_user"
    assert workflow["metadata"]["identity_match_source"] == "sender"
    assert workflow["metadata"]["reply_thread"]["reply_all_to"] == ["kushaltrivedi1711@gmail.com"]
    assert workflow["metadata"]["reply_thread"]["reply_all_cc"] == ["kushal@hushh.ai"]
    assert any(
        candidate["scope"].startswith("attr.financial")
        for candidate in workflow["metadata"]["candidate_scopes"]
    )


@pytest.mark.asyncio
async def test_sync_recent_messages_catches_up_verified_sender_mail_without_webhook_state():
    db = _FakeDb(
        user_id="sender_user",
        identity_rows=[
            {
                "user_id": "sender_user",
                "email": "kushaltrivedi1711@gmail.com",
                "email_verified": True,
            }
        ],
    )
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    service._list_recent_message_ids = lambda max_results=12, newer_than_days=7: [  # type: ignore[method-assign]
        "gmail_msg_recent"
    ]
    service._fetch_message = lambda message_id: _message(  # type: ignore[method-assign]
        sender="kushaltrivedi1711@gmail.com",
        to='"one@hushh.ai" <one@hushh.ai>',
        subject="Financial request",
        body="forward my financial information over here",
    )

    result = await service.sync_recent_messages(user_id="sender_user", max_results=12)

    assert result["scanned_count"] == 1
    assert result["matched_count"] == 1
    assert result["workflows"][0]["user_id"] == "sender_user"
    assert result["workflows"][0]["status"] == "needs_scope"


@pytest.mark.asyncio
async def test_first_history_notification_catches_up_recent_messages_instead_of_dropping_them():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    service._get_mailbox_state = lambda: None  # type: ignore[method-assign]
    service._upsert_mailbox_state = lambda **kwargs: None  # type: ignore[method-assign]
    service._list_recent_message_ids = lambda max_results=12, newer_than_days=7: [  # type: ignore[method-assign]
        "gmail_msg_recent"
    ]
    service._fetch_message = lambda message_id: _message(  # type: ignore[method-assign]
        body="Please complete KYC. Required: full name.",
    )

    payload = {
        "message": {
            "data": base64.b64encode(json.dumps({"historyId": "200"}).encode("utf-8")).decode(
                "utf-8"
            )
        }
    }
    result = await service.handle_push_notification(payload, headers={})

    assert result["reason"] == "history_primed_recent_catchup"
    assert result["handled"] is True
    assert result["results"][0]["workflow"]["status"] == "needs_scope"


@pytest.mark.asyncio
async def test_process_message_matches_dynamic_available_scope_for_email_helper_request():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    async def available_entries(user_id: str):
        assert user_id == "user_123"
        return [
            {
                "scope": "attr.travel.*",
                "domain": "travel",
                "path": None,
                "wildcard": True,
                "label": "Travel Preferences",
                "consumer_visible": True,
                "internal_only": False,
            }
        ]

    service._available_one_email_scope_entries = available_entries  # type: ignore[method-assign]

    result = await service._process_message(
        _message(
            subject="Test",
            body="Hey One, can you get my favourite locations and create a draft here.",
        ),
        history_id="101dynamic",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "needs_scope"
    assert workflow["requested_scope"] == "attr.travel.*"
    assert workflow["metadata"]["classification"] == "dynamic_disclosure"
    assert workflow["metadata"]["dynamic_scope_detection"] is True
    assert workflow["required_fields"] == ["favorite_locations"]
    assert [item["scope"] for item in workflow["metadata"]["candidate_scopes"]] == ["attr.travel.*"]

    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        selected_scopes=["attr.travel.*"],
    )

    assert selected["requested_scopes"] == ["attr.travel.*"]
    assert consent_db.events[0]["scope"] == "attr.travel.*"


@pytest.mark.asyncio
async def test_dynamic_scope_detection_prefers_intent_domain_over_stopword_path_matches():
    service = _service(_FakeDb(), _FakeConsentDb())

    async def available_entries(user_id: str):
        assert user_id == "user_123"
        return [
            {
                "scope": (
                    "attr.financial.analysis_history.aapl.items.raw_card.key_metrics."
                    "fundamental.research_and_development_billions"
                ),
                "domain": "financial",
                "path": (
                    "analysis_history.aapl.items.raw_card.key_metrics.fundamental."
                    "research_and_development_billions"
                ),
                "wildcard": False,
                "label": "Research And Development Billions",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.shopping.*",
                "domain": "shopping",
                "path": None,
                "wildcard": True,
                "label": "Shopping Domain",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.shopping.receipts_memory",
                "domain": "shopping",
                "path": "receipts_memory",
                "wildcard": False,
                "label": "Receipts Memory",
                "consumer_visible": True,
                "internal_only": False,
            },
        ]

    service._available_one_email_scope_entries = available_entries  # type: ignore[method-assign]

    candidates = await service._detect_available_scope_candidates(
        user_id="user_123",
        subject="Get my information",
        body="Hey One, can you get my shopping information and create a draft here.",
    )

    assert [candidate["scope"] for candidate in candidates] == ["attr.shopping.*"]


@pytest.mark.asyncio
async def test_dynamic_scope_detection_prefers_seat_preferences_over_generic_preferences():
    service = _service(_FakeDb(), _FakeConsentDb())

    async def available_entries(user_id: str):
        assert user_id == "user_123"
        return [
            {
                "scope": "attr.travel.*",
                "domain": "travel",
                "path": None,
                "wildcard": True,
                "label": "Travel Domain",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.financial.profile.preferences",
                "domain": "financial",
                "path": "profile.preferences",
                "wildcard": False,
                "label": "Profile Preferences",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.location.preferences.*",
                "domain": "location",
                "path": "preferences",
                "wildcard": True,
                "label": "Preferences",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.travel.seat_preferences.*",
                "domain": "travel",
                "path": "seat_preferences",
                "wildcard": True,
                "label": "Seat Preferences",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.travel.seat_preferences.entities.travel_preference_seat_001",
                "domain": "travel",
                "path": "seat_preferences.entities.travel_preference_seat_001",
                "wildcard": False,
                "label": "Seat Preferences Entities Travel Preference Seat 001",
                "consumer_visible": True,
                "internal_only": False,
            },
        ]

    service._available_one_email_scope_entries = available_entries  # type: ignore[method-assign]

    candidates = await service._detect_available_scope_candidates(
        user_id="user_123",
        subject="Get my information",
        body="Hey One, can you get my seat preferences and create a draft here.",
    )

    assert [candidate["scope"] for candidate in candidates] == ["attr.travel.seat_preferences.*"]


@pytest.mark.asyncio
async def test_dynamic_scope_detection_prefers_financial_portfolio_metadata_scope():
    service = _service(_FakeDb(), _FakeConsentDb())

    async def available_entries(user_id: str):
        assert user_id == "user_123"
        return [
            {
                "scope": "attr.financial.*",
                "domain": "financial",
                "path": None,
                "wildcard": True,
                "label": "Financial Domain",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.financial.portfolio.*",
                "domain": "financial",
                "path": "portfolio",
                "wildcard": True,
                "label": "Portfolio",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.financial.analytics.*",
                "domain": "financial",
                "path": "analytics",
                "wildcard": True,
                "label": "Analytics",
                "consumer_visible": True,
                "internal_only": False,
            },
        ]

    service._available_one_email_scope_entries = available_entries  # type: ignore[method-assign]

    candidates = await service._detect_available_scope_candidates(
        user_id="user_123",
        subject="Portfolio request",
        body="Can you get my portfolio information?",
    )

    assert [candidate["scope"] for candidate in candidates] == ["attr.financial.portfolio.*"]


@pytest.mark.asyncio
async def test_dynamic_scope_detection_derives_required_field_from_scope_metadata():
    db = _FakeDb(
        user_id="sender_user",
        identity_rows=[
            {
                "user_id": "sender_user",
                "email": "kushaltrivedi1711@gmail.com",
                "email_verified": True,
            },
            {
                "user_id": "marked_recipient",
                "email": "ankit@hushh.ai",
                "email_verified": True,
            },
        ],
    )
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    async def available_entries(user_id: str):
        assert user_id == "sender_user"
        return [
            {
                "scope": "attr.mobility.cabin_comfort.*",
                "domain": "mobility",
                "path": "cabin_comfort",
                "wildcard": True,
                "label": "Cabin Comfort",
                "consumer_visible": True,
                "internal_only": False,
                "source_kind": "pkm_manifests.top_level_scope_paths",
            }
        ]

    service._available_one_email_scope_entries = available_entries  # type: ignore[method-assign]

    result = await service._process_message(
        _message(
            sender="kushaltrivedi1711@gmail.com",
            to="one@hushh.ai, Ankit <ankit@hushh.ai>",
            cc="",
            subject="Travel request",
            body="Hey One, please share my cabin comfort preference for this booking.",
        ),
        history_id="101dynamicmeta",
    )

    workflow = result["workflow"]
    assert workflow["user_id"] == "sender_user"
    assert workflow["metadata"]["identity_match_source"] == "sender"
    assert workflow["requested_scope"] == "attr.mobility.cabin_comfort.*"
    assert workflow["required_fields"] == ["cabin_comfort"]
    assert workflow["metadata"]["candidate_scopes"][0]["path"] == "cabin_comfort"
    assert workflow["metadata"]["reply_thread"]["reply_all_to"] == ["kushaltrivedi1711@gmail.com"]
    assert workflow["metadata"]["reply_thread"]["reply_all_cc"] == ["ankit@hushh.ai"]


@pytest.mark.asyncio
async def test_process_message_does_not_treat_email_subject_as_requested_email_field():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    async def available_entries(user_id: str):
        assert user_id == "user_123"
        return [
            {
                "scope": "attr.travel.seat_preferences.*",
                "domain": "travel",
                "path": "seat_preferences",
                "wildcard": True,
                "label": "Seat Preferences",
                "consumer_visible": True,
                "internal_only": False,
            }
        ]

    service._available_one_email_scope_entries = available_entries  # type: ignore[method-assign]

    result = await service._process_message(
        _message(
            subject="Test Email",
            body="Hey One, can you get my seat preferences and create a draft here.",
        ),
        history_id="101testemail",
    )

    workflow = result["workflow"]
    assert workflow["requested_scope"] == "attr.travel.seat_preferences.*"
    assert workflow["required_fields"] == ["seat_preferences"]
    assert "email" not in workflow["required_fields"]


@pytest.mark.asyncio
async def test_reply_classification_ignores_quoted_prior_thread_text():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    async def available_entries(user_id: str):
        assert user_id == "user_123"
        return [
            {
                "scope": "attr.shopping.*",
                "domain": "shopping",
                "path": None,
                "wildcard": True,
                "label": "Shopping Domain",
                "consumer_visible": True,
                "internal_only": False,
            },
            {
                "scope": "attr.travel.seat_preferences.*",
                "domain": "travel",
                "path": "seat_preferences",
                "wildcard": True,
                "label": "Seat Preferences",
                "consumer_visible": True,
                "internal_only": False,
            },
        ]

    service._available_one_email_scope_entries = available_entries  # type: ignore[method-assign]

    result = await service._process_message(
        _message(
            subject="Re: Get my information",
            body=(
                "can you get my seat preferences\n\n"
                "On Thu, 14 May 2026 at 04:57, Kushal Trivedi wrote:\n"
                "> can you retrieve my shopping preferences and share here.\n"
            ),
        ),
        history_id="101reply",
    )

    workflow = result["workflow"]
    assert workflow["requested_scope"] == "attr.travel.seat_preferences.*"
    assert workflow["required_fields"] == ["seat_preferences"]
    assert workflow["metadata"]["quoted_reply_text_stripped"] is True
    assert [item["scope"] for item in workflow["metadata"]["candidate_scopes"]] == [
        "attr.travel.seat_preferences.*"
    ]


@pytest.mark.asyncio
async def test_select_scopes_creates_bundled_multi_scope_consent_requests():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    result = await service._process_message(
        _message(
            subject="Broker API KYC and financial questionnaire",
            body=(
                "Please complete KYC and include all financial information for broker API "
                "onboarding. Required: full name, date of birth, portfolio."
            ),
        ),
        history_id="101multi",
    )

    workflow = result["workflow"]
    assert workflow["metadata"]["scope_selection_required"] is True
    assert [item["scope"] for item in workflow["metadata"]["candidate_scopes"]] == [
        "attr.identity.*",
        "attr.financial.*",
    ]

    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        selected_scopes=["attr.identity.*", "attr.financial.*"],
    )

    assert selected["status"] == "needs_scope"
    assert selected["requested_scope"] == "attr.identity.*"
    assert selected["requested_scopes"] == ["attr.identity.*", "attr.financial.*"]
    assert selected["metadata"]["scope_selection_required"] is False
    assert selected["consent_bundle_id"].startswith("okycb_")
    assert "/consents?tab=incoming" in selected["consent_request_url"]
    assert "bundleId=" in selected["consent_request_url"]
    assert len(consent_db.events) == 2
    bundle_ids = {event["metadata"]["bundle_id"] for event in consent_db.events}
    assert bundle_ids == {selected["consent_bundle_id"]}
    assert [event["scope"] for event in consent_db.events] == [
        "attr.identity.*",
        "attr.financial.*",
    ]


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
            sender="original@example.com",
            body="KYC questionnaire for broker onboarding.",
            cc="",
        ),
        history_id="101b",
    )

    assert result["workflow"]["status"] == "blocked"
    assert result["workflow"]["last_error_code"] == "ambiguous_identity_resolution"
    assert result["workflow"]["metadata"]["identity_match_source"] == "sender"
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
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
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
        workflow_id=workflow_with_consent["workflow_id"],
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
        workflow_id=workflow_with_consent["workflow_id"],
    )
    assert export_package["status"] == "success"
    assert export_package["encrypted_data"]
    assert export_package["wrapped_key_bundle"]["connector_key_id"] == "one-kyc-key"
    assert "token_123" not in json.dumps(export_package, default=str)


@pytest.mark.asyncio
async def test_select_scopes_reuses_existing_email_agent_grant_for_draft_readiness():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Portfolio request",
            body="Can you get my portfolio information?",
        ),
        history_id="102existing",
    )
    workflow = result["workflow"]
    assert workflow["status"] == "needs_scope"

    consent_db.active_tokens.append(
        {
            "user_id": "user_123",
            "agent_id": "agent_kyc",
            "scope": "attr.financial.portfolio.*",
            "request_id": "okyc_existing_portfolio",
            "token_id": "token_existing_portfolio",
        }
    )
    consent_db.export_by_token["token_existing_portfolio"] = _encrypted_export(
        {"financial": {"portfolio": [{"ticker": "UAT", "value": "test only"}]}},
        scope="attr.financial.portfolio.*",
        export_revision=4,
    )

    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        selected_scopes=["attr.financial.portfolio.*"],
    )

    assert selected["status"] == "waiting_on_user"
    assert selected["draft_status"] == "ready"
    assert selected["consent_request_id"] == "okyc_existing_portfolio"
    assert selected["metadata"]["reused_existing_consent_grant"] is True
    assert selected["metadata"]["consent_export"]["request_id"] == "okyc_existing_portfolio"
    assert consent_db.events == []


@pytest.mark.asyncio
async def test_select_scopes_marks_default_available_projection_ready_without_consent():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    db.workflows.append(
        _workflow_row(
            "default_available_financial",
            metadata={
                "scope_selection_required": True,
                "candidate_scopes": [
                    {
                        "scope": "attr.financial.portfolio.*",
                        "domain": "financial",
                        "label": "Portfolio",
                        "recommended": True,
                        "visibility_posture": "default_available",
                        "default_projection_ready": True,
                        "default_projection_updated_at": "2026-05-21T10:00:00Z",
                    }
                ],
            },
        )
    )

    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id="default_available_financial",
        selected_scopes=["attr.financial.portfolio.*"],
    )

    assert selected["status"] == "waiting_on_user"
    assert selected["draft_status"] == "ready"
    assert selected["consent_request_id"] is None
    assert selected["metadata"]["reused_default_available_projection"] is True
    assert selected["metadata"]["default_available_scopes"] == ["attr.financial.portfolio.*"]
    assert selected["metadata"]["consent_requests"] == []
    assert selected["metadata"]["consent_statuses"] == [
        {
            "scope": "attr.financial.portfolio.*",
            "action": "DEFAULT_AVAILABLE",
            "visibility_posture": "default_available",
        }
    ]
    assert consent_db.events == []


@pytest.mark.asyncio
async def test_refresh_sibling_email_reuses_scope_granted_from_another_workflow():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)

    workflows = []
    for index in range(3):
        message = _message(
            subject=f"Portfolio request {index}",
            body="Can you get my portfolio information?",
        )
        message["id"] = f"gmail_msg_portfolio_{index}"
        message["threadId"] = f"gmail_thread_portfolio_{index}"
        result = await service._process_message(message, history_id=f"102sibling-{index}")
        workflows.append(result["workflow"])

    first = await service.select_scopes(
        user_id="user_123",
        workflow_id=workflows[0]["workflow_id"],
        selected_scopes=["attr.financial.portfolio.*"],
    )
    consent_db.status_by_request[first["consent_request_id"]] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_sibling_portfolio",
    }
    consent_db.active_tokens.append(
        {
            "user_id": "user_123",
            "agent_id": "agent_kyc",
            "scope": "attr.financial.portfolio.*",
            "request_id": first["consent_request_id"],
            "token_id": "token_sibling_portfolio",
        }
    )
    consent_db.export_by_token["token_sibling_portfolio"] = _encrypted_export(
        {"financial": {"portfolio": [{"ticker": "UAT", "value": "test only"}]}},
        scope="attr.financial.portfolio.*",
        export_revision=10,
    )
    event_count_after_first_request = len(consent_db.events)

    for sibling in workflows[1:]:
        refreshed = await service.refresh_workflow(
            user_id="user_123",
            workflow_id=sibling["workflow_id"],
        )
        assert refreshed["status"] == "waiting_on_user"
        assert refreshed["draft_status"] == "ready"
        assert refreshed["consent_request_id"] == first["consent_request_id"]
        assert refreshed["metadata"]["selected_scopes"] == ["attr.financial.portfolio.*"]
        assert refreshed["metadata"]["reused_existing_consent_grant"] is True

    assert len(consent_db.events) == event_count_after_first_request


@pytest.mark.asyncio
async def test_select_scopes_reuses_existing_grant_over_stale_denied_request():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Portfolio request",
            body="Can you get my portfolio information?",
        ),
        history_id="102existing-denied",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.financial.portfolio.*"],
    )
    stale_request_id = selected["consent_request_id"]
    consent_db.status_by_request[stale_request_id] = {"action": "CONSENT_DENIED"}
    consent_db.active_tokens.append(
        {
            "user_id": "user_123",
            "agent_id": "agent_kyc",
            "scope": "attr.financial.portfolio.*",
            "request_id": "okyc_existing_active_financial",
            "token_id": "token_existing_active_financial",
        }
    )
    consent_db.export_by_token["token_existing_active_financial"] = _encrypted_export(
        {"financial": {"portfolio": [{"ticker": "UAT", "value": "test only"}]}},
        scope="attr.financial.portfolio.*",
        export_revision=5,
    )

    refreshed = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    assert refreshed["status"] == "waiting_on_user"
    assert refreshed["draft_status"] == "ready"
    assert refreshed["consent_request_id"] == "okyc_existing_active_financial"
    assert refreshed["metadata"]["reused_existing_consent_grant"] is True
    assert refreshed["metadata"]["consent_statuses"] == [
        {
            "request_id": "okyc_existing_active_financial",
            "scope": "attr.financial.portfolio.*",
            "action": "CONSENT_GRANTED",
            "reused_existing_grant": True,
            "granted_scope": "attr.financial.portfolio.*",
        }
    ]


@pytest.mark.asyncio
async def test_select_scopes_reuses_broader_existing_grant_for_specific_request():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Portfolio request",
            body="Can you get my portfolio information?",
        ),
        history_id="102existing-broader",
    )
    consent_db.active_tokens.append(
        {
            "user_id": "user_123",
            "agent_id": "agent_kyc",
            "scope": "attr.financial.*",
            "request_id": "okyc_existing_financial_domain",
            "token_id": "token_existing_financial_domain",
        }
    )
    consent_db.export_by_token["token_existing_financial_domain"] = _encrypted_export(
        {"financial": {"portfolio": [{"ticker": "UAT", "value": "test only"}]}},
        scope="attr.financial.*",
        export_revision=6,
    )

    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.financial.portfolio.*"],
    )
    exports = await service.get_workflow_consent_exports(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    assert selected["status"] == "waiting_on_user"
    assert selected["draft_status"] == "ready"
    assert selected["consent_request_id"] == "okyc_existing_financial_domain"
    assert selected["metadata"]["consent_statuses"][0]["granted_scope"] == "attr.financial.*"
    assert exports["exports"][0]["scope"] == "attr.financial.portfolio.*"
    assert exports["exports"][0]["request_id"] == "okyc_existing_financial_domain"


@pytest.mark.asyncio
async def test_refresh_accepts_broader_export_for_specific_granted_request():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Financial profile request",
            body="Can you get my financial profile?",
        ),
        history_id="102granted-broader-export",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.financial.profile.*"],
    )
    consent_db.status_by_request[selected["consent_request_id"]] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_granted_financial_domain",
    }
    consent_db.export_by_token["token_granted_financial_domain"] = _encrypted_export(
        {"financial": {"profile": {"risk": "moderate"}}},
        scope="attr.financial.*",
        export_revision=8,
    )

    refreshed = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )
    exports = await service.get_workflow_consent_exports(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    assert refreshed["status"] == "waiting_on_user"
    assert refreshed["draft_status"] == "ready"
    assert refreshed["metadata"]["consent_export"]["scope"] == "attr.financial.*"
    assert exports["exports"][0]["scope"] == "attr.financial.profile.*"


@pytest.mark.asyncio
async def test_refresh_rejects_narrower_export_for_broader_granted_request():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Full financial request",
            body="Can you get all my financial information?",
        ),
        history_id="102granted-narrow-export",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.financial.*"],
    )
    consent_db.status_by_request[selected["consent_request_id"]] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_granted_financial_profile",
    }
    consent_db.export_by_token["token_granted_financial_profile"] = _encrypted_export(
        {"financial": {"profile": {"risk": "moderate"}}},
        scope="attr.financial.profile.*",
        export_revision=9,
    )

    with pytest.raises(OneEmailKycError) as exc:
        await service.refresh_workflow(
            user_id="user_123",
            workflow_id=selected["workflow_id"],
        )

    assert exc.value.code == "ONE_KYC_EXPORT_SCOPE_MISMATCH"


@pytest.mark.asyncio
async def test_refresh_blocked_workflow_recovers_when_active_grant_exists():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Portfolio request",
            body="Can you get my portfolio information?",
        ),
        history_id="102blocked-recovery",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.financial.portfolio.*"],
    )
    consent_db.status_by_request[selected["consent_request_id"]] = {"action": "CONSENT_DENIED"}
    blocked = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )
    assert blocked["status"] == "blocked"

    consent_db.active_tokens.append(
        {
            "user_id": "user_123",
            "agent_id": "agent_kyc",
            "scope": "attr.financial.portfolio.*",
            "request_id": "okyc_recovered_financial",
            "token_id": "token_recovered_financial",
        }
    )
    consent_db.export_by_token["token_recovered_financial"] = _encrypted_export(
        {"financial": {"portfolio": [{"ticker": "UAT", "value": "test only"}]}},
        scope="attr.financial.portfolio.*",
        export_revision=7,
    )

    recovered = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    assert recovered["status"] == "waiting_on_user"
    assert recovered["draft_status"] == "ready"
    assert recovered["consent_request_id"] == "okyc_recovered_financial"
    assert recovered["metadata"]["reused_existing_consent_grant"] is True


@pytest.mark.asyncio
async def test_refresh_workflow_marks_multi_scope_exports_ready():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Broker API KYC and financial questionnaire",
            body="Broker KYC questionnaire asking for full name and all financial information.",
        ),
        history_id="102multi",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.identity.*", "attr.financial.*"],
    )
    requests = selected["metadata"]["consent_requests"]
    consent_db.status_by_request[requests[0]["request_id"]] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_identity_multi",
    }
    consent_db.export_by_token["token_identity_multi"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}},
        scope="attr.identity.*",
        export_revision=1,
    )

    pending = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )
    assert pending["status"] == "needs_scope"

    consent_db.status_by_request[requests[1]["request_id"]] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_financial_multi",
    }
    consent_db.export_by_token["token_financial_multi"] = _encrypted_export(
        {"financial": {"portfolio": [{"ticker": "UAT", "value": "test only"}]}},
        scope="attr.financial.*",
        export_revision=7,
    )

    ready = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )
    assert ready["status"] == "waiting_on_user"
    assert ready["draft_status"] == "ready"
    assert ready["draft_body"] is None
    assert len(ready["metadata"]["consent_exports"]) == 2

    export_response = await service.get_workflow_consent_exports(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )
    assert [item["scope"] for item in export_response["exports"]] == [
        "attr.identity.*",
        "attr.financial.*",
    ]


@pytest.mark.asyncio
async def test_refresh_workflow_demotes_stale_ready_multi_scope_when_export_revoked():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Broker API KYC and financial questionnaire",
            body="Broker KYC questionnaire asking for full name and all financial information.",
        ),
        history_id="102multi-stale",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.identity.*", "attr.financial.*"],
    )
    requests = selected["metadata"]["consent_requests"]
    for request, token_id in zip(
        requests,
        ["token_identity_stale", "token_financial_stale"],
        strict=True,
    ):
        consent_db.status_by_request[request["request_id"]] = {
            "action": "CONSENT_GRANTED",
            "token_id": token_id,
        }
        consent_db.export_by_token[token_id] = _encrypted_export(
            {"data": {"scope": request["scope"]}},
            scope=request["scope"],
            export_revision=1,
        )

    ready = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )
    assert ready["status"] == "waiting_on_user"
    assert ready["draft_status"] == "ready"

    consent_db.status_by_request[requests[1]["request_id"]] = {
        "action": "REQUESTED",
    }

    refreshed = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    assert refreshed["status"] == "needs_scope"
    assert refreshed["draft_status"] == "not_ready"
    assert refreshed["last_error_code"] == "scoped_export_pending"


@pytest.mark.asyncio
async def test_denied_selected_scope_blocks_external_reply():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Broker API KYC and financial questionnaire",
            body="Broker KYC questionnaire asking for full name and all financial information.",
        ),
        history_id="102denied",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.identity.*", "attr.financial.*"],
    )
    requests = selected["metadata"]["consent_requests"]
    consent_db.status_by_request[requests[0]["request_id"]] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_identity_denied",
    }
    consent_db.export_by_token["token_identity_denied"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}},
        scope="attr.identity.*",
    )
    consent_db.status_by_request[requests[1]["request_id"]] = {"action": "CONSENT_DENIED"}

    blocked = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    assert blocked["status"] == "blocked"
    assert blocked["metadata"]["external_reply_blocked"] is True
    with pytest.raises(OneEmailKycError) as exc:
        await service.send_approved_reply(
            user_id="user_123",
            workflow_id=selected["workflow_id"],
            approved_subject="Re: Broker API KYC and financial questionnaire",
            approved_body="Approved body",
            pkm_writeback_artifact_hash="a" * 64,
        )
    assert exc.value.code == "ONE_KYC_EXTERNAL_REPLY_BLOCKED"


@pytest.mark.asyncio
async def test_refresh_workflow_rejects_export_for_wrong_client_connector_key():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name and date of birth."),
        history_id="103",
    )
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
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
            workflow_id=workflow_with_consent["workflow_id"],
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
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_redraft",
    }
    consent_db.export_by_token["token_redraft"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
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
async def test_redraft_formatting_financial_data_does_not_request_extra_scope():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            subject="Financial request",
            body="Can you get all my financial information?",
        ),
        history_id="104-financial-redraft",
    )
    selected = await service.select_scopes(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
        selected_scopes=["attr.financial.*"],
    )
    consent_db.status_by_request[selected["consent_request_id"]] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_financial_redraft",
    }
    consent_db.export_by_token["token_financial_redraft"] = _encrypted_export(
        {"financial": {"portfolio": [{"ticker": "UAT", "value": "test only"}]}},
        scope="attr.financial.*",
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=selected["workflow_id"],
    )

    redrafted = await service.redraft(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        instructions="Format the financial data as a clean table with headings.",
        source="text",
    )

    assert redrafted["status"] == "waiting_on_user"
    assert redrafted["draft_status"] == "ready"
    assert redrafted["metadata"]["scope_selection_required"] is False
    assert "redraft_requested_scopes" not in redrafted["metadata"]


@pytest.mark.asyncio
async def test_redraft_additional_uncovered_scope_requires_selection():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="104-extra-scope-redraft",
    )
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_redraft_identity_only",
    }
    consent_db.export_by_token["token_redraft_identity_only"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
    )

    redrafted = await service.redraft(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        instructions="Also include my portfolio information.",
        source="text",
    )

    assert redrafted["status"] == "needs_scope"
    assert redrafted["draft_status"] == "not_ready"
    assert redrafted["metadata"]["scope_selection_required"] is True
    assert redrafted["metadata"]["redraft_requested_scopes"] == ["attr.financial.portfolio.*"]


@pytest.mark.asyncio
async def test_send_approved_reply_revalidates_consent_and_sends_transient_body():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(
            body="Broker KYC questionnaire asking for full name.",
            cc="User <verified@example.com>, Broker Assistant <assistant@example.com>",
        ),
        history_id="105",
    )
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_send",
    }
    consent_db.export_by_token["token_send"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
    )
    sent_payloads = []

    def _capture_send(url, *, json_payload, scopes):
        sent_payloads.append(json_payload)
        return {"id": "gmail_sent_1", "threadId": "gmail_thread_1"}

    service._post_json_sync = _capture_send
    service._fetch_message = lambda message_id: {"id": message_id, "threadId": "gmail_thread_1"}

    sent = await service.send_approved_reply(
        user_id="user_123",
        workflow_id=workflow["workflow_id"],
        approved_subject=workflow["draft_subject"],
        approved_body="Approved KYC reply body",
        approved_html=(
            '<div style="color:#111827;background:url(https://bad.example/x)">'
            "<h2>Portfolio summary</h2><script>alert(1)</script>"
            "<table><tr><td>Approved KYC reply body</td></tr></table>"
            "</div>"
        ),
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
        base64.urlsafe_b64decode((raw + ("=" * (-len(raw) % 4))).encode("utf-8")),
        policy=email.policy.default,
    )
    assert parsed["From"] == "One <one@hushh.ai>"
    assert parsed["To"] == "verified@example.com"
    assert parsed["Cc"] == "assistant@example.com"
    assert parsed["Subject"] == "Broker API KYC questionnaire"
    assert parsed["In-Reply-To"] == "<m1@example.com>"
    assert parsed["References"] == "<m1@example.com>"
    assert sent_payloads[0].keys() == {"raw", "threadId"}
    assert sent_payloads[0]["threadId"] == "gmail_thread_1"
    assert sent["sent_thread_id"] == "gmail_thread_1"
    assert sent["thread_match_status"] == "matched"
    assert parsed.is_multipart()
    assert parsed.get_body(("plain",)).get_content() == "Approved KYC reply body\n"
    html_body = parsed.get_body(("html",)).get_content()
    assert "<h2>Portfolio summary</h2>" in html_body
    assert "<table>" in html_body
    assert "Approved KYC reply body" in html_body
    assert "script" not in html_body
    assert "url(" not in html_body
    assert "Approved KYC reply body" not in json.dumps(db.workflows, default=str)


@pytest.mark.asyncio
async def test_send_approved_reply_requires_original_gmail_thread_before_send():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="105a",
    )
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_no_thread",
    }
    consent_db.export_by_token["token_no_thread"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
    )
    db.workflows[0]["gmail_thread_id"] = None
    send_called = False

    def _capture_send(url, *, json_payload, scopes):
        nonlocal send_called
        send_called = True
        return {"id": "gmail_sent_no_thread", "threadId": "new_thread"}

    service._post_json_sync = _capture_send

    with pytest.raises(OneEmailKycError) as exc:
        await service.send_approved_reply(
            user_id="user_123",
            workflow_id=workflow["workflow_id"],
            approved_subject=workflow["draft_subject"],
            approved_body="Approved KYC reply body",
            consent_export_revision=1,
            pkm_writeback_artifact_hash="a" * 64,
        )

    assert exc.value.code == "ONE_KYC_ORIGINAL_THREAD_REQUIRED"
    assert send_called is False
    failed = await service.get_workflow(user_id="user_123", workflow_id=workflow["workflow_id"])
    assert failed["send_status"] == "failed"
    assert failed["pkm_writeback_status"] == "not_started"


@pytest.mark.asyncio
async def test_send_approved_reply_fails_if_gmail_returns_different_thread():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="105b",
    )
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_mismatch_thread",
    }
    consent_db.export_by_token["token_mismatch_thread"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
    )

    service._post_json_sync = lambda url, *, json_payload, scopes: {
        "id": "gmail_sent_wrong_thread",
        "threadId": "gmail_thread_new",
    }
    service._fetch_message = lambda message_id: {"id": message_id, "threadId": "gmail_thread_new"}

    with pytest.raises(OneEmailKycError) as exc:
        await service.send_approved_reply(
            user_id="user_123",
            workflow_id=workflow["workflow_id"],
            approved_subject=workflow["draft_subject"],
            approved_body="Approved KYC reply body",
            consent_export_revision=1,
            pkm_writeback_artifact_hash="a" * 64,
        )

    assert exc.value.code == "ONE_KYC_THREAD_MISMATCH"
    failed = await service.get_workflow(user_id="user_123", workflow_id=workflow["workflow_id"])
    assert failed["send_status"] == "failed"
    assert failed["pkm_writeback_status"] == "not_started"


@pytest.mark.asyncio
async def test_send_approved_reply_rejects_when_bound_export_revision_changes():
    db = _FakeDb()
    consent_db = _FakeConsentDb()
    service = _service(db, consent_db)
    result = await service._process_message(
        _message(body="Broker KYC questionnaire asking for full name."),
        history_id="106",
    )
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
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
        workflow_id=workflow_with_consent["workflow_id"],
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
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_send_failed",
    }
    consent_db.export_by_token["token_send_failed"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
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
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_writeback",
    }
    consent_db.export_by_token["token_writeback"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
    )
    service._post_json_sync = lambda url, *, json_payload, scopes: {
        "id": "gmail_sent_writeback",
        "threadId": "gmail_thread_1",
    }
    service._fetch_message = lambda message_id: {"id": message_id, "threadId": "gmail_thread_1"}
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
    workflow_with_consent = await _select_identity_scope(service, result["workflow"])
    request_id = workflow_with_consent["consent_request_id"]
    consent_db.status_by_request[request_id] = {
        "action": "CONSENT_GRANTED",
        "token_id": "token_writeback_mismatch",
    }
    consent_db.export_by_token["token_writeback_mismatch"] = _encrypted_export(
        {"identity": {"full_name": "Test Reviewer"}}
    )
    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=workflow_with_consent["workflow_id"],
    )
    service._post_json_sync = lambda url, *, json_payload, scopes: {
        "id": "gmail_sent_writeback",
        "threadId": "gmail_thread_1",
    }
    service._fetch_message = lambda message_id: {"id": message_id, "threadId": "gmail_thread_1"}
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
