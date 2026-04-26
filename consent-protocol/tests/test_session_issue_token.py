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
