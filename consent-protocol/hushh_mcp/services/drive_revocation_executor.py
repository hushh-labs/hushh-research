"""Owner-confirmed removal only; no Drive content, recipient token or general writes."""

import asyncio

from hushh_mcp.services.drive_permission_executor import (
    DrivePermissionExecutor,
    verified_issuer,
)
from hushh_mcp.services.drive_revocation_store import DriveRevocationStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import DrivePermissionError


def current_recorded_viewer(snapshot, plan):
    current = next(
        (item for item in snapshot.permissions if item["id"] == plan["permission_id"]), None
    )
    if current is None:
        return None
    details = current.get("permissionDetails")
    if (
        current.get("type") != "user"
        or current.get("role") != "reader"
        or current.get("emailAddress", "").casefold() != plan["recipient_email"].casefold()
        or current.get("deleted") is True
        or current.get("pendingOwner") is True
        or current.get("expirationTime") is not None
        or not isinstance(details, list)
        or not details
        or any(
            item.get("inherited") is not False
            or item.get("permissionType") != "file"
            or item.get("role") != "reader"
            for item in details
        )
    ):
        raise DriveSharingError("permission_changed_manage_in_google")
    return current


class DriveRevocationExecutor(DrivePermissionExecutor):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if kwargs.get("store") is None:
            self.store = DriveRevocationStore(db=self.oauth.lifecycle.db)

    async def revoke(self, *, user_id, operation_id):
        job = await self.store.claim_revoke(user_id=user_id, operation_id=operation_id)
        if job is None:
            return "not_claimed"
        dispatched = provider_succeeded = False
        try:
            async with asyncio.timeout(75):
                plan = self.store._plan(job)
                row, credentials = await self.oauth.current_credential(user_id=user_id)
                issuer = verified_issuer(credentials)
                if row["connection_generation"] != job["connection_generation"]:
                    raise DriveSharingError("connection_changed")
                if issuer != plan["issuer"]:
                    raise DriveSharingError("reconnect_original_account")
                args = {
                    "file_id": plan["file_id"],
                    "access_token": credentials["accessToken"],
                    "require_current": lambda: self.store.require_current(job),
                }
                await self.adapter.inspect_permission_management(**args)
                before = await self.adapter.list_permissions(**args)
                existing = current_recorded_viewer(before, plan)
                if existing is None:
                    await self.store.require_current(job)
                    await self.store.settle(
                        job,
                        state="absent",
                        evidence={
                            "before": list(before.permissions),
                            "managed": False,
                            "other_access_may_remain": True,
                        },
                    )
                    return "absent"
                await self.store.mark_dispatching(
                    job, before=list(before.permissions), issuer=issuer
                )
                dispatched = True
                await self.adapter.remove_recorded_permission(
                    **args, recorded_permission_id=plan["permission_id"]
                )
                provider_succeeded = True
                await self.store.settle(
                    job,
                    state="succeeded",
                    evidence={
                        "removed_permission_id": plan["permission_id"],
                        "other_access_may_remain": True,
                    },
                )
                return "succeeded"
        except (DriveReadError, TimeoutError) as error:
            if provider_succeeded:
                raise
            unknown = dispatched and (
                not isinstance(error, DrivePermissionError) or error.outcome_unknown
            )
            state = "unknown" if unknown else "rejected" if dispatched else "not_dispatched"
            code = (
                str(error)
                if isinstance(error, DriveReadError)
                else "permission_outcome_unknown"
                if unknown
                else "permission_unavailable"
            )
            await self.store.settle(
                job, state=state, evidence={"other_access_may_remain": True}, safe_error_code=code
            )
            return state
