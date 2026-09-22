"""One fixed, owner-approved Viewer grant; no agent/tool/API HTTP passthrough."""

from __future__ import annotations

import asyncio
from dataclasses import asdict

from firebase_admin import auth as firebase_auth

from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import (
    DrivePermissionError,
    GoogleDrivePermissionAdapter,
)


async def require_recipient_identity(recipient: dict) -> None:
    """Recheck the same verified Google provider identity, not primary/cache email."""
    try:
        user = await asyncio.to_thread(firebase_auth.get_user, recipient["user_id"])
        candidates = [item for item in user.provider_data if item.provider_id == "google.com"]
        if (
            user.disabled
            or len(candidates) != 1
            or candidates[0].uid != recipient["subject"]
            or candidates[0].email != recipient["email"]
        ):
            raise DriveSharingError("recipient_changed")
    except DriveSharingError:
        raise
    except Exception:
        raise DriveSharingError("recipient_verification_unavailable", retryable=True) from None


def existing_individual_permission(snapshot, *, email: str) -> dict | None:
    for permission in snapshot.permissions:
        if (
            permission["type"] == "user"
            and not permission.get("emailAddress")
            and permission.get("deleted") is not True
        ):
            # An incomplete identity list cannot prove this recipient is absent.
            raise DriveSharingError("permission_catalog_incomplete")
        if (
            permission["type"] == "user"
            and permission.get("emailAddress", "").casefold() == email.casefold()
            and permission.get("deleted") is not True
        ):
            return dict(permission)
    return None


def verified_issuer(credentials: dict) -> dict:
    """Only server-verified OAuth credentials may supply receipt identity."""
    subject, client = credentials.get("subject"), credentials.get("oauthClientId")
    if (
        not isinstance(subject, str)
        or not 1 <= len(subject) <= 255
        or not isinstance(client, str)
        or not 1 <= len(client) <= 512
    ):
        raise DriveSharingError("reconnect_required")
    return {"subject": subject, "oauthClientId": client}


class DrivePermissionExecutor:
    def __init__(self, *, store=None, oauth=None, adapter=None, verify_recipient=None):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DrivePermissionStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDrivePermissionAdapter()
        self.verify_recipient = verify_recipient or require_recipient_identity

    async def grant(self, *, user_id: str, operation_id: str) -> str:
        job = await self.store.claim_grant(user_id=user_id, operation_id=operation_id)
        if job is None:
            return "not_claimed"
        dispatched = False
        provider_succeeded = False
        try:
            async with asyncio.timeout(75):
                plan = self.store._plan(job)
                await self.verify_recipient(plan["recipient"])
                row, credentials = await self.oauth.current_credential(user_id=user_id)
                if row["connection_generation"] != job["connection_generation"]:
                    raise DriveSharingError("connection_changed")
                issuer = verified_issuer(credentials)
                args = {
                    "file_id": plan["file_id"],
                    "access_token": credentials["accessToken"],
                    "require_current": lambda: self.store.require_current(job),
                }
                await self.adapter.inspect_shareable(
                    **args, expected_version=plan["source_version"]
                )
                before = await self.adapter.list_permissions(**args)
                existing = existing_individual_permission(before, email=plan["recipient"]["email"])
                if existing is not None:
                    # Never downgrade an existing writer/owner or claim its provenance.
                    await self.store.require_current(job)
                    await self.store.settle(
                        job,
                        state="preexisting",
                        evidence={
                            "before": list(before.permissions),
                            "existing": existing,
                            "managed": False,
                        },
                    )
                    return "preexisting"
                # No-await gap after this commit is required for safety: durable
                # dispatching is conservative even if cancellation precedes POST.
                await self.store.mark_dispatching(
                    job, before=list(before.permissions), issuer=issuer
                )
                dispatched = True
                created = await self.adapter.create_reader(
                    **args, verified_email=plan["recipient"]["email"]
                )
                provider_succeeded = True
                # A receipt is recorded even after owner disconnect. No raw
                # result returns to the browser or enters persistent tool history.
                await self.store.settle(
                    job,
                    state="succeeded",
                    evidence={
                        "created": asdict(created),
                        "managed": True,
                        "provenance": "successful_create_after_complete_absence_check",
                    },
                )
                return "succeeded"
        except (DriveReadError, TimeoutError) as error:
            if provider_succeeded:
                # Never replace a known success with a fabricated failure when
                # durable receipt storage itself fails. Leave it reconcilable.
                raise
            unknown = dispatched and (
                not isinstance(error, DrivePermissionError) or error.outcome_unknown
            )
            state = "unknown" if unknown else "rejected" if dispatched else "not_dispatched"
            code = "permission_outcome_unknown" if unknown else "permission_unavailable"
            if isinstance(error, DriveReadError):
                code = str(error)
            await self.store.settle(
                job, state=state, evidence={"managed": False}, safe_error_code=code
            )
            return state
        # Cancellation or storage failure leaves the durable lease/dispatching
        # evidence intact. A later worker must reconcile with GET, never re-POST.

    async def reconcile(self, *, user_id: str, operation_id: str) -> str:
        target = await self.store.reconciliation_target(user_id=user_id, operation_id=operation_id)
        if not target or target["state"] not in {"dispatching", "unknown"}:
            return "not_claimed"
        row, credentials = await self.oauth.current_credential(user_id=user_id)
        job = await self.store.claim_reconciliation(
            user_id=user_id,
            operation_id=operation_id,
            generation=row["connection_generation"],
            issuer=verified_issuer(credentials),
        )
        if job is None:
            return "not_claimed"
        plan = self.store._plan(job)
        try:
            snapshot = await self.adapter.list_permissions(
                file_id=plan["file_id"],
                access_token=credentials["accessToken"],
                require_current=lambda: self.store.require_reconciliation_current(job),
            )
            present = (
                next(
                    (item for item in snapshot.permissions if item["id"] == plan["permission_id"]),
                    None,
                )
                if job["kind"] == "revoke"
                else existing_individual_permission(snapshot, email=plan["recipient"]["email"])
            )
            await self.store.require_reconciliation_current(job)
        except DriveReadError:
            # GET failure proves neither absence nor safe repeatability.
            return "unknown"
        state = (
            ("needs_review" if job["kind"] == "revoke" else "present_unattributed")
            if present is not None
            else "absent"
        )
        await self.store.settle(
            job,
            state=state,
            evidence={
                "reconciled": list(snapshot.permissions),
                "managed": False,
                "provenance": "reconciled_presence_only" if present else "reconciled_absence_only",
            },
        )
        # Neither result silently re-enqueues a mutation. Absent -> fresh review;
        # present -> Google management, not a Hushh-created grant revoke.
        return state
