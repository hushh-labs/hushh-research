"""Renew only unperformed units of an existing, owner-encrypted command.

The directive ledger remains the authority. These functions compare its original
plan and receipts; they never resolve people or dispatch effects. Postgres locks
serialize concurrent resumes today; a future Redis adapter must preserve this CAS.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from typing import Any
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.location_command_audience_receipts import prepare_audience_plan
from hushh_mcp.services.location_command_membership_receipts import (
    MembershipPreparation,
    prepare_membership_plan,
)


def _remaining(
    store: ActionDirectiveStore,
    *,
    owner: str,
    outcome: dict[str, Any],
    preparation: MembershipPreparation,
    binding_digest: str,
) -> dict[str, Any]:
    actual = hashlib.sha256(f"{preparation.nonce}:{preparation.binding_json}".encode()).hexdigest()
    if not hmac.compare_digest(actual, binding_digest) or outcome.get(
        "resource_binding_hmac"
    ) != store._hmac({"digest": binding_digest}):
        raise ActionDirectiveAuthorityError("Resume requires the original encrypted selection.")
    action = outcome["action_id"]
    if action == "location.add_to_circle" and outcome.get("membership_plan"):
        kind = "membership"
        plan = prepare_membership_plan(
            preparation, owner=owner, binding_digest=binding_digest, store=store
        )
        stored, receipts = outcome["membership_plan"], outcome.get("membership_receipts") or {}
        keys = [str(index) for index in range(len(plan))]
        # A batch containing an invitation or an ineligible skip cannot be
        # split into different individual mutations under its original receipt.
        for key, receipt in receipts.items():
            expected = plan.get(key)
            result = receipt.get("result") or {}
            if not expected or any(receipt.get(field) != expected[field] for field in expected):
                raise ActionDirectiveAuthorityError(
                    "A membership receipt changed. Review the circle."
                )
            if (
                result.get("invites")
                or result.get("createdInviteIds")
                or result.get("invitedUserIds")
                or any(
                    value != "already_member"
                    for value in (result.get("skippedReasons") or {}).values()
                )
            ):
                raise ActionDirectiveAuthorityError(
                    "A recorded batch needs membership review before another task."
                )
    elif outcome.get("audience_plan"):
        kind = "audience"
        plan = prepare_audience_plan(
            preparation, action=action, owner=owner, binding_digest=binding_digest
        )
        stored, receipts = outcome["audience_plan"], outcome.get("audience_receipts") or {}
        keys = [
            store._hmac(person) for person in json.loads(preparation.binding_json)["recipientIds"]
        ]
        if any(
            key not in plan or value.get("terms") != plan[key]["terms"]
            for key, value in receipts.items()
        ):
            raise ActionDirectiveAuthorityError("An audience receipt changed. Review Location.")
    else:
        raise ActionDirectiveAuthorityError("This operation requires its authored review screen.")
    if plan != stored or set(receipts) - set(plan):
        raise ActionDirectiveAuthorityError("The original operation plan changed. Review Location.")
    completed = [index for index, key in enumerate(keys) if key in receipts]
    pending = [index for index, key in enumerate(keys) if key not in receipts]
    if not pending:
        raise ActionDirectiveAuthorityError(
            "All units have receipts. Refresh the completed result."
        )
    return {
        "kind": kind,
        "operation_id": outcome["operation_id"],
        "total_units": len(keys),
        "completed_unit_indices": completed,
        "pending_unit_indices": pending,
        "snapshot": store._hmac(
            [
                outcome["operation_id"],
                outcome["directive_id"],
                outcome["state"],
                kind,
                plan,
                receipts,
            ]
        ),
    }


def inspect_remaining_command(
    store: ActionDirectiveStore,
    *,
    owner: str,
    outcome: dict[str, Any],
    preparation: MembershipPreparation,
    binding_digest: str,
) -> dict[str, Any]:
    if (
        outcome.get("state") not in {"consumed", "issued", "confirmed"}
        or not outcome.get("consumed_at")
        or outcome.get("command_effect") != "action"
    ):
        raise ActionDirectiveAuthorityError("This operation has no unperformed command units.")
    return _remaining(
        store, owner=owner, outcome=outcome, preparation=preparation, binding_digest=binding_digest
    )


async def renew_remaining_command(
    store: ActionDirectiveStore,
    *,
    owner: str,
    command: str,
    step: int,
    checkpoint_revision: int,
    plan_digest: str,
    action: dict[str, Any],
    context_revision: str,
    preparation: MembershipPreparation,
    binding_digest: str,
    snapshot: str,
) -> dict[str, Any]:
    """Rotate attempt authority, preserving every original plan and receipt."""

    def transaction() -> dict[str, Any]:
        with store.db.engine.begin() as connection:
            params = {
                "owner": owner,
                "command": command,
                "step": step,
                "revision": checkpoint_revision,
                "plan": plan_digest,
            }
            session = connection.execute(
                text("""
                SELECT revision FROM one_adk_sessions
                WHERE app_name='one.location.commands.v1' AND user_id=:owner AND session_id=:command
                  AND revision=:revision AND command_plan_hmac=:plan
                  AND command_status IN ('ready','admitted')
                  AND created_at>NOW()-INTERVAL '24 hours' FOR UPDATE
            """),
                params,
            ).first()
            if not session:
                raise ActionDirectiveAuthorityError(
                    "The task changed or expired. Unlock and refresh it."
                )
            row = (
                connection.execute(
                    text("""
                SELECT * FROM one_action_directive_ledger WHERE user_id=:owner
                  AND session_id=:command AND command_step=:step AND channel='command' FOR UPDATE
            """),
                    params,
                )
                .mappings()
                .first()
            )
            if (
                not row
                or row["action_id"] != action["action_id"]
                or row["action_contract_digest"] != store._hmac(action)
            ):
                raise ActionDirectiveAuthorityError(
                    "The action contract changed. Review the remaining operation."
                )
            current = inspect_remaining_command(
                store,
                owner=owner,
                outcome=dict(row),
                preparation=preparation,
                binding_digest=binding_digest,
            )
            if not hmac.compare_digest(current["snapshot"], snapshot):
                raise ActionDirectiveAuthorityError(
                    "Another attempt changed the receipts. Refresh this task."
                )
            directive_id = f"dir_{uuid4().hex}"
            renewed = (
                connection.execute(
                    text("""
                UPDATE one_action_directive_ledger SET directive_id=:directive,
                  state='issued', context_revision=:context, receipt_hash=NULL,
                  confirmed_at=NULL, execution_receipt_hash=NULL, issued_at=clock_timestamp(),
                  expires_at=clock_timestamp()+INTERVAL '5 minutes', settlement_status=NULL,
                  settlement_reason_code=NULL, settled_at=NULL
                WHERE user_id=:owner AND session_id=:command AND command_step=:step AND channel='command'
                RETURNING directive_id,operation_id,context_revision,requires_confirmation,expires_at
            """),
                    {**params, "directive": directive_id, "context": context_revision},
                )
                .mappings()
                .one()
            )
            return dict(renewed)

    return await asyncio.to_thread(transaction)


async def pause_remaining_command(
    store: ActionDirectiveStore,
    *,
    owner: str,
    command: str,
    step: int,
    operation: str,
    execution_receipt: str,
) -> bool:
    """A partial executor result expires that attempt but retains its capsule.

    Lock the session before the directive, like domain writes and cancellation.
    A completed result wins a race and must be settled normally by the caller.
    """

    def transaction() -> bool:
        with store.db.engine.begin() as connection:
            params = {
                "owner": owner,
                "command": command,
                "step": step,
                "operation": operation,
                "receipt": hashlib.sha256(execution_receipt.encode()).hexdigest(),
            }
            session = connection.execute(
                text("""
                SELECT session_id FROM one_adk_sessions WHERE app_name='one.location.commands.v1'
                  AND user_id=:owner AND session_id=:command AND command_status IN ('ready','admitted')
                  AND created_at>NOW()-INTERVAL '24 hours' FOR UPDATE
            """),
                params,
            ).first()
            if not session:
                return False
            result = connection.execute(
                text("""
                UPDATE one_action_directive_ledger SET expires_at=LEAST(expires_at,clock_timestamp()),
                  settlement_reason_code='command_partial_resume_required'
                WHERE user_id=:owner AND session_id=:command AND command_step=:step AND channel='command'
                  AND state='consumed' AND operation_id=:operation AND execution_receipt_hash=:receipt
                  AND (membership_plan<>'{}'::jsonb OR audience_plan<>'{}'::jsonb)
                RETURNING directive_id
            """),
                params,
            ).first()
            return bool(result)

    return await asyncio.to_thread(transaction)
