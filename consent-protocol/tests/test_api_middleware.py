from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException

import api.middleware as middleware


@pytest.mark.asyncio
async def test_require_firebase_auth_rejects_missing_bearer_with_challenge():
    with pytest.raises(HTTPException) as exc_info:
        await middleware.require_firebase_auth(BackgroundTasks(), None)

    assert exc_info.value.status_code == 401
    assert exc_info.value.headers == {"WWW-Authenticate": "Bearer"}


@pytest.mark.asyncio
async def test_require_firebase_auth_rejects_malformed_bearer_with_challenge():
    with pytest.raises(HTTPException) as exc_info:
        await middleware.require_firebase_auth(BackgroundTasks(), "raw-token")

    assert exc_info.value.status_code == 401
    assert exc_info.value.headers == {"WWW-Authenticate": "Bearer"}


@pytest.mark.asyncio
async def test_require_firebase_auth_schedules_identity_warmup(monkeypatch):
    calls: list[str] = []

    async def _fake_run_in_threadpool(func, authorization):
        assert authorization == "Bearer firebase-token"
        return "firebase-user-123"

    class _FakeActorIdentityService:
        def schedule_sync_from_firebase(self, firebase_uid: str) -> None:
            calls.append(firebase_uid)

    monkeypatch.setattr(middleware, "run_in_threadpool", _fake_run_in_threadpool)
    monkeypatch.setattr(
        middleware,
        "ActorIdentityService",
        lambda: _FakeActorIdentityService(),
    )

    background_tasks = BackgroundTasks()
    firebase_uid = await middleware.require_firebase_auth(
        background_tasks,
        "Bearer firebase-token",
    )

    assert firebase_uid == "firebase-user-123"
    assert calls == []

    await background_tasks()

    assert calls == ["firebase-user-123"]


@pytest.mark.asyncio
async def test_require_vault_owner_token_accepts_explicit_consent_header(monkeypatch):
    example_consent_value = "consent-example"

    async def _fake_validate(token: str, scope):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="user-123",
                agent_id="kai",
                scope=scope,
                scope_str=None,
            ),
        )

    monkeypatch.setattr(middleware, "validate_token_with_db", _fake_validate)

    token_data = await middleware.require_vault_owner_token(
        authorization="Bearer firebase-token",
        hushh_consent=f"Bearer {example_consent_value}",
    )

    assert token_data["user_id"] == "user-123"
    assert token_data["token"] == example_consent_value
