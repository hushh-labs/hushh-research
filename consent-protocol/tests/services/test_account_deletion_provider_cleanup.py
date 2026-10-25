"""Provider-side grant release for a committed account deletion."""

from __future__ import annotations

import asyncio
import copy
import hashlib
from contextlib import asynccontextmanager, contextmanager
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import httpx
import pytest

from hushh_mcp.services import account_deletion_provider_cleanup as cleanup
from hushh_mcp.services import pod_google_oauth
from hushh_mcp.services.account_deletion_provider_cleanup import (
    ProviderCredentialSnapshot,
    release_provider_grants_after_erasure,
    snapshot_provider_credentials_in_transaction,
)
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService
from hushh_mcp.services.google_connection_service import GoogleConnectionService

_KEY = b"k" * 32
pytestmark = [pytest.mark.feature_account_deletion, pytest.mark.trace_loop]


def _snapshot(**rows) -> ProviderCredentialSnapshot:
    return ProviderCredentialSnapshot(
        user_id="uid_1", rows={source: tuple(value) for source, value in rows.items()}
    )


def _conn_returning(rows_by_table: dict[str, list[dict]]):
    conn = MagicMock()

    def execute(statement, params):
        sql = str(statement)
        table = next(name for name in rows_by_table if f"FROM {name} " in sql)
        result = MagicMock()
        result.mappings.return_value = [{"row": row} for row in rows_by_table[table]]
        return result

    conn.execute.side_effect = execute
    return conn


def test_snapshot_reads_only_the_owner_rows_under_a_savepoint():
    conn = _conn_returning(
        {
            "google_provider_connections": [{"refresh_token_ciphertext": "c1"}],
            "google_calendar_additional_accounts": [
                {"account_id": "calendar-second", "refresh_token_ciphertext": "c2"}
            ],
            "kai_gmail_connections": [],
            "user_external_connector_connections": [{"connector_id": "google_drive"}],
        }
    )

    snapshot = snapshot_provider_credentials_in_transaction(
        conn, user_id="uid_1", table_exists=lambda _table: True
    )

    conn.begin_nested.assert_called_once()
    assert snapshot.collection_failed is False
    assert snapshot.rows["google_connection"] == ({"refresh_token_ciphertext": "c1"},)
    assert snapshot.rows["calendar_additional"] == (
        {"account_id": "calendar-second", "refresh_token_ciphertext": "c2"},
    )
    assert snapshot.rows["external_connector"] == ({"connector_id": "google_drive"},)
    assert all(call.args[1] == {"user_id": "uid_1"} for call in conn.execute.call_args_list)
    assert "c1" not in repr(snapshot)
    assert "c2" not in repr(snapshot)


def test_snapshot_skips_absent_tables_and_never_raises():
    conn = MagicMock()
    conn.execute.side_effect = RuntimeError("column missing")

    assert snapshot_provider_credentials_in_transaction(
        conn, user_id="uid_1", table_exists=lambda _table: False
    ).is_empty
    failed = snapshot_provider_credentials_in_transaction(
        conn, user_id="uid_1", table_exists=lambda _table: True
    )
    assert failed.collection_failed is True


async def test_release_without_grants_makes_no_provider_calls(monkeypatch):
    revoke = AsyncMock()
    monkeypatch.setattr(cleanup, "revoke_google_oauth_token", revoke)

    assert await release_provider_grants_after_erasure(_snapshot()) == {
        "status": "no_provider_grants"
    }
    assert await release_provider_grants_after_erasure(
        ProviderCredentialSnapshot(user_id="uid_1", collection_failed=True)
    ) == {"status": "snapshot_failed"}
    revoke.assert_not_awaited()


@pytest.mark.parametrize(
    "status,body,expected",
    [
        (200, {}, "revoked"),
        (400, {"error": "invalid_token"}, "token_absent"),
        (400, {"error": "invalid_request"}, "failed"),
        (400, "unreadable", "failed"),
        (302, {}, "failed"),
        (503, {"error": "invalid_token"}, "failed"),
    ],
)
async def test_revocation_distinguishes_grant_confirmation_from_absent_token(
    monkeypatch, status, body, expected
):
    def reply(request):
        assert request.url == cleanup.GOOGLE_OAUTH_REVOKE_URL
        return httpx.Response(status, json=body)

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(reply), **kwargs),
    )
    assert await cleanup.revoke_google_oauth_token("synthetic-token") == expected


async def test_release_revokes_google_and_verified_drive_grants_only(monkeypatch):
    revoke = AsyncMock(return_value="revoked")
    monkeypatch.setattr(cleanup, "revoke_google_oauth_token", revoke)
    google = MagicMock()
    google.refresh_token_for_erasure.return_value = "google-refresh"
    monkeypatch.setattr(
        "hushh_mcp.services.google_connection_service.get_google_connection_service",
        lambda: google,
    )
    credentials = MagicMock()
    credentials.open_credential.return_value = {"refreshToken": "drive-refresh"}
    monkeypatch.setattr(
        "hushh_mcp.services.external_connector_credentials_service."
        "get_external_connector_credentials_service",
        lambda: credentials,
    )

    outcome = await release_provider_grants_after_erasure(
        _snapshot(
            google_connection=[{"refresh_token_ciphertext": "c"}],
            external_connector=[
                {
                    "connector_id": "google_drive",
                    "envelope_version": 2,
                    "credential_ciphertext": "x",
                },
                {
                    "connector_id": "google_drive",
                    "envelope_version": 1,
                    "credential_ciphertext": "x",
                },
                {"connector_id": "hubspot", "envelope_version": 2, "credential_ciphertext": "x"},
            ],
        )
    )

    assert outcome["status"] == "attempted"
    assert outcome["google_connection"] == ["revoked"]
    assert outcome["external_connectors"] == ["revoked", "not_applicable", "not_applicable"]
    assert sorted(call.args[0] for call in revoke.await_args_list) == [
        "drive-refresh",
        "google-refresh",
    ]
    credentials.open_credential.assert_called_once()


async def test_release_is_bounded_and_never_raises(monkeypatch):
    async def hang(_snapshot):
        await asyncio.sleep(60)

    async def boom(_snapshot):
        raise RuntimeError("provider down")

    monkeypatch.setattr(cleanup, "_release_google_connections", hang)
    assert await release_provider_grants_after_erasure(
        _snapshot(google_connection=[{"x": 1}]), timeout_seconds=0.05
    ) == {"status": "timed_out"}

    monkeypatch.setattr(cleanup, "_release_google_connections", boom)
    outcome = await release_provider_grants_after_erasure(_snapshot(google_connection=[{"x": 1}]))
    assert outcome["google_connection"] == "failed"


def test_google_refresh_token_for_erasure_decrypts_only_its_own_envelope(monkeypatch):
    service = GoogleConnectionService(db=MagicMock())
    monkeypatch.setattr(service, "_token_key", lambda: _KEY)
    envelope = service._encrypt("refresh-secret", aad="google-connection:uid_1")
    row = {"refresh_token_ciphertext": envelope["ciphertext"], "refresh_token_iv": envelope["iv"]}

    assert service.refresh_token_for_erasure(row, user_id="uid_1") == "refresh-secret"
    assert service.refresh_token_for_erasure(row, user_id="someone_else") is None
    assert service.refresh_token_for_erasure({}, user_id="uid_1") is None


def _gmail_row(service: GmailReceiptsService, *, access_expires_in: timedelta, watch_status: str):
    refresh = service._encrypt_token("gmail-refresh")
    access = service._encrypt_token("gmail-access")
    return {
        "refresh_token_ciphertext": refresh["ciphertext"],
        "refresh_token_iv": refresh["iv"],
        "refresh_token_tag": refresh["tag"],
        "access_token_ciphertext": access["ciphertext"],
        "access_token_iv": access["iv"],
        "access_token_tag": access["tag"],
        "access_token_expires_at": (datetime.now(UTC) + access_expires_in).isoformat(),
        "watch_status": watch_status,
        "watch_expiration_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
    }


@pytest.fixture
def gmail(monkeypatch) -> GmailReceiptsService:
    service = GmailReceiptsService()
    monkeypatch.setattr(service, "_token_key", lambda: _KEY)
    return service


async def test_gmail_erasure_stops_a_live_watch_before_revoking(gmail, monkeypatch):
    order: list[str] = []
    post_json = AsyncMock(side_effect=lambda url, **_: order.append(url) or {})
    post_form = AsyncMock(side_effect=lambda url, data: (order.append(url) or 200, {}))
    monkeypatch.setattr(gmail, "_http_post_json", post_json)
    monkeypatch.setattr(pod_google_oauth, "http_post", post_form)

    outcome = await gmail.stop_watch_and_revoke_for_erasure(
        _gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="active")
    )

    assert outcome == {"gmail_watch": "stopped", "gmail_grant": "revoked"}
    assert order == [
        "https://gmail.googleapis.com/gmail/v1/users/me/stop",
        "https://oauth2.googleapis.com/revoke",
    ]
    assert post_json.await_args.kwargs["token"] == "gmail-access"
    assert post_form.await_args.args[1] == {"token": "gmail-refresh"}


@pytest.mark.parametrize("watch_failed", [False, True])
async def test_durable_cleanup_watch_step_never_revokes_even_after_failure(
    gmail, monkeypatch, watch_failed
):
    post = AsyncMock(
        side_effect=RuntimeError("synthetic provider failure") if watch_failed else None,
        return_value={},
    )
    revoke = AsyncMock()
    monkeypatch.setattr(gmail, "_http_post_json", post)
    monkeypatch.setattr(gmail, "_revoke_refresh_token", revoke)
    row = {
        **_gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="active"),
        "user_id": "synthetic-owner",
    }
    if watch_failed:
        with pytest.raises(RuntimeError, match="synthetic provider failure"):
            await gmail.stop_watch_for_account_cleanup(row, user_id="synthetic-owner")
    else:
        assert (
            await gmail.stop_watch_for_account_cleanup(row, user_id="synthetic-owner") == "stopped"
        )
    revoke.assert_not_awaited()
    post.assert_awaited_once()


async def test_durable_cleanup_watch_refuses_wrong_owner_or_unreadable_custody(gmail, monkeypatch):
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    post = AsyncMock()
    monkeypatch.setattr(gmail, "_http_post_json", post)
    row = {
        **_gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="active"),
        "user_id": "synthetic-owner",
    }
    with pytest.raises(GmailApiError):
        await gmail.stop_watch_for_account_cleanup(row, user_id="another-owner")
    with pytest.raises(GmailApiError):
        await gmail.stop_watch_for_account_cleanup(
            {**row, "refresh_token_ciphertext": "tampered"}, user_id="synthetic-owner"
        )
    post.assert_not_awaited()


async def test_gmail_erasure_refreshes_an_expired_access_token_for_stop(gmail, monkeypatch):
    refresh = AsyncMock(return_value={"access_token": "fresh-access"})
    post_json = AsyncMock(return_value={})
    monkeypatch.setattr(gmail, "_refresh_access_token", refresh)
    monkeypatch.setattr(gmail, "_http_post_json", post_json)
    monkeypatch.setattr(pod_google_oauth, "http_post", AsyncMock(return_value=(200, {})))

    outcome = await gmail.stop_watch_and_revoke_for_erasure(
        _gmail_row(gmail, access_expires_in=timedelta(minutes=-5), watch_status="active")
    )

    refresh.assert_awaited_once_with(refresh_token="gmail-refresh")  # noqa: S106
    assert post_json.await_args.kwargs["token"] == "fresh-access"
    assert outcome["gmail_watch"] == "stopped"


@pytest.mark.parametrize("status,body", [(302, {}), (503, {"error": "invalid_token"})])
async def test_gmail_erasure_reports_failures_without_raising(gmail, monkeypatch, status, body):
    requests = []

    def provider(request):
        requests.append(request)
        return httpx.Response(
            status, headers={"Location": "https://accounts.google.com/signin"}, json=body
        )

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(provider)
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: original_client(transport=transport, **kwargs)
    )

    outcome = await gmail.stop_watch_and_revoke_for_erasure(
        _gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="active")
    )

    assert outcome == {"gmail_watch": "failed", "gmail_grant": "failed"}
    assert len(requests) == 2, "a watch redirect and grant failure never count as cleanup"


async def test_gmail_erasure_skips_stop_when_no_watch_is_live(gmail, monkeypatch):
    post_json = AsyncMock()
    monkeypatch.setattr(gmail, "_http_post_json", post_json)
    monkeypatch.setattr(pod_google_oauth, "http_post", AsyncMock(return_value=(200, {})))
    row = _gmail_row(gmail, access_expires_in=timedelta(minutes=30), watch_status="expired")
    row["watch_expiration_at"] = (datetime.now(UTC) - timedelta(days=1)).isoformat()

    outcome = await gmail.stop_watch_and_revoke_for_erasure(row)

    post_json.assert_not_awaited()
    assert outcome == {"gmail_watch": "not_active", "gmail_grant": "revoked"}


# --- curated providers that publish a revocation endpoint (Notion) ---------------


@pytest.fixture
def notion(monkeypatch):
    from hushh_mcp.services import external_connector_curated_oauth as curated

    post = AsyncMock()
    monkeypatch.setattr(curated, "post_revocation", post)
    monkeypatch.setenv("NOTION_OAUTH_CLIENT_ID", "client-1")
    credentials = MagicMock()
    credentials.open_credential.return_value = {
        "refreshToken": "notion-refresh",
        "accessToken": "notion-access",
        "oauthClientId": "client-1",
    }
    monkeypatch.setattr(
        "hushh_mcp.services.external_connector_credentials_service."
        "get_external_connector_credentials_service",
        lambda: credentials,
    )
    return SimpleNamespace(post=post, credentials=credentials)


def _notion_row(**overrides):
    return {
        "connector_id": "notion",
        "envelope_version": 2,
        "credential_ciphertext": "x",
        **overrides,
    }


async def _release(*rows):
    outcome = await release_provider_grants_after_erasure(_snapshot(external_connector=list(rows)))
    return outcome["external_connectors"]


async def test_deletion_revokes_a_notion_grant_at_the_provider(notion):
    assert await _release(_notion_row()) == ["revoked"]
    notion.post.assert_awaited_once_with(
        url="https://mcp.notion.com/token",
        data={
            "token": "notion-refresh",
            "token_type_hint": "refresh_token",
            "client_id": "client-1",
        },
    )


async def test_deletion_falls_back_to_the_access_token(notion):
    notion.credentials.open_credential.return_value = {
        "accessToken": "notion-access",
        "oauthClientId": "client-1",
    }
    assert await _release(_notion_row()) == ["revoked"]
    data = notion.post.await_args.kwargs["data"]
    assert data["token"] == "notion-access" and data["token_type_hint"] == "access_token"


async def test_a_credential_without_a_token_is_not_sent_anywhere(notion):
    notion.credentials.open_credential.return_value = {"oauthClientId": "client-1"}
    assert await _release(_notion_row()) == ["none"]
    notion.post.assert_not_awaited()


@pytest.mark.parametrize(
    "case",
    ["client_changed", "client_not_mounted", "unreadable", "provider_refused"],
)
async def test_an_unverifiable_or_refused_grant_is_reported_failed_and_never_raises(
    notion, monkeypatch, case
):
    if case == "client_changed":
        notion.credentials.open_credential.return_value = {
            "refreshToken": "notion-refresh",
            "oauthClientId": "another-client",
        }
    elif case == "client_not_mounted":
        monkeypatch.delenv("NOTION_OAUTH_CLIENT_ID")
    elif case == "unreadable":
        notion.credentials.open_credential.side_effect = RuntimeError("PRIVATE_DECRYPT_DETAIL")
    else:
        notion.post.side_effect = RuntimeError("provider down")
    assert await _release(_notion_row()) == ["failed"]
    if case != "provider_refused":
        notion.post.assert_not_awaited()


async def test_a_legacy_envelope_or_a_provider_with_no_endpoint_is_never_sent(notion):
    outcomes = await _release(
        _notion_row(envelope_version=1),
        {"connector_id": "attio", "envelope_version": 2, "credential_ciphertext": "x"},
    )
    assert outcomes == ["not_applicable", "not_applicable"]
    notion.post.assert_not_awaited()


async def test_a_failure_log_names_the_provider_and_class_but_not_the_detail(notion, caplog):
    notion.credentials.open_credential.side_effect = RuntimeError("PRIVATE_DECRYPT_DETAIL")
    with caplog.at_level("WARNING"):
        await _release(_notion_row())
    assert "provider=notion" in caplog.text and "RuntimeError" in caplog.text
    assert "PRIVATE_DECRYPT_DETAIL" not in caplog.text


@pytest.mark.asyncio
async def test_blocked_erasure_keeps_event_loop_responsive_and_rolls_back(monkeypatch):
    entered = Event()
    release = Event()
    starved = Event()
    provider_release = AsyncMock()

    @contextmanager
    def blocked_transaction():
        entered.set()
        # A bounded wait makes the broken, event-loop-blocking implementation
        # fail this test instead of hanging the suite.
        if not release.wait(2):
            starved.set()
            raise RuntimeError("event loop could not release the DB worker")
        raise RuntimeError("simulated database rollback")
        yield  # pragma: no cover - this transaction always rolls back

    monkeypatch.setattr("hushh_mcp.services.account_service.get_db_connection", blocked_transaction)
    monkeypatch.setattr(
        "hushh_mcp.services.account_service.release_provider_grants_after_erasure",
        provider_release,
    )
    task = asyncio.create_task(
        AccountService()._settle_full_account_transaction("departing", requested_target="both")
    )
    try:
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        assert not starved.is_set(), "blocked SQL starved the heartbeat coroutine"
        assert not task.done(), "blocked SQL must not block the server heartbeat"
    finally:
        release.set()
        result = await task

    assert result["success"] is False
    assert result["account_deleted"] is False
    provider_release.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancelled_delete_settles_transaction_and_releases_provider_grants(monkeypatch):
    from hushh_mcp.services.account_deletion_provider_cleanup import ProviderCredentialSnapshot

    service = AccountService()
    entered = Event()
    release = Event()
    snapshot = ProviderCredentialSnapshot(user_id="departing")
    provider_release = AsyncMock(return_value={"status": "released"})

    def committed_rows(*_args, **_kwargs):
        entered.set()
        assert release.wait(2)
        return {"success": True, "account_deleted": True, "details": {}}, snapshot

    monkeypatch.setattr(service, "_delete_full_account_transaction", committed_rows)
    monkeypatch.setattr(
        "hushh_mcp.services.account_service.release_provider_grants_after_erasure",
        provider_release,
    )
    task = asyncio.create_task(
        service._settle_full_account_transaction("departing", requested_target="both")
    )
    try:
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(0.005)
        assert entered.is_set()
        for _ in range(2):
            task.cancel()
            await asyncio.sleep(0)
        assert not task.done(), "cancellation must not abandon the transaction"
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    provider_release.assert_awaited_once_with(snapshot)


async def test_staged_erasure_requires_provider_proof_before_files_and_never_revokes_after_commit(
    monkeypatch,
):
    from hushh_mcp.services import account_deletion_provider_journal as journal

    claim = journal.ProviderCleanupClaim(
        owner_id="application-owner",
        firebase_uid="firebase-identity",
        cleanup_id=str(uuid4()),
        claim_token=str(uuid4()),
        inventory={},
        receipt={},
    )
    service = AccountService()
    ready = False
    files = AsyncMock(return_value=None)
    erase = MagicMock(
        return_value=(
            {"success": True, "account_deleted": True, "details": {}},
            ProviderCredentialSnapshot(user_id=claim.owner_id),
        )
    )
    release = AsyncMock()
    monkeypatch.setattr(journal, "is_ready", lambda observed: ready and observed == claim)
    monkeypatch.setattr(service, "_erase_shared_files_if_present", files)
    monkeypatch.setattr(service, "_delete_full_account_transaction", erase)
    monkeypatch.setattr(
        "hushh_mcp.services.account_service.release_provider_grants_after_erasure", release
    )
    with pytest.raises(journal.ProviderCleanupNotReady):
        await service.finalize_provider_cleanup(claim)
    files.assert_not_awaited()
    erase.assert_not_called()
    ready = True
    result = await service.finalize_provider_cleanup(claim)
    assert result["account_deleted"] is True
    assert result["details"]["provider_grant_release"] == {
        "status": "cleanup_qualified_before_erasure"
    }
    files.assert_awaited_once_with(claim.owner_id, backend_only=False)
    erase.assert_called_once_with(
        claim.owner_id, requested_target="both", backend_only=False, provider_cleanup=claim
    )
    release.assert_not_awaited()


@pytest.mark.parametrize("matching_subject", [True, False])
async def test_cleanup_google_binding_requires_real_owner_aad_client_and_provider_subject(
    monkeypatch, matching_subject
):
    from hushh_mcp.services import account_deletion_provider_credentials as credentials

    monkeypatch.setenv(
        "GOOGLE_OAUTH_CLIENT_ID", "123456789012-abcdefghijklmnop.apps.googleusercontent.com"
    )
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-test-secret")
    service = GoogleConnectionService(db=MagicMock())
    monkeypatch.setattr(service, "_token_key", lambda: _KEY)
    monkeypatch.setattr(
        "hushh_mcp.services.google_connection_service.get_google_connection_service",
        lambda: service,
    )
    envelope = service._encrypt("refresh-secret", aad="google-connection:uid_1")
    row = {
        "user_id": "uid_1",
        "provider_subject": "123456789",
        "refresh_token_ciphertext": envelope["ciphertext"],
        "refresh_token_iv": envelope["iv"],
    }
    grant = credentials.CleanupGrant("opaque-ref", "uid_1", "google_provider_connections", row)
    credentials._open_grant(MagicMock(), grant)
    assert grant.descriptor()["revocationSupport"] == "required"
    assert "refresh-secret" not in repr(grant)
    post = AsyncMock(
        return_value=(
            200,
            {
                "access_token": "fresh-access",
                "refresh_token": "rotated-refresh",
                "expires_in": 3600,
            },
        )
    )

    async def identify(*args, **kwargs):
        capture.assert_called_once()
        sealed = capture.call_args.kwargs["encrypted_update"]
        assert (
            service._decrypt(
                {
                    "ciphertext": sealed["refresh_token_ciphertext"],
                    "iv": sealed["refresh_token_iv"],
                },
                aad="google-connection:uid_1",
            )
            == "rotated-refresh"
        )
        return (200, {"sub": "123456789" if matching_subject else "987654321"})

    identity = AsyncMock(side_effect=identify)
    monkeypatch.setattr(credentials, "_google_post", post)
    monkeypatch.setattr(credentials, "_google_json", identity)
    from hushh_mcp.services import account_deletion_provider_journal as journal

    operation = SimpleNamespace()
    monkeypatch.setattr(journal, "dispatch_refresh", lambda *_args, **_kwargs: operation)
    capture = MagicMock()
    monkeypatch.setattr(journal, "capture_refresh", capture)
    if matching_subject:
        await credentials.verify_grant(grant, claim=object())
        assert grant.verified is True
    else:
        with pytest.raises(credentials.CleanupCredentialUnavailable):
            await credentials.verify_grant(grant, claim=object())
        assert grant.verified is False
    capture.assert_called_once()
    assert post.await_count == 1
    assert post.await_args.args[0] == pod_google_oauth.TOKEN_URL
    assert post.await_args.args[1]["client_id"] == service._client_id()
    assert post.await_args.args[1]["refresh_token"] == "refresh-secret"
    assert "scope" not in post.await_args.args[1]
    from hushh_mcp.services.google_connection_service import GoogleConnectionError

    with pytest.raises(GoogleConnectionError):
        credentials._open_grant(
            MagicMock(),
            credentials.CleanupGrant(
                "opaque-ref", "another-owner", "google_provider_connections", row
            ),
        )


@pytest.mark.parametrize("watch_failed", [False, True])
async def test_staged_worker_stops_all_watches_then_revokes_a_project_account_once(
    monkeypatch, watch_failed
):
    from hushh_mcp.services import account_deletion_provider_journal as journal
    from hushh_mcp.services import account_deletion_provider_worker as worker

    @asynccontextmanager
    async def admitted():
        yield SimpleNamespace(check=AsyncMock())

    monkeypatch.setattr(worker, "release_admission", admitted)
    events = []
    descriptor = {"revocationSupport": "required", "groupDigest": "a" * 64}
    inventory = {
        ref: {**descriptor, "revision": "b" * 64, "watchRequired": ref == "mail"}
        for ref in ("mail", "calendar")
    }
    receipt = {
        "version": 2,
        "items": {
            ref: {
                "watchOutcome": "pending" if ref == "mail" else "not_required",
                "revocation": "pending",
            }
            for ref in inventory
        },
    }
    claim = journal.ProviderCleanupClaim(
        "owner", "identity", str(uuid4()), str(uuid4()), inventory, receipt
    )
    grants = {
        ref: SimpleNamespace(reference=ref, kind="google", descriptor=lambda: dict(descriptor))
        for ref in inventory
    }
    monkeypatch.setattr(journal, "load_grants", lambda _claim: grants)
    monkeypatch.setattr(journal, "current_receipt", lambda _claim: copy.deepcopy(receipt))

    def dispatch(_claim, *, reference, phase):
        if phase == "revocation":
            assert all(
                item["watchOutcome"] in {"stopped", "not_required"}
                for item in receipt["items"].values()
            )
        receipt["items"][reference][phase] = "dispatched"
        return True

    def record(_claim, *, reference, phase, outcome):
        receipt["items"][reference][phase] = outcome

    def record_group(_claim, *, reference):
        for ref, item in receipt["items"].items():
            item["revocation"] = "revoked" if ref == reference else "covered_by_group"

    async def verify(grant, *, claim):
        events.append("verify:" + grant.reference)

    async def stop(grant):
        events.append("stop:" + grant.reference)
        if watch_failed:
            raise RuntimeError("synthetic provider timeout")

    async def revoke(grant):
        events.append("revoke:" + grant.reference)
        return "revoked"

    monkeypatch.setattr(journal, "dispatch", dispatch)
    monkeypatch.setattr(journal, "record", record)
    monkeypatch.setattr(journal, "record_group_revoked", record_group)
    monkeypatch.setattr(worker.credentials, "verify_grant", verify)
    monkeypatch.setattr(worker.credentials, "stop_watch", stop)
    monkeypatch.setattr(worker.credentials, "revoke_grant", revoke)
    finalize = AsyncMock(return_value={"success": True, "account_deleted": True})
    monkeypatch.setattr(AccountService, "finalize_provider_cleanup", finalize)
    if watch_failed:
        with pytest.raises(journal.ProviderCleanupNotReady):
            await worker.run_claim(claim)
        assert events == ["verify:mail", "verify:calendar", "stop:mail"]
        assert receipt["items"]["mail"]["watchOutcome"] == "uncertain"
        finalize.assert_not_awaited()
    else:
        assert await worker.run_claim(claim)
        assert events == ["verify:mail", "verify:calendar", "stop:mail", "revoke:mail"]
        finalize.assert_awaited_once_with(claim)


def _retained_google_fixture(monkeypatch, source):
    from hushh_mcp.services import account_deletion_provider_credentials as credentials

    client_id = "12345-abcdefghijklmnop.apps.googleusercontent.com"
    for name in ["GOOGLE_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_ID"]:
        monkeypatch.setenv(name, client_id)
    if source == "google_provider_connections":
        service = GoogleConnectionService(db=MagicMock())
        decrypt = MagicMock(side_effect=AssertionError("retained token must stay unopened"))
        monkeypatch.setattr(service, "_decrypt", decrypt)
        monkeypatch.setattr(
            "hushh_mcp.services.google_connection_service.get_google_connection_service",
            lambda: service,
        )
    else:
        service = GmailReceiptsService()
        decrypt = MagicMock(side_effect=AssertionError("retained token must stay unopened"))
        monkeypatch.setattr(service, "_decrypt_token", decrypt)
        monkeypatch.setattr(
            "hushh_mcp.services.gmail_receipts_service.get_gmail_receipts_service", lambda: service
        )
    row = {
        "provider_subject": "123456789",
        "google_sub": "123456789",
        "refresh_token_ciphertext": "synthetic-unopened",
        "refresh_token_iv": "synthetic-iv",
    }
    grant = credentials.CleanupGrant("mail", "owner", source, row)
    credentials._open_grant(MagicMock(), grant)
    decrypt.assert_not_called()
    assert grant.refresh_token == ""
    return grant, decrypt, row


@pytest.mark.parametrize("accepted", [False, True])
@pytest.mark.parametrize("source", ["google_provider_connections", "kai_gmail_connections"])
async def test_shared_google_authority_requires_local_confirmation_without_any_provider_effect(
    monkeypatch, accepted, source
):
    from hushh_mcp.services import account_deletion_provider_credentials as credentials
    from hushh_mcp.services import account_deletion_provider_journal as journal
    from hushh_mcp.services import account_deletion_provider_worker as worker

    @asynccontextmanager
    async def admitted():
        yield SimpleNamespace(check=AsyncMock())

    monkeypatch.setattr(worker, "release_admission", admitted)
    monkeypatch.setattr(
        credentials,
        "_shared_google_projects",
        lambda: frozenset({hashlib.sha256(b"12345").hexdigest()}),
    )
    grant, decrypt, row = _retained_google_fixture(monkeypatch, source)
    descriptor = grant.descriptor()
    assert descriptor["revocationSupport"] == "required"
    assert descriptor["authorityScope"] == "retain_shared_google"
    inventory = {"mail": {**descriptor, "revision": "b" * 64, "watchRequired": True}}
    receipt = {
        "version": 2,
        "items": {"mail": {"watchOutcome": "pending", "revocation": "pending"}},
        "localErasureAccepted": accepted,
    }
    claim = journal.ProviderCleanupClaim(
        "owner", "identity", str(uuid4()), str(uuid4()), inventory, receipt
    )
    monkeypatch.setattr(journal, "load_grants", lambda _: {"mail": grant})
    monkeypatch.setattr(journal, "current_receipt", lambda _: receipt)

    def settle(_claim, *, reference):
        if not accepted:
            raise journal.ProviderCleanupNotReady("local confirmation required")
        receipt["items"][reference]["revocation"] = "local_erasure_approved"

    monkeypatch.setattr(journal, "settle_unsupported", settle)
    ports = [AsyncMock(), AsyncMock(), AsyncMock()]
    for name, port in zip(["verify_grant", "stop_watch", "revoke_grant"], ports, strict=True):
        monkeypatch.setattr(credentials, name, port)
    finalize = AsyncMock(return_value={"success": True, "account_deleted": True})
    monkeypatch.setattr(AccountService, "finalize_provider_cleanup", finalize)
    if accepted:
        assert await worker.run_claim(claim)
        finalize.assert_awaited_once_with(claim)
    else:
        with pytest.raises(journal.ProviderCleanupNotReady):
            await worker.run_claim(claim)
        finalize.assert_not_awaited()
    for port in ports:
        port.assert_not_awaited()
    if accepted:
        receipt["items"]["mail"]["revocation"] = "pending"
        monkeypatch.setattr(credentials, "_shared_google_projects", lambda: frozenset())
        with pytest.raises(credentials.CleanupCredentialUnavailable, match="configuration changed"):
            await worker.run_claim(claim)
        for port in ports:
            port.assert_not_awaited()

    monkeypatch.setattr(credentials, "_shared_google_projects", lambda: frozenset())
    # Exclusive authority still requires the original encrypted-custody adapter.
    with pytest.raises(AssertionError, match="retained token must stay unopened"):
        credentials._open_grant(MagicMock(), credentials.CleanupGrant("mail", "owner", source, row))
    decrypt.assert_called_once()


@pytest.mark.parametrize(
    "watch,accepted,scope,revocation,allowed",
    [
        ("retained_shared", True, "retain_shared_google", "local_erasure_approved", True),
        ("pending", True, "retain_shared_google", "local_erasure_approved", False),
        ("uncertain", True, "retain_shared_google", "local_erasure_approved", False),
        ("retained_shared", False, "retain_shared_google", "local_erasure_approved", False),
        ("retained_shared", True, "exclusive", "local_erasure_approved", False),
        ("retained_shared", True, "retain_shared_google", "pending", False),
    ],
)
def test_mixed_cleanup_dispatch_requires_exact_shared_watch_approval(
    monkeypatch, watch, accepted, scope, revocation, allowed
):
    from hushh_mcp.services import account_deletion_provider_journal as journal

    shared = {"authorityScope": scope, "watchRequired": True}
    inventory = {"shared": shared, "exclusive": {"watchRequired": False}}
    receipt = {
        "localErasureAccepted": accepted,
        "items": {
            "shared": {**shared, "watchOutcome": watch, "revocation": revocation},
            "exclusive": {"watchOutcome": "not_required", "revocation": "pending"},
        },
    }
    claim = journal.ProviderCleanupClaim(
        "owner", "identity", "cleanup", "claim", inventory, receipt
    )
    conn, written = MagicMock(), MagicMock()
    conn.__enter__.return_value = conn
    monkeypatch.setattr(journal, "get_db_connection", lambda: conn)
    monkeypatch.setattr(journal, "_lock_claim", lambda *_args: copy.deepcopy(receipt))
    monkeypatch.setattr(journal, "_write_receipt", written)
    if allowed:
        assert journal.dispatch(claim, reference="exclusive", phase="revocation")
        written.assert_called_once()
        settled = written.call_args.args[2]["items"]
        assert settled["exclusive"]["revocation"] == "dispatched"
        assert settled["shared"] == receipt["items"]["shared"]
    else:
        with pytest.raises(journal.ProviderCleanupNotReady, match="all watches"):
            journal.dispatch(claim, reference="exclusive", phase="revocation")
        written.assert_not_called()


async def test_cleanup_cancellation_joins_replacement_capture_before_returning(monkeypatch):
    from hushh_mcp.services import account_deletion_provider_credentials as credentials
    from hushh_mcp.services import account_deletion_provider_journal as journal

    started, release = asyncio.Event(), asyncio.Event()
    events = []
    grant = credentials.CleanupGrant(
        "reference",
        "owner",
        "google_provider_connections",
        {},
        kind="google",
        client_id="client",
        refresh_token="old-refresh",  # noqa: S106 - synthetic fixture
    )
    monkeypatch.setattr(journal, "dispatch_refresh", lambda *_args, **_kwargs: object())

    async def refresh(**kwargs):
        started.set()
        await release.wait()
        events.append("returned")
        return pod_google_oauth.TokenGrant((), 3600, "access", "replacement")

    monkeypatch.setattr(pod_google_oauth, "refresh", refresh)
    monkeypatch.setattr(
        credentials, "seal_refresh", lambda *_args: {"refresh_token_ciphertext": "sealed"}
    )
    monkeypatch.setattr(
        journal, "capture_refresh", lambda *_args, **_kwargs: events.append("captured")
    )
    task = asyncio.create_task(credentials.refresh_and_capture(grant, claim=object()))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert events == ["returned", "captured"]
    assert grant.refresh_token == "replacement"
