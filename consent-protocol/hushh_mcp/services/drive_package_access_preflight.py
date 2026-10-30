"""Read-only recipient ACL evidence before charging for an exact approved packet.

An owner's ability to read a file is never evidence of the buyer's access.
Group/domain membership is not inferred from an email address. Unknown access
blocks checkout rather than treating an incomplete permission list as absence.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime

from hushh_mcp.services.drive_live_reader import DriveLiveReader
from hushh_mcp.services.drive_permission_executor import require_recipient_identity
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_permission_adapter import GoogleDrivePermissionAdapter

ACCESS_EVIDENCE_MAX_AGE_SECONDS = 60


@dataclass(frozen=True)
class PackageAccessResult:
    user_id: str = field(repr=False)
    request_id: str = field(repr=False)
    request_revision: int
    checked_at: datetime
    status: str
    recipient: dict = field(repr=False)
    files: tuple[dict, ...] = field(repr=False)


def _expiration(permission, now):
    value = permission.get("expirationTime")
    if value is None:
        return True
    try:
        deadline = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if deadline.tzinfo is None:
            raise ValueError()
        return deadline > now
    except (TypeError, ValueError, AttributeError):
        raise DriveSharingError("permission_catalog_incomplete") from None


def recipient_access(snapshot, *, email, now):
    """Present, absent or unknown from the complete, validated Drive ACL."""
    uncertain = False
    present = None
    for permission in snapshot.permissions:
        if permission.get("deleted") is True or not _expiration(permission, now):
            continue
        kind = permission["type"]
        if kind == "anyone" or (
            kind == "user" and permission.get("emailAddress", "").casefold() == email.casefold()
        ):
            present = {
                key: permission[key]
                for key in ("id", "type", "role", "expirationTime")
                if key in permission
            }
        elif kind == "user" and not permission.get("emailAddress"):
            uncertain = True
        elif kind in {"group", "domain"}:
            # The owner credential cannot establish the recipient's group or
            # Workspace membership. Never charge on this unproven absence.
            uncertain = True
    if present is not None:
        return "present", present
    return ("unknown", None) if uncertain else ("absent", None)


class DrivePackageAccessPreflight:
    def __init__(
        self,
        *,
        sharing,
        bulk,
        reader_factory=None,
        permission_adapter=None,
        verify_recipient=None,
    ):
        self.sharing = sharing
        self.bulk = bulk
        self.reader_factory = reader_factory or DriveLiveReader
        self.permissions = permission_adapter or GoogleDrivePermissionAdapter()
        self.verify_recipient = verify_recipient or require_recipient_identity

    async def inspect(self, *, user_id, request_id, require_current, files=None):
        checked_at = datetime.now(UTC)
        await require_current()
        context = await self.sharing.request_bulk_context(user_id=user_id, request_id=request_id)
        await require_current()
        recipient = {**context["recipient"], "user_id": context["recipientUserId"]}
        await self.verify_recipient(recipient)
        if files is None:
            files = await self.bulk.package_sources(user_id=user_id, request_id=request_id)
        if not files or len(files) > 120 or len({item["id"] for item in files}) != len(files):
            raise DriveSharingError("package_incomplete")
        reader = self.reader_factory(user_id=user_id, require_access=require_current)
        credential = await reader._credential()
        semaphore = asyncio.Semaphore(4)

        async def inspect(file):
            async with semaphore:
                await require_current()
                if reader._generation != file["generation"]:
                    raise DriveSharingError("connection_changed")
                args = {"file_id": file["id"], "access_token": credential["accessToken"]}

                async def source_current():
                    actual = await reader.adapter.get_share_metadata(
                        **args,
                        include_permissions=True,
                        **(
                            {"resource_key": file["resourceKey"]} if file.get("resourceKey") else {}
                        ),
                    )
                    # Agent packets pin the Drive version. Older automatic
                    # searches saved a modified timestamp instead; compare
                    # that frozen source fingerprint without interpreting it
                    # as the document's financial coverage period.
                    version = file.get("sourceVersion")
                    modified = file.get("modifiedTime")
                    if (
                        actual.name != file["name"]
                        or version is not None
                        and actual.version != version
                        or version is None
                        and (
                            not isinstance(modified, str)
                            or not modified
                            or actual.modified_time != modified
                        )
                    ):
                        raise DriveSharingError("source_changed")
                    await require_current()
                    return actual

                actual = await source_current()
                # The validated complete My Drive ACL and source identity came
                # from one fresh response. Other cases retain the fenced list.
                snapshot = getattr(actual, "permission_snapshot", None)
                if snapshot is None:
                    snapshot = await self.permissions.list_permissions(
                        **args,
                        require_current=require_current,
                        **(
                            {"resource_key": file["resourceKey"]} if file.get("resourceKey") else {}
                        ),
                    )
                    await source_current()
                state, permission = recipient_access(
                    snapshot, email=recipient["email"], now=datetime.now(UTC)
                )
                return {
                    "id": file["id"],
                    "name": file["name"],
                    "modifiedTime": file.get("modifiedTime"),
                    "sourceVersion": file.get("sourceVersion"),
                    "contentFingerprint": file.get("contentFingerprint"),
                    "generation": file["generation"],
                    "access": state,
                    "permission": permission,
                }

        tasks = [asyncio.create_task(inspect(file)) for file in files]
        try:
            async with asyncio.timeout(40):
                evidence = tuple(await asyncio.gather(*tasks))
        finally:
            # A failed file must not leave the other Google reads running
            # after checkout has already refused the selection.
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        await self.verify_recipient(recipient)
        await require_current()
        states = {item["access"] for item in evidence}
        status = (
            "unknown"
            if "unknown" in states
            else "all_existing"
            if states == {"present"}
            else "none"
            if states == {"absent"}
            else "mixed"
        )
        return PackageAccessResult(
            user_id=user_id,
            request_id=str(request_id),
            request_revision=context["revision"],
            checked_at=checked_at,
            status=status,
            recipient=recipient,
            files=evidence,
        )
