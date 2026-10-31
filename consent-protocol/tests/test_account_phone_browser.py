"""Recorded Firebase transports -> production phone UI/API/policy -> disposable SQL.

This does not qualify real Google/Apple sign-in, SMS, native plugins or a deployed
environment. No runtime database URL or production identity is accepted.
"""

from __future__ import annotations

import base64
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import asyncpg
import pytest
from fastapi import FastAPI, HTTPException, Request, Response
from sqlalchemy import create_engine

from tests.helpers.document_delivery_browser import browser_backend, run_browser_process
from tests.helpers.phone_conflict_browser import (
    OWNERS,
    PHONE,
    _assert_erased,
    _assert_linked_deleted,
    _assert_preserved,
    _schema,
    _seed,
)
from tests.helpers.phone_transfer_postgres import database_url as database_url

pytestmark = [pytest.mark.feature_auth_reliability, pytest.mark.trace_loop]
SCENARIOS = {"recover", "delete", "delete_linked", "transfer", "devices"}


class RecordedFirebase:
    """External SDK transport only; every application policy stays installed."""

    def __init__(self, provider: str):
        self.provider = provider
        self.active = "receiving-a"
        self.claims: dict[str, dict] = {}
        self.auth_times = {uid: int(time.time()) for uid in OWNERS.values()}
        self.challenges: dict[str, dict] = {}
        self.phone = PHONE
        self.unlink_count = 0
        self.sends = 0

    def describe(self, name: str):
        return {
            "uid": OWNERS[name],
            "provider": self.provider,
            "phone": self.phone if name == "previous" else None,
        }

    def token(self, uid: str, *, phone: bool = False, stamp: int | None = None):
        if uid not in OWNERS.values():
            raise HTTPException(403)
        now = int(time.time())
        claims = {
            "uid": uid,
            "sub": uid,
            "iat": now,
            "exp": now + 3600,
            "auth_time": stamp if stamp is not None else self.auth_times[uid],
            "email_verified": True,
            "email": f"{uid}@example.test",
            "firebase": {"sign_in_provider": "phone" if phone else self.provider},
        }
        if phone:
            claims["phone_number"] = PHONE
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        token = f"fixture.{payload}.{uuid4().hex}"
        self.claims[token] = claims
        return token

    def verify(self, token, **_kwargs):
        # Synthetic signature transport: unknown bytes never become claims.
        if token not in self.claims:
            raise ValueError("unrecognized fixture credential")
        return dict(self.claims[token])

    def get_user(self, uid, **_kwargs):
        if uid not in OWNERS.values():
            raise ValueError("unknown fixture identity")
        return SimpleNamespace(
            uid=uid,
            phone_number=self.phone if uid == OWNERS["previous"] else None,
            email=f"{uid}@example.test",
            email_verified=True,
            display_name="Synthetic account",
            photo_url=None,
            disabled=False,
            custom_claims={},
            tokens_valid_after_timestamp=0,
            provider_data=[
                SimpleNamespace(provider_id=self.provider, uid=uid, email=f"{uid}@example.test")
            ],
        )

    def install_http(self, app):
        @app.api_route("/__phone_fixture/sdk/{operation}", methods=["GET", "POST"])
        async def sdk(operation: str, request: Request, response: Response):
            response.headers["Cache-Control"] = "no-store"
            body = await request.json() if request.method == "POST" else {}
            if operation == "state":
                return {
                    "user": self.describe(self.active) if self.active else None,
                    "provider": self.provider,
                }
            if (
                operation == "sign-in"
                and body.get("owner") in OWNERS
                and body.get("provider") == self.provider
            ):
                self.active = body["owner"]
                return {"user": self.describe(self.active)}
            if operation == "sign-out":
                self.active = None
                return {"success": True}
            if operation == "token":
                return {"token": self.token(body.get("uid"))}
            if operation == "reauthenticate":
                if (
                    not self.active
                    or body.get("uid") != OWNERS[self.active]
                    or body.get("provider") != self.provider
                ):
                    raise HTTPException(403)
                self.auth_times[body["uid"]] = int(time.time())
                return {"success": True}
            if operation == "send" and body.get("phone") == PHONE:
                challenge = str(uuid4())
                self.challenges[challenge] = {"created": int(time.time()), "spent": False}
                self.sends += 1
                return {"verificationId": challenge}
            if operation == "verify":
                challenge = self.challenges.get(body.get("verificationId"))
                if not challenge or challenge["spent"] or body.get("verificationCode") != "123456":
                    return Response(
                        json.dumps({"code": "auth/invalid-verification-code"}),
                        status_code=400,
                        media_type="application/json",
                    )
                challenge["spent"] = True
                return {
                    "user": {**self.describe("previous"), "provider": "phone"},
                    "token": self.token(OWNERS["previous"], phone=True, stamp=challenge["created"]),
                }
            raise HTTPException(404)


def _install_ports(monkeypatch, pool, engine, recorded):
    from firebase_admin import auth

    import db.connection as connection
    import db.db_client as db_client
    from api.routes import account
    from api.utils import firebase_admin, firebase_auth
    from hushh_mcp.runtime_settings import get_app_runtime_settings
    from hushh_mcp.services import (
        account_deletion_lifecycle_service,
        account_deletion_release_admission,
        actor_identity_service,
        phone_recovery_state,
        phone_transfer_service,
    )

    for name, value in {
        "ENVIRONMENT": "local",
        "APP_RUNTIME_PROFILE": "local",
        "AUTH_PHONE_RECOVERY_ENABLED": "true",
        "PERSONAL_AGENT_ENABLED": "false",
        "PERSONAL_AGENT_AUTOPROVISION_ENABLED": "false",
        "ACCOUNT_GENERATION_ADMISSION_ENABLED": "false",
        "HUSHH_TRUSTED_DEVICE_ENABLED": "true",
        "OTEL_ENABLED": "false",
    }.items():
        monkeypatch.setenv(name, value)
    for name in (
        "HUSHH_DEPLOY_ENV",
        "K_SERVICE",
        "K_REVISION",
        "CONTAINER_APP_NAME",
        "CONTAINER_APP_REVISION",
        "FIREBASE_AUTH_EMULATOR_HOST",
    ):
        monkeypatch.delenv(name, raising=False)
    get_app_runtime_settings.cache_clear()
    monkeypatch.setattr(connection, "_pool", pool)
    monkeypatch.setattr(db_client, "_engine", engine)
    monkeypatch.setattr(db_client, "_db_client", db_client.DatabaseClient(engine))
    for module in (
        connection,
        actor_identity_service,
        phone_transfer_service,
        phone_recovery_state,
    ):
        monkeypatch.setattr(module, "get_pool", AsyncMock(return_value=pool))
    fixture_app = SimpleNamespace(
        project_id="synthetic-auth", credential=SimpleNamespace(get_credential=lambda: object())
    )
    for module in (
        firebase_admin,
        firebase_auth,
        account,
        actor_identity_service,
        account_deletion_lifecycle_service,
    ):
        monkeypatch.setattr(module, "get_firebase_auth_app", lambda: fixture_app)
    monkeypatch.setattr(
        firebase_auth, "ensure_firebase_auth_admin", lambda: (True, "synthetic-auth")
    )
    monkeypatch.setattr(auth, "verify_id_token", recorded.verify)
    monkeypatch.setattr(auth, "get_user", recorded.get_user)

    @asynccontextmanager
    async def release_connection():
        conn = await asyncpg.connect(engine.url.render_as_string(hide_password=False))
        try:
            yield conn
        finally:
            await conn.close(timeout=3)

    monkeypatch.setattr(account_deletion_release_admission, "_connect", release_connection)

    _install_provider_transport(monkeypatch, recorded)


def _install_provider_transport(monkeypatch, recorded):
    from hushh_mcp.services import account_firebase_mutations, phone_transfer_authority

    class ProviderResponse:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def iter_content(self, chunk_size=4096):
            yield json.dumps(self.body).encode()

        def close(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    class ProviderSession:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get(self, url, **_kwargs):
            assert (
                url
                == "https://identitytoolkit.googleapis.com/admin/v2/projects/synthetic-auth/config"
            )
            return ProviderResponse({"signIn": {"phoneNumber": {"testPhoneNumbers": {}}}})

        def mount(self, *_args):
            pass

        def post(self, url, *, json, **_kwargs):
            assert (
                url
                == "https://identitytoolkit.googleapis.com/v1/projects/synthetic-auth/accounts:update"
            )
            assert json == {"localId": OWNERS["previous"], "deleteProvider": ["phone"]}
            recorded.unlink_count += 1
            recorded.phone = None
            return ProviderResponse({"localId": OWNERS["previous"]})

    monkeypatch.setattr(phone_transfer_authority, "AuthorizedSession", ProviderSession)
    monkeypatch.setattr(account_firebase_mutations, "AuthorizedSession", ProviderSession)


def _fixture_app(pool, recorded, baseline, outcomes, monkeypatch):
    from api.middlewares.observability import observability_middleware
    from api.routes import account, account_phone_linked_deletion, db_proxy
    from hushh_mcp.services import account_deletion_provider_worker as worker

    app = FastAPI()
    app.middleware("http")(observability_middleware)
    app.include_router(account.router)
    app.include_router(account_phone_linked_deletion.router)
    app.include_router(db_proxy.router)
    recorded.install_http(app)

    @app.delete("/api/auth/session")
    async def cookie_transport(response: Response):
        # The ordinary Next cookie transport only; real AuthProvider owns sign-out.
        response.delete_cookie("__session")
        return {"success": True}

    @app.post("/__phone_fixture/reset/{scenario}")
    async def reset(scenario: str):
        if scenario not in SCENARIOS:
            raise HTTPException(404)
        baseline.clear()
        baseline.update(await _seed(pool, files=scenario in {"recover", "transfer"}))
        recorded.active = "previous" if scenario == "devices" else "receiving-a"
        # The sign-in handoff remains the path whenever in-place deletion is off.
        monkeypatch.setenv(
            "HUSHH_PHONE_LINKED_DELETION_ENABLED", "false" if scenario == "delete" else "true"
        )
        recorded.phone = PHONE
        recorded.claims.clear()
        recorded.challenges.clear()
        recorded.unlink_count = 0
        recorded.sends = 0
        return {"ready": True}

    @app.post("/__phone_fixture/drain/{scenario}")
    async def drain(scenario: str):
        if scenario not in {"delete", "delete_linked"}:
            raise HTTPException(404)
        # Controlled scheduler delivery; canonical lease, journal and SQL writer.
        return {"settled": await worker.drain(limit=1)}

    @app.post("/__phone_fixture/assert/{scenario}")
    async def assert_persisted(scenario: str):
        if scenario not in SCENARIOS:
            raise HTTPException(404)
        async with pool.acquire() as conn:
            if scenario == "delete":
                await _assert_erased(conn, recorded, baseline)
            elif scenario == "delete_linked":
                await _assert_linked_deleted(conn, recorded, baseline)
            else:
                await _assert_preserved(conn, recorded, baseline, scenario)
        outcomes.append(scenario)
        return {"persisted": True}

    return app


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "browser_engine,provider,readback_failure",
    [
        ("chromium", "google.com", False),
        ("webkit", "apple.com", False),
        ("webkit", "apple.com", True),
    ],
)
async def test_recorded_phone_browser_journeys(
    database_url, monkeypatch, browser_engine, provider, readback_failure
):
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=4, command_timeout=5)
    engine = create_engine(database_url, pool_size=3, max_overflow=1)
    try:
        await _schema(pool)
        recorded = RecordedFirebase(provider)
        _install_ports(monkeypatch, pool, engine, recorded)
        outcomes = []
        baseline = {}
        app = _fixture_app(pool, recorded, baseline, outcomes, monkeypatch)
        async with browser_backend(app) as origin:
            try:
                result = await run_browser_process(
                    {
                        "backend": origin,
                        "engine": browser_engine,
                        "provider": provider,
                        "transferReadbackFailure": readback_failure,
                    },
                    script="phone-conflict-flow.mjs",
                )
            except AssertionError as error:
                if not readback_failure:
                    raise
                report = None
                for line in reversed(str(error).splitlines()):
                    try:
                        candidate = json.loads(line.removeprefix("Browser loop failed: "))
                    except json.JSONDecodeError:
                        continue
                    if (
                        isinstance(candidate, dict)
                        and candidate.get("code") == "PHONE_BROWSER_LOOP_FAILED"
                    ):
                        report = candidate
                        break
                if report is None:
                    raise
                assert report["code"] == "PHONE_BROWSER_LOOP_FAILED"
                assert report["stage"] == "transfer_readback"
                assert report["diagnostics"]["transfer"] == {
                    "get_requests": 1,
                    "get_responses": 0,
                    "get_failures": 1,
                    "confirm_requests": 1,
                    "erase_requests": 0,
                    "click_started": True,
                    "click_completed": True,
                }
                async with pool.acquire() as connection:
                    await _assert_preserved(connection, recorded, baseline, "transfer")
                assert outcomes == ["recover", "delete", "delete_linked"]
                return
        assert not readback_failure, (
            "A blocked authoritative status read must not pass the browser gate"
        )
        assert result["feature"] == "phone_conflict"
        assert result["engine"] == browser_engine
        assert outcomes == ["recover", "delete", "delete_linked", "transfer", "devices"]
        assert "legacy_257_handoff_rejected" in result["trace_loop"]
    finally:
        engine.dispose()
        await pool.close()
