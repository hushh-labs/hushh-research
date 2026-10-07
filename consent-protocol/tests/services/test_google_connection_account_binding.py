"""Google service grants cannot silently move to another provider account."""

import asyncio
import json
import time
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from hushh_mcp.services import google_connector_transition as transition
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.google_connector_transition_store import (
    METADATA_KEY,
    REVOCATIONS_KEY,
    publish_legacy_credential,
)
from hushh_mcp.services.google_oauth_attempt import connection_generation
from hushh_mcp.services.pod_request_signing import VerifiedPod
from tests.google_oauth_test_support import TransactionEngine


class _Db:
    def __init__(self, existing=None, *, accept_connection=True, accept_grant=True, grants=None):
        self.existing = existing
        self.grants = grants or []
        self.accept_connection = accept_connection
        self.accept_grant = accept_grant
        self.calls = []
        self.engine = TransactionEngine(self)

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params))
        if "SELECT * FROM google_provider_connections" in sql:
            return SimpleNamespace(data=[self.existing] if self.existing else [])
        if "SELECT scope_csv FROM google_service_grants" in sql:
            return SimpleNamespace(data=[{"scope_csv": value} for value in self.grants])
        if "INSERT INTO google_provider_connections" in sql:
            return SimpleNamespace(data=[{"user_id": "owner"}] if self.accept_connection else [])
        if "INSERT INTO google_service_grants" in sql:
            return SimpleNamespace(data=[{"user_id": "owner"}] if self.accept_grant else [])
        return SimpleNamespace(data=[])


def _service(monkeypatch, db, *, subject="google-a"):
    service = GoogleConnectionService(db=db)
    monkeypatch.setattr(service, "_userinfo", AsyncMock(return_value={"sub": subject}))
    monkeypatch.setattr(service, "_decrypt", Mock(return_value="synthetic-old-refresh"))
    monkeypatch.setattr(
        service, "_encrypt", Mock(return_value={"ciphertext": "new", "iv": "iv", "tag": "tag"})
    )
    monkeypatch.setattr(service, "status", AsyncMock(return_value={"connected": True}))
    return service


async def _store(service, *, token=None, level="read"):
    return await service._store_authorized_connection(
        user_id="owner",
        token=token
        if token is not None
        else {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"},
        service="calendar",
        requested_scopes=GoogleConnectionService.scopes("calendar", level),
        oauth_started_at=datetime(2026, 9, 22, tzinfo=UTC),
        attempt_id="synthetic-attempt",
        expected_generation=connection_generation(service.db.existing),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("with_refresh", [True, False])
async def test_different_provider_account_never_reuses_or_replaces_existing_connection(
    monkeypatch, with_refresh
):
    db = _Db({"status": "connected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, subject="google-b")
    token = {"access_token": "synthetic-new-access"}
    if with_refresh:
        token["refresh_token"] = "synthetic-new-refresh"
    with pytest.raises(GoogleConnectionError) as error:
        await _store(service, token=token)
    assert error.value.status_code == 409
    service._decrypt.assert_not_called()
    service._encrypt.assert_not_called()
    assert not any("INSERT" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
async def test_verified_same_account_can_reuse_its_refresh_token(monkeypatch):
    db = _Db(
        {
            "status": "connected",
            "provider_subject": "google-a",
            "refresh_token_ciphertext": "old",
            "refresh_token_iv": "iv",
        }
    )
    service = _service(monkeypatch, db)
    await _store(service, token={"access_token": "synthetic-access"})
    service._decrypt.assert_called_once()
    assert service._encrypt.call_args_list[0].args == ("synthetic-old-refresh",)


@pytest.mark.asyncio
async def test_new_google_service_cannot_invalidate_existing_service_grant(monkeypatch):
    db = _Db(
        {
            "status": "connected",
            "provider_subject": "google-a",
            "refresh_token_ciphertext": "old",
            "refresh_token_iv": "iv",
        },
        grants=["https://www.googleapis.com/auth/calendar.events.readonly"],
    )
    service = _service(monkeypatch, db)
    with pytest.raises(GoogleConnectionError, match="existing Google permissions"):
        await _store(
            service,
            token={
                "access_token": "synthetic-access",
                "scope": "https://www.googleapis.com/auth/calendar.freebusy",
            },
        )
    service._encrypt.assert_not_called()
    assert not any("INSERT" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("subject", ["google-a", "google-b"])
async def test_disconnected_account_requires_fresh_refresh_token(monkeypatch, subject):
    db = _Db({"status": "disconnected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, subject=subject)
    with pytest.raises(GoogleConnectionError, match="refresh token"):
        await _store(service, token={"access_token": "synthetic-access"})
    service._decrypt.assert_not_called()
    assert not any("INSERT" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
async def test_explicitly_disconnected_account_can_connect_a_new_subject(monkeypatch):
    db = _Db({"status": "disconnected", "provider_subject": "google-a"})
    service = _service(monkeypatch, db, subject="google-b")
    assert await _store(service) == {"connected": True}
    service._decrypt.assert_not_called()
    writes = [(sql, params) for sql, params in db.calls if "INSERT" in sql]
    assert all(params["subject"] == "google-b" for _, params in writes)
    assert "provider_subject = EXCLUDED.provider_subject" in writes[0][0]
    assert "access_token_ciphertext = :access_ciphertext" in writes[1][0]


@pytest.mark.asyncio
async def test_missing_verified_subject_fails_before_credential_read(monkeypatch):
    db = _Db()
    service = _service(monkeypatch, db, subject="")
    with pytest.raises(GoogleConnectionError, match="could not be verified"):
        await _store(service)
    assert db.calls == []


@pytest.mark.asyncio
async def test_active_legacy_row_without_subject_requires_reconnection(monkeypatch):
    db = _Db({"status": "connected", "provider_subject": None})
    service = _service(monkeypatch, db)
    with pytest.raises(GoogleConnectionError) as error:
        await _store(service)
    assert error.value.status_code == 409
    service._encrypt.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("level", ["read", "manage"])
async def test_complete_read_and_manage_permissions_remain_supported(monkeypatch, level):
    service = _service(monkeypatch, _Db())
    assert await _store(service, level=level) == {"connected": True}


class _TransitionDb:
    def __init__(self, *, legacy=True):
        self.registry = {
            "user_id": "owner",
            "hushh_id": "hushh-owner",
            "status": "provisioned",
            "deployment_target": "user_azure",
            "pod_key_id": "pod-key",
            "pod_signing_key_id": "pods_fixture",
            "placement_epoch": 0,
            "backend_metadata": {},
        }
        self.legacy = {
            family: (
                {
                    "user_id": "owner",
                    "status": "connected",
                    "provider_subject": "123456",
                    "google_sub": "123456",
                    "refresh_token_ciphertext": family + "-encrypted",
                    "connected_at": 1,
                }
                if legacy
                else None
            )
            for family in ("google_provider_connections", "kai_gmail_connections")
        }
        self.calls = []
        self.engine = TransactionEngine(self)

    def execute_raw(self, sql, params=None):
        self.calls.append((sql, params))
        sql = sql.strip()
        rows = []
        if sql.startswith("SELECT") and "FROM personal_agent_registry" in sql:
            rows = [self.registry] if self.registry else []
        elif sql.startswith("SELECT") and "FROM google_service_grants" in sql:
            rows = [] if "SELECT 1" in sql else [{"service": "calendar"}]
        elif sql.startswith("UPDATE personal_agent_registry"):
            key = REVOCATIONS_KEY if "'{googleLegacyRevocations}'" in sql else METADATA_KEY
            self.registry["backend_metadata"][key] = json.loads(params["state"])
        else:
            for family, row in self.legacy.items():
                if sql.startswith("SELECT * FROM " + family):
                    rows = [row] if row else []
                elif sql.startswith("UPDATE " + family) and row:
                    row["status"] = "disconnected"
                    if "SET refresh_token_ciphertext=NULL" in sql:
                        for field in ("refresh_token_ciphertext", "access_token_ciphertext"):
                            row[field] = None
                elif sql.startswith("DELETE FROM " + family) and row:
                    self.legacy[family] = None
        return SimpleNamespace(data=rows)


@pytest.fixture
def custody_transition(monkeypatch):
    from hushh_mcp.services import gmail_receipts_service, google_connection_service

    monkeypatch.setenv(
        "GOOGLE_IOS_CONNECTOR_CLIENT_ID", "123456789012-abcdefghijklmnop.apps.googleusercontent.com"
    )
    google = SimpleNamespace(
        refresh_token_for_erasure=lambda row, **_: row["refresh_token_ciphertext"]
    )
    gmail = SimpleNamespace(_decrypt_token=lambda ciphertext, *_: ciphertext)
    monkeypatch.setattr(google_connection_service, "get_google_connection_service", lambda: google)
    monkeypatch.setattr(gmail_receipts_service, "get_gmail_receipts_service", lambda: gmail)
    db = _TransitionDb()
    return db, transition.GoogleConnectorTransitionService(db=db, clock=lambda: 10)


def _transition_mutation(receipt, **changes):
    return transition.TransitionMutation(
        operation="admit",
        transition=receipt,
        connectorId="gmail",
        credentialId="11111111-2222-4333-8444-555555555555",
        clientProfile="hussh_ios",
        podKeyId="pod-key",
        issuedAtMs=10_001,
        epoch=0,
        **changes,
    )


async def test_legacy_transition_requires_exact_confirmation_before_any_mutation(
    custody_transition,
):
    db, service = custody_transition
    provider = AsyncMock()
    assert await service.prepare(
        owner="owner", profile="hussh_ios", confirmed=False, post=provider
    ) == {
        "status": "confirmation_required",
        "services": ["calendar", "gmail"],
        "scope": "all_google_project_grants",
    }
    provider.assert_not_awaited()
    assert not any(sql.startswith(("UPDATE", "DELETE")) for sql, _ in db.calls)


async def test_a_new_owner_gets_a_noop_transition_without_a_revoke_warning(custody_transition):
    _, configured = custody_transition
    db = _TransitionDb(legacy=False)
    service = transition.GoogleConnectorTransitionService(db=db, clock=configured._clock)
    provider = AsyncMock()
    result = await service.prepare(
        owner="owner", profile="hussh_ios", confirmed=False, post=provider
    )
    assert result["status"] == "ready" and set(result["transition"]) == {"id", "nonce"}
    provider.assert_not_awaited()


@pytest.mark.parametrize("changed", ["pod_key_id", "pod_signing_key_id", "placement_epoch"])
async def test_prepare_rechecks_pod_incarnation_after_provider_await(custody_transition, changed):
    db, service = custody_transition

    async def provider(_url, _form):
        db.registry[changed] = 1 if changed == "placement_epoch" else "replacement-key"
        return 200, {}

    with pytest.raises(transition.TransitionRefused) as refusal:
        await service.prepare(owner="owner", profile="hussh_ios", confirmed=True, post=provider)
    assert refusal.value.code == "GOOGLE_TRANSITION_CONNECTION_CHANGED"
    assert db.registry["backend_metadata"][METADATA_KEY]["phase"] != "ready"


async def test_unreadable_legacy_token_retains_envelopes_and_blocks_fresh_authorization(
    custody_transition, monkeypatch
):
    from hushh_mcp.services import google_connection_service

    db, service = custody_transition

    def unreadable(*args, **kwargs):
        raise ValueError("synthetic sensitive diagnostics")

    monkeypatch.setattr(
        google_connection_service,
        "get_google_connection_service",
        lambda: SimpleNamespace(refresh_token_for_erasure=unreadable),
    )
    provider = AsyncMock()
    with pytest.raises(transition.TransitionRefused) as refusal:
        await service.prepare(owner="owner", profile="hussh_ios", confirmed=True, post=provider)
    assert refusal.value.code == "GOOGLE_TRANSITION_PROVIDER_UNCONFIRMED"
    assert db.registry["backend_metadata"][METADATA_KEY]["phase"] == "blocked"
    assert all(db.legacy.values())
    provider.assert_not_awaited()


@pytest.mark.parametrize("family", ["google_provider_connections", "kai_gmail_connections"])
async def test_prepare_cannot_open_fresh_authorization_during_an_actual_legacy_revoke(
    custody_transition, monkeypatch, family
):
    from hushh_mcp.services import owner_placement_guard, pod_google_oauth
    from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService

    db, service = custody_transition
    service._clock = time.time
    db.registry["deployment_target"] = "shared"
    started, finish = asyncio.Event(), asyncio.Event()

    async def placement(_owner):
        return db.registry["deployment_target"]

    monkeypatch.setattr(owner_placement_guard, "get_owner_hosting_mode", placement)

    async def legacy_provider(*args, **kwargs):
        started.set()
        await finish.wait()
        return 503, {}

    monkeypatch.setattr(pod_google_oauth, "http_post", legacy_provider)

    if family == "google_provider_connections":
        legacy = GoogleConnectionService(db=db)
        legacy._decrypt = lambda envelope, **_: envelope["ciphertext"]
        legacy.status = AsyncMock(return_value={"connected": False})
        task = asyncio.create_task(legacy.disconnect_service(user_id="owner", service="calendar"))
    else:
        legacy = GmailReceiptsService()
        legacy._db = db
        legacy._fetch_connection_row = lambda **_: dict(db.legacy[family])
        legacy._decrypt_token = lambda ciphertext, *_: ciphertext
        legacy.get_status = AsyncMock(return_value={"connected": False})
        task = asyncio.create_task(legacy.disconnect(user_id="owner"))
    try:
        await asyncio.wait_for(started.wait(), 2)
        db.registry["deployment_target"] = "user_azure"
        assert db.legacy[family]["status"] == "disconnected"
        assert db.legacy[family]["refresh_token_ciphertext"], "the last recovery envelope survives"
        prepare_provider = AsyncMock(return_value=(200, {}))
        with pytest.raises(transition.TransitionRefused) as refusal:
            await service.prepare(
                owner="owner", profile="hussh_ios", confirmed=True, post=prepare_provider
            )
        assert refusal.value.code == "GOOGLE_TRANSITION_BUSY"
        prepare_provider.assert_not_awaited()
    finally:
        finish.set()
        await task
    assert db.registry["backend_metadata"][REVOCATIONS_KEY][family]["phase"] == "unconfirmed"
    warning = await service.prepare(
        owner="owner", profile="hussh_ios", confirmed=False, post=prepare_provider
    )
    assert warning["status"] == "confirmation_required"
    prepare_provider.assert_not_awaited()
    recovered = await service.prepare(
        owner="owner", profile="hussh_ios", confirmed=True, post=prepare_provider
    )
    assert recovered["status"] == "ready" and db.registry["backend_metadata"][REVOCATIONS_KEY] == {}


async def test_expired_pending_revoke_requires_retained_material_and_provider_confirmation(
    custody_transition,
):
    from hushh_mcp.services.google_connector_transition_store import begin_legacy_revocation

    db, service = custody_transition
    with db.engine.begin() as connection:
        begin_legacy_revocation(
            connection,
            owner="owner",
            family="google_provider_connections",
            row=db.legacy["google_provider_connections"],
        )
    db.registry["backend_metadata"][REVOCATIONS_KEY]["google_provider_connections"][
        "expiresAtMs"
    ] = 1
    provider = AsyncMock(return_value=(503, {}))
    assert (
        await service.prepare(owner="owner", profile="hussh_ios", confirmed=False, post=provider)
    )["status"] == "confirmation_required"
    provider.assert_not_awaited()
    with pytest.raises(transition.TransitionRefused) as refusal:
        await service.prepare(owner="owner", profile="hussh_ios", confirmed=True, post=provider)
    assert refusal.value.code == "GOOGLE_TRANSITION_PROVIDER_UNCONFIRMED"
    assert db.legacy["google_provider_connections"]["refresh_token_ciphertext"]
    assert db.registry["backend_metadata"][METADATA_KEY]["phase"] == "blocked"


async def test_absent_registry_never_creates_assignment_or_discards_recovery_envelope(
    custody_transition,
):
    from hushh_mcp.services.google_connector_transition_store import (
        begin_legacy_revocation,
        finish_legacy_revocation,
    )

    db, _ = custody_transition
    db.registry = None
    row = db.legacy["google_provider_connections"]
    with db.engine.begin() as connection:
        claim = begin_legacy_revocation(
            connection, owner="owner", family="google_provider_connections", row=row
        )
        row["status"] = "disconnected"
    finish_legacy_revocation(
        db, owner="owner", family="google_provider_connections", claim=claim, confirmed=False
    )
    assert db.registry is None and row["refresh_token_ciphertext"]
    assert not any(
        "personal_agent_registry" in sql and sql.startswith(("INSERT", "UPDATE"))
        for sql, _ in db.calls
    )
    with pytest.raises(GoogleConnectionError):
        publish_legacy_credential(
            db,
            "INSERT INTO google_provider_connections VALUES (:user_id)",
            {"user_id": "owner"},
            owner="owner",
        )
    assert not any(sql.startswith("INSERT") for sql, _ in db.calls)
    finish_legacy_revocation(
        db, owner="owner", family="google_provider_connections", claim=claim, confirmed=True
    )
    assert row["refresh_token_ciphertext"] is None


@pytest.mark.parametrize(
    "provider_status,body", [(302, {"status": "redirected"}), (503, {"error": "invalid_token"})]
)
async def test_gmail_revoke_redirect_retains_recovery_and_blocks_fresh_admission(
    custody_transition, monkeypatch, provider_status, body
):
    from hushh_mcp.services import owner_placement_guard, pod_google_oauth
    from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService

    db, service = custody_transition
    db.registry["deployment_target"] = "shared"
    requests = []

    def provider(request):
        requests.append(request)
        assert str(request.url) == pod_google_oauth.REVOKE_URL
        return httpx.Response(
            provider_status,
            headers={"Location": "https://accounts.google.com/signin"},
            json=body,
        )

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(provider)
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs)
    )

    async def shared(_owner):
        return "shared"

    monkeypatch.setattr(owner_placement_guard, "get_owner_hosting_mode", shared)
    legacy = GmailReceiptsService()
    legacy._db = db
    legacy._fetch_connection_row = lambda **_: dict(db.legacy["kai_gmail_connections"])
    legacy._decrypt_token = lambda ciphertext, *_: ciphertext
    legacy.get_status = AsyncMock(return_value={"connected": False})
    await legacy.disconnect(user_id="owner")
    assert db.legacy["kai_gmail_connections"]["refresh_token_ciphertext"]
    assert (
        db.registry["backend_metadata"][REVOCATIONS_KEY]["kai_gmail_connections"]["phase"]
        == "unconfirmed"
    )
    assert len(requests) == 1, "authentication redirects are never followed"
    db.registry["deployment_target"] = "user_azure"
    with pytest.raises(transition.TransitionRefused) as refusal:
        await service.prepare(owner="owner", profile="hussh_ios", confirmed=True)
    assert refusal.value.code == "GOOGLE_TRANSITION_PROVIDER_UNCONFIRMED"
    assert db.registry["backend_metadata"][METADATA_KEY]["phase"] == "blocked"


@pytest.mark.parametrize("provider_status", [200, 503])
async def test_legacy_readers_are_fenced_before_revoke_and_outage_keeps_existing_envelopes(
    custody_transition, provider_status
):
    db, service = custody_transition

    async def revoke(_url, form):
        assert all(row["status"] == "disconnected" for row in db.legacy.values())
        assert form["token"].endswith("-encrypted")
        return provider_status, {}

    if provider_status == 503:
        with pytest.raises(transition.TransitionRefused) as error:
            await service.prepare(owner="owner", profile="hussh_ios", confirmed=True, post=revoke)
        assert error.value.code == "GOOGLE_TRANSITION_PROVIDER_UNCONFIRMED"
        assert db.registry["backend_metadata"][METADATA_KEY]["phase"] == "blocked"
    else:
        assert (
            await service.prepare(owner="owner", profile="hussh_ios", confirmed=True, post=revoke)
        )["status"] == "ready"
    assert all(row["refresh_token_ciphertext"] for row in db.legacy.values())


async def test_verified_pod_connection_cleanup_never_revokes_fresh_google_grants(
    custody_transition,
):
    db, service = custody_transition
    provider = AsyncMock(return_value=(200, {}))
    ready = await service.prepare(owner="owner", profile="hussh_ios", confirmed=True, post=provider)
    principal = VerifiedPod("hushh-owner", key_id="pods_fixture")
    body = _transition_mutation(ready["transition"])
    admitted = await service.mutate(principal, body)
    assert admitted["status"] == "admitted" and len(admitted["reauthAccounts"]) == 2
    assert all(db.legacy.values()), "admission alone is no proof of a pod login"
    completed = body.model_copy(update={"operation": "complete"})
    assert await service.mutate(principal, completed) == {"status": "completed"}
    assert await service.mutate(principal, completed) == {"status": "completed"}
    assert all(row is None for row in db.legacy.values())
    assert provider.await_count == 2, "only the preparation revoked legacy tokens"
    state = json.dumps(db.registry["backend_metadata"])
    assert (
        "-encrypted" not in state
        and "123456" not in state
        and ready["transition"]["nonce"] not in state
    )


@pytest.mark.parametrize("failure", ["nonce", "profile", "key", "epoch", "cutoff", "expiry"])
async def test_transition_admission_rejects_changed_authority_and_replay(
    custody_transition, failure
):
    db, service = custody_transition
    ready = await service.prepare(
        owner="owner", profile="hussh_ios", confirmed=True, post=AsyncMock(return_value=(200, {}))
    )
    principal = VerifiedPod("hushh-owner", key_id="pods_fixture")
    body = _transition_mutation(ready["transition"])
    if failure == "nonce":
        body = body.model_copy(
            update={
                "transition": transition.TransitionReceipt(id=body.transition.id, nonce="z" * 43)
            }
        )
    elif failure == "profile":
        body = body.model_copy(update={"clientProfile": "hussh_android"})
    elif failure == "key":
        principal = replace(principal, key_id="another-key")
    elif failure == "epoch":
        db.registry["placement_epoch"] = 1
    elif failure == "cutoff":
        body = body.model_copy(update={"issuedAtMs": 9999})
    else:
        service._clock = lambda: 700
    with pytest.raises(transition.TransitionRefused):
        await service.mutate(principal, body)
    assert all(db.legacy.values())


async def test_cleanup_preserves_a_concurrent_replacement_hub_login(custody_transition):
    db, service = custody_transition
    ready = await service.prepare(
        owner="owner", profile="hussh_ios", confirmed=True, post=AsyncMock(return_value=(200, {}))
    )
    principal = VerifiedPod("hushh-owner", key_id="pods_fixture")
    body = _transition_mutation(ready["transition"])
    await service.mutate(principal, body)
    db.legacy["kai_gmail_connections"].update(
        {"status": "connected", "refresh_token_ciphertext": "replacement-encrypted"}
    )
    with pytest.raises(transition.TransitionRefused):
        await service.mutate(principal, body.model_copy(update={"operation": "complete"}))
    assert db.legacy["kai_gmail_connections"]["refresh_token_ciphertext"] == "replacement-encrypted"


async def test_prepare_retry_after_authorization_begins_never_revokes_an_old_snapshot_again(
    custody_transition,
):
    db, service = custody_transition
    provider = AsyncMock(return_value=(200, {}))
    first = await service.prepare(owner="owner", profile="hussh_ios", confirmed=True, post=provider)
    await service.mutate(
        VerifiedPod("hushh-owner", key_id="pods_fixture"), _transition_mutation(first["transition"])
    )
    second = await service.prepare(
        owner="owner", profile="hussh_ios", confirmed=False, post=provider
    )
    assert second["status"] == "ready" and provider.await_count == 2
    with pytest.raises(transition.TransitionRefused):
        await service.mutate(
            VerifiedPod("hushh-owner", key_id="pods_fixture"),
            _transition_mutation(first["transition"]),
        )


def test_legacy_callback_cannot_publish_after_transition(custody_transition):
    db, _ = custody_transition
    db.registry["backend_metadata"][METADATA_KEY] = {"phase": "ready"}
    with pytest.raises(GoogleConnectionError):
        publish_legacy_credential(
            db,
            "INSERT INTO kai_gmail_connections VALUES (:user_id)",
            {"user_id": "owner"},
            owner="owner",
        )
    assert not any(sql.startswith("INSERT") for sql, _ in db.calls)


@pytest.mark.asyncio
async def test_declined_service_scopes_do_not_create_connection_or_grant(monkeypatch):
    db = _Db()
    service = _service(monkeypatch, db)
    with pytest.raises(GoogleConnectionError) as error:
        await _store(
            service,
            token={
                "access_token": "synthetic-access",
                "refresh_token": "synthetic-refresh",
                "scope": "openid email",
            },
        )
    assert error.value.status_code == 403
    assert not any("INSERT" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["connection", "grant"])
async def test_concurrent_replacement_refuses_stale_callback(monkeypatch, boundary):
    db = _Db(accept_connection=boundary != "connection", accept_grant=boundary != "grant")
    service = _service(monkeypatch, db)
    with pytest.raises(GoogleConnectionError) as error:
        await _store(service)
    assert error.value.status_code == 409
    service.status.assert_not_called()
    if boundary == "connection":
        assert not any("INSERT INTO google_service_grants" in sql for sql, _ in db.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("admitted", [True, False])
async def test_cached_bearer_is_admitted_against_one_provider_grant_snapshot(monkeypatch, admitted):
    class SnapshotDb:
        def __init__(self):
            self.calls = []

        def execute_raw(self, sql, params):
            self.calls.append((sql, params))
            if "google_provider_connections" in sql:
                return SimpleNamespace(
                    data=[
                        {
                            "status": "connected",
                            "provider_subject": "google-a",
                            "access_token_expires_at": "2999-01-01T00:00:00+00:00",
                            "access_token_ciphertext": "account-a-ciphertext",
                            "access_token_iv": "iv",
                            "service_status": "connected" if admitted else "disconnected",
                            "service_access_level": "read",
                            "service_scope_csv": " ".join(
                                GoogleConnectionService.scopes("calendar", "read")
                            ),
                        }
                    ]
                )
            # A separate read would see a replacement account's valid grant.
            # The old two-query implementation would wrongly admit A's token.
            return SimpleNamespace(
                data=[
                    {
                        "status": "connected",
                        "access_level": "read",
                        "scope_csv": " ".join(GoogleConnectionService.scopes("calendar", "read")),
                    }
                ]
            )

    db = SnapshotDb()
    service = _service(monkeypatch, db)
    if admitted:
        assert (
            await service.access_token(user_id="owner", service="calendar", access_level="read")
            == "synthetic-old-refresh"
        )
        service._decrypt.assert_called_once_with(
            {"ciphertext": "account-a-ciphertext", "iv": "iv"}, aad="google-connection:owner"
        )
    else:
        with pytest.raises(GoogleConnectionError) as error:
            await service.access_token(user_id="owner", service="calendar", access_level="read")
        assert error.value.status_code == 403
        service._decrypt.assert_not_called()
    assert len(db.calls) == 1
    assert "LEFT JOIN google_service_grants" in db.calls[0][0]
    assert db.calls[0][1] == {"user_id": "owner", "service": "calendar"}
