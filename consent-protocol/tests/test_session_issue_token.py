from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import session


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(session.router)
    return app


def _issue_token_payload(user_id: str = "user_123") -> dict[str, str]:
    return {"userId": user_id, "scope": "session"}


def test_issue_session_token_invalid_firebase_token_returns_401(monkeypatch):
    def _raise_invalid_token(_authorization: str | None) -> str:
        raise ValueError("malformed firebase token")

    monkeypatch.setattr(session, "verify_firebase_bearer", _raise_invalid_token)

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/issue-token",
        json=_issue_token_payload(),
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid token"


def test_issue_session_token_user_mismatch_returns_403(monkeypatch):
    monkeypatch.setattr(session, "verify_firebase_bearer", lambda _authorization: "other_user")

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/issue-token",
        json=_issue_token_payload("user_123"),
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "userId mismatch"


def test_issue_session_token_unexpected_verifier_failure_returns_500(monkeypatch):
    def _raise_unexpected(_authorization: str | None) -> str:
        raise RuntimeError("firebase verifier unavailable")

    monkeypatch.setattr(session, "verify_firebase_bearer", _raise_unexpected)

    client = TestClient(_build_app())
    response = client.post(
        "/api/consent/issue-token",
        json=_issue_token_payload(),
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 500
    assert response.json()["detail"] == "Internal server error"


class _FakeConsentDBService:
    async def get_audit_log(self, user_id: str, page: int, limit: int):
        assert user_id == "user_123"
        assert page == 2
        assert limit == 10
        return {
            "page": page,
            "limit": limit,
            "total": 1,
            "items": [{"agent_id": "agent_a", "action": "GRANTED"}],
        }

    async def get_active_tokens(self, user_id: str):
        assert user_id == "user_123"
        return [
            {
                "developer": "developer:test_app",
                "scope": "vault.owner",
                "id": "tok_123",
                "issued_at": 1,
                "expires_at": 2,
                "time_remaining_ms": 1000,
            }
        ]


def test_consent_history_uses_vault_owner_dependency(monkeypatch):
    app = _build_app()
    app.dependency_overrides[session.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(session, "ConsentDBService", _FakeConsentDBService)

    client = TestClient(app)
    response = client.get(
        "/api/consent/history", params={"userId": "user_123", "page": 2, "limit": 10}
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["items"] == [{"agent_id": "agent_a", "action": "GRANTED"}]
    assert payload["grouped"] == {"agent_a": [{"agent_id": "agent_a", "action": "GRANTED"}]}


def test_consent_history_rejects_token_user_mismatch():
    app = _build_app()
    app.dependency_overrides[session.require_vault_owner_token] = lambda: {"user_id": "other_user"}

    client = TestClient(app)
    response = client.get("/api/consent/history", params={"userId": "user_123"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Token user mismatch"


def test_active_consents_uses_vault_owner_dependency(monkeypatch):
    app = _build_app()
    app.dependency_overrides[session.require_vault_owner_token] = lambda: {"user_id": "user_123"}
    monkeypatch.setattr(session, "ConsentDBService", _FakeConsentDBService)

    client = TestClient(app)
    response = client.get("/api/consent/active", params={"userId": "user_123"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["active"][0]["id"] == "tok_123"
    assert payload["grouped"]["developer:test_app"]["appName"] == "test_app"


def test_active_consents_rejects_token_user_mismatch():
    app = _build_app()
    app.dependency_overrides[session.require_vault_owner_token] = lambda: {"user_id": "other_user"}

    client = TestClient(app)
    response = client.get("/api/consent/active", params={"userId": "user_123"})

    assert response.status_code == 403
    assert response.json()["detail"] == "Token user mismatch"
