"""HTTP phone challenge trace and persistence-port regression."""

import time
from unittest.mock import AsyncMock
from uuid import uuid4

import asyncpg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from api.middleware import require_firebase_auth
from api.middlewares.observability import capture_request_trace_events, observability_middleware
from api.routes import account
from hushh_mcp.services import actor_identity_service as identity
from hushh_mcp.services import phone_test_transport
from hushh_mcp.services import phone_transfer_service as transfer
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from tests.helpers.phone_transfer_postgres import database_url as database_url
from tests.helpers.phone_transfer_postgres import seed

PHONE = "+16505550101"


def _build_app():
    app = FastAPI()
    app.include_router(account.router)
    return app


@pytest.fixture
def recorded_phone_loop(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("AUTH_PHONE_RECOVERY_ENABLED", raising=False)
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
@pytest.mark.parametrize("enabled", [False, True, None], ids=["flag-off", "flag-on", "unset"])
def test_recorded_phone_http_trace_loop_persists_exact_owner(recorded_phone_loop, enabled):
    """Exercise real challenge validation and HTTP routing with an isolated storage port."""
    app, identity = recorded_phone_loop
    headers = {
        "X-Trace-Id": "auth-loop-fixture-0001",
    }
    if enabled is not None:
        headers["X-Feature-Flags"] = f"AUTH_PHONE_RECOVERY_ENABLED={str(enabled).lower()}"
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
            event["feature_flags"]["AUTH_PHONE_RECOVERY_ENABLED"] is (enabled is not False)
            for event in events
        )
        assert time.perf_counter() - started < 2


def _configure_transfer_ports(monkeypatch, pool, engine, mode):
    import time
    from types import SimpleNamespace
    from unittest.mock import Mock

    from fastapi import FastAPI
    from firebase_admin import auth

    from api.middleware import require_firebase_auth
    from api.middlewares import auth_reliability_trace
    from api.middlewares.observability import (
        observability_middleware,
    )
    from api.routes import account
    from api.utils import firebase_admin

    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("OTEL_ENABLED", "false")
    for name in (
        *auth_reliability_trace._HOSTED_RUNTIME_MARKERS,
        "HUSHH_DEPLOY_ENV",
        "APP_RUNTIME_PROFILE",
        "AUTH_PHONE_RECOVERY_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(identity, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(transfer, "get_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(transfer.mutations, "get_db_connection", engine.begin)
    monkeypatch.setattr(identity.ActorIdentityService, "_ensure_actor_spine", AsyncMock())
    monkeypatch.setattr(
        identity.ActorIdentityService, "_sync_referral_qualification_best_effort", AsyncMock()
    )
    # Provisioning is a separate port; this loop owns phone state, not pod jobs.
    monkeypatch.setattr(identity.ActorIdentityService, "schedule_provision_personal_agent", Mock())
    monkeypatch.setattr(identity.ActorIdentityService, "_schedule_phone_resume", Mock())
    app_identity = SimpleNamespace(project_id="synthetic-auth")
    provider_user = SimpleNamespace(
        phone_number=PHONE, provider_data=[SimpleNamespace(provider_id="google.com")]
    )
    monkeypatch.setattr(account, "get_firebase_auth_app", lambda: app_identity)
    monkeypatch.setattr(transfer, "check_provider", lambda *_args: True)
    monkeypatch.setattr(auth, "get_user", lambda *_args, **_kwargs: provider_user)
    monkeypatch.setattr(firebase_admin, "assert_firebase_identity_mutation_allowed", lambda _: None)

    async def verify(_token, *, transfer, proof_metadata):
        assert transfer is True
        proof_metadata.update(event="http-loop-fresh-sms-event", valid_until=time.time() + 180)
        return PHONE, "previous"

    def update(_app, uid, fields):
        assert uid == "previous" and fields == {"deleteProvider": ["phone"]}
        provider_user.phone_number = None
        if mode == "uncertain":
            raise TimeoutError("synthetic-provider-response-lost")

    effect = Mock(side_effect=update)
    monkeypatch.setattr(account, "_verify_phone_claim_id_token", verify)
    monkeypatch.setattr(transfer.mutations, "_update_identity", effect)
    app = FastAPI()
    app.include_router(account.router)
    app.middleware("http")(observability_middleware)
    app.dependency_overrides[require_firebase_auth] = lambda: "receiving-a"
    return app, effect


def _assert_transfer_trace(events, headers, enabled, payload):
    expected_stages = (
        [
            "receive",
            "provider",
            "response",
            "receive",
            "provider",
            "persist",
            "provider",
            "response",
            "receive",
            "response",
            "receive",
            "response",
            "receive",
            "response",
        ]
        if enabled
        else ["receive", "response", "receive", "response"]
    )
    assert [event["name"] for event in events] == [
        f"auth.phone.{stage}" for stage in expected_stages
    ]
    assert all(event["status"] == "ok" for event in events)
    assert all(event["trace_id"] == headers["X-Trace-Id"] for event in events)
    assert all(event["feature_flags"]["AUTH_PHONE_RECOVERY_ENABLED"] is enabled for event in events)
    assert all(event["duration_ms"] < 5000 for event in events)
    assert PHONE not in str(events) and payload["phone_id_token"] not in str(events)


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
@pytest.mark.parametrize("mode", ["off", "on", "unset", "uncertain"])
async def test_http_transfer_trace_loop_preserves_information_without_retrying_effects(
    database_url, monkeypatch, mode
):
    import httpx

    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    engine = create_engine(database_url)
    app, effect = _configure_transfer_ports(monkeypatch, pool, engine, mode)
    enabled = mode != "off"
    headers = {"X-Trace-Id": "phone-transfer-http-loop-0001"}
    if mode != "unset":
        headers["X-Feature-Flags"] = f"AUTH_PHONE_RECOVERY_ENABLED={str(enabled).lower()}"
    try:
        _, before = await seed(pool)
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM account_phone_transfers")
            before_files = await conn.fetchrow("SELECT * FROM shared_files_storage")
        payload = {"phone_id_token": "synthetic-signed-proof", "expected_user_id": "receiving-a"}
        with capture_request_trace_events() as events:
            started = time.perf_counter()
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers
            ) as client:
                prepared = await client.post("/api/account/phone/transfer/prepare", json=payload)
                assert prepared.status_code == (200 if enabled else 503)
                operation_id = prepared.json().get("transfer_id", str(uuid4()))
                confirmed = await client.post(
                    "/api/account/phone/transfer/confirm",
                    json={**payload, "transfer_id": operation_id, "confirmed": True},
                )
                assert confirmed.status_code == (200 if enabled else 503)
                if enabled:
                    expected = "in_progress" if mode == "uncertain" else "completed"
                    assert confirmed.json()["transfer_status"] == expected
                    # A retry after a lost provider response is status-only, even
                    # when a provider read would now show the phone absent.
                    for _ in range(2):
                        status = await client.get(f"/api/account/phone/transfer/{operation_id}")
                        assert status.status_code == 200
                        assert status.json()["transfer_status"] == expected
                    replay = await client.post(
                        "/api/account/phone/transfer/confirm",
                        json={**payload, "transfer_id": operation_id, "confirmed": True},
                    )
                    assert replay.status_code == 409
                else:
                    with pytest.raises(identity.ActorIdentityPhoneClaimConflictError):
                        await identity.ActorIdentityService().claim_verified_phone(
                            user_id="receiving-a", phone_number=PHONE
                        )
            assert time.perf_counter() - started < 5
            _assert_transfer_trace(events, headers, enabled, payload)
        assert effect.call_count == int(enabled)
        async with pool.acquire() as conn:
            assert await conn.fetchrow("SELECT * FROM pkm_data WHERE user_id='previous'") == before
            assert await conn.fetchrow("SELECT * FROM shared_files_storage") == before_files
            assert await conn.fetchval("SELECT vault_status FROM vault_keys") == "locked"
            assert await conn.fetchval(
                "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1 AND phone_verified=TRUE",
                PHONE,
            ) == ("receiving-a" if enabled else "previous")
            assert await conn.fetchval(
                "SELECT count(*) FROM internal_access_events WHERE action='REVOKED'"
            ) == int(enabled)
    finally:
        engine.dispose()
        await pool.close()


@pytest.mark.feature_auth_reliability
@pytest.mark.trace_loop
async def test_not_started_status_fences_a_confirm_still_waiting_for_provider(
    database_url, monkeypatch
):
    import asyncio
    import threading

    import httpx

    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2, command_timeout=5)
    engine = create_engine(database_url)
    app, effect = _configure_transfer_ports(monkeypatch, pool, engine, "on")
    started, release = threading.Event(), threading.Event()
    pending = None

    def provider(*_args):
        started.set()
        assert release.wait(3), "Synthetic provider gate was not released"
        return True

    try:
        _, before = await seed(pool)
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM account_phone_transfers")
        payload = {"phone_id_token": "synthetic-signed-proof", "expected_user_id": "receiving-a"}
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            prepared = await client.post("/api/account/phone/transfer/prepare", json=payload)
            assert prepared.status_code == 200
            operation_id = prepared.json()["transfer_id"]
            monkeypatch.setattr(transfer, "check_provider", provider)
            pending = asyncio.create_task(
                client.post(
                    "/api/account/phone/transfer/confirm",
                    json={**payload, "transfer_id": operation_id, "confirmed": True},
                )
            )
            assert await asyncio.wait_for(asyncio.to_thread(started.wait, 2), 3)
            status = await client.get(f"/api/account/phone/transfer/{operation_id}")
            assert status.status_code == 200 and status.json()["transfer_status"] == "not_started"
            release.set()
            late = await asyncio.wait_for(pending, 3)
            assert late.status_code == 409
            # Cancellation spends this still-fresh SMS event through its validity
            # window; pruning must not permit it to create a replacement intent.
            reused = await client.post("/api/account/phone/transfer/prepare", json=payload)
            assert reused.status_code == 409
        effect.assert_not_called()
        async with pool.acquire() as conn:
            assert (
                await conn.fetchval(
                    "SELECT user_id FROM actor_identity_cache WHERE phone_number=$1", PHONE
                )
                == "previous"
            )
            assert await conn.fetchrow("SELECT * FROM pkm_data WHERE user_id='previous'") == before
            assert await conn.fetchval("SELECT count(*) FROM account_firebase_mutations") == 0
            assert await conn.fetchval("SELECT count(*) FROM internal_access_events") == 0
    finally:
        release.set()
        if pending:
            await asyncio.gather(pending, return_exceptions=True)
        engine.dispose()
        await pool.close()
