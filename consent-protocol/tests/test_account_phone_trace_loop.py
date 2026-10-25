"""HTTP phone challenge trace and persistence-port regression."""

import time
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.middlewares.observability import capture_request_trace_events, observability_middleware
from api.routes import account
from hushh_mcp.services import phone_test_transport
from hushh_mcp.services.actor_identity_service import ActorIdentityService


def _build_app():
    app = FastAPI()
    app.include_router(account.router)
    return app


@pytest.fixture
def recorded_phone_loop(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    for key in (
        "HUSHH_DEPLOY_ENV",
        "APP_RUNTIME_PROFILE",
        "K_SERVICE",
        "K_REVISION",
        "CONTAINER_APP_NAME",
        "CONTAINER_APP_REVISION",
        "WEBSITE_INSTANCE_ID",
        "VERCEL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_NUMBERS", "+16505550101")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CODE", "000000")
    monkeypatch.setenv("HUSHH_UAT_PHONE_TEST_CHALLENGE_SECRET", "isolated-loop-challenge-secret")
    monkeypatch.setattr(phone_test_transport, "_runtime_environment", lambda: "uat")
    monkeypatch.setattr(ActorIdentityService, "can_claim_test_phone", AsyncMock(return_value=True))
    identity = {}

    async def persist(*, user_id, phone_number, source):
        assert source == "uat_test_phone_claim"
        identity.update(user_id=user_id, phone_number=phone_number, phone_verified=True)
        return dict(identity)

    monkeypatch.setattr(
        ActorIdentityService, "claim_verified_phone", AsyncMock(side_effect=persist)
    )
    app = _build_app()
    app.middleware("http")(observability_middleware)
    app.dependency_overrides[require_firebase_auth] = lambda: "isolated-loop-owner"
    return app, identity


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize("enabled", [False, True], ids=["flag-off", "flag-on"])
def test_recorded_phone_http_trace_loop_persists_exact_owner(recorded_phone_loop, enabled):
    """Exercise real challenge validation and HTTP routing with an isolated storage port."""
    app, identity = recorded_phone_loop
    headers = {
        "X-Trace-Id": "auth-loop-fixture-0001",
        "X-Feature-Flags": f"AUTH_PHONE_RECOVERY_ENABLED={str(enabled).lower()}",
    }
    with capture_request_trace_events() as events, TestClient(app) as client:
        started = time.perf_counter()
        start = client.post(
            "/api/account/phone/uat-test/start",
            headers=headers,
            json={"phone_number": "+16505550101"},
        )
        assert start.status_code == 200 and start.json()["eligible"] is True
        confirmation = client.post(
            "/api/account/phone/uat-test/confirm",
            headers=headers,
            json={
                "phone_number": "+16505550101",
                "verification_code": "000000",
                "verification_id": start.json()["verification_id"],
                "expected_user_id": "isolated-loop-owner",
            },
        )
        assert confirmation.status_code == 200
        assert (
            confirmation.json()["identity"]
            == identity
            == {
                "user_id": "isolated-loop-owner",
                "phone_number": "+16505550101",
                "phone_verified": True,
            }
        )
        assert confirmation.headers["X-Trace-Id"] == headers["X-Trace-Id"]
        assert [event["name"] for event in events] == [
            "auth.phone.receive",
            "auth.phone.challenge",
            "auth.phone.identity",
            "auth.phone.response",
            "auth.phone.receive",
            "auth.phone.provider",
            "auth.phone.persist",
            "auth.phone.response",
        ]
        assert all(event["status"] == "ok" and event["duration_ms"] < 1000 for event in events)
        assert all(event["trace_id"] == headers["X-Trace-Id"] for event in events)
        assert all(
            event["feature_flags"]["AUTH_PHONE_RECOVERY_ENABLED"] is enabled for event in events
        )
        assert time.perf_counter() - started < 2
