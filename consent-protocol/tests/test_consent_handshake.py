"""
Tests for the unified consent handshake between investor and RIA.

Issue #122: The full lifecycle — invite -> accept -> grant -> revoke — must be
reflected consistently in both the investor and RIA consent surfaces.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import consent

# ============================================================================
# Helpers
# ============================================================================


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(consent.router)
    app.dependency_overrides[consent.require_vault_owner_token] = lambda: {"user_id": "investor_1"}
    app.dependency_overrides[consent.require_firebase_auth] = lambda: "investor_1"
    return app


class _FakeConsentDBService:
    """In-memory consent DB stub for lifecycle tests."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.pending: dict[str, dict] = {}
        self.active: dict[tuple[str, str], dict] = {}  # (agent, scope) -> row
        self.export_writes: list[dict] = []

    # Pending helpers ----------------------------------------------------------
    @staticmethod
    def _normalize_identifier(value: object) -> str:
        normalized = str(value or "").strip()
        if "@" in normalized:
            normalized = normalized.lower()
        return normalized

    @classmethod
    def _allowed_user_ids(cls, user_id: str, user_ids=None) -> set[str]:
        values = [user_id, *(list(user_ids or []))]
        return {
            cls._normalize_identifier(value) for value in values if cls._normalize_identifier(value)
        }

    @classmethod
    def _row_user_id(cls, row: dict, fallback_user_id: str) -> str:
        return cls._normalize_identifier(row.get("user_id") or fallback_user_id)

    def _add_pending(self, request_id: str, row: dict) -> None:
        self.pending[request_id] = row

    async def get_pending_requests(self, user_id: str, *, user_ids=None):
        now_ms = int(time.time() * 1000)
        allowed_user_ids = self._allowed_user_ids(user_id, user_ids)
        results = []
        for row in self.pending.values():
            row_user_id = self._row_user_id(row, user_id)
            if row_user_id not in allowed_user_ids:
                continue
            results.append(
                {
                    "id": row["request_id"],
                    "userId": row_user_id,
                    "subjectUserId": row_user_id,
                    "developer": row.get("agent_id", row.get("developer")),
                    "scope": row["scope"],
                    "scopeDescription": row.get("scope_description"),
                    "requestedAt": row.get("issued_at", now_ms),
                    "pollTimeoutAt": row.get("poll_timeout_at"),
                    "metadata": row.get("metadata", {}),
                }
            )
        return results

    async def get_pending_by_request_id(self, user_id: str, request_id: str, *, user_ids=None):
        row = self.pending.get(request_id)
        if not row:
            return None
        row_user_id = self._row_user_id(row, user_id)
        if row_user_id not in self._allowed_user_ids(user_id, user_ids):
            return None
        return {
            "request_id": request_id,
            "user_id": row_user_id,
            "developer": row.get("agent_id", row.get("developer")),
            "agent_id": row.get("agent_id"),
            "requester_label": row.get("requester_label"),
            "requester_image_url": row.get("requester_image_url"),
            "requester_website_url": row.get("requester_website_url"),
            "scope": row["scope"],
            "scope_description": row.get("scope_description"),
            "poll_timeout_at": row.get("poll_timeout_at"),
            "issued_at": row.get("issued_at"),
            "request_url": row.get("request_url"),
            "reason": row.get("reason"),
            "metadata": row.get("metadata", {}),
            "bundle_id": row.get("bundle_id"),
            "bundle_label": row.get("bundle_label"),
            "bundle_scope_count": row.get("bundle_scope_count"),
            "is_scope_upgrade": row.get("is_scope_upgrade"),
            "existing_granted_scopes": row.get("existing_granted_scopes"),
            "additional_access_summary": row.get("additional_access_summary"),
        }

    async def mark_pending_request_opened(self, **_kwargs):
        return {"request_id": "req_1"}

    # Active helpers -----------------------------------------------------------
    async def find_covering_active_token(
        self,
        user_id,
        *,
        requested_scope,
        agent_id=None,
        user_ids=None,
    ):
        active_tokens = await self.get_active_tokens(user_id, agent_id=agent_id, user_ids=user_ids)
        for token in active_tokens:
            if token.get("scope") == requested_scope:
                return token
        return None

    async def get_active_tokens(self, user_id, agent_id=None, scope=None, *, user_ids=None):
        allowed_user_ids = self._allowed_user_ids(user_id, user_ids)
        results = []
        for key, row in self.active.items():
            row_user_id = self._row_user_id(row, user_id)
            if row_user_id not in allowed_user_ids:
                continue
            if agent_id and key[0] != agent_id:
                continue
            if scope and key[1] != scope:
                continue
            results.append(row)
        return results

    async def get_active_internal_tokens(self, user_id, agent_id=None, scope=None):
        return []

    async def get_superseded_active_tokens(self, *_args, **_kwargs):
        return []

    async def store_consent_export(self, **kwargs):
        self.export_writes.append(kwargs)
        return True

    async def delete_consent_export(self, consent_token):
        return True

    async def get_audit_log(self, user_id, page=1, limit=50, *, user_ids=None):
        allowed_user_ids = self._allowed_user_ids(user_id, user_ids)
        items = [
            event
            for event in self.events
            if self._normalize_identifier(event.get("user_id") or user_id) in allowed_user_ids
        ]
        return {"items": items, "total": len(items), "page": page, "limit": limit}

    async def get_internal_activity_summary(self, user_id, limit=8):
        return {"active_sessions": 0, "recent_operations_24h": 0, "recent": []}

    # Event insertion ----------------------------------------------------------
    async def insert_event(self, **kwargs):
        self.events.append(kwargs)
        action = kwargs.get("action")
        agent_id = kwargs.get("agent_id")
        scope = kwargs.get("scope")
        request_id = kwargs.get("request_id")

        # Side-effects to mirror real DB behavior.
        if action == "CONSENT_GRANTED" and agent_id and scope:
            self.active[(agent_id, scope)] = {
                "user_id": kwargs.get("user_id"),
                "agent_id": agent_id,
                "scope": scope,
                "token_id": kwargs.get("token_id"),
                "issued_at": int(time.time() * 1000),
                "expires_at": kwargs.get("expires_at"),
                "request_id": request_id,
                "metadata": kwargs.get("metadata"),
            }
            if request_id and request_id in self.pending:
                del self.pending[request_id]
        elif action in {"CONSENT_DENIED", "CANCELLED"} and request_id:
            self.pending.pop(request_id, None)
        elif action == "REVOKED" and agent_id and scope:
            self.active.pop((agent_id, scope), None)

        return len(self.events)

    async def insert_internal_event(self, **kwargs):
        return len(self.events) + 1

    async def list_internal_request_events(self, request_ids, *, actions=None):
        return []


class _NoOpRIAIAMService:
    """Stub RIA IAM service that accepts all calls."""

    async def sync_relationship_from_consent_action(self, **_kwargs):
        return

    async def get_persona_state(self, user_id):
        return {
            "user_id": user_id,
            "personas": ["investor"],
            "last_active_persona": "investor",
            "iam_schema_ready": False,
            "mode": "compat_investor",
        }


# ============================================================================
# Tests
# ============================================================================


def test_vault_userid_query_params_reject_oversized_values_before_service(monkeypatch):
    """Vault-gated userId query params are bounded before service dispatch."""

    class _UnexpectedConsentDBService:
        def __init__(self):
            raise AssertionError("userId validation should run before service dispatch")

    monkeypatch.setattr(consent, "ConsentDBService", _UnexpectedConsentDBService)

    app = _build_app()
    client = TestClient(app)
    long_user_id = "u" * 129

    responses = [
        client.get("/api/consent/pending", params={"userId": long_user_id}),
        client.get(
            "/api/consent/pending/lookup",
            params={"userId": long_user_id, "request_id": "req_123"},
        ),
        client.post(
            "/api/consent/pending/deny",
            params={"userId": long_user_id, "requestId": "req_123"},
        ),
        client.get("/api/consent/export-refresh/jobs", params={"userId": long_user_id}),
    ]

    assert [response.status_code for response in responses] == [422, 422, 422, 422]


def test_full_handshake_lifecycle(monkeypatch):
    """
    Simulate the canonical handshake: request -> approve -> revoke.
    Verify events are recorded at each step.
    """
    fake_db = _FakeConsentDBService()
    issued_token = "token_handshake_granted"  # noqa: S105

    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(
        consent,
        "issue_token",
        lambda **_kwargs: SimpleNamespace(
            token=issued_token, expires_at=int(time.time() * 1000) + 86400000
        ),
    )
    monkeypatch.setattr(consent, "revoke_token", lambda t: None)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    # Bypass hydration which tries real DB via ActorIdentityService.
    async def _passthrough(items):
        return items

    monkeypatch.setattr(consent, "_hydrate_pending_requester_labels", _passthrough)

    app = _build_app()
    client = TestClient(app)

    # 1) RIA creates a consent request (simulated via inserting a pending row).
    fake_db._add_pending(
        "req_handshake",
        {
            "request_id": "req_handshake",
            "agent_id": "ria:profile_abc",
            "scope": "attr.financial.*",
            "scope_description": "Financial data",
            "issued_at": int(time.time() * 1000),
            "metadata": {
                "requester_actor_type": "ria",
                "requester_entity_id": "profile_abc",
                "expiry_hours": 24,
                "developer_app_display_name": "Advisor X",
            },
        },
    )

    # 2) Investor sees the pending request.
    resp = client.get("/api/consent/pending", params={"userId": "investor_1"})
    assert resp.status_code == 200
    pending = resp.json()["pending"]
    assert len(pending) == 1
    assert pending[0]["scope"] == "attr.financial.*"

    # 3) Investor approves.
    resp = client.post(
        "/api/consent/pending/approve",
        json={"userId": "investor_1", "requestId": "req_handshake"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "approved"
    assert data["consent_token"] == issued_token

    # Verify CONSENT_GRANTED event recorded.
    granted_events = [e for e in fake_db.events if e["action"] == "CONSENT_GRANTED"]
    assert len(granted_events) == 1
    assert granted_events[0]["scope"] == "attr.financial.*"
    assert granted_events[0]["request_id"] == "req_handshake"

    # 4) Investor revokes.
    # First ensure active token is present in the fake DB.
    active_key = ("ria:profile_abc", "attr.financial.*")
    assert active_key in fake_db.active

    resp = client.post(
        "/api/consent/revoke",
        json={"userId": "investor_1", "scope": "attr.financial.*"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "revoked"

    # Verify REVOKED event recorded.
    revoked_events = [e for e in fake_db.events if e["action"] == "REVOKED"]
    assert len(revoked_events) == 1


def test_pending_lookup_resolves_cross_linked_request_ids(monkeypatch):
    """Product surfaces resolve canonical consent rows by cross-linked ids."""
    fake_db = _FakeConsentDBService()
    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)

    issued_at = int(time.time() * 1000)
    fake_db._add_pending(
        "req_email_scope",
        {
            "request_id": "req_email_scope",
            "agent_id": "developer:one-email",
            "requester_label": "One",
            "scope": "attr.travel.preferences.seat.*",
            "scope_description": "Seat preferences",
            "issued_at": issued_at,
            "poll_timeout_at": issued_at + 60000,
            "request_url": "/consent/pending?requestId=req_email_scope",
            "reason": "Reply to an email request with approved seat preferences.",
            "bundle_id": "bundle_email",
            "bundle_label": "Email access request",
            "bundle_scope_count": 1,
            "metadata": {
                "request_source": "one_email_kyc_v1",
                "connector_public_key": "public-key",
                "connector_key_id": "one-email-key",
            },
        },
    )

    app = _build_app()
    client = TestClient(app)

    resp = client.get(
        "/api/consent/pending/lookup",
        params=[
            ("userId", "investor_1"),
            ("request_id", "req_email_scope"),
            ("request_id", "req_email_scope"),
            ("request_id", "missing_scope"),
        ],
    )

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["missing_request_ids"] == ["missing_scope"]
    assert len(payload["items"]) == 1
    item = payload["items"][0]
    assert item["request_id"] == "req_email_scope"
    assert item["scope"] == "attr.travel.preferences.seat.*"
    assert item["scope_description"] == "Seat preferences"
    assert item["requester_label"] == "One"
    assert item["bundle_id"] == "bundle_email"
    assert item["metadata"]["request_source"] == "one_email_kyc_v1"
    assert item["metadata"]["connector_public_key"] == "public-key"


def test_deny_consent_records_event(monkeypatch):
    """Investor denies a pending consent request."""
    fake_db = _FakeConsentDBService()
    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    fake_db._add_pending(
        "req_deny",
        {
            "request_id": "req_deny",
            "agent_id": "ria:profile_deny",
            "scope": "attr.financial.portfolio.*",
            "metadata": {
                "requester_actor_type": "ria",
                "requester_entity_id": "profile_deny",
                "developer_app_display_name": "Advisor Y",
            },
        },
    )

    app = _build_app()
    client = TestClient(app)
    resp = client.post(
        "/api/consent/pending/deny",
        params={"userId": "investor_1", "requestId": "req_deny"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "denied"

    denied = [e for e in fake_db.events if e["action"] == "CONSENT_DENIED"]
    assert len(denied) == 1
    assert denied[0]["request_id"] == "req_deny"


def test_alias_keyed_pending_request_can_be_denied_by_account_owner(monkeypatch):
    """The account owner can act on requests keyed by a verified email alias."""
    fake_db = _FakeConsentDBService()
    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    async def _owned_identifiers(_user_id: str):
        return ["investor_1", "akshat@example.com", "relay@privaterelay.appleid.com"]

    monkeypatch.setattr(consent, "_owned_consent_identifiers", _owned_identifiers)

    fake_db._add_pending(
        "req_alias_deny",
        {
            "request_id": "req_alias_deny",
            "user_id": "relay@privaterelay.appleid.com",
            "agent_id": "developer:app_alias",
            "scope": "pkm.read",
            "metadata": {
                "requester_actor_type": "developer",
                "developer_app_display_name": "External Agent",
            },
        },
    )

    app = _build_app()
    client = TestClient(app)

    resp = client.get("/api/consent/pending", params={"userId": "investor_1"})
    assert resp.status_code == 200
    assert [item["id"] for item in resp.json()["pending"]] == ["req_alias_deny"]

    resp = client.post(
        "/api/consent/pending/deny",
        params={"userId": "investor_1", "requestId": "req_alias_deny"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "denied"

    denied = [event for event in fake_db.events if event["action"] == "CONSENT_DENIED"]
    assert len(denied) == 1
    assert denied[0]["user_id"] == "relay@privaterelay.appleid.com"
    assert denied[0]["request_id"] == "req_alias_deny"


def test_alias_keyed_pending_request_reuses_account_active_token(monkeypatch):
    """Existing UID-keyed grants cover matching requests keyed by a verified alias."""
    fake_db = _FakeConsentDBService()
    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    async def _owned_identifiers(_user_id: str):
        return ["investor_1", "relay@privaterelay.appleid.com"]

    monkeypatch.setattr(consent, "_owned_consent_identifiers", _owned_identifiers)

    def _unexpected_issue_token(**_kwargs):
        raise AssertionError("approval should reuse the account-owned active token")

    monkeypatch.setattr(consent, "issue_token", _unexpected_issue_token)

    fake_db.active[("ria:profile_alias", "pkm.read")] = {
        "user_id": "investor_1",
        "agent_id": "ria:profile_alias",
        "scope": "pkm.read",
        "token_id": "token_existing_uid",
        "issued_at": int(time.time() * 1000),
        "expires_at": int(time.time() * 1000) + 86400000,
        "request_id": "req_original",
    }
    fake_db._add_pending(
        "req_alias_approve",
        {
            "request_id": "req_alias_approve",
            "user_id": "relay@privaterelay.appleid.com",
            "agent_id": "ria:profile_alias",
            "scope": "pkm.read",
            "metadata": {
                "requester_actor_type": "ria",
                "requester_entity_id": "profile_alias",
                "developer_app_display_name": "Advisor Alias",
            },
        },
    )

    app = _build_app()
    client = TestClient(app)
    resp = client.post(
        "/api/consent/pending/approve",
        json={"userId": "investor_1", "requestId": "req_alias_approve"},
    )

    assert resp.status_code == 200
    assert resp.json()["consent_token"] == "token_existing_uid"  # noqa: S105

    granted = [event for event in fake_db.events if event["action"] == "CONSENT_GRANTED"]
    assert [event["user_id"] for event in granted] == [
        "relay@privaterelay.appleid.com",
        "investor_1",
    ]
    assert {event["request_id"] for event in granted} == {"req_alias_approve"}


def test_alias_keyed_developer_approval_stores_export_for_canonical_user(monkeypatch):
    """Alias-keyed developer requests close by alias but store export under the vault owner."""
    fake_db = _FakeConsentDBService()
    issued: dict[str, object] = {}

    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    async def _owned_identifiers(_user_id: str):
        return ["investor_1", "relay@privaterelay.appleid.com"]

    def _issue_token(**kwargs):
        issued.update(kwargs)
        return SimpleNamespace(
            token="token_alias_export",  # noqa: S106
            expires_at=int(time.time() * 1000) + 86400000,
        )

    monkeypatch.setattr(consent, "_owned_consent_identifiers", _owned_identifiers)
    monkeypatch.setattr(consent, "issue_token", _issue_token)

    fake_db._add_pending(
        "req_alias_export",
        {
            "request_id": "req_alias_export",
            "user_id": "relay@privaterelay.appleid.com",
            "agent_id": "developer:app_alias",
            "scope": "pkm.read",
            "metadata": {
                "requester_actor_type": "developer",
                "developer_app_display_name": "External Agent",
                "connector_public_key": "connector-public-key",
                "connector_key_id": "connector-key-1",
                "connector_wrapping_alg": "X25519-AES256-GCM",
            },
        },
    )

    app = _build_app()
    client = TestClient(app)
    resp = client.post(
        "/api/consent/pending/approve",
        json={
            "userId": "investor_1",
            "requestId": "req_alias_export",
            "encryptedData": "ciphertext",
            "encryptedIv": "iv",
            "encryptedTag": "tag",
            "wrappedExportKey": "wrapped",
            "wrappedKeyIv": "wrapped-iv",
            "wrappedKeyTag": "wrapped-tag",
            "senderPublicKey": "sender-public-key",
            "wrappingAlg": "X25519-AES256-GCM",
            "connectorKeyId": "connector-key-1",
        },
    )

    assert resp.status_code == 200
    assert issued["user_id"] == "investor_1"
    assert fake_db.export_writes[0]["user_id"] == "investor_1"

    granted = [event for event in fake_db.events if event["action"] == "CONSENT_GRANTED"]
    assert [event["user_id"] for event in granted] == [
        "relay@privaterelay.appleid.com",
        "investor_1",
    ]
    assert {event["request_id"] for event in granted} == {"req_alias_export"}


def test_alias_keyed_active_consent_can_be_revoked_by_account_owner(monkeypatch):
    """Revocation uses the same verified alias ownership filter as consent reads."""
    fake_db = _FakeConsentDBService()
    revoked_tokens: list[str] = []

    import hushh_mcp.consent.token as token_module

    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(token_module, "revoke_token", lambda token: revoked_tokens.append(token))
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    async def _owned_identifiers(_user_id: str):
        return ["investor_1", "relay@privaterelay.appleid.com"]

    monkeypatch.setattr(consent, "_owned_consent_identifiers", _owned_identifiers)

    fake_db.active[("developer:app_alias", "pkm.read")] = {
        "user_id": "relay@privaterelay.appleid.com",
        "agent_id": "developer:app_alias",
        "scope": "pkm.read",
        "token_id": "token_alias_active",
        "issued_at": int(time.time() * 1000),
        "expires_at": int(time.time() * 1000) + 86400000,
        "request_id": "req_alias_approve",
    }

    app = _build_app()
    client = TestClient(app)
    resp = client.post(
        "/api/consent/revoke",
        json={"userId": "investor_1", "scope": "pkm.read"},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "revoked"
    assert revoked_tokens == ["token_alias_active"]

    revoked = [event for event in fake_db.events if event["action"] == "REVOKED"]
    assert len(revoked) == 1
    assert revoked[0]["user_id"] == "relay@privaterelay.appleid.com"
    assert revoked[0]["request_id"] == "req_alias_approve"


def test_cancel_consent_records_event(monkeypatch):
    """Investor cancels a pending consent request."""
    fake_db = _FakeConsentDBService()
    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    fake_db._add_pending(
        "req_cancel",
        {
            "request_id": "req_cancel",
            "agent_id": "ria:profile_cancel",
            "scope": "attr.financial.*",
            "metadata": {
                "requester_actor_type": "ria",
                "requester_entity_id": "profile_cancel",
            },
        },
    )

    app = _build_app()
    client = TestClient(app)
    resp = client.post(
        "/api/consent/cancel",
        json={"userId": "investor_1", "requestId": "req_cancel"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"

    cancelled = [e for e in fake_db.events if e["action"] == "CANCELLED"]
    assert len(cancelled) == 1


def test_no_data_access_before_approved_consent(monkeypatch):
    """
    Core invariant: consent/data endpoint rejects requests with no valid token.
    """

    async def mock_validate_token_with_db(token_str, expected_scope=None):
        return (False, "Token has been revoked", None)

    monkeypatch.setattr(consent, "validate_token_with_db", mock_validate_token_with_db)

    app = _build_app()
    client = TestClient(app)
    resp = client.get("/api/consent/data", params={"consent_token": "bad_token"})
    assert resp.status_code == 401
    assert resp.headers.get("WWW-Authenticate") == "Bearer"
    assert "Invalid token" in resp.json()["detail"]


def test_revoke_immediately_invalidates_data_access(monkeypatch):
    """After revocation, data endpoint rejects the revoked token."""
    fake_db = _FakeConsentDBService()
    revoked_tokens: set[str] = set()

    def mock_revoke(t):
        revoked_tokens.add(t)

    async def mock_validate_token_with_db(token_str, expected_scope=None):
        if token_str in revoked_tokens:
            return (False, "Token has been revoked", None)
        return (
            True,
            None,
            SimpleNamespace(
                user_id="investor_1",
                agent_id="ria:profile_abc",
                scope_str="attr.financial.*",
            ),
        )

    import hushh_mcp.consent.token as token_module

    monkeypatch.setattr(consent, "ConsentDBService", lambda: fake_db)
    monkeypatch.setattr(consent, "revoke_token", mock_revoke)
    monkeypatch.setattr(token_module, "revoke_token", mock_revoke)  # Patch the source module too
    monkeypatch.setattr(consent, "validate_token_with_db", mock_validate_token_with_db)
    monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAMService)

    token_id = "token_to_revoke"  # noqa: S105
    fake_db.active[("ria:profile_abc", "attr.financial.*")] = {
        "user_id": "investor_1",
        "agent_id": "ria:profile_abc",
        "scope": "attr.financial.*",
        "token_id": token_id,
        "issued_at": int(time.time() * 1000),
        "expires_at": int(time.time() * 1000) + 86400000,
    }

    app = _build_app()
    client = TestClient(app)

    # Revoke.
    resp = client.post(
        "/api/consent/revoke",
        json={"userId": "investor_1", "scope": "attr.financial.*"},
    )
    assert resp.status_code == 200
    assert token_id in revoked_tokens

    # Attempt to access data with the revoked token.
    resp = client.get("/api/consent/data", params={"consent_token": token_id})
    assert resp.status_code == 401


def test_handshake_history_returns_timeline():
    """GET /handshake/history returns a chronological timeline."""
    app = _build_app()
    with patch(
        "hushh_mcp.services.consent_center_service.ConsentCenterService.get_handshake_history",
        new_callable=AsyncMock,
        return_value={
            "user_id": "investor_1",
            "counterpart_id": "profile_abc",
            "total": 3,
            "timeline": [
                {"action": "REVOKED"},
                {"action": "CONSENT_GRANTED"},
                {"action": "REQUESTED"},
            ],
        },
    ):
        client = TestClient(app)
        resp = client.get(
            "/api/consent/handshake/history",
            params={"counterpart_id": "profile_abc"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert len(data["timeline"]) == 3
    actions = [e["action"] for e in data["timeline"]]
    assert actions == ["REVOKED", "CONSENT_GRANTED", "REQUESTED"]


def test_handshake_history_empty_for_unrelated_counterpart():
    """Timeline is empty when there are no events for the counterpart."""
    app = _build_app()
    with patch(
        "hushh_mcp.services.consent_center_service.ConsentCenterService.get_handshake_history",
        new_callable=AsyncMock,
        return_value={
            "user_id": "investor_1",
            "counterpart_id": "unknown",
            "total": 0,
            "timeline": [],
        },
    ):
        client = TestClient(app)
        resp = client.get(
            "/api/consent/handshake/history",
            params={"counterpart_id": "unknown"},
        )

    assert resp.status_code == 200
    assert resp.json()["total"] == 0
    assert resp.json()["timeline"] == []
