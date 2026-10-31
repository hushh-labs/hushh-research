"""Complete Drive inventory and current-job cache authority contracts."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_groups import row


def inventory_row(identity, version="1"):
    return row(identity, "statement.pdf", version=version, modifiedTime="2026-04-01T00:00:00Z")


async def test_worker_inventory_cache_uses_fresh_ports_and_never_returns_revoked_rows():
    from hushh_mcp.services.drive_groups.inventory import InventoryCache

    cache = InventoryCache()
    current = AsyncMock()
    listing = AsyncMock(return_value=([inventory_row("old")], True, False))
    first = SimpleNamespace(
        read_tool=AsyncMock(
            side_effect=[
                SimpleNamespace(
                    is_error=False, truncated=False, payload={"startPageToken": "start"}
                ),
                changes_page([]),
            ]
        )
    )
    key = ("owner", 1, 1, 1)
    await cache.load(first, "owner", key=key, listing=listing, require_current=current)
    # Reuse the complete rows+cursor, but never the previous job's read port.
    second = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=changes_page(
                [
                    file_change("old", removed=True),
                    file_change("new", version="2"),
                ]
            )
        )
    )
    result = await cache.load(second, "owner", key=key, listing=listing, require_current=current)
    assert listing.await_count == 1
    assert [(item["id"], item["version"]) for item in result.rows] == [("new", "2")]
    assert second.read_tool.await_count == 1 and first.read_tool.await_count == 2
    current.side_effect = DriveReadError("connection_changed")
    with pytest.raises(DriveReadError, match="connection_changed"):
        await cache.load(second, "owner", key=key, listing=listing, require_current=current)
    assert second.read_tool.await_count == 1


async def test_worker_inventory_cache_refuses_revocation_after_delta_io():
    from hushh_mcp.services.drive_groups.inventory import InventoryCache

    cache = InventoryCache()
    current = AsyncMock()
    listing = AsyncMock(return_value=([inventory_row("old")], True, False))
    port = SimpleNamespace(
        read_tool=AsyncMock(
            side_effect=[
                SimpleNamespace(
                    is_error=False, truncated=False, payload={"startPageToken": "start"}
                ),
                changes_page([]),
            ]
        )
    )
    key = ("owner", 1, 1, 1)
    await cache.load(port, "owner", key=key, listing=listing, require_current=current)

    async def revoked_during_read(**kwargs):
        current.side_effect = DriveReadError("connection_changed")
        return changes_page([file_change("new")])

    port.read_tool.side_effect = revoked_during_read
    with pytest.raises(DriveReadError, match="connection_changed"):
        await cache.load(port, "owner", key=key, listing=listing, require_current=current)
    # Restored authority must bootstrap; the revoked delta was not published.
    current.side_effect = None
    port.read_tool.side_effect = [
        SimpleNamespace(is_error=False, truncated=False, payload={"startPageToken": "fresh"}),
        changes_page([]),
    ]
    result = await cache.load(port, "owner", key=key, listing=listing, require_current=current)
    assert result.mode == "full" and listing.await_count == 2
    assert [item["id"] for item in result.rows] == ["old"]


def changes_page(changes, *, following=None, terminal="next-cursor"):
    return SimpleNamespace(
        is_error=False,
        truncated=False,
        payload={
            "changes": changes,
            "nextPageToken": following,
            "newStartPageToken": terminal,
        },
    )


def file_change(identity, *, version="1", removed=False):
    return {
        "changeType": "file",
        "fileId": identity,
        "removed": removed,
        "trashed": False,
        **({} if removed else {"file": inventory_row(identity, version)}),
    }


@pytest.mark.parametrize("oversize", [False, True])
async def test_incremental_inventory_reuses_snapshot_and_applies_updates_and_removals(
    monkeypatch, oversize
):
    from scripts import drive_group_local_inventory as inventory

    listing = AsyncMock()
    monkeypatch.setattr(inventory.DriveGroupIndexJob, "list_files", listing)
    saved = inventory.LocalInventory(
        [inventory_row("unchanged"), inventory_row("edited"), inventory_row("deleted")],
        True,
        False,
        "old-cursor",
        "old-cursor",
    ).checkpoint(completed=True)
    read = AsyncMock(
        side_effect=[
            *([DriveReadError("file_too_large")] if oversize else []),
            changes_page(
                [file_change("edited", version="2"), file_change("deleted", removed=True)],
                following="page-two",
                terminal=None,
            ),
            changes_page([file_change("new")]),
        ]
    )
    result = await inventory.load_inventory(SimpleNamespace(read_tool=read), "owner", saved=saved)
    assert [(item["id"], item["version"]) for item in result.rows] == [
        ("unchanged", "1"),
        ("edited", "2"),
        ("new", "1"),
    ]
    assert result.mode == "changes" and result.complete and not result.limited
    assert result.checkpoint(completed=False)["cursor"] == "old-cursor"
    assert result.checkpoint(completed=True)["cursor"] == "next-cursor"
    assert [call.kwargs["arguments"]["pageToken"] for call in read.await_args_list] == [
        *(["old-cursor"] if oversize else []),
        "old-cursor",
        "page-two",
    ]
    assert read.await_args_list[-1].kwargs["arguments"]["pageSize"] == (25 if oversize else 200)
    listing.assert_not_awaited()
    assert saved["rows"][-1]["id"] == "deleted"  # Failed publication may retain the old checkpoint.


@pytest.mark.parametrize("reset", [None, "expired", "membership"])
async def test_incremental_inventory_bootstrap_captures_cursor_before_listing_and_catches_up(
    monkeypatch, reset
):
    from scripts import drive_group_local_inventory as inventory

    calls = []

    async def listing(*args):
        calls.append("listing")
        return [inventory_row("edited")], True, False

    monkeypatch.setattr(inventory.DriveGroupIndexJob, "list_files", listing)

    async def read(*, tool_name, **kwargs):
        calls.append(tool_name)
        if tool_name == "changes_start_token":
            return SimpleNamespace(
                is_error=False, truncated=False, payload={"startPageToken": "start"}
            )
        if len(calls) == 1:
            if reset == "expired":
                raise DriveReadError("source_unavailable")
            return changes_page([{"changeType": "drive"}])
        return changes_page([file_change("edited", version="2")])

    saved = (
        None
        if reset is None
        else inventory.LocalInventory([inventory_row("old")], True, False, "old", "old").checkpoint(
            completed=True
        )
    )
    result = await inventory.load_inventory(SimpleNamespace(read_tool=read), "owner", saved=saved)
    assert calls[-3:] == ["changes_start_token", "listing", "list_changes"]
    assert result.rows == [inventory_row("edited", "2")] and result.mode == "full"


@pytest.mark.parametrize("failure", ["truncated", "cycle", "revoked"])
async def test_incremental_inventory_refuses_incomplete_or_revoked_delta_without_advancing(failure):
    from scripts import drive_group_local_inventory as inventory

    saved = inventory.LocalInventory([inventory_row("old")], True, False, "old", "old").checkpoint(
        completed=True
    )
    before = json.dumps(saved)
    if failure == "revoked":
        read = AsyncMock(side_effect=DriveReadError("connection_changed"))
    else:
        page = changes_page([], following="old", terminal=None)
        page.truncated = failure == "truncated"
        read = AsyncMock(return_value=page)
    with pytest.raises(DriveReadError, match="provider_response_invalid|connection_changed"):
        await inventory.load_inventory(SimpleNamespace(read_tool=read), "owner", saved=saved)
    assert json.dumps(saved) == before
