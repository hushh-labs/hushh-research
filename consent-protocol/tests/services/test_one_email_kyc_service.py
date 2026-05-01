import base64
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services.one_email_kyc_service import OneEmailKycConfig, OneEmailKycService


def _b64url(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("utf-8").rstrip("=")


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
                if key == "workflow_id":
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

    async def insert_event(self, **kwargs):
        self.events.append(kwargs)
        return 1

    async def get_request_status(self, user_id: str, request_id: str):
        return self.status_by_request.get(request_id)

    async def get_consent_export_metadata(self, consent_token: str):
        return self.export_metadata_by_token.get(consent_token)


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
        connector_public_key="connector_public_key",
        connector_key_id="one-kyc-key",
        default_kyc_scope="attr.identity.*",
        configured=True,
    )
    return service


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
    assert workflow["consent_request_id"].startswith("one_kyc_")
    assert workflow["required_fields"] == ["full_name", "date_of_birth", "address"]
    assert consent_db.events[0]["agent_id"] == "agent_kyc"
    assert consent_db.events[0]["scope"] == "attr.identity.*"
    assert consent_db.events[0]["metadata"]["requester_actor_type"] == "developer"
    assert consent_db.events[0]["metadata"]["connector_public_key"] == "connector_public_key"
    assert raw_body_marker not in json.dumps(db.workflows, default=str)


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
    consent_db.export_metadata_by_token["token_123"] = {
        "scope": "attr.identity.*",
        "export_revision": 1,
        "export_generated_at": "2026-04-28T00:00:00Z",
        "connector_key_id": "one-kyc-key",
        "is_strict_zero_knowledge": True,
    }

    workflow = await service.refresh_workflow(
        user_id="user_123",
        workflow_id=result["workflow"]["workflow_id"],
    )

    assert workflow["status"] == "waiting_on_user"
    assert workflow["draft_status"] == "ready"
    assert "approved encrypted export metadata" in workflow["draft_body"]
