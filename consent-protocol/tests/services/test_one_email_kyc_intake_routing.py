"""Tests for LLM Pass 1 routing wired into the KYC intake flow.

Task 3: _process_message now calls classify_kyc_request + _load_pkm_index_for_user
and produces a workflow in status='needs_confirm' carrying the proposal in metadata.
"""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.one_email_kyc_service import (
    _KYC_ROUTING_CONFIDENCE_FLOOR,
    _KYC_WORKFLOW_STATES,
    OneEmailKycConfig,
    OneEmailKycService,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CONNECTOR_PUBLIC_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"  # 43-char placeholder


def _make_service() -> OneEmailKycService:
    """Minimal service with fakes; LLM calls are mocked per-test."""
    from datetime import datetime, timezone
    from types import SimpleNamespace

    class _FakeDb:
        def __init__(self) -> None:
            self.workflows: list = []
            self.connectors = [
                {
                    "connector_id": "c1",
                    "user_id": "user-1",
                    "connector_key_id": "key-1",
                    "connector_public_key": _CONNECTOR_PUBLIC_B64,
                    "connector_wrapping_alg": "X25519-AES256-GCM",
                    "public_key_fingerprint": "fp-1",
                    "status": "active",
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "rotated_at": None,
                    "revoked_at": None,
                }
            ]

        def execute_raw(self, sql: str, params: dict | None = None):
            import json

            params = params or {}
            normalized = " ".join(sql.lower().split())
            if "from actor_identity_cache" in normalized:
                emails = set(params.get("emails") or [])
                if "sender@example.com" in emails:
                    return SimpleNamespace(
                        data=[{"user_id": "user-1", "email": "sender@example.com"}]
                    )
                return SimpleNamespace(data=[])
            if "from actor_verified_email_aliases" in normalized:
                return SimpleNamespace(data=[])
            if "from one_kyc_workflows" in normalized and "where gmail_message_id" in normalized:
                msg_id = params.get("gmail_message_id")
                rows = [r for r in self.workflows if r.get("gmail_message_id") == msg_id]
                return SimpleNamespace(data=rows[:1])
            if "from one_kyc_client_connectors" in normalized:
                uid = params.get("user_id")
                rows = [
                    r
                    for r in self.connectors
                    if r.get("user_id") == uid and r.get("status") == "active"
                ]
                return SimpleNamespace(data=rows[:1])
            if "insert into one_kyc_workflows" in normalized:
                row = dict(params)
                row["participant_emails"] = json.loads(row["participant_emails"])
                row["required_fields"] = json.loads(row["required_fields"])
                row["metadata"] = json.loads(row["metadata"])
                row.setdefault("draft_status", "not_ready")
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
                row.setdefault("created_at", datetime.now(timezone.utc))
                row.setdefault("updated_at", datetime.now(timezone.utc))
                self.workflows.append(row)
                return SimpleNamespace(data=[row])
            return SimpleNamespace(data=[])

    import base64

    def _b64url(value: str) -> str:
        return base64.urlsafe_b64encode(value.encode("utf-8")).decode("utf-8").rstrip("=")

    svc = OneEmailKycService(db=_FakeDb())
    svc._config = OneEmailKycConfig(
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
    # Default PKM mock — no real DB
    svc._load_pkm_index_for_user = AsyncMock(
        return_value={"available_domains": [], "domain_summaries": {}, "computed_tags": []}
    )
    return svc


def _make_message(
    *,
    sender: str = "sender@example.com",
    subject: str = "KYC Request",
    body: str = "Please share your information.",
) -> dict:
    import base64

    def _b64url(value: str) -> str:
        return base64.urlsafe_b64encode(value.encode("utf-8")).decode("utf-8").rstrip("=")

    return {
        "id": "gmail_msg_routing_1",
        "threadId": "gmail_thread_routing_1",
        "payload": {
            "headers": [
                {"name": "From", "value": f"Sender <{sender}>"},
                {"name": "To", "value": "one@hushh.ai"},
                {"name": "Subject", "value": subject},
                {"name": "Message-ID", "value": "<routing1@example.com>"},
            ],
            "mimeType": "multipart/mixed",
            "parts": [{"mimeType": "text/plain", "body": {"data": _b64url(body)}}],
        },
    }


_IDENTITY_PROPOSAL = {
    "classification": "kyc",
    "requested_items": [
        {
            "label": "Full name",
            "domain": "identity",
            "scope": "attr.identity.*",
            "rationale": "identity check",
        }
    ],
    "primary_domains": ["identity"],
    "confidence": 0.9,
    "reasoning": "identity request",
}

_LOW_CONFIDENCE_PROPOSAL = {
    "classification": "kyc",
    "requested_items": [
        {
            "label": "Full name",
            "domain": "identity",
            "scope": "attr.identity.*",
            "rationale": "identity check",
        }
    ],
    "primary_domains": ["identity"],
    "confidence": _KYC_ROUTING_CONFIDENCE_FLOOR - 0.1,
    "reasoning": "uncertain",
}

_UNSUPPORTED_PROPOSAL = {
    "classification": "unsupported",
    "requested_items": [],
    "primary_domains": [],
    "confidence": 0.8,
    "reasoning": "not a data request",
}

_FALLBACK_PROPOSAL = {
    "fallback": True,
    "classification": "kyc",
    "requested_items": [],
    "primary_domains": [],
    "confidence": 0.0,
    "reasoning": "gemini unavailable",
}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_needs_confirm_in_workflow_states():
    """Regression: needs_confirm must be a recognised state."""
    assert "needs_confirm" in _KYC_WORKFLOW_STATES


@pytest.mark.asyncio
async def test_intake_sets_needs_confirm_with_proposal():
    """Happy-path: a valid proposal lands the workflow in needs_confirm."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_IDENTITY_PROPOSAL)

    result = await service._process_message(
        _make_message(body="Please share your full name for KYC."),
        history_id="h1",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "needs_confirm"
    assert workflow["metadata"]["kyc_proposal"]["classification"] == "kyc"
    assert workflow["metadata"]["kyc_proposal"]["primary_domains"] == ["identity"]
    assert workflow["metadata"]["classification"] == "kyc"
    assert workflow["metadata"]["candidate_scopes"][0]["scope"] == "attr.identity.*"
    assert workflow["metadata"]["detected_domains"] == ["identity"]
    assert result["blocked"] is False


@pytest.mark.asyncio
async def test_intake_stores_full_proposal_in_metadata():
    """All proposal fields are preserved verbatim in kyc_proposal."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_IDENTITY_PROPOSAL)

    result = await service._process_message(
        _make_message(body="KYC check needed."),
        history_id="h2",
    )

    proposal_stored = result["workflow"]["metadata"]["kyc_proposal"]
    assert proposal_stored["requested_items"][0]["scope"] == "attr.identity.*"
    assert proposal_stored["confidence"] == 0.9
    assert proposal_stored["reasoning"] == "identity request"


@pytest.mark.asyncio
async def test_intake_uses_pkm_index_for_routing():
    """_load_pkm_index_for_user is called with the matched user_id."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_IDENTITY_PROPOSAL)

    await service._process_message(
        _make_message(body="KYC request."),
        history_id="h3",
    )

    service._load_pkm_index_for_user.assert_called_once_with("user-1")


@pytest.mark.asyncio
async def test_intake_blocks_on_fallback_proposal():
    """Gemini unavailable (fallback) → blocked with kyc_routing_unavailable."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_FALLBACK_PROPOSAL)

    result = await service._process_message(
        _make_message(body="KYC request."),
        history_id="h4",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "blocked"
    assert workflow["last_error_code"] == "kyc_routing_unavailable"
    assert result["blocked"] is True


@pytest.mark.asyncio
async def test_intake_blocks_on_unsupported_classification():
    """classification='unsupported' → blocked with kyc_routing_unavailable."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_UNSUPPORTED_PROPOSAL)

    result = await service._process_message(
        _make_message(body="Hello, just checking in."),
        history_id="h5",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "blocked"
    assert workflow["last_error_code"] == "kyc_routing_unavailable"
    assert result["blocked"] is True


@pytest.mark.asyncio
async def test_intake_low_confidence_sets_flag_but_stays_needs_confirm():
    """Confidence below floor → needs_confirm with kyc_low_confidence=True."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_LOW_CONFIDENCE_PROPOSAL)

    result = await service._process_message(
        _make_message(body="KYC request."),
        history_id="h6",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "needs_confirm"
    assert workflow["metadata"]["kyc_low_confidence"] is True
    assert result["blocked"] is False


@pytest.mark.asyncio
async def test_intake_no_connector_stores_proposal_in_needs_client_connector():
    """No client connector → needs_client_connector, but proposal is stored in metadata."""
    import json
    from datetime import datetime, timezone
    from types import SimpleNamespace

    class _NoConnectorDb:
        def __init__(self) -> None:
            self.workflows: list = []

        def execute_raw(self, sql: str, params: dict | None = None):
            params = params or {}
            normalized = " ".join(sql.lower().split())
            if "from actor_identity_cache" in normalized:
                emails = set(params.get("emails") or [])
                if "sender@example.com" in emails:
                    return SimpleNamespace(
                        data=[{"user_id": "user-1", "email": "sender@example.com"}]
                    )
                return SimpleNamespace(data=[])
            if "from actor_verified_email_aliases" in normalized:
                return SimpleNamespace(data=[])
            if "from one_kyc_workflows" in normalized and "where gmail_message_id" in normalized:
                msg_id = params.get("gmail_message_id")
                rows = [r for r in self.workflows if r.get("gmail_message_id") == msg_id]
                return SimpleNamespace(data=rows[:1])
            if "from one_kyc_client_connectors" in normalized:
                # No connector
                return SimpleNamespace(data=[])
            if "insert into one_kyc_workflows" in normalized:
                row = dict(params)
                row["participant_emails"] = json.loads(row["participant_emails"])
                row["required_fields"] = json.loads(row["required_fields"])
                row["metadata"] = json.loads(row["metadata"])
                for key in (
                    "draft_status",
                    "consent_request_id",
                    "draft_subject",
                    "draft_body",
                    "send_attempt_id",
                    "send_status",
                    "sent_message_id",
                    "sent_at",
                    "client_draft_hash",
                    "approved_send_hash",
                    "pkm_writeback_status",
                    "pkm_writeback_artifact_hash",
                    "pkm_writeback_attempt_count",
                    "pkm_writeback_last_error",
                    "pkm_writeback_completed_at",
                ):
                    row.setdefault(key, None)
                row.setdefault("pkm_writeback_status", "not_started")
                row.setdefault("pkm_writeback_attempt_count", 0)
                row.setdefault("draft_status", "not_ready")
                row.setdefault("send_status", "not_started")
                row.setdefault("created_at", datetime.now(timezone.utc))
                row.setdefault("updated_at", datetime.now(timezone.utc))
                self.workflows.append(row)
                return SimpleNamespace(data=[row])
            return SimpleNamespace(data=[])

    svc = OneEmailKycService(db=_NoConnectorDb())
    svc._config = _make_service()._config
    svc._load_pkm_index_for_user = AsyncMock(
        return_value={"available_domains": [], "domain_summaries": {}, "computed_tags": []}
    )
    svc.classify_kyc_request = AsyncMock(return_value=_IDENTITY_PROPOSAL)

    result = await svc._process_message(
        _make_message(body="KYC check for identity."),
        history_id="h7",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "needs_client_connector"
    assert workflow["last_error_code"] == "kyc_client_connector_missing"
    # Proposal metadata preserved for use after connector registration
    assert workflow["metadata"]["kyc_proposal"]["classification"] == "kyc"
    assert result["blocked"] is False


@pytest.mark.asyncio
async def test_intake_blocked_when_sender_not_matched():
    """Sender not matched → blocked before routing; classify_kyc_request not called."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_IDENTITY_PROPOSAL)

    result = await service._process_message(
        _make_message(sender="unknown@other.com", body="KYC request."),
        history_id="h8",
    )

    workflow = result["workflow"]
    assert workflow["status"] == "blocked"
    assert workflow["last_error_code"] == "user_not_found"
    service.classify_kyc_request.assert_not_called()


@pytest.mark.asyncio
async def test_intake_required_fields_empty_at_needs_confirm():
    """At intake, required_fields is [] — populated at confirm time (Task 4)."""
    service = _make_service()
    service.classify_kyc_request = AsyncMock(return_value=_IDENTITY_PROPOSAL)

    result = await service._process_message(
        _make_message(body="Full KYC form: name, DOB, address."),
        history_id="h9",
    )

    assert result["workflow"]["required_fields"] == []


@pytest.mark.asyncio
async def test_confidence_floor_constant_is_half():
    """Smoke-test: the confidence floor is 0.5 as specified."""
    assert _KYC_ROUTING_CONFIDENCE_FLOOR == 0.5


# ---------------------------------------------------------------------------
# Connector-repair path: needs_client_connector → needs_confirm (Fix I2)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connector_repair_routes_to_needs_confirm_when_proposal_present():
    """Workflow parked at needs_client_connector WITH kyc_proposal in metadata
    must advance to needs_confirm (not needs_scope) once a connector is present.
    """
    import json
    from datetime import datetime, timezone
    from types import SimpleNamespace

    _WORKFLOW_ID = "c" * 32

    class _RepairDb:
        """Minimal fake db that pre-populates a needs_client_connector workflow
        with a kyc_proposal and serves a connector on lookup.
        """

        def __init__(self) -> None:
            self.workflows: list = [
                {
                    "workflow_id": _WORKFLOW_ID,
                    "user_id": "user-1",
                    "status": "needs_client_connector",
                    "gmail_message_id": "gmail_repair_msg_1",
                    "gmail_thread_id": "gmail_repair_thread_1",
                    "gmail_history_id": "200",
                    "sender_email": "sender@example.com",
                    "sender_name": "Sender",
                    "participant_emails": ["sender@example.com"],
                    "subject": "KYC Request",
                    "snippet": None,
                    "counterparty_label": "Sender",
                    "rfc_message_id": "<repair1@example.com>",
                    "required_fields": [],
                    "requested_scope": "attr.identity.*",
                    "last_error_code": "kyc_client_connector_missing",
                    "last_error_message": "Unlock the KYC workspace.",
                    "metadata": {
                        "kyc_proposal": _IDENTITY_PROPOSAL,
                        "candidate_scopes": _IDENTITY_PROPOSAL["requested_items"],
                        "classification": "kyc",
                        "detected_domains": ["identity"],
                        "strict_client_zk": True,
                        "client_connector_required": True,
                    },
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
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                }
            ]
            self.connectors = [
                {
                    "connector_id": "c1",
                    "user_id": "user-1",
                    "connector_key_id": "key-1",
                    "connector_public_key": _CONNECTOR_PUBLIC_B64,
                    "connector_wrapping_alg": "X25519-AES256-GCM",
                    "public_key_fingerprint": "fp-1",
                    "status": "active",
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "rotated_at": None,
                    "revoked_at": None,
                }
            ]

        def execute_raw(self, sql: str, params: dict | None = None):
            params = params or {}
            normalized = " ".join(sql.lower().split())
            if "from one_kyc_workflows" in normalized and "where gmail_message_id" in normalized:
                msg_id = params.get("gmail_message_id")
                rows = [r for r in self.workflows if r.get("gmail_message_id") == msg_id]
                return SimpleNamespace(data=rows[:1])
            if "from one_kyc_client_connectors" in normalized:
                uid = params.get("user_id")
                rows = [
                    r
                    for r in self.connectors
                    if r.get("user_id") == uid and r.get("status") == "active"
                ]
                return SimpleNamespace(data=rows[:1])
            if "update one_kyc_workflows" in normalized:
                wf_id = params["workflow_id"]
                row = next(r for r in self.workflows if r["workflow_id"] == wf_id)
                for key, value in params.items():
                    if key == "workflow_id" or key.startswith("set_"):
                        continue
                    if not params.get(f"set_{key}", True):
                        continue
                    row[key] = json.loads(value) if key == "metadata" else value
                row["updated_at"] = datetime.now(timezone.utc)
                return SimpleNamespace(data=[row])
            return SimpleNamespace(data=[])

    svc = OneEmailKycService(db=_RepairDb())
    svc._config = _make_service()._config

    result = await svc.process_message_id("gmail_repair_msg_1", history_id="200")

    assert result["reason"] == "client_connector_repaired"
    workflow = result["workflow"]
    assert workflow["status"] == "needs_confirm", (
        f"Expected needs_confirm (proposal present), got {workflow['status']!r}"
    )
    # Proposal and candidate scopes must be preserved
    assert workflow["metadata"]["kyc_proposal"]["classification"] == "kyc"
    assert workflow["metadata"]["candidate_scopes"][0]["scope"] == "attr.identity.*"


@pytest.mark.asyncio
async def test_connector_repair_routes_to_needs_scope_without_proposal():
    """Workflow parked at needs_client_connector WITHOUT kyc_proposal (legacy)
    must advance to needs_scope (existing behavior preserved).
    """
    import json
    from datetime import datetime, timezone
    from types import SimpleNamespace

    _WORKFLOW_ID = "d" * 32

    class _LegacyRepairDb:
        def __init__(self) -> None:
            self.workflows: list = [
                {
                    "workflow_id": _WORKFLOW_ID,
                    "user_id": "user-1",
                    "status": "needs_client_connector",
                    "gmail_message_id": "gmail_legacy_repair_1",
                    "gmail_thread_id": "gmail_legacy_thread_1",
                    "gmail_history_id": "300",
                    "sender_email": "sender@example.com",
                    "sender_name": "Sender",
                    "participant_emails": ["sender@example.com"],
                    "subject": "KYC Request",
                    "snippet": None,
                    "counterparty_label": "Sender",
                    "rfc_message_id": "<legacy1@example.com>",
                    "required_fields": [],
                    "requested_scope": "attr.identity.*",
                    "last_error_code": "kyc_client_connector_missing",
                    "last_error_message": "Unlock the KYC workspace.",
                    # No kyc_proposal — legacy workflow
                    "metadata": {"strict_client_zk": True, "client_connector_required": True},
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
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                }
            ]
            self.connectors = [
                {
                    "connector_id": "c1",
                    "user_id": "user-1",
                    "connector_key_id": "key-1",
                    "connector_public_key": _CONNECTOR_PUBLIC_B64,
                    "connector_wrapping_alg": "X25519-AES256-GCM",
                    "public_key_fingerprint": "fp-1",
                    "status": "active",
                    "created_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "rotated_at": None,
                    "revoked_at": None,
                }
            ]
            self.consent_events: list = []
            self.consent_db_pending: dict = {}

        def execute_raw(self, sql: str, params: dict | None = None):
            params = params or {}
            normalized = " ".join(sql.lower().split())
            if "from one_kyc_workflows" in normalized and "where gmail_message_id" in normalized:
                msg_id = params.get("gmail_message_id")
                rows = [r for r in self.workflows if r.get("gmail_message_id") == msg_id]
                return SimpleNamespace(data=rows[:1])
            if "from one_kyc_client_connectors" in normalized:
                uid = params.get("user_id")
                rows = [
                    r
                    for r in self.connectors
                    if r.get("user_id") == uid and r.get("status") == "active"
                ]
                return SimpleNamespace(data=rows[:1])
            if "update one_kyc_workflows" in normalized:
                wf_id = params["workflow_id"]
                row = next(r for r in self.workflows if r["workflow_id"] == wf_id)
                for key, value in params.items():
                    if key == "workflow_id" or key.startswith("set_"):
                        continue
                    if not params.get(f"set_{key}", True):
                        continue
                    row[key] = json.loads(value) if key == "metadata" else value
                row["updated_at"] = datetime.now(timezone.utc)
                return SimpleNamespace(data=[row])
            return SimpleNamespace(data=[])

    class _FakeConsentDb:
        async def insert_event(self, **kwargs):
            pass

        async def get_pending_by_request_id(self, user_id, request_id):
            return {"request_id": request_id, "action": "REQUESTED"}

        async def get_request_status(self, user_id, request_id):
            return None

        async def get_active_token(self, user_id):
            return None

        async def get_covering_active_tokens(self, user_id, *, requested_scope, agent_id=None):
            return []

    legacy_db = _LegacyRepairDb()
    svc = OneEmailKycService(db=legacy_db, consent_db=_FakeConsentDb())
    svc._config = _make_service()._config

    result = await svc.process_message_id("gmail_legacy_repair_1", history_id="300")

    assert result["reason"] == "client_connector_repaired"
    workflow = result["workflow"]
    assert workflow["status"] == "needs_scope", (
        f"Expected needs_scope (no proposal), got {workflow['status']!r}"
    )
