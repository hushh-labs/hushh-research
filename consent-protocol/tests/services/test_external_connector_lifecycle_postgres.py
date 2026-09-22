"""Real PostgreSQL races in synthetic, isolated schemas; never use DATABASE_URL."""
# ruff: noqa: S106 -- all provider credentials below are synthetic test fixtures

from __future__ import annotations

import asyncio
import base64
import os
import shutil
import subprocess
import tempfile
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url

from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialsService,
)
from hushh_mcp.services.external_connector_google_oauth import (
    AUTHORIZE_URL,
    SCOPES,
    TOKEN_URL,
    DriveOAuthError,
    ExternalConnectorGoogleOAuth,
)
from hushh_mcp.services.external_connector_lifecycle_store import (
    ConnectorLifecycleError,
    ExternalConnectorLifecycleStore,
)
from hushh_mcp.services.external_connector_oauth_service import ExternalConnectorOAuthService
from hushh_mcp.services.external_connector_registry_service import ExternalMcpConnectorDefinition

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


@pytest.fixture(scope="module")
def connector_postgres_url():
    # The existing CI service is explicitly test-only. Refuse any runtime URL,
    # Cloud SQL proxy, non-local host, or non-test database/user even if supplied.
    supplied = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if supplied:
        url = make_url(supplied)
        if (
            url.host not in {"127.0.0.1", "localhost"}
            or url.database != "command_test"
            or url.username != "command_test"
            or url.port not in {None, 5432}
        ):
            pytest.fail("Connector tests refuse a non-isolated PostgreSQL target")
        yield url
        return
    pg_config = shutil.which("pg_config")
    if not pg_config or os.geteuid() == 0:
        if os.getenv("REQUIRE_CONNECTOR_POSTGRES") == "1" or os.getenv("CI") == "true":
            pytest.fail("Connector concurrency acceptance requires PostgreSQL server binaries")
        pytest.skip("Set test-only PostgreSQL URL or install local PostgreSQL server binaries")
    bindir = Path(subprocess.check_output([pg_config, "--bindir"], text=True, timeout=5).strip())  # noqa: S603
    if not all((bindir / tool).is_file() for tool in ("initdb", "pg_ctl")):
        pytest.fail("Connector concurrency acceptance requires server, not client-only PostgreSQL")
    directory = Path(tempfile.mkdtemp(prefix="one-connector-pg-", dir="/tmp"))
    data = directory / "data"
    started = False

    def run(tool, *arguments, check=True):
        return subprocess.run(  # noqa: S603 - fixed server commands, private synthetic cluster
            [str(bindir / tool), *map(str, arguments)],
            check=check,
            capture_output=True,
            text=True,
            timeout=30,
        )

    try:
        run(
            "initdb",
            "-D",
            data,
            "-A",
            "trust",
            "-U",
            "connector_test",
            "--no-locale",
            "--encoding=UTF8",
        )
        run(
            "pg_ctl",
            "-D",
            data,
            "-l",
            directory / "server.log",
            "-o",
            f"-k {directory} -h '' -p 16581",
            "-w",
            "-t",
            "20",
            "start",
        )
        started = True
        yield URL.create(
            "postgresql+psycopg2",
            username="connector_test",
            database="postgres",
            query={"host": str(directory), "port": "16581"},
        )
    finally:
        if started or (data / "postmaster.pid").exists():
            run("pg_ctl", "-D", data, "-m", "immediate", "-w", "-t", "20", "stop")
            assert run("pg_ctl", "-D", data, "status", check=False).returncode == 3
        shutil.rmtree(directory)


@pytest.fixture
def lifecycle(connector_postgres_url):
    # Identifier generated here, never from configuration or user input.
    schema = f"connector_test_{uuid.uuid4().hex}"
    admin = create_engine(connector_postgres_url)
    with admin.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
    engine = create_engine(
        connector_postgres_url,
        pool_size=8,
        connect_args={"options": f"-csearch_path={schema},public"},
    )
    try:
        with engine.connect() as connection:
            for filename in (
                "225_external_mcp_connectors.sql",
                "227_external_connector_lifecycle.sql",
                "228_selected_drive_documents.sql",
                "229_drive_document_chunks.sql",
            ):
                connection.exec_driver_sql((MIGRATIONS / filename).read_text())
            # Release migrations are replayable, including after constraints exist.
            connection.exec_driver_sql(
                (MIGRATIONS / "227_external_connector_lifecycle.sql").read_text()
            )
            connection.exec_driver_sql(
                (MIGRATIONS / "228_selected_drive_documents.sql").read_text()
            )
            connection.execute(
                text("""
                INSERT INTO external_mcp_connectors
                  (connector_id, display_name, mcp_endpoint, auth_style, created_by)
                VALUES ('drive', 'Drive', 'https://example.invalid', 'oauth', 'test'),
                       ('api-key', 'Legacy', 'https://example.invalid', 'api_key', 'test'),
                       ('google_drive', 'Drive', 'https://example.invalid', 'oauth', 'test')
            """)
            )
            connection.commit()
        yield ExternalConnectorLifecycleStore(db=SimpleNamespace(engine=engine))
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
        admin.dispose()


async def start(store, attempt="attempt-a", *, user="owner", flow="web"):
    return await store.start_attempt(
        user_id=user,
        connector_id="drive",
        attempt_id=attempt,
        client_id="isolated-client",
        redirect_uri="https://example.invalid/return",
        flow=flow,
        ciphertext="encrypted-verifier",
        iv="iv",
    )


def envelope(*_):
    return dict(
        ciphertext="sealed",
        iv="nonce",
        algorithm="test-only",
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )


async def activate(store, attempt="attempt-a"):
    await start(store, attempt)
    assert await store.claim_attempt(attempt_id=attempt, user_id="owner")
    return await store.finalize(attempt_id=attempt, user_id="owner", seal=envelope)


def sql(store, statement, params=None):
    with store.db.engine.begin() as connection:
        return connection.execute(text(statement), params or {})


@pytest.mark.asyncio
async def test_callback_replay_has_one_winner_and_wrong_owner_cannot_consume(lifecycle):
    await start(lifecycle)
    assert await lifecycle.claim_attempt(attempt_id="attempt-a", user_id="intruder") is None
    results = await asyncio.gather(
        *(lifecycle.claim_attempt(attempt_id="attempt-a", user_id="owner") for _ in range(8))
    )
    assert sum(result is not None for result in results) == 1
    completed = await asyncio.gather(
        *(
            lifecycle.finalize(attempt_id="attempt-a", user_id="owner", seal=envelope)
            for _ in range(4)
        )
    )
    assert sum(result is not None for result in completed) == 1
    row = await lifecycle.read(user_id="owner", connector_id="drive")
    assert (row["connection_generation"], row["credential_version"]) == (1, 1)
    assert row["status"] == "verifying"  # OAuth success is not transport health.


@pytest.mark.asyncio
async def test_new_attempt_and_disconnect_each_reject_late_exchange(lifecycle):
    await start(lifecycle)
    assert await lifecycle.claim_attempt(attempt_id="attempt-a", user_id="owner")
    await start(lifecycle, "attempt-b")
    assert await lifecycle.finalize(attempt_id="attempt-a", user_id="owner", seal=envelope) is None
    assert await lifecycle.claim_attempt(attempt_id="attempt-b", user_id="owner")
    await lifecycle.disconnect(user_id="owner", connector_id="drive")
    assert await lifecycle.finalize(attempt_id="attempt-b", user_id="owner", seal=envelope) is None
    row = await lifecycle.read(user_id="owner", connector_id="drive")
    assert row["status"] == "revoked"
    assert row["credential_ciphertext"] is None


@pytest.mark.asyncio
async def test_expiry_and_native_finalization_require_pending_credentials(lifecycle):
    await start(lifecycle, flow="native")
    assert await lifecycle.claim_attempt(attempt_id="attempt-a", user_id=None)

    def forbidden(*_):
        raise AssertionError("seal must not run before pending credentials are ready")

    assert await lifecycle.finalize(attempt_id="attempt-a", user_id="owner", seal=forbidden) is None
    assert not await lifecycle.stage_native(
        attempt_id="attempt-a",
        ciphertext="sealed",
        iv="iv",
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    assert await lifecycle.stage_native(
        attempt_id="attempt-a",
        ciphertext="sealed",
        iv="iv",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    assert not await lifecycle.stage_native(
        attempt_id="attempt-a",
        ciphertext="replacement",
        iv="iv",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    assert (
        await lifecycle.finalize(attempt_id="attempt-a", user_id="intruder", seal=forbidden) is None
    )
    sql(
        lifecycle,
        "UPDATE external_connector_oauth_attempts SET pending_credential_expires_at = clock_timestamp() - interval '1 second'",
    )
    assert await lifecycle.finalize(attempt_id="attempt-a", user_id="owner", seal=forbidden) is None
    await start(lifecycle, "attempt-b")
    sql(
        lifecycle,
        "UPDATE external_connector_oauth_attempts SET expires_at = clock_timestamp() - interval '1 second'",
    )
    assert await lifecycle.claim_attempt(attempt_id="attempt-b", user_id="owner") is None


@pytest.mark.asyncio
async def test_native_finalize_once_and_web_attempt_cannot_use_unauthenticated_callback(lifecycle):
    await start(lifecycle)
    assert await lifecycle.claim_attempt(attempt_id="attempt-a", user_id=None) is None
    await start(lifecycle, "native", flow="native")
    assert await lifecycle.claim_attempt(attempt_id="native", user_id=None)
    assert await lifecycle.stage_native(
        attempt_id="native",
        ciphertext="sealed",
        iv="iv",
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    assert await lifecycle.finalize(attempt_id="native", user_id="owner", seal=envelope)
    assert await lifecycle.finalize(attempt_id="native", user_id="owner", seal=envelope) is None
    with lifecycle.db.engine.connect() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM external_connector_oauth_attempts WHERE attempt_id = 'native'")
            )
            .mappings()
            .one()
        )
    assert row["pending_credential_ciphertext"] is None
    assert row["code_verifier_ciphertext"] == ""


@pytest.mark.asyncio
async def test_refresh_single_winner_and_version_cas(lifecycle):
    await activate(lifecycle)
    common = dict(user_id="owner", connector_id="drive", generation=1, version=1)
    results = await asyncio.gather(
        *(lifecycle.claim_refresh(**common, lease_id=f"lease-{i}") for i in range(8))
    )
    winners = [i for i, result in enumerate(results) if result]
    assert len(winners) == 1
    lease = f"lease-{winners[0]}"
    assert not await lifecycle.settle_refresh(**common, lease_id="other", envelope=envelope())
    assert await lifecycle.settle_refresh(**common, lease_id=lease, envelope=envelope())
    assert not await lifecycle.settle_refresh(**common, lease_id=lease, rejected=True)
    row = await lifecycle.read(user_id="owner", connector_id="drive")
    assert row["credential_version"] == 2
    assert row["status"] == "verifying"


@pytest.mark.asyncio
@pytest.mark.parametrize("late_rejection", [False, True])
async def test_expired_refresh_worker_cannot_settle_new_lease_or_disconnect(
    lifecycle, late_rejection
):
    await activate(lifecycle)
    common = dict(user_id="owner", connector_id="drive", generation=1, version=1)
    assert await lifecycle.claim_refresh(**common, lease_id="old")
    sql(
        lifecycle,
        "UPDATE user_external_connector_connections SET refresh_lease_expires_at = clock_timestamp() - interval '1 second'",
    )
    assert await lifecycle.claim_refresh(**common, lease_id="new")
    outcome = {"rejected": True} if late_rejection else {"envelope": envelope()}
    assert not await lifecycle.settle_refresh(**common, lease_id="old", **outcome)
    await lifecycle.disconnect(user_id="owner", connector_id="drive")
    assert not await lifecycle.settle_refresh(**common, lease_id="new", **outcome)
    assert not await lifecycle.mark_verified(**common, policy_hash="approved")
    assert (await lifecycle.read(user_id="owner", connector_id="drive"))["status"] == "revoked"


@pytest.mark.asyncio
async def test_transient_refresh_preserves_grant_but_rejection_needs_reauth(lifecycle):
    await activate(lifecycle)
    common = dict(user_id="owner", connector_id="drive", generation=1, version=1)
    assert await lifecycle.claim_refresh(**common, lease_id="transient")
    assert await lifecycle.settle_refresh(**common, lease_id="transient")
    row = await lifecycle.read(user_id="owner", connector_id="drive")
    assert row["credential_ciphertext"] == "sealed"
    assert row["credential_version"] == 1
    assert await lifecycle.claim_refresh(**common, lease_id="rejected")
    assert await lifecycle.settle_refresh(**common, lease_id="rejected", rejected=True)
    row = await lifecycle.read(user_id="owner", connector_id="drive")
    assert row["status"] == "needs_reauth"
    assert row["verified_policy_hash"] is None
    assert await lifecycle.claim_refresh(**common, lease_id="again") is None


@pytest.mark.asyncio
async def test_pending_revocation_blocks_reconnect_and_duplicate_disconnect(lifecycle):
    await activate(lifecycle)
    old = await lifecycle.disconnect(user_id="owner", connector_id="drive")
    assert old["credential_ciphertext"] == "sealed"
    duplicate = await lifecycle.disconnect(user_id="owner", connector_id="drive")
    assert duplicate["credential_ciphertext"] is None
    assert duplicate["connection_generation"] == 2
    with pytest.raises(ConnectorLifecycleError, match="revocation_in_progress"):
        await start(lifecycle, "too-early")
    assert await lifecycle.record_revocation(
        user_id="owner", connector_id="drive", generation=2, outcome="revoked"
    )
    assert await activate(lifecycle, "reconnected")
    assert not await lifecycle.record_revocation(
        user_id="owner", connector_id="drive", generation=2, outcome="failed"
    )
    assert (await lifecycle.read(user_id="owner", connector_id="drive"))["status"] == "verifying"


@pytest.mark.asyncio
async def test_revocation_failure_reports_truth_and_crashed_worker_fence_expires(lifecycle):
    await activate(lifecycle)
    await lifecycle.disconnect(user_id="owner", connector_id="drive")
    assert await lifecycle.record_revocation(
        user_id="owner", connector_id="drive", generation=2, outcome="failed"
    )
    with pytest.raises(ConnectorLifecycleError, match="revocation_in_progress"):
        await start(lifecycle, "too-early")
    sql(
        lifecycle,
        "UPDATE user_external_connector_connections SET revocation_pending_until = clock_timestamp() - interval '1 second', revocation_outcome = 'pending'",
    )
    await start(lifecycle, "after-deadline")
    row = await lifecycle.read(user_id="owner", connector_id="drive")
    assert row["revocation_outcome"] == "unavailable"
    assert row["credential_ciphertext"] is None


@pytest.mark.asyncio
async def test_new_attempt_does_not_destroy_current_connection(lifecycle):
    await activate(lifecycle)
    assert await lifecycle.mark_verified(
        user_id="owner", connector_id="drive", generation=1, version=1, policy_hash="approved"
    )
    await start(lifecycle, "cancelled-later")
    row = await lifecycle.read(user_id="owner", connector_id="drive")
    assert row["status"] == "connected"
    assert row["credential_ciphertext"] == "sealed"
    assert row["connection_generation"] == 1


@pytest.mark.asyncio
async def test_migration_replay_preserves_legacy_api_key_envelope(lifecycle):
    sql(
        lifecycle,
        """INSERT INTO user_external_connector_connections
        (user_id, connector_id, status, credential_ciphertext, credential_iv)
        VALUES ('legacy-owner', 'api-key', 'connected', 'legacy-ciphertext', 'legacy-iv')""",
    )
    with lifecycle.db.engine.connect() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "227_external_connector_lifecycle.sql").read_text()
        )
    row = await lifecycle.read(user_id="legacy-owner", connector_id="api-key")
    assert row["credential_ciphertext"] == "legacy-ciphertext"
    assert row["envelope_version"] == 1
    assert row["connection_generation"] == 0


@pytest.fixture
def drive(lifecycle, monkeypatch):
    monkeypatch.setenv(
        "EXTERNAL_CONNECTOR_CREDENTIAL_KEY", base64.urlsafe_b64encode(os.urandom(32)).decode()
    )
    monkeypatch.setenv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "dedicated-test-client")
    monkeypatch.setenv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "synthetic-test-secret")
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_CONNECTION", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    registry = SimpleNamespace(
        get_connector=AsyncMock(
            return_value=ExternalMcpConnectorDefinition(
                connector_id="google_drive",
                display_name="Drive",
                description="Read Drive",
                mcp_endpoint="https://example.invalid",
                auth_style="oauth",
                oauth_authorize_url=AUTHORIZE_URL,
                oauth_token_url=TOKEN_URL,
                oauth_scopes=SCOPES,
                oauth_client_id_env="GOOGLE_DRIVE_OAUTH_CLIENT_ID",
                oauth_client_secret_env="GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
                api_key_header_name=None,
                is_active=True,
                registered_redirect_uris=(
                    "https://example.invalid/return",
                    "https://api.example.invalid/api/connectors/oauth/native/callback",
                ),
            )
        )
    )
    credentials = ExternalConnectorCredentialsService(db=lifecycle.db)
    codec = ExternalConnectorOAuthService(
        db=lifecycle.db, registry=registry, credentials=credentials
    )
    service = ExternalConnectorGoogleOAuth(
        db=lifecycle.db,
        registry=registry,
        credentials=credentials,
        state_codec=codec,
        lifecycle=lifecycle,
    )
    # Provider consent and signature verification are independent of these real
    # database lifecycle tests. The separate identity suite verifies signed JWTs.
    service._post = AsyncMock(
        return_value=dict(
            access_token="synthetic-access",
            refresh_token="synthetic-refresh",
            token_type="Bearer",
            expires_in=3600,
            scope=" ".join(SCOPES),
            id_token="synthetic-id-token",
        )
    )
    service._verify_identity = lambda *_, **__: {
        "subject": "subject-a",
        "accountLabel": "synthetic@example.invalid",
    }
    return service


async def drive_start(drive, *, flow="web"):
    redirect = (
        "https://example.invalid/return"
        if flow == "web"
        else "https://api.example.invalid/api/connectors/oauth/native/callback"
    )
    result = await drive.start(user_id="owner", redirect_uri=redirect, flow=flow)
    query = parse_qs(urlparse(result["authorizeUrl"]).query)
    return result, query


async def drive_connect(drive):
    result, query = await drive_start(drive)
    completed = await drive.complete(
        state=query["state"][0], code="synthetic-code", expected_user_id="owner"
    )
    assert completed == {"status": "verifying", "connectorId": "google_drive"}
    return result


@pytest.mark.asyncio
async def test_drive_signed_pkce_attempt_registered_redirect_and_replay(drive):
    with pytest.raises(DriveOAuthError, match="redirect_not_registered"):
        await drive.start(user_id="owner", redirect_uri="https://attacker.invalid/return")
    result, query = await drive_start(drive)
    assert query["include_granted_scopes"] == ["false"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["nonce"]
    with drive.lifecycle.db.engine.connect() as connection:
        attempt = dict(
            connection.execute(
                text("SELECT * FROM external_connector_oauth_attempts WHERE attempt_id = :attempt"),
                {"attempt": result["attemptId"]},
            )
            .mappings()
            .one()
        )
    assert query["nonce"][0] not in str(attempt)
    assert attempt["expires_at"] - attempt["created_at"] <= timedelta(minutes=10, seconds=1)
    with pytest.raises(DriveOAuthError, match="attempt_unavailable"):
        await drive.complete(
            state=query["state"][0], code="synthetic-code", expected_user_id="wrong-owner"
        )
    drive._post.assert_not_called()
    await drive.complete(state=query["state"][0], code="synthetic-code", expected_user_id="owner")
    with pytest.raises(DriveOAuthError, match="attempt_unavailable"):
        await drive.complete(
            state=query["state"][0], code="synthetic-code", expected_user_id="owner"
        )
    drive._post.assert_awaited_once()


@pytest.mark.asyncio
async def test_partial_consent_cannot_activate_connection(drive):
    drive._post.return_value["scope"] = "openid email"
    _, query = await drive_start(drive)
    with pytest.raises(DriveOAuthError, match="insufficient_scope"):
        await drive.complete(
            state=query["state"][0], code="synthetic-code", expected_user_id="owner"
        )
    row = await drive.lifecycle.read(user_id="owner", connector_id="google_drive")
    assert row["credential_ciphertext"] is None
    assert row["status"] == "revoked"


@pytest.mark.asyncio
async def test_drive_disconnect_during_provider_exchange_suppresses_activation(drive):
    _, query = await drive_start(drive)
    entered, release = asyncio.Event(), asyncio.Event()
    token = dict(drive._post.return_value)

    async def paused(*args, **kwargs):
        entered.set()
        await release.wait()
        return token

    drive._post.side_effect = paused
    pending = asyncio.create_task(
        drive.complete(state=query["state"][0], code="synthetic-code", expected_user_id="owner")
    )
    await entered.wait()
    await drive.disconnect(user_id="owner")
    release.set()
    with pytest.raises(DriveOAuthError, match="attempt_unavailable"):
        await pending
    assert (await drive.lifecycle.read(user_id="owner", connector_id="google_drive"))[
        "credential_ciphertext"
    ] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("same_account", [True, False])
async def test_refresh_preservation_requires_same_verified_account(drive, same_account):
    await drive_connect(drive)
    drive._post.return_value.pop("refresh_token")
    if not same_account:
        drive._verify_identity = lambda *_, **__: {
            "subject": "other-account",
            "accountLabel": "other@example.invalid",
        }
    _, query = await drive_start(drive)
    if same_account:
        await drive.complete(
            state=query["state"][0], code="synthetic-code", expected_user_id="owner"
        )
        _, credential = await drive.current_credential(user_id="owner")
        assert credential["refreshToken"] == "synthetic-refresh"
    else:
        with pytest.raises(DriveOAuthError, match="offline_consent_required"):
            await drive.complete(
                state=query["state"][0], code="synthetic-code", expected_user_id="owner"
            )
        _, credential = await drive.current_credential(user_id="owner")
        assert credential["subject"] == "subject-a"


@pytest.mark.asyncio
async def test_drive_refresh_90_seconds_early_rotates_once_and_preserves_on_transient(drive):
    drive._post.return_value["expires_in"] = 60
    await drive_connect(drive)
    drive._post.reset_mock()
    drive._post.side_effect = DriveOAuthError("provider_unavailable", status_code=503)
    with pytest.raises(DriveOAuthError, match="provider_unavailable"):
        await drive.current_credential(user_id="owner")
    row = await drive.lifecycle.read(user_id="owner", connector_id="google_drive")
    assert row["credential_version"] == 1 and row["status"] == "verifying"
    drive._post.side_effect = None
    drive._post.return_value.update(refresh_token="rotated-refresh", expires_in=3600)
    _, credential = await drive.current_credential(user_id="owner")
    assert credential["refreshToken"] == "rotated-refresh"
    assert drive._post.await_count == 2
    _, again = await drive.current_credential(user_id="owner")
    assert again == credential
    assert drive._post.await_count == 2


@pytest.mark.asyncio
async def test_drive_grant_rejection_needs_reauth_without_destroying_envelope(drive):
    drive._post.return_value["expires_in"] = 60
    await drive_connect(drive)
    drive._post.side_effect = DriveOAuthError("grant_rejected", status_code=401)
    with pytest.raises(DriveOAuthError, match="grant_rejected"):
        await drive.current_credential(user_id="owner")
    row = await drive.lifecycle.read(user_id="owner", connector_id="google_drive")
    assert row["status"] == "needs_reauth" and row["credential_ciphertext"]
    with pytest.raises(DriveOAuthError, match="reconnect_required"):
        await drive.current_credential(user_id="owner")


@pytest.mark.asyncio
async def test_native_handoff_contains_only_reference_and_requires_original_owner(drive):
    result, query = await drive_start(drive, flow="native")
    handoff = await drive.complete_native(state=query["state"][0], code="synthetic-code")
    assert handoff == {"attemptId": result["attemptId"], "outcome": "ready"}
    row = await drive.lifecycle.read(user_id="owner", connector_id="google_drive")
    assert row["status"] == "revoked" and not row["credential_ciphertext"]
    with pytest.raises(DriveOAuthError, match="attempt_unavailable"):
        await drive.finalize_native(attempt_id=result["attemptId"], user_id="other-owner")
    assert (await drive.finalize_native(attempt_id=result["attemptId"], user_id="owner"))[
        "status"
    ] == "verifying"
    with pytest.raises(DriveOAuthError, match="attempt_unavailable"):
        await drive.finalize_native(attempt_id=result["attemptId"], user_id="owner")


@pytest.mark.asyncio
async def test_disabled_start_stays_closed_but_disconnect_still_works(drive, monkeypatch):
    await drive_connect(drive)
    monkeypatch.setenv("GOOGLE_DRIVE_CONNECTION", "false")
    with pytest.raises(DriveOAuthError, match="connector_unavailable"):
        await drive_start(drive)
    drive._post.side_effect = DriveOAuthError("provider_unavailable", status_code=503)
    result = await drive.disconnect(user_id="owner")
    assert result["status"] == "revoked" and result["revocationOutcome"] == "failed"
    row = await drive.lifecycle.read(user_id="owner", connector_id="google_drive")
    assert row["credential_ciphertext"] is None
    assert row["revocation_outcome"] == "failed"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["client", "registry", "flag", "cohort", "redirect"])
async def test_staged_native_credentials_cannot_activate_after_configuration_or_admission_changes(
    drive, monkeypatch, change
):
    from dataclasses import replace

    result, query = await drive_start(drive, flow="native")
    await drive.complete_native(state=query["state"][0], code="synthetic-code")
    if change == "client":
        monkeypatch.setenv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "rotated-client")
    elif change == "registry":
        drive.registry.get_connector.return_value = None
    elif change == "flag":
        monkeypatch.setenv("GOOGLE_DRIVE_CONNECTION", "false")
    elif change == "cohort":
        monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "different-owner")
    else:
        drive.registry.get_connector.return_value = replace(
            drive.registry.get_connector.return_value, registered_redirect_uris=()
        )
    with pytest.raises(DriveOAuthError):
        await drive.finalize_native(attempt_id=result["attemptId"], user_id="owner")
    row = await drive.lifecycle.read(user_id="owner", connector_id="google_drive")
    assert row["credential_ciphertext"] is None


@pytest.mark.asyncio
async def test_expired_attempt_scrubs_pending_refresh_and_pkce_without_touching_active_grant(drive):
    await drive_connect(drive)
    result, query = await drive_start(drive, flow="native")
    await drive.complete_native(state=query["state"][0], code="synthetic-code")
    sql(
        drive.lifecycle,
        "UPDATE external_connector_oauth_attempts SET expires_at = clock_timestamp() - interval '1 second' WHERE attempt_id = :attempt",
        {"attempt": result["attemptId"]},
    )
    await drive.lifecycle.purge_expired()
    with drive.lifecycle.db.engine.connect() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM external_connector_oauth_attempts WHERE attempt_id = :attempt"),
                {"attempt": result["attemptId"]},
            )
            .mappings()
            .one()
        )
        assert row["pending_credential_ciphertext"] is None
        assert row["code_verifier_ciphertext"] == ""
    current, credential = await drive.current_credential(user_id="owner")
    assert current["connection_generation"] == 1
    assert credential["refreshToken"] == "synthetic-refresh"
