"""Read-only original source and recipient ACL checks before payment."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_package_access_preflight import (
    DrivePackageAccessPreflight,
    recipient_access,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_permission_adapter import PermissionSnapshot


def acl(*rows):
    return PermissionSnapshot(tuple(rows))


def user_acl(**extra):
    return {
        "id": "permission-1",
        "type": "user",
        "role": "reader",
        "emailAddress": "buyer@example.invalid",
        **extra,
    }


@pytest.mark.parametrize(
    "permissions,state",
    [
        ([], "absent"),
        ([user_acl()], "present"),
        ([user_acl(role="writer")], "present"),
        (
            [
                user_acl(
                    permissionDetails=[
                        {"inherited": True, "permissionType": "member", "role": "reader"}
                    ]
                )
            ],
            "present",
        ),
        ([user_acl(deleted=True)], "absent"),
        ([user_acl(expirationTime="2000-01-01T00:00:00Z")], "absent"),
        ([{"id": "public", "type": "anyone", "role": "reader"}], "present"),
        (
            [
                {
                    "id": "group",
                    "type": "group",
                    "role": "reader",
                    "emailAddress": "team@example.invalid",
                }
            ],
            "unknown",
        ),
        (
            [{"id": "domain", "type": "domain", "role": "reader", "domain": "example.invalid"}],
            "unknown",
        ),
        ([{"id": "anonymous-user", "type": "user", "role": "reader"}], "unknown"),
    ],
)
def test_permission_absence_never_guesses_group_or_domain_membership(permissions, state):
    assert (
        recipient_access(acl(*permissions), email="BUYER@example.invalid", now=datetime.now(UTC))[0]
        == state
    )


def pipeline(permissions):
    source = {
        "id": "source-1",
        "name": "Statement.pdf",
        "sourceVersion": "7",
        "generation": 1,
        "contentFingerprint": "a" * 64,
    }
    sharing = SimpleNamespace(
        request_bulk_context=AsyncMock(
            return_value={
                "revision": 2,
                "recipientUserId": "buyer",
                "recipient": {"subject": "google-buyer", "email": "buyer@example.invalid"},
            }
        )
    )
    bulk = SimpleNamespace(package_sources=AsyncMock(return_value=[source]))
    reader = SimpleNamespace(
        _generation=1,
        _credential=AsyncMock(return_value={"accessToken": "private-test-token"}),
        adapter=SimpleNamespace(
            get_share_metadata=AsyncMock(
                return_value=SimpleNamespace(version="7", name="Statement.pdf")
            )
        ),
    )
    adapter = SimpleNamespace(
        list_permissions=AsyncMock(return_value=permissions), create_reader=AsyncMock()
    )
    verifier = AsyncMock()
    service = DrivePackageAccessPreflight(
        sharing=sharing,
        bulk=bulk,
        reader_factory=lambda **_: reader,
        permission_adapter=adapter,
        verify_recipient=verifier,
    )
    return service, bulk, reader, adapter, verifier


@pytest.mark.parametrize("embedded", [False, True])
async def test_original_version_and_buyer_access_are_checked_without_granting(embedded):
    service, _, reader, adapter, verifier = pipeline(acl(user_acl()))
    if embedded:
        reader.adapter.get_share_metadata.return_value.permission_snapshot = acl(user_acl())
    result = await service.inspect(
        user_id="owner", request_id="request", require_current=AsyncMock()
    )
    assert result.status == "all_existing" and result.files[0]["sourceVersion"] == "7"
    assert result.files[0]["permission"]["role"] == "reader"
    assert reader.adapter.get_share_metadata.await_count == (1 if embedded else 2)
    assert adapter.list_permissions.await_count == (0 if embedded else 1)
    assert verifier.await_count == 2
    adapter.create_reader.assert_not_awaited()
    assert "buyer@example.invalid" not in repr(result) and "source-1" not in repr(result)


async def test_mixed_and_unknown_access_cannot_be_reported_as_new_paid_delivery():
    service, bulk, _, adapter, _ = pipeline(acl())
    bulk.package_sources.return_value.append(
        {**bulk.package_sources.return_value[0], "id": "source-2"}
    )
    adapter.list_permissions.side_effect = [acl(user_acl()), acl()]
    result = await service.inspect(
        user_id="owner", request_id="request", require_current=AsyncMock()
    )
    assert result.status == "mixed"
    adapter.list_permissions.side_effect = None
    adapter.list_permissions.return_value = acl({"id": "group", "type": "group", "role": "reader"})
    assert (
        await service.inspect(user_id="owner", request_id="request", require_current=AsyncMock())
    ).status == "unknown"


@pytest.mark.parametrize("embedded", [False, True])
async def test_revoked_acl_is_observed_on_recheck_instead_of_reusing_snapshot(embedded):
    service, _, reader, adapter, _ = pipeline(acl(user_acl()))
    if embedded:
        reader.adapter.get_share_metadata.return_value.permission_snapshot = acl(user_acl())
    first = await service.inspect(
        user_id="owner", request_id="request", require_current=AsyncMock()
    )
    adapter.list_permissions.return_value = acl()
    if embedded:
        reader.adapter.get_share_metadata.return_value.permission_snapshot = acl()
    second = await service.inspect(
        user_id="owner", request_id="request", require_current=AsyncMock()
    )
    assert first.status == "all_existing" and second.status == "none"


async def test_source_change_during_acl_read_and_revoked_owner_fence_discard_receipts():
    service, _, reader, _, _ = pipeline(acl(user_acl()))
    reader.adapter.get_share_metadata.side_effect = [
        SimpleNamespace(version="7", name="Statement.pdf"),
        SimpleNamespace(version="8", name="Statement.pdf"),
    ]
    with pytest.raises(DriveSharingError, match="source_changed"):
        await service.inspect(user_id="owner", request_id="request", require_current=AsyncMock())
    service, _, _, adapter, _ = pipeline(acl(user_acl()))
    guard = AsyncMock(side_effect=DriveSharingError("background_preparation_required"))
    with pytest.raises(DriveSharingError, match="background_preparation_required"):
        await service.inspect(user_id="owner", request_id="request", require_current=guard)
    adapter.list_permissions.assert_not_awaited()


async def test_legacy_frozen_modified_time_is_rechecked_but_not_used_as_coverage():
    service, bulk, reader, _, _ = pipeline(acl())
    bulk.package_sources.return_value = [
        {
            "id": "source-1",
            "name": "Statement.pdf",
            "modifiedTime": "2026-10-01T00:00:00Z",
            "generation": 1,
        }
    ]
    reader.adapter.get_share_metadata.return_value = SimpleNamespace(
        name="Statement.pdf", modified_time="2026-10-01T00:00:00Z", version="8"
    )
    result = await service.inspect(
        user_id="owner", request_id="request", require_current=AsyncMock()
    )
    assert result.status == "none"
    assert result.files[0]["sourceVersion"] is None
    reader.adapter.get_share_metadata.return_value = SimpleNamespace(
        name="Statement.pdf", modified_time="2026-10-02T00:00:00Z", version="8"
    )
    with pytest.raises(DriveSharingError, match="source_changed"):
        await service.inspect(user_id="owner", request_id="request", require_current=AsyncMock())


async def test_resource_key_and_current_shareability_are_checked_before_payment():
    service, bulk, reader, adapter, _ = pipeline(acl())
    bulk.package_sources.return_value[0]["resourceKey"] = "resource-key"
    await service.inspect(user_id="owner", request_id="request", require_current=AsyncMock())
    assert reader.adapter.get_share_metadata.await_args.kwargs["resource_key"] == "resource-key"
    assert adapter.list_permissions.await_args.kwargs["resource_key"] == "resource-key"
    reader.adapter.get_share_metadata.side_effect = DriveSharingError("source_unavailable")
    adapter.list_permissions.reset_mock()
    with pytest.raises(DriveSharingError, match="source_unavailable"):
        await service.inspect(user_id="owner", request_id="request", require_current=AsyncMock())
    adapter.list_permissions.assert_not_awaited()
    adapter.create_reader.assert_not_awaited()


async def test_failed_preflight_cancels_sibling_google_reads_before_returning():
    service, bulk, reader, adapter, _ = pipeline(acl())
    bulk.package_sources.return_value.append(
        {**bulk.package_sources.return_value[0], "id": "source-2"}
    )
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def metadata(**kwargs):
        if kwargs["file_id"] == "source-1":
            await entered.wait()
            raise DriveSharingError("source_unavailable")
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    reader.adapter.get_share_metadata.side_effect = metadata
    with pytest.raises(DriveSharingError, match="source_unavailable"):
        await service.inspect(user_id="owner", request_id="request", require_current=AsyncMock())
    assert cancelled.is_set()
    adapter.list_permissions.assert_not_awaited()
