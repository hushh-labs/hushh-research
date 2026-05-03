from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.one import email as one_email


def _build_app(firebase_uid: str = "user_123") -> TestClient:
    app = FastAPI()
    app.include_router(one_email.router)
    app.dependency_overrides[one_email.require_firebase_auth] = lambda: firebase_uid
    return TestClient(app)


def test_one_kyc_route_rejects_user_mismatch():
    client = _build_app(firebase_uid="user_123")

    response = client.get("/api/one/kyc/workflows?user_id=other_user")

    assert response.status_code == 403


def test_one_watch_renew_rejects_missing_maintenance_token(monkeypatch):
    monkeypatch.setenv("ONE_EMAIL_WATCH_RENEW_AUTH_ENABLED", "true")
    monkeypatch.setenv("ONE_EMAIL_WATCH_RENEW_TOKEN", "expected-token")
    client = _build_app()

    response = client.post("/api/one/email/watch/renew")

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "ONE_EMAIL_WATCH_RENEW_UNAUTHORIZED"


def test_one_kyc_reject_route_uses_authenticated_user(monkeypatch):
    calls: list[dict] = []

    class _Service:
        async def reject_draft(self, *, user_id: str, workflow_id: str, reason: str | None = None):
            calls.append({"user_id": user_id, "workflow_id": workflow_id, "reason": reason})
            return {"workflow_id": workflow_id, "user_id": user_id, "status": "blocked"}

    monkeypatch.setattr(one_email, "_service", lambda: _Service())
    client = _build_app(firebase_uid="user_123")

    response = client.post(
        "/api/one/kyc/workflows/workflow_123/reject-draft",
        json={"user_id": "user_123", "reason": "No"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "blocked"
    assert calls == [{"user_id": "user_123", "workflow_id": "workflow_123", "reason": "No"}]
