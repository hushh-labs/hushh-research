"""Integration tests for the full consent request-to-response lifecycle.

Covers:
    Approve flow    — pending → approve → active token issued → audit event
    Deny flow       — pending → deny → terminal event, no token issued
    Cancel / Escape — pending → cancel → state rolled back (removed from
                      pending, CANCELLED event recorded, no active token)
    Revoke flow     — active → revoke → token invalidated → in-memory set
    Cross-user guard — user A cannot approve / cancel / revoke user B's data
    Idempotency     — acting on an already-terminal request returns 404

Each test calls the existing route handlers directly through TestClient
(``api.routes.consent`` router) — no live DB, no network.
ConsentDBService is replaced by an in-memory stub that mirrors the real
side-effects (pending removed on terminal action, active entry created on
CONSENT_GRANTED, etc.).

No new test roots.  Lives in tests/integration/ within the standard
tests/ tree.

Integrated by Abdul Gaffar — canonical consent-flow integration coverage.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import consent

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_USER = "investor-flow-test-001"
_AGENT = "ria:firm-integration-001"
_SCOPE = "attr.financial.read"
_SCOPE_DESC = "Read financial portfolio data"
_ISSUED_TOKEN = "tok_integration_granted"  # noqa: S105
_EXPIRES_AT = int(time.time() * 1000) + 86_400_000  # +24 h

# ---------------------------------------------------------------------------
# In-memory DB stub (mirrors _FakeConsentDBService in test_consent_handshake)
# ---------------------------------------------------------------------------


class _FakeDB:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.pending: dict[str, dict] = {}
        self.active: dict[tuple[str, str], dict] = {}
        self.revoked_tokens: set[str] = set()

    # ── pending ───────────────────────────────────────────────────────────
    def seed_pending(self, request_id: str, *, agent_id: str = _AGENT,
                     scope: str = _SCOPE, metadata: dict | None = None) -> None:
        self.pending[request_id] = {
            "request_id": request_id,
            "developer": agent_id,
            "scope": scope,
            "scope_description": _SCOPE_DESC,
            "metadata": metadata or {
                "requester_actor_type": "ria",
                "requester_entity_id": agent_id.split(":", 1)[-1],
                "developer_app_display_name": "Integration Advisor",
                "expiry_hours": 24,
            },
        }

    async def get_pending_requests(self, user_id: str) -> list[dict]:
        now_ms = int(time.time() * 1000)
        return [
            {
                "id": row["request_id"],
                "developer": row["developer"],
                "scope": row["scope"],
                "scopeDescription": row.get("scope_description"),
                "requestedAt": now_ms,
                "pollTimeoutAt": None,
                "metadata": row.get("metadata", {}),
            }
            for row in self.pending.values()
        ]

    async def get_pending_by_request_id(self, user_id: str, request_id: str):
        return self.pending.get(request_id)

    async def mark_pending_request_opened(self, **_kw):
        return {}

    # ── active ────────────────────────────────────────────────────────────
    async def find_covering_active_token(self, *_a, **_kw):
        return None

    async def get_active_tokens(self, user_id: str, agent_id=None, scope=None):
        rows = []
        for (ag, sc), row in self.active.items():
            if agent_id and ag != agent_id:
                continue
            if scope and sc != scope:
                continue
            rows.append(row)
        return rows

    async def get_active_internal_tokens(self, user_id, agent_id=None, scope=None):
        return []

    async def get_superseded_active_tokens(self, *_a, **_kw):
        return []

    # ── export / exports ─────────────────────────────────────────────────
    async def store_consent_export(self, **_kw):
        return True

    async def delete_consent_export(self, consent_token: str):
        return True

    # ── audit events ──────────────────────────────────────────────────────
    async def insert_event(self, **kw) -> int:
        self.events.append(kw)
        action = kw.get("action")
        agent_id = kw.get("agent_id")
        scope = kw.get("scope")
        request_id = kw.get("request_id")

        if action == "CONSENT_GRANTED" and agent_id and scope:
            self.active[(agent_id, scope)] = {
                "user_id": kw.get("user_id"),
                "agent_id": agent_id,
                "scope": scope,
                "token_id": _ISSUED_TOKEN,
                "issued_at": int(time.time() * 1000),
                "expires_at": _EXPIRES_AT,
                "request_id": request_id,
            }
            self.pending.pop(request_id, None)

        elif action in {"CONSENT_DENIED", "CANCELLED"} and request_id:
            self.pending.pop(request_id, None)

        elif action == "REVOKED" and agent_id and scope:
            self.active.pop((agent_id, scope), None)

        return len(self.events)

    async def insert_internal_event(self, **_kw) -> int:
        return len(self.events) + 1

    async def list_internal_request_events(self, request_ids, *, actions=None):
        return []

    async def get_audit_log(self, user_id, page=1, limit=50):
        return {"items": self.events, "total": len(self.events), "page": page, "limit": limit}

    async def get_internal_activity_summary(self, user_id, limit=8):
        return {"active_sessions": 0, "recent_operations_24h": 0, "recent": []}


# ---------------------------------------------------------------------------
# IAM / token stubs
# ---------------------------------------------------------------------------


class _NoOpRIAIAM:
    async def sync_relationship_from_consent_action(self, **_kw):
        return

    async def get_persona_state(self, user_id):
        return {"user_id": user_id, "personas": ["investor"],
                "iam_schema_ready": False, "mode": "compat_investor"}


def _fake_issue_token(**_kw):
    return SimpleNamespace(token=_ISSUED_TOKEN, expires_at=_EXPIRES_AT)


# ---------------------------------------------------------------------------
# App builder
# ---------------------------------------------------------------------------


def _build_app(user_id: str = _USER) -> FastAPI:
    app = FastAPI()
    app.include_router(consent.router)
    app.dependency_overrides[consent.require_vault_owner_token] = (
        lambda: {"user_id": user_id}
    )
    app.dependency_overrides[consent.require_firebase_auth] = lambda: user_id
    return app


async def _passthrough(items):
    return items


# ===========================================================================
# 1. Approve flow — full request → response lifecycle
# ===========================================================================


class TestApproveFlow:
    """Full approve path: pending → approve → active token → audit event."""

    def test_approve_returns_200_approved(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-approve-01")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "_hydrate_pending_requester_labels", _passthrough)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/pending/approve",
                           json={"userId": _USER, "requestId": "req-approve-01"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "approved"

    def test_approve_returns_consent_token(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-approve-02")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "_hydrate_pending_requester_labels", _passthrough)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/pending/approve",
                           json={"userId": _USER, "requestId": "req-approve-02"})
        assert resp.json()["consent_token"] == _ISSUED_TOKEN

    def test_approve_records_consent_granted_event(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-approve-03")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "_hydrate_pending_requester_labels", _passthrough)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/approve",
                    json={"userId": _USER, "requestId": "req-approve-03"})

        granted = [e for e in db.events if e["action"] == "CONSENT_GRANTED"]
        assert len(granted) == 1
        assert granted[0]["scope"] == _SCOPE
        assert granted[0]["request_id"] == "req-approve-03"

    def test_approve_removes_request_from_pending(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-approve-04")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "_hydrate_pending_requester_labels", _passthrough)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/approve",
                    json={"userId": _USER, "requestId": "req-approve-04"})

        assert "req-approve-04" not in db.pending

    def test_approve_creates_active_token_entry(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-approve-05")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "_hydrate_pending_requester_labels", _passthrough)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/approve",
                    json={"userId": _USER, "requestId": "req-approve-05"})

        assert (_AGENT, _SCOPE) in db.active

    def test_approve_missing_request_returns_404(self, monkeypatch):
        db = _FakeDB()
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/pending/approve",
                           json={"userId": _USER, "requestId": "req-nonexistent"})
        assert resp.status_code == 404


# ===========================================================================
# 2. Cancel / Escape flow — state must be fully rolled back
# ===========================================================================


class TestCancelFlow:
    """Cancel / Escape: pending → cancel → removed from pending, CANCELLED event,
    no active token created."""

    def test_cancel_returns_200_cancelled(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-cancel-01")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/cancel",
                           json={"userId": _USER, "requestId": "req-cancel-01"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"

    def test_cancel_records_cancelled_event(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-cancel-02")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/cancel",
                    json={"userId": _USER, "requestId": "req-cancel-02"})

        cancelled = [e for e in db.events if e["action"] == "CANCELLED"]
        assert len(cancelled) == 1
        assert cancelled[0]["request_id"] == "req-cancel-02"

    def test_cancel_removes_request_from_pending(self, monkeypatch):
        """Rollback: cancelled request must not remain in pending state."""
        db = _FakeDB()
        db.seed_pending("req-cancel-03")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/cancel",
                    json={"userId": _USER, "requestId": "req-cancel-03"})

        assert "req-cancel-03" not in db.pending

    def test_cancel_does_not_create_active_token(self, monkeypatch):
        """Rollback: no active token should be created on cancel."""
        db = _FakeDB()
        db.seed_pending("req-cancel-04")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/cancel",
                    json={"userId": _USER, "requestId": "req-cancel-04"})

        assert len(db.active) == 0

    def test_cancel_nonexistent_request_returns_404(self, monkeypatch):
        db = _FakeDB()
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/cancel",
                           json={"userId": _USER, "requestId": "req-ghost"})
        assert resp.status_code == 404

    def test_cancel_then_approve_attempt_returns_404(self, monkeypatch):
        """After cancel, the request no longer exists — approve must fail."""
        db = _FakeDB()
        db.seed_pending("req-cancel-05")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/cancel",
                    json={"userId": _USER, "requestId": "req-cancel-05"})

        resp = client.post("/api/consent/pending/approve",
                           json={"userId": _USER, "requestId": "req-cancel-05"})
        assert resp.status_code == 404


# ===========================================================================
# 3. Deny flow
# ===========================================================================


class TestDenyFlow:
    """Deny: pending → deny → terminal event, removed from pending, no token."""

    def test_deny_returns_200_denied(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-deny-01")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/pending/deny",
                           params={"userId": _USER, "requestId": "req-deny-01"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "denied"

    def test_deny_records_consent_denied_event(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-deny-02")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/deny",
                    params={"userId": _USER, "requestId": "req-deny-02"})

        denied = [e for e in db.events if e["action"] == "CONSENT_DENIED"]
        assert len(denied) == 1
        assert denied[0]["request_id"] == "req-deny-02"

    def test_deny_removes_request_from_pending(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-deny-03")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/deny",
                    params={"userId": _USER, "requestId": "req-deny-03"})

        assert "req-deny-03" not in db.pending

    def test_deny_does_not_create_active_token(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-deny-04")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/deny",
                    params={"userId": _USER, "requestId": "req-deny-04"})

        assert len(db.active) == 0


# ===========================================================================
# 4. Revoke flow
# ===========================================================================


class TestRevokeFlow:
    """Revoke: active token → revoke → removed from active, in-memory revocation."""

    def _seed_active(self, db: _FakeDB, token_id: str = _ISSUED_TOKEN) -> None:
        db.active[(_AGENT, _SCOPE)] = {
            "user_id": _USER,
            "agent_id": _AGENT,
            "scope": _SCOPE,
            "token_id": token_id,
            "issued_at": int(time.time() * 1000),
            "expires_at": _EXPIRES_AT,
        }

    def test_revoke_returns_200_revoked(self, monkeypatch):
        db = _FakeDB()
        self._seed_active(db)
        revoked: set[str] = set()
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "revoke_token", revoked.add)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/revoke",
                           json={"userId": _USER, "scope": _SCOPE})
        assert resp.status_code == 200
        assert resp.json()["status"] == "revoked"

    def test_revoke_adds_token_to_revocation_set(self, monkeypatch):
        db = _FakeDB()
        self._seed_active(db)
        revoked: set[str] = set()
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "revoke_token", revoked.add)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        # revoke_consent imports revoke_token locally inside the function body,
        # so patch the source module as well to intercept the local import.
        import hushh_mcp.consent.token as _tok_mod
        monkeypatch.setattr(_tok_mod, "revoke_token", revoked.add)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/revoke",
                    json={"userId": _USER, "scope": _SCOPE})
        assert _ISSUED_TOKEN in revoked

    def test_revoke_removes_active_entry(self, monkeypatch):
        db = _FakeDB()
        self._seed_active(db)
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "revoke_token", lambda _t: None)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/revoke",
                    json={"userId": _USER, "scope": _SCOPE})
        assert (_AGENT, _SCOPE) not in db.active

    def test_revoke_nonexistent_scope_returns_404(self, monkeypatch):
        db = _FakeDB()
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "revoke_token", lambda _t: None)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        resp = client.post("/api/consent/revoke",
                           json={"userId": _USER, "scope": "attr.does.not.exist"})
        assert resp.status_code == 404


# ===========================================================================
# 5. Cross-user guard — must return 403 on every terminal action
# ===========================================================================


class TestCrossUserGuard:
    """User A cannot approve / cancel / deny / revoke on behalf of User B."""

    def test_approve_wrong_user_returns_403(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-xuser-01")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(user_id="attacker-user"), raise_server_exceptions=False)
        resp = client.post("/api/consent/pending/approve",
                           json={"userId": _USER, "requestId": "req-xuser-01"})
        assert resp.status_code == 403

    def test_cancel_wrong_user_returns_403(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-xuser-02")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(user_id="attacker-user"), raise_server_exceptions=False)
        resp = client.post("/api/consent/cancel",
                           json={"userId": _USER, "requestId": "req-xuser-02"})
        assert resp.status_code == 403

    def test_deny_wrong_user_returns_403(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-xuser-03")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(user_id="attacker-user"), raise_server_exceptions=False)
        resp = client.post("/api/consent/pending/deny",
                           params={"userId": _USER, "requestId": "req-xuser-03"})
        assert resp.status_code == 403

    def test_revoke_wrong_user_returns_403(self, monkeypatch):
        db = _FakeDB()
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "revoke_token", lambda _t: None)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(user_id="attacker-user"), raise_server_exceptions=False)
        resp = client.post("/api/consent/revoke",
                           json={"userId": _USER, "scope": _SCOPE})
        assert resp.status_code == 403


# ===========================================================================
# 6. Idempotency — acting on a terminal request returns 404
# ===========================================================================


class TestIdempotency:
    """Once a request reaches a terminal state it cannot be acted on again."""

    def test_double_cancel_second_returns_404(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-idempotent-01")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/cancel",
                    json={"userId": _USER, "requestId": "req-idempotent-01"})
        resp = client.post("/api/consent/cancel",
                           json={"userId": _USER, "requestId": "req-idempotent-01"})
        assert resp.status_code == 404

    def test_deny_then_approve_returns_404(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-idempotent-02")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/deny",
                    params={"userId": _USER, "requestId": "req-idempotent-02"})
        resp = client.post("/api/consent/pending/approve",
                           json={"userId": _USER, "requestId": "req-idempotent-02"})
        assert resp.status_code == 404

    def test_approve_then_approve_again_returns_404(self, monkeypatch):
        db = _FakeDB()
        db.seed_pending("req-idempotent-03")
        monkeypatch.setattr(consent, "ConsentDBService", lambda: db)
        monkeypatch.setattr(consent, "RIAIAMService", _NoOpRIAIAM)
        monkeypatch.setattr(consent, "issue_token", _fake_issue_token)
        monkeypatch.setattr(consent, "_hydrate_pending_requester_labels", _passthrough)

        client = TestClient(_build_app(), raise_server_exceptions=False)
        client.post("/api/consent/pending/approve",
                    json={"userId": _USER, "requestId": "req-idempotent-03"})
        resp = client.post("/api/consent/pending/approve",
                           json={"userId": _USER, "requestId": "req-idempotent-03"})
        assert resp.status_code == 404
