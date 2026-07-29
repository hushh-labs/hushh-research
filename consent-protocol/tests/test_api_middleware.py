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


# ── URL tracking-parameter sanitizer proof ───────────────────────────────────


def _make_request(path: str, params: list[tuple[str, str]]) -> SimpleNamespace:
    """Minimal request stand-in: real url string + query_params.multi_items()."""
    qs = "&".join(f"{k}={v}" for k, v in params)
    url = f"https://api.example.com{path}" + (f"?{qs}" if qs else "")
    return SimpleNamespace(
        state=SimpleNamespace(),
        url=url,
        query_params=SimpleNamespace(multi_items=lambda: list(params)),
    )


def test_sanitize_strips_fbclid_and_gclid_preserves_rest():
    request = _make_request(
        "/api/consent/pending/approve",
        [("fbclid", "abc123"), ("gclid", "xyz789"), ("purpose", "analytics")],
    )

    middleware._sanitize_request_url(request)

    assert "fbclid" not in request.state.sanitized_url
    assert "gclid"  not in request.state.sanitized_url
    assert "purpose=analytics" in request.state.sanitized_url


def test_sanitize_strips_all_utm_variants():
    request = _make_request(
        "/api/consent/revoke",
        [
            ("utm_source", "google"),
            ("utm_medium", "cpc"),
            ("utm_campaign", "summer"),
            ("utm_term", "consent"),
            ("utm_content", "banner"),
            ("userId", "u-123"),
        ],
    )

    middleware._sanitize_request_url(request)

    sanitized = request.state.sanitized_url
    assert "utm_source"   not in sanitized
    assert "utm_medium"   not in sanitized
    assert "utm_campaign" not in sanitized
    assert "utm_term"     not in sanitized
    assert "utm_content"  not in sanitized
    assert "userId=u-123" in sanitized


def test_sanitize_url_with_no_tracking_params_is_unchanged():
    request = _make_request(
        "/api/consent/session-token",
        [("userId", "u-123"), ("scope", "read")],
    )

    middleware._sanitize_request_url(request)

    assert request.state.sanitized_url == (
        "https://api.example.com/api/consent/session-token?userId=u-123&scope=read"
    )


def test_sanitize_url_with_only_tracking_params_drops_query_string():
    request = _make_request(
        "/api/consent/active",
        [("fbclid", "abc"), ("gclid", "xyz")],
    )

    middleware._sanitize_request_url(request)

    assert request.state.sanitized_url == "https://api.example.com/api/consent/active"
    assert "?" not in request.state.sanitized_url


def test_sanitize_none_request_is_noop():
    # Must not raise; no state to mutate.
    middleware._sanitize_request_url(None)


@pytest.mark.asyncio
async def test_require_vault_owner_token_sanitizes_url_before_processing(monkeypatch):
    """sanitized_url must be stamped on state before token validation runs."""

    async def _fake_validate(token: str, scope):
        return (
            True,
            None,
            SimpleNamespace(user_id="user-123", agent_id="kai", scope=scope, scope_str=None),
        )

    monkeypatch.setattr(middleware, "validate_token_with_db", _fake_validate)

    request = _make_request(
        "/api/consent/pending/approve",
        [("fbclid", "click-id"), ("requestId", "req-1")],
    )

    await middleware.require_vault_owner_token(
        request=request,
        authorization="Bearer test-token",
    )

    assert hasattr(request.state, "sanitized_url")
    assert "fbclid"       not in request.state.sanitized_url
    assert "requestId=req-1" in request.state.sanitized_url


# ── Consumption proof: sanitized_url is what the middleware actually emits ────
# The two tests below prove that the sanitized path — not the raw URL — is
# what the middleware forwards to downstream log consumers when a request is
# rejected.  This closes the "no consumer for sanitized_url" gap identified
# in the code review.


@pytest.mark.asyncio
async def test_vault_owner_token_rejection_logs_sanitized_path_not_tracking_params(
    monkeypatch, caplog
):
    """When require_vault_owner_token rejects a request, the warning log must
    contain the sanitized path (without tracking params), never the raw URL."""
    import logging

    async def _fake_validate(token, scope):
        return (False, "Token expired", None)

    monkeypatch.setattr(middleware, "validate_token_with_db", _fake_validate)

    request = _make_request(
        "/api/consent/pending/approve",
        [("fbclid", "adclick-sentinel"), ("requestId", "req-proof-1")],
    )

    with pytest.raises(HTTPException):
        with caplog.at_level(logging.WARNING, logger="api.middleware"):
            await middleware.require_vault_owner_token(
                request=request,
                authorization="Bearer expired-token",
            )

    combined = " ".join(caplog.messages)
    # Tracking param value must never surface in any log output.
    assert "fbclid" not in combined, "tracking param key leaked into log"
    assert "adclick-sentinel" not in combined, "tracking param value leaked into log"
    # The clean application param IS present — sanitized_url was consumed.
    assert "requestId=req-proof-1" in combined


@pytest.mark.asyncio
async def test_scoped_token_rejection_logs_sanitized_path_not_tracking_params(
    monkeypatch, caplog
):
    """When require_consent_scope rejects a request, the warning log must
    contain the sanitized path (without tracking params), never the raw URL."""
    import logging

    async def _fake_validate(token, scope):
        return (False, "Token expired", None)

    monkeypatch.setattr(middleware, "validate_token_with_db", _fake_validate)

    request = _make_request(
        "/api/kai/analyze",
        [("utm_source", "email-campaign"), ("tab", "active")],
    )

    scoped_dep = middleware.require_consent_scope("attr.financial.*")

    with pytest.raises(HTTPException):
        with caplog.at_level(logging.WARNING, logger="api.middleware"):
            await scoped_dep(
                request=request,
                authorization="Bearer Bearer expired-token",
            )

    combined = " ".join(caplog.messages)
    # UTM tracking param must never surface in log output.
    assert "utm_source" not in combined, "tracking param key leaked into log"
    assert "email-campaign" not in combined, "tracking param value leaked into log"
    # The clean application param IS present — sanitized path was consumed.
    assert "tab=active" in combined
