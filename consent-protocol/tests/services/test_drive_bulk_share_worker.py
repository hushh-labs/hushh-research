"""Bulk grant safety: no per-file email, uncertain POSTs, and one summary signal."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import external_connector_google_oauth as google_oauth
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_permission_adapter import (
    CreatedReader,
    DrivePermissionError,
    GoogleDrivePermissionAdapter,
    PermissionSnapshot,
)


def _job(state="queued"):
    return {
        "share_id": "00000000-0000-0000-0000-000000000001",
        "user_id": "owner",
        "position": 1,
        "recipient_user_id": "recipient",
        "generation": 7,
        "state": state,
        "lease_id": "00000000-0000-0000-0000-000000000002",
        "file": {"id": "file-1", "name": "Financial document"},
        "recipient": {
            "user_id": "recipient",
            "subject": "subject",
            "email": "recipient@example.com",
            "kind": "verified_email",
        },
    }


def _worker(*, permission=None, send_push=None):
    store = SimpleNamespace(
        require_current=AsyncMock(),
        require_reconciliation_current=AsyncMock(),
        mark_dispatching=AsyncMock(),
        settle=AsyncMock(return_value=True),
        release=AsyncMock(return_value="unknown"),
        claim_notification=AsyncMock(
            return_value={
                "share_id": "00000000-0000-0000-0000-000000000001",
                "recipient_user_id": "recipient",
                "user_id": "owner",
                "lease_id": "00000000-0000-0000-0000-000000000002",
            }
        ),
        settle_notification=AsyncMock(return_value="settled"),
        cipher=SimpleNamespace(digest=lambda *args: "a" * 64),
    )
    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            return_value=CreatedReader("permission-1", "recipient@example.com")
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 7},
                {
                    "accessToken": "synthetic-token",
                    "subject": "owner-google",
                    "oauthClientId": "synthetic-client",
                },
            )
        )
    )
    worker = DriveBulkShareWorker(
        store=store,
        adapter=adapter,
        oauth=oauth,
        verify_recipient=AsyncMock(),
        send_push=send_push or (lambda *args, **kwargs: 1),
        wake=AsyncMock(),
    )
    if permission is not None:
        adapter.create_reader.side_effect = permission
    return worker, store, adapter


@pytest.mark.parametrize("disabled", ["drive_document_sharing", "google_drive_chat_reads"])
def test_rollout_disable_fences_a_new_grant_before_provider_io(monkeypatch, disabled):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_bulk_share_store.connector_feature_enabled",
        lambda feature, user_id: feature != disabled,
    )
    store = DriveBulkShareStore.__new__(DriveBulkShareStore)
    assert not store._owner_grants_enabled("owner")
    with pytest.raises(DriveSharingError, match="sharing_unavailable"):
        store._effect_current(None, _job())


@pytest.mark.asyncio
async def test_grant_suppresses_google_email_and_records_confirmed_receipt():
    worker, store, adapter = _worker()
    job = _job()
    job["file"]["resourceKey"] = "synthetic-resource-key"
    assert await worker._grant(job) == "succeeded"
    store.mark_dispatching.assert_awaited_once()
    adapter.create_reader.assert_awaited_once()
    assert adapter.create_reader.await_args.kwargs["send_notification_email"] is False
    assert store.settle.await_args.kwargs["state"] == "succeeded"
    assert store.settle.await_args.kwargs["receipt"]["permission_id"] == "permission-1"
    for operation in (adapter.inspect_shareable, adapter.list_permissions, adapter.create_reader):
        assert operation.await_args.kwargs["resource_key"] == "synthetic-resource-key"


@pytest.mark.asyncio
async def test_parallel_files_wait_for_real_oauth_refresh_before_granting(monkeypatch):
    """Replay the production OAuth/ACL path with only persistence and HTTP replaced."""
    worker, store, _ = _worker()
    contended = asyncio.Event()
    refreshed = asyncio.Event()
    row = {
        "status": "connected",
        "envelope_version": 2,
        "connection_generation": 7,
        "credential_version": 1,
        "credential_expires_at": datetime.now(UTC) - timedelta(seconds=1),
    }
    credential = {
        "profile": "live",
        "grantedScopes": list(google_oauth.LIVE_SCOPES),
        "oauthClientId": "synthetic-client",
        "subject": "synthetic-owner-subject",
        "accessToken": "synthetic-expired-token",
        "refreshToken": "synthetic-refresh-token",
    }
    claimed = False

    async def claim_refresh(**_kwargs):
        nonlocal claimed
        if claimed:
            contended.set()
            return False
        claimed = True
        return True

    async def settle_refresh(**kwargs):
        credential.update(kwargs["envelope"]["secret"])
        row.update(
            credential_version=2,
            credential_expires_at=kwargs["envelope"]["expires_at"],
        )
        refreshed.set()
        return True

    service = google_oauth.ExternalConnectorGoogleOAuth(
        db=None,
        registry=None,
        credentials=SimpleNamespace(
            open_credential=lambda **_kwargs: dict(credential),
            seal_credential=lambda **kwargs: kwargs,
        ),
        state_codec=None,
        lifecycle=SimpleNamespace(
            read=AsyncMock(side_effect=lambda **_kwargs: dict(row)),
            claim_refresh=claim_refresh,
            settle_refresh=settle_refresh,
        ),
    )
    service._configuration = AsyncMock(
        return_value=(
            SimpleNamespace(
                capability_policy=google_oauth.DRIVE_POLICY,
                oauth_scopes=google_oauth.REGISTRY_SCOPES,
            ),
            "synthetic-client",
            "synthetic-client-secret",
        )
    )
    worker.oauth = service
    worker.adapter = GoogleDrivePermissionAdapter()
    store.release.side_effect = lambda _job, **kwargs: (
        "queued" if kwargs["retryable"] else "skipped"
    )
    calls = []

    class Stream(httpx.AsyncByteStream):
        def __init__(self, payload):
            self.data = json.dumps(payload).encode()

        async def __aiter__(self):
            yield self.data

    async def handle(request):
        calls.append((request.method, request.url.host, request.url.path))
        if request.url.host == "oauth2.googleapis.com":
            await asyncio.wait_for(contended.wait(), 2)
            payload = {
                "access_token": "synthetic-current-token",
                "token_type": "Bearer",
                "expires_in": 3600,
            }
        else:
            assert refreshed.is_set()
            assert request.headers["Authorization"] == "Bearer synthetic-current-token"
            existing = {
                "id": "permission-2",
                "type": "user",
                "role": "reader",
                "emailAddress": "recipient@example.com",
            }
            if request.method == "POST":
                assert request.url.path == "/drive/v3/files/file-1/permissions"
                payload = {**existing, "id": "permission-1"}
            elif request.url.path.endswith("/permissions"):
                payload = {"permissions": [existing] if "/file-2/" in request.url.path else []}
            else:
                payload = {
                    "id": request.url.path.rsplit("/", 1)[-1],
                    "name": "Financial document",
                    "mimeType": "application/pdf",
                    "trashed": False,
                    "modifiedTime": "2026-10-01T00:00:00Z",
                    "capabilities": {"canShare": True},
                }
        return httpx.Response(200, stream=Stream(payload))

    original_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(handle)),
    )
    first, second = _job(), _job()
    second["position"] = 2
    second["file"] = {**second["file"], "id": "file-2"}
    outcomes = await asyncio.wait_for(
        asyncio.gather(worker._grant(first), worker._grant(second)), 5
    )
    assert outcomes == ["succeeded", "preexisting"]
    assert sum(host == "oauth2.googleapis.com" for _, host, _ in calls) == 1
    assert sum(method == "POST" and host == "www.googleapis.com" for method, host, _ in calls) == 1
    store.release.assert_not_awaited()
    assert [call.kwargs["state"] for call in store.settle.await_args_list] == [
        "succeeded",
        "preexisting",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code,status,retryable,calls,logged_code",
    [
        ("refresh_in_progress", 409, True, 4, "refresh_in_progress"),
        ("connection_changed", 409, False, 1, "connection_changed"),
        ("PRIVATE provider account response", 409, False, 1, "unavailable"),
    ],
)
async def test_refresh_contention_is_bounded_and_only_exact_conflict_retries(
    monkeypatch, caplog, code, status, retryable, calls, logged_code
):
    worker, store, adapter = _worker()
    worker.oauth.current_credential.side_effect = google_oauth.DriveOAuthError(
        code, status_code=status
    )
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)
    store.release.side_effect = lambda _job, **kwargs: (
        "queued" if kwargs["retryable"] else "skipped"
    )
    caplog.set_level("WARNING", logger="drive_bulk_share")

    assert await worker._grant(_job()) == ("queued" if retryable else "skipped")

    assert worker.oauth.current_credential.await_count == calls
    assert [call.args[0] for call in sleep.await_args_list] == (
        [0.2, 0.4, 0.8] if retryable else []
    )
    assert store.release.await_args.kwargs == {
        "error": "provider_unavailable" if code != "connection_changed" else "connection_changed",
        "retryable": retryable,
        "uncertain": False,
    }
    store.mark_dispatching.assert_not_awaited()
    adapter.create_reader.assert_not_awaited()
    assert f"stage=credential code={logged_code} dispatched=False" in caplog.text
    assert "PRIVATE" not in caplog.text
    assert "recipient@example.com" not in caplog.text
    assert "file-1" not in caplog.text


@pytest.mark.asyncio
async def test_authority_change_while_joining_refresh_prevents_further_io(monkeypatch):
    worker, store, adapter = _worker()
    worker.oauth.current_credential.side_effect = google_oauth.DriveOAuthError(
        "refresh_in_progress", status_code=409
    )
    store.require_current.side_effect = DriveSharingError("bulk_changed")
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())

    await worker._grant(_job())

    worker.oauth.current_credential.assert_awaited_once()
    store.require_current.assert_awaited_once()
    adapter.inspect_shareable.assert_not_awaited()
    store.mark_dispatching.assert_not_awaited()
    adapter.create_reader.assert_not_awaited()
    assert store.release.await_args.kwargs["retryable"] is False


@pytest.mark.asyncio
async def test_uncertain_post_is_not_retried_and_reconcile_never_posts():
    worker, store, adapter = _worker(
        permission=DrivePermissionError("permission_outcome_unknown", outcome_unknown=True)
    )
    assert await worker._grant(_job()) == "unknown"
    assert adapter.create_reader.await_count == 1
    assert store.release.await_args.kwargs["uncertain"] is True
    adapter.list_permissions.return_value = PermissionSnapshot(
        (
            {
                "id": "permission-1",
                "type": "user",
                "role": "reader",
                "emailAddress": "recipient@example.com",
            },
        )
    )
    job = _job("unknown")
    job["file"]["resourceKey"] = "synthetic-resource-key"
    assert await worker._reconcile(job) == "present_unattributed"
    assert adapter.list_permissions.await_args.kwargs["resource_key"] == "synthetic-resource-key"
    assert adapter.create_reader.await_count == 1
    assert store.settle.await_args.kwargs["state"] == "present_unattributed"


@pytest.mark.asyncio
async def test_summary_push_has_no_file_or_account_identifiers():
    calls = []

    def send(user_id, **kwargs):
        calls.append((user_id, kwargs))
        return 1

    worker, store, _ = _worker(send_push=send)
    outcome = await worker._notification(
        {
            "share_id": "00000000-0000-0000-0000-000000000001",
            "recipient_user_id": "recipient",
        }
    )
    assert outcome == "settled"
    assert len(calls) == 1
    assert calls[0][1]["deep_link"] == "/one/profile/my-data"
    assert calls[0][1]["include_user_id"] is False
    assert "file-1" not in str(calls[0][1])
    assert "recipient@example.com" not in str(calls[0][1])
    store.settle_notification.assert_awaited_once()
    assert store.settle_notification.await_args.kwargs["delivered"] is True
