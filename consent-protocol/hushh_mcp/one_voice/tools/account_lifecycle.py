"""Reset and delete the signed-in person's account from One Voice.

Both are the most consequential things a person can ask One to do, so both
are ``confirm_tap``: the card names the exact effect and only a physical tap
on it can arm anything. A spoken or typed "yes" never can.

Neither executes on the server. The vault-owner authority these operations
need is resolved on the device (it may require a vault unlock the device has
to show), and the device also owns the cleanup that must follow -- cache
purge, local state, sign-out, navigation. So the tap issues a *device step*
bound to this owner and operation; the device runs the existing lifecycle
flow (``resolveDeleteAccountAuth`` → ``AccountService.resetAccount`` /
``executeVerifiedAccountDeletion``) and reports what happened.

The device's report is never the outcome. ``report_account_lifecycle`` re-reads
the server: a reset is proven by the ``vault_keys`` columns ``reset_account``
stamps, a deletion by the lifecycle tombstone. What the card and the model get
is that verified reading, so "reset" and "deleted" are only ever spoken about
state the server can see, and a lost device reply still resolves honestly.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Literal

from pydantic import Field

from hushh_mcp.one_voice.tools.base import (
    Prepared,
    Rejected,
    ToolContext,
    ToolInput,
    ToolPolicy,
    ToolResult,
    ToolSpec,
)
from hushh_mcp.services.account_deletion_lifecycle_service import (
    AccountDeletionLifecycleService,
)
from hushh_mcp.services.account_service import AccountService

ACCOUNT_SERVICE = "account"
LIFECYCLE_SERVICE = "account_lifecycle"

STEP_KIND = "account_lifecycle"
STEP_TIMEOUT_S = 180

Operation = Literal["reset", "delete"]
ClientStatus = Literal[
    "reset",
    "not_reset",
    "deleted",
    "needs_unlock",
    "auth_failed",
    "blocked_external",
    "failed",
    "unknown",
]

RESET_SUMMARY = (
    "reset your Hussh account: keep your sign-in and vault, clear your personal setup "
    "and data, and start onboarding again"
)
DELETE_SUMMARY = (
    "permanently delete your Hussh account, its Memory, connections and shares. "
    "This cannot be undone"
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _account(ctx: ToolContext) -> Any:
    return ctx.service(ACCOUNT_SERVICE, AccountService)


def _lifecycle(ctx: ToolContext) -> Any:
    return ctx.service(LIFECYCLE_SERVICE, AccountDeletionLifecycleService)


async def _is_tombstoned(ctx: ToolContext) -> bool:
    return bool(await asyncio.to_thread(_lifecycle(ctx).is_tombstoned, ctx.user_id))


async def _reset_evidence(ctx: ToolContext) -> dict[str, Any] | None:
    return await asyncio.to_thread(_account(ctx).read_reset_evidence, ctx.user_id)


def _step(operation: Operation, ctx: ToolContext) -> dict[str, Any]:
    return {
        "kind": STEP_KIND,
        "operation": operation,
        "user_id": ctx.user_id,
        "issued_at_ms": _now_ms(),
        "timeout_s": STEP_TIMEOUT_S,
    }


# -- reset_account -------------------------------------------------------------


class ResetAccountInput(ToolInput):
    pass


class ResetAccountResult(ToolResult):
    status: Literal["reset_step_issued", "account_deleted", "unavailable"]
    client_step: dict[str, Any] | None = None


async def prepare_reset(ctx: ToolContext, args: ResetAccountInput) -> Prepared | ToolResult:
    try:
        if await _is_tombstoned(ctx):
            return ResetAccountResult(
                status="account_deleted",
                reason_code="account_deleted",
                spoken_facts=[
                    "This account has already been deleted, so there is nothing to reset."
                ],
            )
    except Exception:  # noqa: BLE001 - lifecycle read unavailable
        return Rejected(
            reason_code="lifecycle_unavailable",
            spoken_facts=["I can't check your account right now, so I didn't start a reset."],
        )
    return Prepared(summary=RESET_SUMMARY, snapshot={"user_id": ctx.user_id})


def summarize_reset(ctx: ToolContext, args: ResetAccountInput) -> str:
    return RESET_SUMMARY


async def reset_account(ctx: ToolContext, args: ResetAccountInput) -> ToolResult:
    snapshot = ctx.prepared or {}
    if str(snapshot.get("user_id") or "") != ctx.user_id:
        return Rejected(
            reason_code="owner_changed",
            spoken_facts=["The signed-in account changed, so I didn't reset anything."],
        )
    return ResetAccountResult(
        status="reset_step_issued",
        needs="client_step",
        spoken_facts=["Resetting your account now."],
        client_step=_step("reset", ctx),
    )


# -- delete_account ------------------------------------------------------------


class DeleteAccountInput(ToolInput):
    pass


class DeleteAccountResult(ToolResult):
    status: Literal["delete_step_issued", "account_deleted", "unavailable"]
    client_step: dict[str, Any] | None = None


async def prepare_delete(ctx: ToolContext, args: DeleteAccountInput) -> Prepared | ToolResult:
    try:
        if await _is_tombstoned(ctx):
            return DeleteAccountResult(
                status="account_deleted",
                reason_code="account_deleted",
                spoken_facts=["This account has already been deleted."],
            )
    except Exception:  # noqa: BLE001
        return Rejected(
            reason_code="lifecycle_unavailable",
            spoken_facts=["I can't check your account right now, so I didn't start a deletion."],
        )
    return Prepared(summary=DELETE_SUMMARY, snapshot={"user_id": ctx.user_id})


def summarize_delete(ctx: ToolContext, args: DeleteAccountInput) -> str:
    return DELETE_SUMMARY


async def delete_account(ctx: ToolContext, args: DeleteAccountInput) -> ToolResult:
    snapshot = ctx.prepared or {}
    if str(snapshot.get("user_id") or "") != ctx.user_id:
        return Rejected(
            reason_code="owner_changed",
            spoken_facts=["The signed-in account changed, so I didn't delete anything."],
        )
    return DeleteAccountResult(
        status="delete_step_issued",
        needs="client_step",
        spoken_facts=["Deleting your account now."],
        client_step=_step("delete", ctx),
    )


# -- report_account_lifecycle --------------------------------------------------


class ReportAccountLifecycleInput(ToolInput):
    operation: Operation
    client_status: ClientStatus = Field(
        description="What the device reported after running the step. Never trusted on its own."
    )
    issued_at_ms: int = Field(ge=0)


class ReportAccountLifecycleResult(ToolResult):
    status: Literal[
        "account_reset",
        "account_deleted",
        "needs_unlock",
        "blocked_external",
        "not_changed",
        "unverified",
    ]
    operation: Operation


def _verified(
    operation: Operation, status: str, facts: list[str], **extra: Any
) -> ReportAccountLifecycleResult:
    return ReportAccountLifecycleResult(
        status=status,  # type: ignore[arg-type]
        operation=operation,
        spoken_facts=facts,
        **extra,
    )


async def report_account_lifecycle(
    ctx: ToolContext, args: ReportAccountLifecycleInput
) -> ToolResult:
    """Decide the outcome from the server, using the device's report only to
    choose between honest wordings of *not changed*."""
    if args.operation == "delete":
        try:
            tombstoned = await _is_tombstoned(ctx)
        except Exception:  # noqa: BLE001
            return _verified(
                "delete",
                "unverified",
                [
                    "I couldn't confirm whether your account was deleted. "
                    "Please sign in again to check before trying again."
                ],
                reason_code="lifecycle_unavailable",
            )
        if tombstoned:
            return _verified("delete", "account_deleted", ["Your account has been deleted."])
        if args.client_status == "needs_unlock":
            return _verified(
                "delete",
                "needs_unlock",
                ["Unlock your vault in Profile first, then ask me again to delete your account."],
                reason_code="vault_locked",
            )
        if args.client_status == "blocked_external":
            return _verified(
                "delete",
                "blocked_external",
                [
                    "Your private agent or cloud setup has to be removed before the account "
                    "can be deleted. Nothing was deleted."
                ],
                reason_code="external_resources_require_deprovisioning",
            )
        if args.client_status == "unknown":
            return _verified(
                "delete",
                "unverified",
                [
                    "I couldn't confirm whether your account was deleted. "
                    "Please sign in again to check before trying again."
                ],
                reason_code="outcome_unknown",
            )
        return _verified(
            "delete",
            "not_changed",
            ["Account deletion didn't complete. Nothing was deleted."],
            reason_code=f"client_{args.client_status}",
        )

    # reset
    try:
        evidence = await _reset_evidence(ctx)
    except Exception:  # noqa: BLE001
        return _verified(
            "reset",
            "unverified",
            ["I couldn't confirm whether your account was reset."],
            reason_code="evidence_unavailable",
        )
    if evidence is None:
        return _verified(
            "reset",
            "unverified",
            ["I couldn't find your account setup to confirm a reset."],
            reason_code="no_vault_row",
        )
    stamped = evidence.get("setup_state_updated_at_ms")
    reset_seen = evidence.get("setup_completed") is None and (
        isinstance(stamped, int) and stamped >= int(args.issued_at_ms)
    )
    if reset_seen:
        return _verified(
            "reset",
            "account_reset",
            ["Your account has been reset. Setup will start again."],
            ui_refresh=["profile", "onboarding"],
        )
    if args.client_status == "needs_unlock":
        return _verified(
            "reset",
            "needs_unlock",
            ["Unlock your vault in Profile first, then ask me again to reset your account."],
            reason_code="vault_locked",
        )
    if args.client_status in {"unknown", "reset"}:
        # The device says reset (or lost its reply) but the server shows no
        # fresh stamp: never narrate a reset the server cannot see.
        return _verified(
            "reset",
            "unverified",
            ["I couldn't confirm the reset on the server yet. Check Profile before trying again."],
            reason_code="stamp_not_seen",
        )
    return _verified(
        "reset",
        "not_changed",
        ["Your account was not reset."],
        reason_code=f"client_{args.client_status}",
    )


TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="reset_account",
        gateway_action_id="profile.reset_account",
        policy=ToolPolicy.confirm_tap,
        input_model=ResetAccountInput,
        output_model=ResetAccountResult,
        description=(
            "Reset the person's own Hussh account after they tap Confirm: keeps their sign-in "
            "and vault, clears personal setup and data, and restarts onboarding. Use only for a "
            "clear request to reset or start the account over -- not for 'start over' about a "
            "draft or this conversation, and never as a substitute for deleting. A spoken yes "
            "cannot arm it. It returns reset_step_issued, which means the device is running the "
            "reset; the server then verifies it (report_account_lifecycle). Never say 'reset' "
            "from this result."
        ),
        handler=reset_account,
        ui_refresh=("profile", "onboarding"),
        firebase_plane=True,
        summarize=summarize_reset,
        prepare=prepare_reset,
        device_step=True,
    ),
    ToolSpec(
        name="delete_account",
        gateway_action_id="profile.delete_account",
        policy=ToolPolicy.confirm_tap,
        input_model=DeleteAccountInput,
        output_model=DeleteAccountResult,
        description=(
            "Permanently delete the person's own Hussh account after they tap Confirm. Use only "
            "for a clear request to delete the account; a question, a quote, 'do not delete', or "
            "an ambiguous 'remove my profile' is not one -- clarify once. Never substitute it for "
            "a reset or a sign-out. A spoken yes cannot arm it. It returns delete_step_issued, "
            "which means the device is running the deletion; the server then verifies it "
            "(report_account_lifecycle). Never say 'deleted' from this result."
        ),
        handler=delete_account,
        ui_refresh=("profile",),
        firebase_plane=True,
        summarize=summarize_delete,
        prepare=prepare_delete,
        device_step=True,
    ),
    ToolSpec(
        name="report_account_lifecycle",
        gateway_action_id="route.profile",
        policy=ToolPolicy.read,
        input_model=ReportAccountLifecycleInput,
        output_model=ReportAccountLifecycleResult,
        description=(
            "Server-verified outcome of a reset or deletion the device just ran. The runtime "
            "calls this after the device step settles; it reads the server, never the device's "
            "claim. Not for the person to ask for directly."
        ),
        handler=report_account_lifecycle,
    ),
)

__all__ = [
    "TOOLS",
    "STEP_KIND",
    "ReportAccountLifecycleResult",
    "ResetAccountResult",
    "DeleteAccountResult",
]
