from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException
from starlette.datastructures import Headers

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


# ── GPC opt-out guard proof ───────────────────────────────────────────────────


def _make_request(headers: list[tuple[str, str]]) -> SimpleNamespace:
    """Build a minimal request stand-in with a real Starlette Headers object."""
    return SimpleNamespace(
        state=SimpleNamespace(),
        headers=Headers(headers=headers),
    )


def test_gpc_opt_out_header_sets_privacy_deny_flags():
    """Sec-GPC: 1 must set gpc_opt_out=True, tracking_allowed=False,
    analytics_allowed=False on request.state before any downstream logic."""
    request = _make_request([("sec-gpc", "1")])

    middleware._apply_gpc_flag(request)

    assert request.state.gpc_opt_out is True
    assert request.state.tracking_allowed is False
    assert request.state.analytics_allowed is False


def test_gpc_header_absent_leaves_request_state_untouched():
    """No Sec-GPC header → _apply_gpc_flag is a no-op; state is never written."""
    request = _make_request([])

    middleware._apply_gpc_flag(request)

    assert not hasattr(request.state, "gpc_opt_out")
    assert not hasattr(request.state, "tracking_allowed")
    assert not hasattr(request.state, "analytics_allowed")


def test_gpc_header_value_zero_leaves_request_state_untouched():
    """Sec-GPC: 0 is an explicit opt-in; state must not be modified."""
    request = _make_request([("sec-gpc", "0")])

    middleware._apply_gpc_flag(request)

    assert not hasattr(request.state, "gpc_opt_out")
    assert not hasattr(request.state, "tracking_allowed")


@pytest.mark.asyncio
async def test_require_vault_owner_token_applies_gpc_flag_before_token_validation(monkeypatch):
    """When Sec-GPC: 1 is present, require_vault_owner_token must stamp privacy
    deny flags on request.state before token validation completes."""

    async def _fake_validate(token: str, scope):
        return (
            True,
            None,
            SimpleNamespace(user_id="user-123", agent_id="kai", scope=scope, scope_str=None),
        )

    monkeypatch.setattr(middleware, "validate_token_with_db", _fake_validate)

    request = _make_request([("sec-gpc", "1")])

    await middleware.require_vault_owner_token(
        request=request,
        authorization="Bearer test-token",
    )

    # GPC flag must be set even though token validation also succeeded.
    assert request.state.gpc_opt_out is True
    assert request.state.tracking_allowed is False
    assert request.state.analytics_allowed is False
