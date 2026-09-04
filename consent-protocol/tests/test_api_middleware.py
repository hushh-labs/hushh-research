from __future__ import annotations

import asyncio
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
async def test_require_firebase_auth_awaits_identity_warmup_lifecycle(monkeypatch):
    calls: list[str] = []
    started = asyncio.Event()
    release = asyncio.Event()

    async def _fake_run_in_threadpool(func, authorization):
        assert authorization == "Bearer firebase-token"
        return "firebase-user-123456789012"

    class _FakeActorIdentityService:
        async def sync_from_firebase_if_due(
            self,
            firebase_uid: str,
            *,
            force: bool = False,
        ) -> dict[str, str]:
            assert asyncio.get_running_loop().is_running()
            assert force is False
            calls.append(firebase_uid)
            started.set()
            await release.wait()
            return {"user_id": firebase_uid}

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

    assert firebase_uid == "firebase-user-123456789012"
    assert calls == []

    warmup = asyncio.create_task(background_tasks())
    await started.wait()

    assert calls == ["firebase-user-123456789012"]
    assert not warmup.done()

    release.set()
    await warmup


@pytest.mark.asyncio
async def test_identity_warmup_failure_never_logs_user_or_phone_details(
    monkeypatch,
    caplog,
):
    firebase_uid = "firebase-user-123456789012"
    phone_number = "+16505550101"

    async def _fake_run_in_threadpool(func, authorization):
        assert authorization == "Bearer firebase-token"
        return firebase_uid

    class _FakeActorIdentityService:
        async def sync_from_firebase_if_due(
            self,
            requested_uid: str,
            *,
            force: bool = False,
        ) -> None:
            assert requested_uid == firebase_uid
            assert force is False
            raise RuntimeError(f"duplicate phone binding {phone_number}")

    monkeypatch.setattr(middleware, "run_in_threadpool", _fake_run_in_threadpool)
    monkeypatch.setattr(
        middleware,
        "ActorIdentityService",
        _FakeActorIdentityService,
    )
    caplog.set_level("DEBUG", logger=middleware.__name__)

    background_tasks = BackgroundTasks()
    authenticated_uid = await middleware.require_firebase_auth(
        authorization="Bearer firebase-token",
        background_tasks=background_tasks,
    )
    await background_tasks()

    assert authenticated_uid == firebase_uid
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "error=RuntimeError" in messages
    assert firebase_uid not in messages
    assert phone_number not in messages
    assert not any(character.isdigit() for character in messages)
    assert all(record.exc_info is None for record in caplog.records)


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


@pytest.mark.asyncio
async def test_require_vault_owner_token_reuses_validated_scope_within_request(monkeypatch):
    calls: list[tuple[str, object]] = []
    request = SimpleNamespace(state=SimpleNamespace())

    async def _fake_validate(token: str, scope):
        calls.append((token, scope))
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

    first = await middleware.require_vault_owner_token(
        request=request,
        authorization="Bearer consent-token",
    )
    second = await middleware.require_vault_owner_token(
        request=request,
        authorization="Bearer consent-token",
    )

    assert first["user_id"] == "user-123"
    assert second["user_id"] == "user-123"
    assert calls == [("consent-token", middleware.ConsentScope.VAULT_OWNER)]


@pytest.mark.asyncio
async def test_require_consent_scope_cache_is_scope_specific(monkeypatch):
    calls: list[tuple[str, object]] = []
    request = SimpleNamespace(state=SimpleNamespace())

    async def _fake_validate(token: str, scope):
        calls.append((token, scope))
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

    read_financial = middleware.require_consent_scope("attr.financial.*")
    read_health = middleware.require_consent_scope("attr.health.*")

    await read_financial(request=request, authorization="Bearer consent-token")
    await read_financial(request=request, authorization="Bearer consent-token")
    await read_health(request=request, authorization="Bearer consent-token")

    assert calls == [
        ("consent-token", "attr.financial.*"),
        ("consent-token", "attr.health.*"),
    ]
