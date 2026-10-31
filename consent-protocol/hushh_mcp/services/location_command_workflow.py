"""Join command authority to the existing Location workflow, without another cursor."""

from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy import text

from db.db_client import get_db
from hushh_mcp.services.action_directive_ledger import (
    ActionDirectiveAuthorityError,
    ActionDirectiveStore,
)
from hushh_mcp.services.app_intelligence_runtime import get_capability_workflow_revision_policy
from hushh_mcp.services.capability_run_service import CapabilityRunStore
from hushh_mcp.services.command_checkpoints import CommandCheckpointConflict, CommandCheckpointStore
from hushh_mcp.services.location_onboarding_runtime import (
    LOCATION_ONBOARDING_WORKFLOW_ID,
    LocationOnboardingLedgerStore,
    LocationOnboardingRuntimeService,
    get_location_onboarding_runtime_service,
)


class WorkflowAlreadyBound(ActionDirectiveAuthorityError):
    def __init__(self, command_id: str):
        super().__init__("Resume the existing Location setup task.")
        self.command_id = command_id


def workflow_command_descriptor(entry: dict[str, Any]) -> dict[str, Any]:
    workflow = entry.get("workflow") or {}
    execution = workflow.get("execution") or {}
    if (
        workflow.get("capability_id") != LOCATION_ONBOARDING_WORKFLOW_ID
        or execution.get("outcome") != "EXECUTE"
        or execution.get("mode") != "durable_capability_run"
        or execution.get("binding_ref") != "backend_workflow:workflow.setup.location:v2"
        or workflow.get("settlement_proof") != "server_location_onboarding_completion_receipt"
    ):
        raise ActionDirectiveAuthorityError("The Location workflow binding is unavailable.")
    # Internal ledger identity only: this is not an invented gateway action.
    return {
        "action_id": workflow["capability_id"],
        "label": workflow["label"],
        "execution_policy": "allow_direct",
        "activation_policy": "none",
        "_command_effect": "workflow",
        "workflow_contract": workflow,
    }


def workflow_revision_arguments() -> dict[str, Any]:
    policy = get_capability_workflow_revision_policy(LOCATION_ONBOARDING_WORKFLOW_ID)
    if policy.workflow_version != 2:
        raise ActionDirectiveAuthorityError("The Location workflow version is unavailable.")
    return {
        "graph_revision": policy.current_revision,
        "compatible_graph_revisions": policy.compatible_revisions,
        "migration_required_graph_revisions": policy.migration_required_revisions,
        "rejected_graph_revisions": policy.rejected_revisions,
    }


async def start_command_workflow(*, authority: dict[str, Any]) -> dict[str, Any]:
    policy = workflow_revision_arguments()

    def transaction() -> str:
        with get_db().engine.begin() as connection:
            # Postgres serializes command reservations today. The store seam can
            # move to a shared lease plane later without changing step identity.
            connection.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:owner, 0))"),
                {"owner": f"location-command-workflow:{authority['user_id']}"},
            )
            ledger = ActionDirectiveStore(connection=connection)
            workflow = LocationOnboardingRuntimeService(
                run_store=CapabilityRunStore(connection=connection),
                ledger_store=LocationOnboardingLedgerStore(connection=connection),
            )

            async def reserve() -> str:
                await ledger.claim_command(**authority)
                run = await workflow.reserve_run(
                    user_id=authority["user_id"],
                    context_revision=authority["context_revision"],
                    **policy,
                )
                live_run = (
                    connection.execute(
                        text(
                            """SELECT status FROM one_capability_runs
                       WHERE user_id=:user AND run_id=:run AND expires_at > clock_timestamp()
                       FOR UPDATE"""
                        ),
                        {"user": authority["user_id"], "run": run.run_id},
                    )
                    .mappings()
                    .first()
                )
                if not live_run or live_run["status"] in {
                    "cancelled",
                    "expired",
                    "verified_failed",
                }:
                    raise ActionDirectiveAuthorityError(
                        "The Location run changed. Refresh before continuing."
                    )
                connection.execute(
                    text(
                        """UPDATE one_capability_runs AS run
                       SET expires_at=LEAST(run.expires_at, command.created_at + INTERVAL '24 hours')
                       FROM one_adk_sessions AS command
                       WHERE run.user_id=:user AND run.run_id=:run
                         AND command.user_id=run.user_id AND command.session_id=:command
                         AND command.app_name='one.location.commands.v1'"""
                    ),
                    {
                        "user": authority["user_id"],
                        "run": run.run_id,
                        "command": authority["command_id"],
                    },
                )
                existing = await workflow.ledger_store.command_binding(
                    user_id=authority["user_id"],
                    run_id=run.run_id,
                )
                if existing and existing["command_id"] != authority["command_id"]:
                    # Raising rolls back this command's claim. The immutable
                    # locator identifies recovery, never an execution grant.
                    raise WorkflowAlreadyBound(existing["command_id"])
                await ledger.bind_command_workflow(
                    user_id=authority["user_id"],
                    command_id=authority["command_id"],
                    step=authority["step"],
                    run_id=run.run_id,
                )
                return run.run_id

            return asyncio.run(reserve())

    run_id = await asyncio.to_thread(transaction)
    # Commit the claim + exact run locator before any adapters or device work.
    # This method cannot restart an expired/cancelled reservation.
    return await get_location_onboarding_runtime_service().advance_reserved_run(
        user_id=authority["user_id"],
        run_id=run_id,
        full_guide_requested=False,
        **policy,
    )


async def reconcile_command_workflow(
    *,
    ledger: ActionDirectiveStore,
    user_id: str,
    command_id: str,
    step: int,
    outcome: dict[str, Any],
    resume: bool = False,
) -> dict[str, Any]:
    run_id = outcome.get("workflow_run_id")
    if outcome.get("command_effect") != "workflow" or not run_id:
        raise ActionDirectiveAuthorityError("The command has no bound workflow.")
    service = get_location_onboarding_runtime_service()
    # Exact reads never reserve another run after cancellation or response loss.
    read = service.advance_reserved_run if resume else service.get
    result = await read(
        user_id=user_id,
        run_id=run_id,
        **workflow_revision_arguments(),
        **({"renew_finalizer": True} if resume else {}),
    )
    bound = await service.run_store.get(user_id=user_id, run_id=run_id, include_slots=True)
    proof = bound if result.get("completion_claim_allowed") is True else None
    if bound and not proof and await service._has_verified_prior_completion(bound):
        # A status-only view reuses the exact original receipt chain. It does
        # not replay onboarding or manufacture receipts on the newer run.
        proof = await service.run_store.get(
            user_id=user_id, run_id=bound.slots["verified_prior_run_id"], include_slots=True
        )
    if proof:
        receipts = await service.ledger_store.list_receipts(user_id=user_id, run_id=proof.run_id)
        if not service._is_bound_verified_completion(proof, receipts):
            raise ActionDirectiveAuthorityError("The workflow completion receipt is unavailable.")
        if proof.run_id != run_id:
            await _settle_completed_view(
                user_id=user_id, command_id=command_id, step=step, run_id=run_id
            )
        else:
            await ledger.settle_workflow_command(
                user_id=user_id,
                command_id=command_id,
                step=step,
                run_id=run_id,
                run_revision=proof.revision,
                settlement_reference_hmac=proof.settlement_reference_hmac,
                verified_run_id=proof.run_id,
            )
    return result


async def _settle_completed_view(*, user_id: str, command_id: str, step: int, run_id: str) -> None:
    """Settle from the original proof and close its informational view atomically."""

    def transaction() -> None:
        with get_db().engine.begin() as connection:
            # Same lock order as dispatch/cancellation/finalization. A response
            # loss cannot leave an open view attached to a completed command.
            connection.execute(
                text("""SELECT session_id FROM one_adk_sessions
                WHERE app_name='one.location.commands.v1' AND user_id=:user
                  AND session_id=:command FOR UPDATE"""),
                {"user": user_id, "command": command_id},
            )
            connection.execute(
                text("""SELECT directive_id FROM one_action_directive_ledger
                WHERE user_id=:user AND session_id=:command AND command_step=:step
                  AND channel='command' FOR UPDATE"""),
                {"user": user_id, "command": command_id, "step": step},
            )
            connection.execute(
                text("""SELECT run_id FROM one_capability_runs
                WHERE user_id=:user AND run_id=:run FOR UPDATE"""),
                {"user": user_id, "run": run_id},
            )
            ledger = ActionDirectiveStore(connection=connection)
            service = LocationOnboardingRuntimeService(
                run_store=CapabilityRunStore(connection=connection),
                ledger_store=LocationOnboardingLedgerStore(connection=connection),
            )

            async def settle() -> None:
                bound = await service.run_store.get(
                    user_id=user_id, run_id=run_id, include_slots=True
                )
                if not bound or not await service._has_verified_prior_completion(bound):
                    raise ActionDirectiveAuthorityError(
                        "The original Location completion is unavailable."
                    )
                proof = await service.run_store.get(
                    user_id=user_id, run_id=bound.slots["verified_prior_run_id"], include_slots=True
                )
                await ledger.settle_workflow_command(
                    user_id=user_id,
                    command_id=command_id,
                    step=step,
                    run_id=run_id,
                    run_revision=proof.revision,
                    settlement_reference_hmac=proof.settlement_reference_hmac,
                    verified_run_id=proof.run_id,
                )
                if not bound.is_terminal:
                    # Cancel just the status continuation; never create another
                    # success receipt or change the original completed run.
                    await service.cancel(
                        user_id=user_id, run_id=run_id, expected_revision=bound.revision
                    )

            asyncio.run(settle())

    await asyncio.to_thread(transaction)


async def cancel_command_workflow(
    *,
    user_id: str,
    outcome: dict[str, Any],
    service: LocationOnboardingRuntimeService | None = None,
) -> None:
    run_id = outcome.get("workflow_run_id")
    if not run_id:
        return
    service = service or get_location_onboarding_runtime_service()
    run = await service.run_store.get(user_id=user_id, run_id=run_id, include_slots=True)
    if run is None:
        return  # The workflow's own retention has already removed its continuation.
    if run.capability_id != LOCATION_ONBOARDING_WORKFLOW_ID:
        raise ActionDirectiveAuthorityError("The workflow owner does not match this command.")
    if not run.is_terminal:
        await service.cancel(user_id=user_id, run_id=run_id, expected_revision=run.revision)


async def cancel_bound_command(
    *, user_id: str, command_id: str, state: dict[str, Any], cipher: Any
) -> dict[str, Any]:
    """Cancel under the same session → directive → workflow lock order as dispatch."""

    def transaction() -> dict[str, Any]:
        with get_db().engine.begin() as connection:
            locked = connection.execute(
                text(
                    """SELECT session_id FROM one_adk_sessions
                   WHERE app_name='one.location.commands.v1' AND user_id=:user
                     AND session_id=:command AND revision=:revision FOR UPDATE"""
                ),
                {"user": user_id, "command": command_id, "revision": state["revision"]},
            ).first()
            if not locked:
                raise CommandCheckpointConflict("The command changed. Refresh before cancelling.")
            ledger = ActionDirectiveStore(connection=connection)
            checkpoints = CommandCheckpointStore(connection=connection, cipher=cipher)
            workflow = LocationOnboardingRuntimeService(
                run_store=CapabilityRunStore(connection=connection),
                ledger_store=LocationOnboardingLedgerStore(connection=connection),
            )

            async def cancel() -> dict[str, Any]:
                # A concurrent claim must finish before this read, so a newly
                # consumed workflow cannot escape cancellation as an issued step.
                outcome = await ledger.command_outcome(
                    user_id=user_id, command_id=command_id, step=state["next_step"]
                )
                if outcome and outcome.get("command_effect") == "workflow":
                    await cancel_command_workflow(
                        user_id=user_id, outcome=outcome, service=workflow
                    )
                saved = await checkpoints.update(
                    user_id,
                    command_id,
                    state["revision"],
                    {**state, "status": "cancelled", "capsule": None},
                )
                await ledger.cancel_command(user_id=user_id, command_id=command_id)
                return saved

            return asyncio.run(cancel())

    return await asyncio.to_thread(transaction)
