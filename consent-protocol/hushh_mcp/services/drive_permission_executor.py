"""One fixed, owner-approved Viewer grant; no agent/tool/API HTTP passthrough."""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from functools import partial

from firebase_admin import auth as firebase_auth

from api.utils.firebase_admin import get_firebase_auth_app
from hushh_mcp.services.document_delivery import drive_bridge
from hushh_mcp.services.drive_permission_store import (
    RECONCILED_CREATE_PROVENANCE,
    DrivePermissionStore,
)
from hushh_mcp.services.drive_rest_admission import scoped_job
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    VerifiedGoogleRecipient,
    recipient_from_google_provider,
    recipient_from_verified_firebase_email,
)
from hushh_mcp.services.external_connector_oauth_service import get_external_connector_oauth_service
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import (
    SHARE_HINTS,
    DrivePermissionError,
    GoogleDrivePermissionAdapter,
    same_expiration,
)
from hushh_mcp.services.one_owner_admission import firebase_uid_for_owner_read
from hushh_mcp.services.owner_placement_guard import admit_hub_content, hub_content_check

# Reasons a reconciled absence may carry instead of a generic rejection.
SHARE_REFUSAL_CODES = frozenset({"recipient_needs_google_account", "drive_policy_blocked"})


async def require_recipient_identity(recipient: dict) -> None:
    """Recheck the same verified address before access or link delivery."""
    try:
        async with asyncio.timeout(6):
            identity_uid = await asyncio.to_thread(
                firebase_uid_for_owner_read, recipient["user_id"]
            )
            user = await asyncio.to_thread(
                firebase_auth.get_user, identity_uid, app=get_firebase_auth_app()
            )
        kind = recipient.get("kind", "google_provider")
        if kind == "calendar_grant":
            if user.uid != identity_uid or user.disabled:
                raise DriveSharingError("recipient_changed")
            from hushh_mcp.services.calendar_meeting_request_service import (
                verified_calendar_recipient,
            )

            current = await verified_calendar_recipient(
                recipient["user_id"],
                recipient["account_id"],
                expected_grant=recipient["grant_id"],
            )
            if current.subject != recipient["subject"] or current.email != recipient["email"]:
                raise DriveSharingError("recipient_changed")
        elif kind == "verified_email":
            try:
                current = recipient_from_verified_firebase_email(
                    recipient["user_id"], user, firebase_uid=identity_uid
                )
            except DriveSharingError:
                raise DriveSharingError("recipient_changed") from None
            if current.subject != recipient["subject"] or current.email != recipient["email"]:
                raise DriveSharingError("recipient_changed")
        elif kind == "google_provider":
            candidates = [item for item in user.provider_data if item.provider_id == "google.com"]
            if (
                user.uid != identity_uid
                or user.disabled
                or len(candidates) != 1
                or candidates[0].uid != recipient["subject"]
                or candidates[0].email != recipient["email"]
            ):
                raise DriveSharingError("recipient_changed")
        else:
            raise DriveSharingError("recipient_changed")
    except DriveSharingError:
        raise
    except Exception:
        raise DriveSharingError("recipient_verification_unavailable", retryable=True) from None


async def recipient_identity_for_user(user_id: str) -> VerifiedGoogleRecipient:
    """B's current Google identity, or a verified One email without one."""
    try:
        async with asyncio.timeout(6):
            identity_uid = await asyncio.to_thread(firebase_uid_for_owner_read, user_id)
            user = await asyncio.to_thread(
                firebase_auth.get_user, identity_uid, app=get_firebase_auth_app()
            )
    except Exception:
        raise DriveSharingError("recipient_verification_unavailable", retryable=True) from None
    candidates = [item for item in user.provider_data if item.provider_id == "google.com"]
    if user.uid != identity_uid or user.disabled or len(candidates) > 1:
        raise DriveSharingError("recipient_google_identity_required")
    if candidates:
        return recipient_from_google_provider(user_id, candidates[0])
    return recipient_from_verified_firebase_email(user_id, user, firebase_uid=identity_uid)


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


def attributable_reader(permission: dict, *, email: str, expiration_time: str | None) -> bool:
    """Whether a reconciled ACL is exactly the direct Viewer grant a create asked for.

    Callers use this only after a complete pre-POST absence check and a create
    Google answered with invalidSharingRequest. Another role, an expiry other
    than the one sent, or inherited access is never attributed: it stays
    present_unattributed and One never deletes it.
    """
    details = permission.get("permissionDetails")
    return (
        permission.get("type") == "user"
        and permission.get("role") == "reader"
        and isinstance(permission.get("emailAddress"), str)
        and permission["emailAddress"].casefold() == email.casefold()
        and permission.get("deleted") is not True
        and permission.get("pendingOwner") is not True
        and same_expiration(permission.get("expirationTime"), expiration_time)
        and (
            details is None
            or isinstance(details, list)
            and all(
                isinstance(item, dict)
                and item.get("inherited") is False
                and item.get("permissionType") == "file"
                and item.get("role") == "reader"
                for item in details
            )
        )
    )


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


def permission_request(file_id, credential, require_current):
    """Provider request arguments with the same freshness callback for every read/write."""
    return {
        "file_id": file_id,
        "access_token": credential["accessToken"],
        "require_current": require_current,
    }


class DrivePermissionExecutor:
    def __init__(self, *, store=None, oauth=None, adapter=None, verify_recipient=None):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DrivePermissionStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDrivePermissionAdapter()
        self.verify_recipient = verify_recipient or require_recipient_identity

    async def grant(self, *, user_id: str, operation_id: str) -> str:
        await admit_hub_content(user_id, "drive_permission_prepare")
        job = await self.store.claim_grant(user_id=user_id, operation_id=operation_id)
        if job is None:
            return "not_claimed"
        return await self._grant_job(job)

    @scoped_job()
    async def _grant_job(self, job):
        user_id = job["user_id"]
        require_current = hub_content_check(user_id, partial(self.store.require_current, job))
        dispatched = False
        provider_succeeded = False
        try:
            async with asyncio.timeout(75):
                plan = self.store._plan(job)
                await self.verify_recipient(plan["recipient"])
                row, credentials = await self.oauth.current_credential(
                    user_id=user_id,
                    required_profile="live" if plan.get("source_kind") == "live" else "selected",
                )
                if row["connection_generation"] != job["connection_generation"]:
                    raise DriveSharingError("connection_changed")
                issuer = verified_issuer(credentials)
                args = permission_request(plan["file_id"], credentials, require_current)
                inspect_options = (
                    {
                        "metadata_only": True,
                        "expected_name": plan.get("file_name"),
                        "time_field": plan["time_field"],
                        "start_time": plan["start_time"],
                        "end_time": plan["end_time"],
                    }
                    if plan.get("metadata_only")
                    else {}
                )
                await self.adapter.inspect_shareable(
                    **args,
                    expected_version=plan["source_version"],
                    require_app_authorized=plan.get("source_kind") != "live",
                    require_genai_eligibility=plan.get("source_kind") != "live",
                    **inspect_options,
                )
                before = await self.adapter.list_permissions(**args)
                # File inspection and permission listing can be slow. Recheck
                # B's address immediately before committing any share outcome.
                await self.verify_recipient(plan["recipient"])
                existing = existing_individual_permission(before, email=plan["recipient"]["email"])
                if existing is not None:
                    # Never downgrade an existing writer/owner or claim its provenance.
                    await require_current()
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
                created = await drive_bridge.create_reader(self.adapter, args, plan)
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
            if dispatched and not unknown and str(error) == "sharing_rate_limited":
                # Google refused the share itself. Wait minutes; the next claim
                # repeats the complete absence check before any later POST.
                if await self.store.defer_rate_limited(job):
                    return "deferred"
            state = "unknown" if unknown else "rejected" if dispatched else "not_dispatched"
            code = "permission_outcome_unknown" if unknown else "permission_unavailable"
            if isinstance(error, DriveReadError):
                code = str(error)
            evidence: dict = {"managed": False}
            if unknown and isinstance(error, DrivePermissionError) and error.share_hint:
                # Sealed in the receipt so read-only reconciliation can record
                # a grant that exists, or why none was created.
                evidence["share_hint"] = error.share_hint
            await self.store.settle(job, state=state, evidence=evidence, safe_error_code=code)
            return state
        # Cancellation or storage failure leaves the durable lease/dispatching
        # evidence intact. A later worker must reconcile with GET, never re-POST.

    def _share_hint(self, job) -> str | None:
        """The fixed hint this executor sealed when Google answered the create."""
        if not job.get("receipt_envelope"):
            return None
        try:
            receipt = self.store.sharing_cipher.open(
                job["receipt_envelope"],
                user_id=job["user_id"],
                resource_id=str(job["operation_id"]),
                purpose="permission-receipt",
            )
        except DriveReadError:
            # An unreadable receipt proves nothing: keep the conservative path.
            return None
        hint = receipt.get("share_hint") if isinstance(receipt, dict) else None
        return hint if hint in SHARE_HINTS else None

    async def reconcile(self, *, user_id: str, operation_id: str) -> str:
        target = await self.store.reconciliation_target(user_id=user_id, operation_id=operation_id)
        if not target or target["state"] not in {"dispatching", "unknown"}:
            return "not_claimed"
        target_plan = self.store._plan(target)
        row, credentials = await self.oauth.current_credential(
            cleanup=True,
            user_id=user_id,
            required_profile="live" if target_plan.get("source_kind") == "live" else "selected",
        )
        job = await self.store.claim_reconciliation(
            user_id=user_id,
            operation_id=operation_id,
            generation=row["connection_generation"],
            issuer=verified_issuer(credentials),
        )
        if job is None:
            return "not_claimed"
        return await self._reconcile_job(job, credentials)

    @scoped_job()
    async def _reconcile_job(self, job, credentials):
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
        hint = self._share_hint(job) if job["kind"] == "grant" else None
        if (
            hint
            and present is not None
            and attributable_reader(
                present,
                email=plan["recipient"]["email"],
                expiration_time=plan.get("expiration_time"),
            )
        ):
            # A complete absence check preceded the POST, and Google's answer can
            # follow a real share. The exact requested grant is One's to manage.
            await self.store.settle(
                job,
                state="succeeded",
                evidence={
                    "reconciled": list(snapshot.permissions),
                    "created": drive_bridge.created_reader_receipt(present),
                    "managed": True,
                    "provenance": RECONCILED_CREATE_PROVENANCE,
                },
            )
            return "succeeded"
        if hint and hint != "shared_without_email" and present is None:
            # No grant exists: report Google's refusal, never a blind retry.
            await self.store.settle(
                job,
                state="rejected",
                evidence={
                    "reconciled": list(snapshot.permissions),
                    "managed": False,
                    "provenance": "reconciled_absence_only",
                },
                safe_error_code=hint if hint in SHARE_REFUSAL_CODES else "permission_rejected",
            )
            return "rejected"
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
