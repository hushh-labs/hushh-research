from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded

from api.middlewares.rate_limit import rate_limit_exceeded_handler
from api.routes import hushh_tech
from hushh_mcp.services.hushh_tech_client_service import HushhTechClientError

UID = "firebase-uat-route-user"


def _enable_uat_product(monkeypatch: pytest.MonkeyPatch, *, allowlist: str = UID) -> None:
    for key, value in {
        "ENVIRONMENT": "test",
        "HUSSH_TECH_CLIENT_ENABLED": "true",
        "HUSSH_TECH_LAUNCH_PEPPER": "test-launch-pepper",
        "HUSSH_TECH_DEVELOPER_APP_ID": "app_hushh_tech_uat",
        "HUSSH_TECH_ALLOWED_AUDIENCE": "hushh-tech-uat",
        "HUSSH_TECH_ALLOWED_REDIRECT_URIS": (
            "https://uat.hushhtech.com/auth/hushh-research/callback"
        ),
        "HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST": allowlist,
        "HUSSH_TECH_PROXY_AUDIENCE": "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
        "HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS": (
            "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
        ),
        "RATE_LIMIT_STORAGE_URI": "redis://10.0.0.2:6379",
    }.items():
        monkeypatch.setenv(key, value)


def _app(*, authenticated: bool = True) -> FastAPI:
    app = FastAPI()
    app.state.limiter = hushh_tech.limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    app.include_router(hushh_tech.router)
    if authenticated:
        app.dependency_overrides[hushh_tech.require_hushh_tech_firebase_auth] = lambda: UID
    return app


def test_authorize_route_preserves_the_frozen_wire_contract(monkeypatch: pytest.MonkeyPatch):
    class Service:
        async def authorize_launch(self, **values):
            assert values == {
                "firebase_uid": UID,
                "audience": "hushh-tech-uat",
                "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
                "code_challenge": "c" * 43,
                "code_challenge_method": "S256",
                "firebase_valid_after_ms": 123_000,
            }
            return SimpleNamespace(
                code="single-use-code",
                audience=values["audience"],
                redirect_uri=values["redirect_uri"],
            )

    async def ensure_actor(firebase_uid: str):
        assert firebase_uid == UID

    async def authorize_watermark(**values):
        assert values == {
            "authorization": "Bearer firebase-id-token",
            "firebase_uid": UID,
        }
        return 123_000

    admitted: list[str] = []

    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(hushh_tech, "_ensure_canonical_actor", ensure_actor)
    monkeypatch.setattr(hushh_tech, "_authorize_firebase_watermark", authorize_watermark)
    monkeypatch.setattr(hushh_tech, "_require_uat_cohort", admitted.append)
    response = TestClient(_app()).post(
        "/api/v1/products/hushh-tech/launch/authorize",
        headers={"Authorization": "Bearer firebase-id-token"},
        json={
            "audience": "hushh-tech-uat",
            "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
            "code_challenge": "c" * 43,
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "code": "single-use-code",
        "expires_in": 60,
        "audience": "hushh-tech-uat",
        "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
    }
    assert admitted == [UID]
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


def test_authorize_rejects_missing_firebase_session_before_service_use(
    monkeypatch: pytest.MonkeyPatch,
):
    _enable_uat_product(monkeypatch)
    response = TestClient(_app(authenticated=False)).post(
        "/api/v1/products/hushh-tech/launch/authorize",
        json={
            "audience": "hushh-tech-uat",
            "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
            "code_challenge": "c" * 43,
            "code_challenge_method": "S256",
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"] == {
        "code": "UNAUTHENTICATED",
        "message": "Sign-in required.",
    }
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


@pytest.mark.parametrize(
    ("firebase_status", "firebase_detail", "expected_status", "expected_code"),
    [
        (401, "invalid-firebase-token", 401, "UNAUTHENTICATED"),
        (401, "revoked-firebase-token", 401, "UNAUTHENTICATED"),
        (503, "firebase-certificate-fetch-failed", 503, "UPSTREAM_UNAVAILABLE"),
    ],
)
def test_authorize_normalizes_firebase_failures_to_typed_product_states(
    monkeypatch: pytest.MonkeyPatch,
    firebase_status: int,
    firebase_detail: str,
    expected_status: int,
    expected_code: str,
):
    _enable_uat_product(monkeypatch)

    def fail_verification(_authorization: str | None) -> str:
        raise HTTPException(firebase_status, firebase_detail)

    monkeypatch.setattr(hushh_tech, "verify_firebase_bearer", fail_verification)
    response = TestClient(_app(authenticated=False)).post(
        "/api/v1/products/hushh-tech/launch/authorize",
        headers={"Authorization": "Bearer invalid-firebase-token"},
        json={
            "audience": "hushh-tech-uat",
            "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
            "code_challenge": "c" * 43,
            "code_challenge_method": "S256",
        },
    )

    assert response.status_code == expected_status
    assert response.json()["detail"]["code"] == expected_code
    assert firebase_detail not in response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


@pytest.mark.parametrize(
    ("environment", "enabled", "allowlist", "expected_status"),
    [
        ("production", "true", UID, 404),
        ("test", "true", "another-firebase-user", 403),
    ],
)
def test_disabled_or_noncohort_product_auth_has_no_identity_or_store_side_effects(
    monkeypatch: pytest.MonkeyPatch,
    environment: str,
    enabled: str,
    allowlist: str,
    expected_status: int,
):
    for key, value in {
        "ENVIRONMENT": environment,
        "HUSSH_TECH_CLIENT_ENABLED": enabled,
        "HUSSH_TECH_LAUNCH_PEPPER": "test-launch-pepper",
        "HUSSH_TECH_DEVELOPER_APP_ID": "app_hushh_tech_uat",
        "HUSSH_TECH_ALLOWED_AUDIENCE": "hushh-tech-uat",
        "HUSSH_TECH_ALLOWED_REDIRECT_URIS": (
            "https://uat.hushhtech.com/auth/hushh-research/callback"
        ),
        "HUSSH_TECH_UAT_FIREBASE_UID_ALLOWLIST": allowlist,
        "HUSSH_TECH_PROXY_AUDIENCE": "https://consent-protocol-f2gsa4kfsq-uc.a.run.app",
        "HUSSH_TECH_TRUSTED_PROXY_SERVICE_ACCOUNTS": (
            "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com"
        ),
        "RATE_LIMIT_STORAGE_URI": "redis://10.0.0.2:6379",
    }.items():
        monkeypatch.setenv(key, value)

    calls = {"firebase": 0, "warmup": 0, "upsert": 0, "service": 0, "watermark": 0}

    def verify_firebase(_authorization: str | None) -> str:
        calls["firebase"] += 1
        return UID

    def warmup(*_args, **_kwargs):
        calls["warmup"] += 1

    async def upsert(*_args, **_kwargs):
        calls["upsert"] += 1
        return {"user_id": UID}

    async def watermark(*_args, **_kwargs):
        calls["watermark"] += 1
        return 0

    class Service:
        def __init__(self):
            calls["service"] += 1

    monkeypatch.setattr(hushh_tech, "verify_firebase_bearer", verify_firebase)
    monkeypatch.setattr(
        "api.middleware.verify_firebase_bearer",
        lambda _auth: UID,
    )
    monkeypatch.setattr(
        hushh_tech.ActorIdentityService,
        "schedule_sync_from_firebase",
        warmup,
    )
    monkeypatch.setattr(hushh_tech.ActorIdentityService, "upsert_identity", upsert)
    monkeypatch.setattr(hushh_tech, "_authorize_firebase_watermark", watermark)
    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)

    client = TestClient(_app(authenticated=False))
    authorize_response = client.post(
        "/api/v1/products/hushh-tech/launch/authorize",
        headers={"Authorization": "Bearer firebase-id-token"},
        json={
            "audience": "hushh-tech-uat",
            "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
            "code_challenge": "c" * 43,
            "code_challenge_method": "S256",
        },
    )
    verify_response = client.post(
        "/api/v1/products/hushh-tech/link/verify",
        headers={
            "Authorization": "Bearer firebase-id-token",
            "X-Hushh-Developer-Token": "server-only-token",
        },
        json={"legacy_session_proof": "p" * 40},
    )

    assert authorize_response.status_code == expected_status
    assert verify_response.status_code == expected_status
    assert calls == {
        "firebase": 0 if environment == "production" else 2,
        "warmup": 0,
        "upsert": 0,
        "service": 0,
        "watermark": 0,
    }


def test_exchange_mints_only_product_bound_firebase_session(monkeypatch: pytest.MonkeyPatch):
    class Service:
        async def exchange_launch(self, **values):
            assert values["code_verifier"] == "v" * 43
            return {
                "firebase_uid": UID,
                "audience": "hushh-tech-uat",
                "authorization_id": "htla_single_use",
                "firebase_valid_after_ms": 123_000,
            }

        async def get_link_status(self, **values):
            assert values == {"firebase_uid": UID, "app_id": "app_hushh_tech_uat"}
            return {"state": "LINK_REQUIRED", "linked": False}

    async def custom_token(**values):
        assert values == {
            "firebase_uid": UID,
            "audience": "hushh-tech-uat",
            "app_id": "app_hushh_tech_uat",
            "launch_authorization_id": "htla_single_use",
            "launch_valid_after_ms": 123_000,
        }
        return "firebase-custom-token"

    async def valid_after(firebase_uid: str):
        assert firebase_uid == UID
        return 123_000

    monkeypatch.setenv("HUSSH_TECH_DEVELOPER_APP_ID", "app_hushh_tech_uat")
    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(hushh_tech, "_firebase_custom_token", custom_token)
    monkeypatch.setattr(hushh_tech, "_firebase_valid_after_ms", valid_after)
    response = TestClient(_app()).post(
        "/api/v1/products/hushh-tech/launch/exchange",
        json={
            "code": "x" * 32,
            "verifier": "v" * 43,
            "audience": "hushh-tech-uat",
            "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "firebase_custom_token": "firebase-custom-token",
        "expires_in": 3600,
        "canonical_user_id": UID,
        "audience": "hushh-tech-uat",
        "state": "LINK_REQUIRED",
    }
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


def test_exchange_fails_when_firebase_is_revoked_during_exchange(
    monkeypatch: pytest.MonkeyPatch,
):
    class Service:
        async def exchange_launch(self, **_values):
            return {
                "firebase_uid": UID,
                "audience": "hushh-tech-uat",
                "authorization_id": "htla_revoked",
                "firebase_valid_after_ms": 123_000,
            }

        async def get_link_status(self, **_values):
            raise AssertionError("revoked launch must not reach link status")

    watermarks = iter((123_000, 124_000))

    async def valid_after(_firebase_uid: str):
        return next(watermarks)

    async def custom_token(**_values):
        return "discarded-custom-token"

    monkeypatch.setenv("HUSSH_TECH_DEVELOPER_APP_ID", "app_hushh_tech_uat")
    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(hushh_tech, "_firebase_valid_after_ms", valid_after)
    monkeypatch.setattr(hushh_tech, "_firebase_custom_token", custom_token)
    response = TestClient(_app()).post(
        "/api/v1/products/hushh-tech/launch/exchange",
        json={
            "code": "x" * 32,
            "verifier": "v" * 43,
            "audience": "hushh-tech-uat",
            "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
        },
    )
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "UNAUTHENTICATED"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


@pytest.mark.asyncio
async def test_recent_auth_errors_are_never_cacheable():
    with pytest.raises(HTTPException) as error:
        await hushh_tech._require_recent_firebase_auth(
            authorization=None,
            firebase_uid=UID,
        )

    assert error.value.status_code == 401
    assert error.value.detail["code"] == "UNAUTHENTICATED"
    assert error.value.headers == {
        "Cache-Control": "private, no-store",
        "Pragma": "no-cache",
    }


@pytest.mark.asyncio
async def test_authorize_rejects_token_issued_before_current_revocation_watermark(
    monkeypatch: pytest.MonkeyPatch,
):
    from firebase_admin import auth as firebase_auth

    monkeypatch.setattr(hushh_tech, "get_firebase_auth_app", lambda: object())
    monkeypatch.setattr(
        firebase_auth,
        "verify_id_token",
        lambda *_args, **_kwargs: {"uid": UID, "iat": 123},
    )

    async def immediate(function, *args, **kwargs):
        return function(*args, **kwargs)

    async def revoked_after_dependency(_firebase_uid: str):
        return 124_000

    monkeypatch.setattr(hushh_tech, "run_in_threadpool", immediate)
    monkeypatch.setattr(hushh_tech, "_firebase_valid_after_ms", revoked_after_dependency)
    with pytest.raises(HTTPException) as error:
        await hushh_tech._authorize_firebase_watermark(
            authorization="Bearer old-id-token",
            firebase_uid=UID,
        )
    assert error.value.status_code == 401
    assert error.value.detail["code"] == "UNAUTHENTICATED"


def test_typed_service_state_is_preserved(monkeypatch: pytest.MonkeyPatch):
    class Service:
        async def get_link_status(self, **_):
            raise HushhTechClientError("LINK_REQUIRED", "Link required.", status_code=409)

    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(
        hushh_tech,
        "_require_product_principal",
        lambda **_: "app_hushh_tech_uat",
    )
    response = TestClient(_app()).get(
        "/api/v1/products/hushh-tech/link/status",
        headers={
            "Authorization": "Bearer firebase-id-token",
            "X-Hushh-Developer-Token": "server-only-token",
        },
    )
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "LINK_REQUIRED", "message": "Link required."}}
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


def test_user_specific_reads_are_never_cacheable(monkeypatch: pytest.MonkeyPatch):
    class Service:
        async def get_link_status(self, **_values):
            return {"state": "READY", "linked": True, "link_id": "synthetic-link"}

        async def get_shadow(self, **values):
            return {
                "state": "READY",
                "record_type": values["record_type"],
                "payload": {"display_name": "Synthetic Ada"},
            }

    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(
        hushh_tech,
        "_require_product_principal",
        lambda **_: "app_hushh_tech_uat",
    )
    client = TestClient(_app())
    headers = {
        "Authorization": "Bearer firebase-id-token",
        "X-Hushh-Developer-Token": "server-only-token",
    }

    for response in (
        client.get("/api/v1/products/hushh-tech/link/status", headers=headers),
        client.get(
            "/api/v1/products/hushh-tech/compatibility/profile",
            headers=headers,
        ),
    ):
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["pragma"] == "no-cache"


@pytest.fixture
def enforcing_product_limiter():
    previous = hushh_tech.limiter.enabled
    hushh_tech.limiter.enabled = True
    hushh_tech.limiter.reset()
    try:
        yield
    finally:
        hushh_tech.limiter.reset()
        hushh_tech.limiter.enabled = previous


def test_public_launch_exchange_is_rate_limited_before_extra_store_lookups(
    monkeypatch: pytest.MonkeyPatch,
    enforcing_product_limiter,
):
    calls = 0

    class Service:
        async def exchange_launch(self, **_values):
            nonlocal calls
            calls += 1
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "The launch code is invalid or expired.",
                status_code=401,
            )

    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    client = TestClient(_app(authenticated=False))
    budget = int(hushh_tech.RateLimits.HUSHH_TECH_LAUNCH_EXCHANGE.split("/")[0])
    payload = {
        "code": "x" * 32,
        "verifier": "v" * 43,
        "audience": "hushh-tech-uat",
        "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
    }

    statuses = [
        client.post(
            "/api/v1/products/hushh-tech/launch/exchange",
            headers={"X-Forwarded-For": "203.0.113.70"},
            json=payload,
        ).status_code
        for _ in range(budget + 1)
    ]

    assert statuses[:budget] == [401] * budget
    assert statuses[budget] == 429
    limited = client.post(
        "/api/v1/products/hushh-tech/launch/exchange",
        headers={"X-Forwarded-For": "203.0.113.70"},
        json=payload,
    )
    assert limited.json() == {"detail": {"code": "RATE_LIMITED", "message": "Try again shortly."}}
    assert limited.headers["cache-control"] == "private, no-store"
    assert limited.headers["pragma"] == "no-cache"
    bystander = client.post(
        "/api/v1/products/hushh-tech/launch/exchange",
        headers={"X-Forwarded-For": "203.0.113.71"},
        json=payload,
    )
    assert bystander.status_code == 401
    assert calls == budget + 1


def test_proxied_exchange_visitors_do_not_share_the_frontend_ingress_bucket(
    monkeypatch: pytest.MonkeyPatch,
    enforcing_product_limiter,
):
    _enable_uat_product(monkeypatch)
    calls = 0

    class Service:
        async def exchange_launch(self, **_values):
            nonlocal calls
            calls += 1
            raise HushhTechClientError(
                "UNAUTHENTICATED",
                "The launch code is invalid or expired.",
                status_code=401,
            )

    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(
        hushh_tech,
        "_verify_proxy_identity_token",
        lambda token, audience: {
            "email": "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "email_verified": True,
            "exp": int(hushh_tech.time.time()) + 600,
            "aud": audience,
            "sub": token,
        },
    )
    client = TestClient(_app(authenticated=False))
    budget = int(hushh_tech.RateLimits.HUSHH_TECH_LAUNCH_EXCHANGE.split("/")[0])
    payload = {
        "code": "x" * 32,
        "verifier": "v" * 43,
        "audience": "hushh-tech-uat",
        "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
    }

    def headers(client_ip: str) -> dict[str, str]:
        return {
            "X-Forwarded-For": "10.8.0.2",
            "X-Hushh-Proxy-Authorization": "Bearer service-identity-token",
            "X-Hushh-Tech-Client-IP": client_ip,
        }

    attacker = [
        client.post(
            "/api/v1/products/hushh-tech/launch/exchange",
            headers=headers("203.0.113.82"),
            json=payload,
        ).status_code
        for _ in range(budget + 1)
    ]
    bystander = client.post(
        "/api/v1/products/hushh-tech/launch/exchange",
        headers=headers("203.0.113.83"),
        json=payload,
    )

    assert attacker[:budget] == [401] * budget
    assert attacker[budget] == 429
    assert bystander.status_code == 401
    assert calls == budget + 1


def test_firebase_preauth_budget_limits_invalid_tokens_before_verifier_work(
    monkeypatch: pytest.MonkeyPatch,
    enforcing_product_limiter,
):
    _enable_uat_product(monkeypatch)
    calls = 0

    def reject_token(_authorization: str | None) -> str:
        nonlocal calls
        calls += 1
        raise HTTPException(401, "invalid-firebase-token")

    monkeypatch.setattr(hushh_tech, "verify_firebase_bearer", reject_token)
    client = TestClient(_app(authenticated=False))
    budget = int(hushh_tech.RateLimits.HUSHH_TECH_FIREBASE_PREAUTH.split("/")[0])
    payload = {
        "audience": "hushh-tech-uat",
        "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
        "code_challenge": "c" * 43,
        "code_challenge_method": "S256",
    }
    headers = {
        "Authorization": "Bearer invalid-firebase-token",
        "X-Forwarded-For": "203.0.113.72",
    }

    statuses = [
        client.post(
            "/api/v1/products/hushh-tech/launch/authorize",
            headers=headers,
            json=payload,
        ).status_code
        for _ in range(budget + 1)
    ]
    bystander = client.post(
        "/api/v1/products/hushh-tech/launch/authorize",
        headers={
            "Authorization": "Bearer invalid-firebase-token",
            "X-Forwarded-For": "203.0.113.73",
        },
        json=payload,
    )

    assert statuses[:budget] == [401] * budget
    assert statuses[budget] == 429
    assert bystander.status_code == 401
    assert calls == budget + 1


def test_proxy_identity_preserves_per_visitor_preauth_buckets(
    monkeypatch: pytest.MonkeyPatch,
    enforcing_product_limiter,
):
    _enable_uat_product(monkeypatch)
    monkeypatch.setattr(
        hushh_tech,
        "_verify_proxy_identity_token",
        lambda token, audience: {
            "email": "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "email_verified": True,
            "exp": int(hushh_tech.time.time()) + 600,
            "aud": audience,
            "sub": token,
        },
    )
    monkeypatch.setattr(
        hushh_tech.RateLimits,
        "HUSHH_TECH_FIREBASE_PREAUTH",
        "2/minute",
    )

    def reject_token(_authorization: str | None) -> str:
        raise HTTPException(401, "invalid-firebase-token")

    monkeypatch.setattr(hushh_tech, "verify_firebase_bearer", reject_token)
    client = TestClient(_app(authenticated=False))
    payload = {
        "audience": "hushh-tech-uat",
        "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
        "code_challenge": "c" * 43,
        "code_challenge_method": "S256",
    }

    def headers(client_ip: str) -> dict[str, str]:
        return {
            "Authorization": "Bearer invalid-firebase-token",
            "X-Forwarded-For": "10.8.0.2",
            "X-Hushh-Proxy-Authorization": "Bearer service-identity-token",
            "X-Hushh-Tech-Client-IP": client_ip,
        }

    attacker = [
        client.post(
            "/api/v1/products/hushh-tech/launch/authorize",
            headers=headers("203.0.113.80"),
            json=payload,
        ).status_code
        for _ in range(3)
    ]
    bystander = client.post(
        "/api/v1/products/hushh-tech/launch/authorize",
        headers=headers("203.0.113.81"),
        json=payload,
    )

    assert attacker == [401, 401, 429]
    assert bystander.status_code == 401


def test_spoofed_proxy_identity_cannot_choose_the_rate_limit_bucket(
    monkeypatch: pytest.MonkeyPatch,
):
    _enable_uat_product(monkeypatch)

    def reject_proxy(_token: str, _audience: str):
        raise ValueError("invalid service identity")

    monkeypatch.setattr(hushh_tech, "_verify_proxy_identity_token", reject_proxy)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/products/hushh-tech/launch/authorize",
            "headers": [
                (b"x-forwarded-for", b"198.51.100.40"),
                (b"x-hushh-proxy-authorization", b"Bearer forged"),
                (b"x-hushh-tech-client-ip", b"203.0.113.200"),
            ],
            "client": ("127.0.0.1", 12345),
            "server": ("testserver", 80),
            "scheme": "http",
            "query_string": b"",
        }
    )

    assert hushh_tech._verified_proxy_client_ip(request) == "198.51.100.40"


def test_direct_ingress_budget_stops_invalid_proxy_tokens_before_more_verification(
    monkeypatch: pytest.MonkeyPatch,
    enforcing_product_limiter,
):
    _enable_uat_product(monkeypatch)
    monkeypatch.setattr(
        hushh_tech.RateLimits,
        "HUSHH_TECH_PROXY_ATTESTATION",
        "2/minute",
    )
    verifier_calls = 0

    def reject_proxy(_token: str, _audience: str):
        nonlocal verifier_calls
        verifier_calls += 1
        raise ValueError("invalid service identity")

    def reject_firebase(_authorization: str | None) -> str:
        raise HTTPException(401, "invalid firebase token")

    monkeypatch.setattr(hushh_tech, "_verify_proxy_identity_token", reject_proxy)
    monkeypatch.setattr(hushh_tech, "verify_firebase_bearer", reject_firebase)
    client = TestClient(_app(authenticated=False))
    payload = {
        "audience": "hushh-tech-uat",
        "redirect_uri": "https://uat.hushhtech.com/auth/hushh-research/callback",
        "code_challenge": "c" * 43,
        "code_challenge_method": "S256",
    }

    def headers(ingress_ip: str, attempt: int) -> dict[str, str]:
        return {
            "Authorization": "Bearer invalid-firebase-token",
            "X-Forwarded-For": ingress_ip,
            "X-Hushh-Proxy-Authorization": f"Bearer forged-{attempt}",
            "X-Hushh-Tech-Client-IP": f"203.0.113.{100 + attempt}",
        }

    attacker = [
        client.post(
            "/api/v1/products/hushh-tech/launch/authorize",
            headers=headers("198.51.100.60", attempt),
            json=payload,
        ).status_code
        for attempt in range(3)
    ]
    bystander = client.post(
        "/api/v1/products/hushh-tech/launch/authorize",
        headers=headers("198.51.100.61", 4),
        json=payload,
    )

    assert attacker == [401, 401, 429]
    assert verifier_calls == 3  # two attacker calls plus the separate ingress
    assert bystander.status_code == 401


def test_authenticated_product_limits_are_isolated_by_verified_firebase_uid(
    monkeypatch: pytest.MonkeyPatch,
    enforcing_product_limiter,
):
    calls = 0

    async def authenticated_uid(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> str:
        assert authorization in {"Bearer firebase-user-a", "Bearer firebase-user-b"}
        uid = str(authorization).removeprefix("Bearer ")
        request.state.rate_limit_user_id = f"firebase:{uid}"
        return uid

    class Service:
        async def get_link_status(self, **_values):
            nonlocal calls
            calls += 1
            return {"state": "LINK_REQUIRED", "linked": False}

    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(
        hushh_tech,
        "_require_product_principal",
        lambda **_: "app_hushh_tech_uat",
    )
    app = _app()
    app.dependency_overrides[hushh_tech.require_hushh_tech_firebase_auth] = authenticated_uid
    client = TestClient(app)
    budget = int(hushh_tech.RateLimits.HUSHH_TECH_CLIENT_READ.split("/")[0])
    headers_a = {
        "Authorization": "Bearer firebase-user-a",
        "X-Hushh-Developer-Token": "developer",
    }
    headers_b = {
        "Authorization": "Bearer firebase-user-b",
        "X-Hushh-Developer-Token": "developer",
    }

    statuses_a = [
        client.get("/api/v1/products/hushh-tech/link/status", headers=headers_a).status_code
        for _ in range(budget + 1)
    ]
    bystander = client.get(
        "/api/v1/products/hushh-tech/link/status",
        headers=headers_b,
    )

    assert statuses_a[:budget] == [200] * budget
    assert statuses_a[budget] == 429
    assert bystander.status_code == 200
    assert calls == budget + 1


def test_missing_developer_token_uses_typed_no_store_contract(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("HUSSH_TECH_DEVELOPER_APP_ID", "app_hushh_tech_uat")
    response = TestClient(_app()).get(
        "/api/v1/products/hushh-tech/link/status",
        headers={"Authorization": "Bearer firebase-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "UNAUTHENTICATED"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


@pytest.mark.parametrize(
    ("failure", "expected_status", "expected_code"),
    [
        (HTTPException(401, "developer-token-internal-detail"), 401, "UNAUTHENTICATED"),
        (RuntimeError("developer-store-internal-detail"), 503, "UPSTREAM_UNAVAILABLE"),
    ],
)
def test_developer_auth_failures_are_typed_and_never_cacheable(
    monkeypatch: pytest.MonkeyPatch,
    failure: Exception,
    expected_status: int,
    expected_code: str,
):
    monkeypatch.setenv("HUSSH_TECH_DEVELOPER_APP_ID", "app_hushh_tech_uat")

    def fail_authentication(**_values):
        raise failure

    monkeypatch.setattr(hushh_tech, "authenticate_developer_principal", fail_authentication)
    response = TestClient(_app()).get(
        "/api/v1/products/hushh-tech/link/status",
        headers={
            "Authorization": "Bearer firebase-token",
            "X-Hushh-Developer-Token": "invalid-developer-token",
        },
    )

    assert response.status_code == expected_status
    assert response.json()["detail"]["code"] == expected_code
    assert "internal-detail" not in response.text
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"


def test_unexpected_service_failure_is_typed_and_does_not_leak(monkeypatch: pytest.MonkeyPatch):
    class Service:
        async def get_link_status(self, **_):
            raise RuntimeError("database-password-should-not-leak")

    monkeypatch.setattr(hushh_tech, "HushhTechClientService", Service)
    monkeypatch.setattr(
        hushh_tech,
        "_require_product_principal",
        lambda **_: "app_hushh_tech_uat",
    )
    response = TestClient(_app()).get(
        "/api/v1/products/hushh-tech/link/status",
        headers={"Authorization": "Bearer token", "X-Hushh-Developer-Token": "developer"},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "UPSTREAM_UNAVAILABLE"
    assert "database-password" not in response.text
