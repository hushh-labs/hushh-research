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

    # Pending helpers ----------------------------------------------------------
    def _add_pending(self, request_id: str, row: dict) -> None:
        self.pending[request_id] = row

    async def get_pending_requests(self, user_id: str):
        now_ms = int(time.time() * 1000)
        results = []
        for row in self.pending.values():
            results.append(
                {
                    "id": row["request_id"],
                    "developer": row.get("agent_id", row.get("developer")),
                    "scope": row["scope"],
                    "scopeDescription": row.get("scope_description"),
                    "requestedAt": row.get("issued_at", now_ms),
                    "pollTimeoutAt": row.get("poll_timeout_at"),
                    "metadata": row.get("metadata", {}),
                }
            )
        return results

    async def get_pending_by_request_id(self, user_id: str, request_id: str):
        row = self.pending.get(request_id)
        if not row:
            return None
        return {
            "request_id": request_id,
            "developer": row.get("agent_id", row.get("developer")),
            "scope": row["scope"],
            "metadata": row.get("metadata", {}),
        }

    async def mark_pending_request_opened(self, **_kwargs):
        return {"request_id": "req_1"}

    # Active helpers -----------------------------------------------------------
    async def find_covering_active_token(self, *_args, **_kwargs):
        return None

    async def get_active_tokens(self, user_id, agent_id=None, scope=None):
        results = []
        for key, row in self.active.items():
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

    async def store_consent_export(self, **_kwargs):
        return True

    async def delete_consent_export(self, consent_token):
        return True

    async def get_audit_log(self, user_id, page=1, limit=50):
        return {"items": self.events, "total": len(self.events), "page": page, "limit": limit}

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
    monkeypatch.setattr(
        consent,
        "validate_token",
        lambda token_str, expected_scope=None: (False, "Token has been revoked", None),
    )

    app = _build_app()
    client = TestClient(app)
    resp = client.get("/api/consent/data", params={"consent_token": "bad_token"})
    assert resp.status_code == 401
    assert "Invalid token" in resp.json()["detail"]


def test_revoke_immediately_invalidates_data_access(monkeypatch):
    """After revocation, data endpoint rejects the revoked token."""
    fake_db = _FakeConsentDBService()
    revoked_tokens: set[str] = set()

    def mock_revoke(t):
        revoked_tokens.add(t)

    def mock_validate(token_str, expected_scope=None):
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
    monkeypatch.setattr(consent, "validate_token", mock_validate)
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
