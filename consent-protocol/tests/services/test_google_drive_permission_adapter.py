"""Synthetic HTTP only: no Google account, grant or credential is used."""

# ruff: noqa: S106

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import google_drive_permission_adapter as acl
from mcp_modules.log_redaction import redact_log_value


def permission(**changes):
    return {
        "id": "synthetic-permission",
        "type": "user",
        "role": "reader",
        "emailAddress": "recipient@example.invalid",
        **changes,
    }


class Stream(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        yield self.data


def response(status=200, payload=None, *, content=None, headers=None):
    return httpx.Response(
        status,
        stream=Stream(content if content is not None else json.dumps(payload).encode()),
        headers=headers,
    )


def install(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: original(**kw, transport=httpx.MockTransport(handler))
    )


def arguments():
    return {
        "file_id": "synthetic-file",
        "access_token": "synthetic-token",
        "require_current": AsyncMock(),
    }


@pytest.mark.asyncio
async def test_removing_permission_does_not_require_content_or_index_eligibility(monkeypatch):
    install(
        monkeypatch,
        lambda request: response(
            payload={
                "id": "synthetic-file",
                "isAppAuthorized": True,
                "mimeType": "application/pdf",
                "version": "999",
                "capabilities": {
                    "canShare": True,
                    "canDownload": False,
                    "canAccessViaGenAi": False,
                },
            }
        ),
    )
    await acl.GoogleDrivePermissionAdapter().inspect_permission_management(**arguments())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mime", [None, "", "application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"]
)
async def test_permission_management_rejects_unapproved_target_types(monkeypatch, mime):
    install(
        monkeypatch,
        lambda request: response(
            payload={
                "id": "synthetic-file",
                "isAppAuthorized": True,
                "mimeType": mime,
                "capabilities": {"canShare": True},
            }
        ),
    )
    with pytest.raises(acl.DrivePermissionError, match="permission_target_unavailable"):
        await acl.GoogleDrivePermissionAdapter().inspect_permission_management(**arguments())


@pytest.mark.asyncio
async def test_fixed_individual_viewer_contract(monkeypatch):
    seen = []

    def handle(request):
        seen.append(request)
        return response(payload=permission())

    install(monkeypatch, handle)
    result = await acl.GoogleDrivePermissionAdapter().create_reader(
        **arguments(), verified_email="recipient@example.invalid"
    )
    request = seen[0]
    assert len(seen) == 1
    assert request.method == "POST"
    assert request.url.host == "www.googleapis.com"
    assert request.url.path == "/drive/v3/files/synthetic-file/permissions"
    assert json.loads(request.content) == {
        "type": "user",
        "role": "reader",
        "emailAddress": "recipient@example.invalid",
    }
    assert dict(request.url.params) == {
        "supportsAllDrives": "true",
        "fields": acl.PERMISSION_FIELDS,
        "sendNotificationEmail": "true",
    }
    assert result.permission_id == "synthetic-permission"
    assert "recipient" not in repr(result)
    assert "synthetic-permission" not in repr(result)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode",
    [
        "timeout",
        "503",
        "redirect",
        "malformed",
        "wrong-role",
        "wrong-email",
        "oversized",
        "compressed",
        "expires",
        "pending-owner",
    ],
)
async def test_uncertain_mutation_never_retries(monkeypatch, mode):
    seen = []

    def handle(request):
        seen.append(request)
        if mode == "timeout":
            raise httpx.ReadTimeout("PRIVATE PROVIDER DETAIL", request=request)
        if mode == "503":
            return response(503, content=b"PRIVATE")
        if mode == "redirect":
            return response(302, headers={"Location": "https://attacker.invalid"})
        if mode == "malformed":
            return response(content=b"PRIVATE INVALID JSON")
        if mode == "oversized":
            return response(content=b" " * (acl.RESPONSE_LIMIT + 1))
        if mode == "compressed":
            return response(payload=permission(), headers={"Content-Encoding": "gzip"})
        changes = {
            "wrong-role": {"role": "writer"},
            "wrong-email": {"emailAddress": "else@example.invalid"},
            "expires": {"expirationTime": "2030-01-01T00:00:00Z"},
            "pending-owner": {"pendingOwner": True},
        }
        return response(payload=permission(**changes[mode]))

    install(monkeypatch, handle)
    with pytest.raises(acl.DrivePermissionError, match="^permission_outcome_unknown$") as caught:
        await acl.GoogleDrivePermissionAdapter().create_reader(
            **arguments(), verified_email="recipient@example.invalid"
        )
    assert caught.value.outcome_unknown
    assert not caught.value.retryable
    assert len(seen) == 1
    assert "PRIVATE" not in str(caught.value)


@pytest.mark.asyncio
async def test_cancellation_after_dispatch_is_not_a_safe_retry(monkeypatch):
    dispatched = asyncio.Event()

    async def handle(_request):
        dispatched.set()
        await asyncio.Event().wait()

    install(monkeypatch, handle)
    task = asyncio.create_task(
        acl.GoogleDrivePermissionAdapter().create_reader(
            **arguments(), verified_email="recipient@example.invalid"
        )
    )
    await asyncio.wait_for(dispatched.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_delete_404_is_not_verified_revocation(monkeypatch):
    install(monkeypatch, lambda _request: response(404, content=b"private"))
    with pytest.raises(acl.DrivePermissionError, match="permission_target_unavailable"):
        await acl.GoogleDrivePermissionAdapter().remove_recorded_permission(
            **arguments(), recorded_permission_id="synthetic-permission"
        )


@pytest.mark.asyncio
async def test_delete_has_no_arbitrary_mutation_parameters(monkeypatch):
    seen = []

    def handle(request):
        seen.append(request)
        return response(204, content=b"")

    install(monkeypatch, handle)
    await acl.GoogleDrivePermissionAdapter().remove_recorded_permission(
        **arguments(), recorded_permission_id="synthetic-permission"
    )
    assert seen[0].method == "DELETE"
    assert seen[0].url.path.endswith("/synthetic-file/permissions/synthetic-permission")
    assert dict(seen[0].url.params) == {"supportsAllDrives": "true"}
    assert seen[0].content == b""


@pytest.mark.asyncio
async def test_repeated_page_token_never_returns_partial_acl(monkeypatch):
    seen = []

    def handle(request):
        seen.append(request)
        return response(payload={"permissions": [], "nextPageToken": "same"})

    install(monkeypatch, handle)
    with pytest.raises(acl.DrivePermissionError, match="permission_catalog_incomplete"):
        await acl.GoogleDrivePermissionAdapter().list_permissions(**arguments())
    assert len(seen) == 2


@pytest.mark.asyncio
async def test_all_pages_required_and_existing_roles_preserved(monkeypatch):
    seen = []

    def handle(request):
        seen.append(request)
        if len(seen) == 1:
            return response(
                payload={
                    "permissions": [permission(role="writer")],
                    "nextPageToken": "next",
                }
            )
        return response(
            payload={
                "permissions": [
                    permission(
                        id="inherited",
                        permissionDetails=[
                            {
                                "inherited": True,
                                "inheritedFrom": "parent",
                                "permissionType": "file",
                                "role": "reader",
                            }
                        ],
                    )
                ]
            }
        )

    install(monkeypatch, handle)
    result = await acl.GoogleDrivePermissionAdapter().list_permissions(**arguments())
    assert len(result.permissions) == 2
    assert result.permissions[0]["role"] == "writer"
    assert result.permissions[1]["permissionDetails"][0]["inherited"] is True
    assert seen[1].url.params["pageToken"] == "next"
    assert "synthetic-permission" not in repr(result)


@pytest.mark.asyncio
async def test_local_revocation_prevents_dispatch(monkeypatch):
    def unexpected(_request):
        raise AssertionError("must not dispatch")

    install(monkeypatch, unexpected)
    args = arguments()
    args["require_current"] = AsyncMock(side_effect=acl.DrivePermissionError("approval_superseded"))
    with pytest.raises(acl.DrivePermissionError, match="approval_superseded"):
        await acl.GoogleDrivePermissionAdapter().create_reader(
            **args, verified_email="recipient@example.invalid"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("identifier", ["../file", "file/permissions/other", "file?alt=media"])
async def test_path_injection_rejected_before_network(identifier):
    args = arguments()
    args["file_id"] = identifier
    with pytest.raises(acl.DrivePermissionError, match="operation_not_allowed"):
        await acl.GoogleDrivePermissionAdapter().remove_recorded_permission(
            **args, recorded_permission_id="synthetic-permission"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change,code",
    [
        ({"version": "8"}, "source_changed"),
        ({"isAppAuthorized": False}, "source_not_shareable"),
        ({"mimeType": "application/vnd.google-apps.shortcut"}, "source_not_shareable"),
        ({"capabilities": {"canShare": False}}, "source_not_shareable"),
        ({"clientEncryptionDetails": {"encryptionState": "encrypted"}}, "source_not_shareable"),
    ],
)
async def test_shareable_requires_exact_approved_eligible_source(monkeypatch, change, code):
    payload = {
        "id": "synthetic-file",
        "version": "7",
        "mimeType": "text/plain",
        "trashed": False,
        "isAppAuthorized": True,
        "capabilities": {"canShare": True, "canDownload": True, "canAccessViaGenAi": True},
        **change,
    }
    install(monkeypatch, lambda _request: response(payload=payload))
    with pytest.raises(acl.DrivePermissionError, match=code):
        await acl.GoogleDrivePermissionAdapter().inspect_shareable(
            **arguments(), expected_version="7"
        )


@pytest.mark.parametrize("as_url", [False, True])
def test_permission_path_hides_both_provider_identifiers(as_url):
    url = (
        "https://www.googleapis.com/drive/v3/files/private-file/"
        "permissions/private-grantee?supportsAllDrives=true"
    )
    rendered = repr(redact_log_value(httpx.URL(url) if as_url else url))
    assert "private-file" not in rendered
    assert "private-grantee" not in rendered


async def test_live_sheet_is_shareable_without_selected_parser_support():
    adapter = acl.GoogleDrivePermissionAdapter()
    adapter._exchange = AsyncMock(
        return_value={
            "id": "synthetic-file",
            "version": "1",
            "trashed": False,
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "capabilities": {"canShare": True, "canDownload": True},
        }
    )
    await adapter.inspect_shareable(
        **arguments(),
        expected_version="1",
        require_app_authorized=False,
        require_genai_eligibility=False,
    )


async def test_metadata_only_video_share_binds_identity_not_version_and_rechecks_share():
    adapter = acl.GoogleDrivePermissionAdapter()
    payload = {
        "id": "synthetic-file",
        "name": "Onboarding - Recording.mp4",
        "version": "1",
        "trashed": False,
        "mimeType": "video/mp4",
        "modifiedTime": "2026-09-23T12:00:00Z",
        "capabilities": {"canShare": True, "canDownload": False},
    }
    adapter._exchange = AsyncMock(return_value=payload)
    metadata_only = {
        "expected_version": "1",
        "expected_name": "Onboarding - Recording.mp4",
        "require_app_authorized": False,
        "require_genai_eligibility": False,
        "metadata_only": True,
        "time_field": "modifiedTime",
        "start_time": "2026-09-22T00:00:00Z",
        "end_time": "2026-09-24T00:00:00Z",
    }
    await adapter.inspect_shareable(**arguments(), **metadata_only)
    # Granting the same file to an earlier recipient bumps its version. It is
    # still the file the owner picked, so the next recipient's grant proceeds.
    adapter._exchange.return_value = {**payload, "version": "2"}
    await adapter.inspect_shareable(**arguments(), **metadata_only)
    # A rename after review is not the file the owner approved.
    adapter._exchange.return_value = {**payload, "version": "2", "name": "Renamed.mp4"}
    with pytest.raises(acl.DrivePermissionError, match="source_changed"):
        await adapter.inspect_shareable(**arguments(), **metadata_only)
    # A plan without a reviewed name fails closed.
    adapter._exchange.return_value = payload
    with pytest.raises(acl.DrivePermissionError, match="source_changed"):
        await adapter.inspect_shareable(**arguments(), **{**metadata_only, "expected_name": None})
    adapter._exchange.return_value = {**payload, "capabilities": {"canShare": False}}
    with pytest.raises(acl.DrivePermissionError, match="source_not_shareable"):
        await adapter.inspect_shareable(**arguments(), **metadata_only)
    adapter._exchange.return_value = {**payload, "modifiedTime": "2026-09-21T00:00:00Z"}
    with pytest.raises(acl.DrivePermissionError, match="source_changed"):
        await adapter.inspect_shareable(**arguments(), **metadata_only)
