"""Opt-in real transaction tests against a disposable, Unix-socket PostgreSQL.

Set GOOGLE_OAUTH_TEST_DATABASE_URL only for an agent-owned local instance under
/tmp/hushh-google-oauth-pg.*. No app database, real identity or provider call.
"""

import asyncio
import base64
import os
import secrets
import threading
from pathlib import Path
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import make_url

from db.db_client import DatabaseClient
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)

OWNER = "synthetic-owner"


@pytest.fixture
def pg_service(monkeypatch):
    url = os.getenv("GOOGLE_OAUTH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("requires disposable local PostgreSQL")
    parsed = make_url(url)
    assert not parsed.host and str(parsed.query.get("host", "")).startswith(
        "/tmp/hushh-google-oauth-pg."  # noqa: S108 - explicitly supplied disposable socket
    )
    schema = "google_oauth_test_" + uuid4().hex
    base = create_engine(url)
    with base.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"})
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE actor_profiles (user_id TEXT PRIMARY KEY)"))
            migration = (
                Path(__file__).parents[2]
                / "db/migrations/144_google_integrations_calendar_foundation.sql"
            )
            # The exact canonical table shape; only outer transaction markers
            # are removed because this fixture already owns the transaction.
            sql = migration.read_text().replace("BEGIN;", "").replace("COMMIT;", "")
            connection.exec_driver_sql(sql)
            connection.execute(
                text("INSERT INTO actor_profiles(user_id) VALUES (:owner), ('synthetic-other')"),
                {"owner": OWNER},
            )
        monkeypatch.setenv(
            "GOOGLE_OAUTH_TOKEN_KEY", base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
        )
        service = GoogleConnectionService(db=DatabaseClient(engine=engine))
        signing_key = secrets.token_bytes(32)
        monkeypatch.setattr(service, "_signing_key", lambda: signing_key)
        monkeypatch.setattr(service, "is_configured", lambda: True)
        monkeypatch.setattr(service, "_client_id", lambda: "synthetic-client")
        monkeypatch.setattr(service, "_client_secret", lambda: "synthetic-secret")
        monkeypatch.setattr(
            service,
            "_userinfo",
            AsyncMock(return_value={"sub": "synthetic-provider", "email": "owner@example.test"}),
        )

        async def token_exchange(_url, payload):
            return {
                "access_token": "synthetic-access-" + payload["code"],
                "refresh_token": "synthetic-refresh-" + payload["code"],
                "expires_in": 3600,
            }

        monkeypatch.setattr(service, "_post_form", AsyncMock(side_effect=token_exchange))
        yield service, engine
    finally:
        engine.dispose()
        with base.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        base.dispose()


async def start(service):
    return await service.start_native(user_id=OWNER, service="calendar", access_level="read")


async def finish(connection_service, attempt, code="fresh", **overrides):
    params = {
        "user_id": OWNER,
        "service": "calendar",
        "access_level": "read",
        "server_auth_code": code,
        "state": attempt["state"],
    }
    return await connection_service.complete_native(**(params | overrides))


async def seed_connected_with_sibling(service, engine):
    await finish(service, await start(service), "initial")
    with engine.begin() as connection:
        # Keep the provider connected on Calendar disconnect so the test also
        # proves invalidation when the shared credential generation is unchanged.
        connection.execute(
            text(
                "INSERT INTO google_service_grants(user_id, service, status) VALUES (:owner, 'gmail', 'connected')"
            ),
            {"owner": OWNER},
        )


@pytest.mark.asyncio
async def test_native_success_consumes_once_and_publishes_both_rows(pg_service):
    service, engine = pg_service
    attempt = await start(service)
    assert (await finish(service, attempt))["connected"]
    with pytest.raises(GoogleConnectionError):
        await finish(service, attempt)
    with engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM google_provider_connections WHERE status = 'connected'")
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM google_service_grants WHERE status = 'connected'")
            ).scalar_one()
            == 1
        )
        assert connection.execute(
            text("SELECT expires_at <= clock_timestamp() FROM google_oauth_attempts")
        ).scalar_one()


@pytest.mark.asyncio
async def test_web_completion_uses_the_original_bound_pkce_verifier(pg_service, monkeypatch):
    service, _ = pg_service
    redirect = "https://app.example.test/one/profile/google/oauth/return"
    monkeypatch.setattr(service, "_redirect_uri", lambda supplied: redirect)
    started = await service.start(
        user_id=OWNER, service="calendar", access_level="read", redirect_uri=None, login_hint=None
    )
    query = parse_qs(urlparse(started["authorize_url"]).query)
    outcome = await service.complete(
        user_id=OWNER, code="synthetic-web", state=query["state"][0], redirect_uri=redirect
    )
    assert outcome["connected"]
    exchanged = service._post_form.await_args.args[1]
    assert service._pkce_challenge(exchanged["code_verifier"]) == query["code_challenge"][0]
    assert exchanged["redirect_uri"] == redirect


@pytest.mark.asyncio
async def test_start_waiting_for_disconnect_gets_a_fresh_creation_timestamp(
    pg_service, monkeypatch
):
    service, engine = pg_service
    await seed_connected_with_sibling(service, engine)
    disconnect_locked, release_disconnect, start_begun = (
        threading.Event(),
        threading.Event(),
        threading.Event(),
    )

    def hold_disconnect(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().startswith(
            "UPDATE google_service_grants SET status = 'disconnected'"
        ):
            disconnect_locked.set()
            assert release_disconnect.wait(timeout=5)

    event.listen(engine, "before_cursor_execute", hold_disconnect)
    disconnecting = asyncio.create_task(
        service.disconnect_service(user_id=OWNER, service="calendar")
    )
    try:
        assert await asyncio.to_thread(disconnect_locked.wait, 5)
        original_lock = service._lock_google_owner

        def start_lock(connection, owner):
            connection.execute(text("SELECT 1"))  # fixes the transaction's NOW() before disconnect
            start_begun.set()
            original_lock(connection, owner)

        monkeypatch.setattr(service, "_lock_google_owner", start_lock)
        starting = asyncio.create_task(start(service))
        assert await asyncio.to_thread(start_begun.wait, 5)
        release_disconnect.set()
        await disconnecting
        attempt = await starting
        assert (await finish(service, attempt))["connected"]
    finally:
        release_disconnect.set()
        event.remove(engine, "before_cursor_execute", hold_disconnect)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override",
    [
        {"user_id": "synthetic-other"},
        {"access_level": "manage"},
        {"state": "forged.state"},
        {"service": "drive"},
    ],
)
async def test_native_owner_permission_and_state_cannot_be_substituted(pg_service, override):
    service, _ = pg_service
    attempt = await start(service)
    with pytest.raises(GoogleConnectionError):
        await finish(service, attempt, **override)
    service._post_form.assert_not_called()


@pytest.mark.asyncio
async def test_legacy_attempt_cannot_bind_generation_at_callback(pg_service):
    service, engine = pg_service
    attempt = await start(service)
    attempt_id = attempt["state"].split(".")[0]
    envelope = service._encrypt("legacy-verifier" * 4, aad=f"oauth-attempt:{attempt_id}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE google_oauth_attempts SET verifier_ciphertext = :ciphertext, verifier_iv = :iv WHERE attempt_id = :id"
            ),
            envelope | {"id": attempt_id},
        )
    with pytest.raises(GoogleConnectionError, match="Restart"):
        await finish(service, attempt)
    service._post_form.assert_not_called()


@pytest.mark.asyncio
async def test_native_attempt_cannot_be_used_as_web_callback(pg_service):
    service, _ = pg_service
    attempt = await start(service)
    with pytest.raises(GoogleConnectionError, match="Restart"):
        await service.complete(
            user_id=OWNER, code="synthetic-code", state=attempt["state"], redirect_uri=None
        )
    service._post_form.assert_not_called()


@pytest.mark.asyncio
async def test_start_and_disconnect_serialize_attempt_creation(pg_service, monkeypatch):
    service, engine = pg_service
    await seed_connected_with_sibling(service, engine)
    reached, release = threading.Event(), threading.Event()
    original = service._encrypt

    def delayed_encrypt(value, *, aad):
        if aad.startswith("oauth-attempt:"):
            reached.set()
            assert release.wait(timeout=5)
        return original(value, aad=aad)

    monkeypatch.setattr(service, "_encrypt", delayed_encrypt)
    starting = asyncio.create_task(start(service))
    assert await asyncio.to_thread(reached.wait, 5)
    disconnecting = asyncio.create_task(
        service.disconnect_service(user_id=OWNER, service="calendar")
    )
    await asyncio.sleep(0.05)
    assert not disconnecting.done()
    release.set()
    attempt, _ = await asyncio.gather(starting, disconnecting)
    with pytest.raises(GoogleConnectionError):
        await finish(service, attempt)
    with engine.connect() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM google_oauth_attempts WHERE service = 'calendar' AND expires_at > clock_timestamp()"
                )
            ).scalar_one()
            == 0
        )


@pytest.mark.asyncio
async def test_two_same_generation_callbacks_have_only_one_publisher(pg_service, monkeypatch):
    service, engine = pg_service
    first, second = await start(service), await start(service)
    barrier = threading.Barrier(2)
    original = service._publish_authorization

    def concurrent_publish(**kwargs):
        barrier.wait(timeout=5)
        original(**kwargs)

    monkeypatch.setattr(service, "_publish_authorization", concurrent_publish)
    outcomes = await asyncio.gather(
        finish(service, first, "one"), finish(service, second, "two"), return_exceptions=True
    )
    assert sum(isinstance(item, dict) and item["connected"] for item in outcomes) == 1
    refused = [item for item in outcomes if isinstance(item, GoogleConnectionError)]
    assert len(refused) == 1 and refused[0].status_code == 409
    with engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM google_service_grants")).scalar_one() == 1
        )


@pytest.mark.asyncio
async def test_grant_failure_rolls_back_provider_write(pg_service):
    service, engine = pg_service
    attempt = await start(service)
    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE google_service_grants ADD CONSTRAINT synthetic_refusal CHECK (service <> 'calendar')"
            )
        )
    with pytest.raises(GoogleConnectionError) as error:
        await finish(service, attempt)
    assert error.value.status_code == 503
    with engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM google_provider_connections")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM google_service_grants")).scalar_one() == 0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("reconnect", [False, True])
async def test_claimed_callback_cannot_revive_disconnected_service(
    pg_service, monkeypatch, reconnect
):
    service, engine = pg_service
    await seed_connected_with_sibling(service, engine)
    attempt = await start(service)
    reached, release = asyncio.Event(), asyncio.Event()
    original = service._post_form

    async def delayed_exchange(url, payload):
        if payload.get("code") == "old":
            reached.set()
            await asyncio.wait_for(release.wait(), timeout=5)
        return await original(url, payload)

    monkeypatch.setattr(service, "_post_form", delayed_exchange)
    pending = asyncio.create_task(finish(service, attempt, "old"))
    await asyncio.wait_for(reached.wait(), timeout=5)
    await service.disconnect_service(user_id=OWNER, service="calendar")
    if reconnect:
        await finish(service, await start(service), "new")
    before = await service._connection(OWNER)
    release.set()
    with pytest.raises(GoogleConnectionError) as error:
        await pending
    assert error.value.status_code == 409
    after = await service._connection(OWNER)
    assert after["refresh_token_ciphertext"] == before["refresh_token_ciphertext"]
    assert (await service.status(user_id=OWNER, service="calendar"))["connected"] is reconnect


@pytest.mark.asyncio
async def test_stale_callback_already_prepared_cannot_replace_reconnected_account(
    pg_service, monkeypatch
):
    service, engine = pg_service
    await seed_connected_with_sibling(service, engine)
    attempt = await start(service)
    old_id = attempt["state"].split(".")[0]
    reached, release = threading.Event(), threading.Event()
    original = service._publish_authorization

    def delayed_publish(**kwargs):
        if kwargs["attempt_id"] == old_id:
            reached.set()
            assert release.wait(timeout=5)
        original(**kwargs)

    monkeypatch.setattr(service, "_publish_authorization", delayed_publish)
    pending = asyncio.create_task(finish(service, attempt, "old"))
    assert await asyncio.to_thread(reached.wait, 5)
    await service.disconnect_service(user_id=OWNER, service="calendar")
    await finish(service, await start(service), "new")
    before = await service._connection(OWNER)
    release.set()
    with pytest.raises(GoogleConnectionError) as error:
        await pending
    assert error.value.status_code == 409
    assert (await service._connection(OWNER))["refresh_token_ciphertext"] == before[
        "refresh_token_ciphertext"
    ]


@pytest.mark.asyncio
async def test_stale_refresh_failure_cannot_poison_new_authorization(pg_service):
    service, engine = pg_service
    await seed_connected_with_sibling(service, engine)
    old = await service._connection(OWNER)
    await finish(service, await start(service), "new")
    await service._mark_needs_reauth(
        user_id=OWNER,
        service="calendar",
        expected_refresh_ciphertext=old["refresh_token_ciphertext"],
    )
    assert (await service.status(user_id=OWNER, service="calendar"))["connected"]


@pytest.mark.asyncio
async def test_expiry_is_checked_after_waiting_for_owner_lock(pg_service, monkeypatch):
    service, engine = pg_service
    attempt = await start(service)
    reached = threading.Event()
    original = service._lock_google_owner

    def observed_lock(connection, owner):
        # Establish the transaction's timestamp before the parent expires the
        # attempt; NOW() would incorrectly keep this attempt alive afterward.
        connection.execute(text("SELECT 1"))
        reached.set()
        original(connection, owner)

    monkeypatch.setattr(service, "_lock_google_owner", observed_lock)
    with engine.begin() as blocker:
        original(blocker, OWNER)
        pending = asyncio.create_task(finish(service, attempt))
        assert await asyncio.to_thread(reached.wait, 5)
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE google_oauth_attempts SET expires_at = clock_timestamp()")
            )
    with pytest.raises(GoogleConnectionError) as error:
        await pending
    assert error.value.status_code == 409
    assert await service._connection(OWNER) is None
