"""Local export inventory: reuse a complete snapshot and replay fenced Drive changes.

The snapshot and cursor contain metadata only. Placements remain version-bound in
the export checkpoint. A cursor advances past changes only with their completed
placements; interrupted batches replay from the previous cursor.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from hushh_mcp.services.drive_group_index_job import (
    MAX_INDEXED_FILES,
    DriveGroupIndexJob,
    _validate_row,
)
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import FILE_ID, DriveReadError

_NOT_FILES = {"application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"}


class InventoryReads(Protocol):
    async def read_tool(
        self, *, user_id: str, tool_name: str, arguments: dict[str, Any]
    ) -> ExternalMcpToolResult: ...


def _cursor(value: object) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 2048
        or any(ord(char) < 32 for char in value)
    ):
        raise DriveReadError("provider_response_invalid")
    return value


@dataclass(frozen=True, slots=True)
class LocalInventory:
    rows: list[dict[str, Any]]
    complete: bool
    limited: bool
    before: str | None = None
    after: str | None = None
    mode: str = "full"

    def checkpoint(self, *, completed: bool) -> dict[str, Any]:
        return {
            "schema": 1,
            "rows": self.rows,
            "complete": self.complete,
            "limited": self.limited,
            "cursor": self.after if completed else self.before,
        }


async def _changes(
    reads: InventoryReads, user: str, rows: list[dict[str, Any]], cursor: str
) -> tuple[list[dict[str, Any]], str] | None:
    entries = {row["id"]: row for row in rows}
    seen, page_size = {cursor}, 200
    for _ in range(100):
        while True:
            try:
                result = await reads.read_tool(
                    user_id=user,
                    tool_name="list_changes",
                    arguments={"pageToken": cursor, "pageSize": page_size},
                )
                break
            except DriveReadError as error:
                if str(error) != "file_too_large" or page_size == 25:
                    raise
                page_size = 25
        payload = result.payload
        if result.is_error or result.truncated or not isinstance(payload, dict):
            raise DriveReadError("provider_response_invalid")
        changes = payload.get("changes")
        if not isinstance(changes, list) or len(changes) > page_size:
            raise DriveReadError("provider_response_invalid")
        following, terminal = payload.get("nextPageToken"), payload.get("newStartPageToken")
        if (following is None) == (terminal is None):
            raise DriveReadError("provider_response_invalid")
        next_cursor = _cursor(following if following is not None else terminal)
        for change in changes:
            if not isinstance(change, dict):
                raise DriveReadError("provider_response_invalid")
            kind, identity = change.get("changeType"), change.get("fileId")
            if kind == "drive":
                # Membership changes require an authoritative inventory again.
                return None
            if kind != "file" or not isinstance(identity, str) or not FILE_ID.fullmatch(identity):
                raise DriveReadError("provider_response_invalid")
            if type(change.get("removed")) is not bool or type(change.get("trashed")) is not bool:
                raise DriveReadError("provider_response_invalid")
            if change["removed"] or change["trashed"]:
                entries.pop(identity, None)
                continue
            row = change.get("file")
            if not isinstance(row, dict) or row.get("id") != identity:
                raise DriveReadError("provider_response_invalid")
            if row.get("mimeType") in _NOT_FILES:
                entries.pop(identity, None)
                continue
            _validate_row(row)
            entries[identity] = row
            if len(entries) > MAX_INDEXED_FILES:
                return None
        if following is None:
            return list(entries.values()), next_cursor
        if next_cursor in seen:
            raise DriveReadError("provider_response_invalid")
        seen.add(next_cursor)
        cursor = next_cursor
    raise DriveReadError("provider_response_invalid")


async def load_inventory(
    reads: InventoryReads, user: str, *, saved: dict[str, Any] | None = None
) -> LocalInventory:
    if isinstance(saved, dict) and saved.get("schema") == 1 and saved.get("complete") is True:
        rows, cursor = saved.get("rows"), _cursor(saved.get("cursor"))
        if not isinstance(rows, list) or len(rows) > MAX_INDEXED_FILES:
            raise DriveReadError("provider_response_invalid")
        for row in rows:
            _validate_row(row)
        if len({row["id"] for row in rows}) != len(rows):
            raise DriveReadError("provider_response_invalid")
        try:
            changed = await _changes(reads, user, rows, cursor)
        except DriveReadError as error:
            # The existing adapter maps expired/invalid cursors (410) to this
            # closed label. Rebuild through the same fences; never trust a gap.
            if str(error) != "source_unavailable":
                raise
        else:
            if changed is not None:
                return LocalInventory(changed[0], True, False, cursor, changed[1], "changes")

    for _ in range(2):
        start = await reads.read_tool(user_id=user, tool_name="changes_start_token", arguments={})
        if start.is_error or start.truncated or not isinstance(start.payload, dict):
            raise DriveReadError("provider_response_invalid")
        before = _cursor(start.payload.get("startPageToken"))
        rows, complete, limited = await DriveGroupIndexJob.list_files(reads, user)
        if not complete or limited:
            return LocalInventory(rows, complete, limited)
        changed = await _changes(reads, user, rows, before)
        if changed is not None:
            return LocalInventory(changed[0], True, False, before, changed[1])
    raise DriveReadError("provider_response_invalid")
