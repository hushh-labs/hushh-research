"""Bind the existing bootstrap executor to one retained managed-pod attempt."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from copy import deepcopy
from typing import Any, Protocol

from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class CheckpointRepository(Protocol):
    async def publish_hosted_bootstrap_checkpoint(
        self, *, owner_id: str, attempt_id: str, checkpoint: dict[str, Any]
    ) -> bool: ...


def bootstrap_contract(plan: dict[str, Any]) -> dict[str, Any]:
    """Freeze the authored plan and executor order, not a caller-selected digest."""
    from hushh_mcp.services.user_gcp_bootstrap import UserGcpBootstrap

    target = plan["target"]
    bootstrap_sa = plan["federation"]["impersonation"]["bootstrap_service_account"]
    if not isinstance(bootstrap_sa, str) or not bootstrap_sa.endswith(
        f"@{target['project']}.iam.gserviceaccount.com"
    ):
        raise ValueError("Hosted bootstrap authority differs from the assigned project")
    steps = [
        call["step"]
        for call in UserGcpBootstrap(
            project=target["project"], region=target["region"], bootstrap_sa=bootstrap_sa
        ).plan_calls(plan)
    ]
    if plan.get("tenancy") != "hussh-hosted" or not 1 <= len(steps) <= 64:
        raise ValueError("Hosted bootstrap contract is unavailable")
    if len(set(steps)) != len(steps):
        raise ValueError("Hosted bootstrap step identities are ambiguous")
    return {"plan": deepcopy(plan), "steps": steps}


def bind_bootstrap_checkpoint(
    *,
    registry: CheckpointRepository,
    reservation: dict[str, Any],
    plan: dict[str, Any],
) -> tuple[Callable[[str, str, list[dict[str, Any]]], None], list[dict[str, Any]]]:
    """Resume successful observed work only; an unresolved intent needs readback."""
    admission = reservation["hostedAdmission"]
    if reservation.get("phase") != "reserved" or admission["assignment"].get(
        "bootstrapContract"
    ) != bootstrap_contract(plan):
        raise ValueError("Hosted bootstrap differs from the retained contract")
    previous = deepcopy(reservation.get("evidence", {}).get("reserved", {}).get("hostedCheckpoint"))
    if previous and (
        previous.get("phase") != "observed"
        or any(result.get("ok") is not True for result in previous.get("completed", []))
    ):
        raise ProvisionReconciliationRequired("Hosted bootstrap requires provider reconciliation")
    generation = previous["generation"] if previous else 0
    prefix = deepcopy(previous["completed"] if previous else [])
    owner, attempt = reservation["ownerId"], reservation["attemptId"]
    digest = admission["bootstrapContractHash"]
    loop, owner_thread = asyncio.get_running_loop(), threading.get_ident()

    def persist(phase: str, step: str, completed: list[dict[str, Any]]) -> None:
        nonlocal generation
        if threading.get_ident() == owner_thread:
            raise ProvisionReconciliationRequired(
                "Hosted bootstrap checkpoints require the provider worker"
            )
        if phase == "complete":
            checkpoint = _completed_receipt(
                previous,
                step,
                completed,
                len(admission["assignment"]["bootstrapContract"]["steps"]),
            )
        else:
            checkpoint = {
                "version": 1,
                "ownerId": owner,
                "attemptId": attempt,
                "expectedGeneration": generation,
                "generation": generation + 1,
                "planDigest": digest,
                "phase": phase,
                "step": step,
                "completed": deepcopy(completed),
            }
        operation = registry.publish_hosted_bootstrap_checkpoint(
            owner_id=owner, attempt_id=attempt, checkpoint=checkpoint
        )
        if not loop.is_running() or loop.is_closed():
            operation.close()
            raise ProvisionReconciliationRequired("Hosted bootstrap coordinator is unavailable")
        try:
            future = asyncio.run_coroutine_threadsafe(operation, loop)
        except RuntimeError:
            operation.close()
            raise ProvisionReconciliationRequired(
                "Hosted bootstrap coordinator is unavailable"
            ) from None
        try:
            admitted = future.result(timeout=20)
        except TimeoutError:
            future.cancel()
            raise ProvisionReconciliationRequired(
                "Hosted bootstrap checkpoint requires reconciliation"
            ) from None
        except Exception:
            raise ProvisionReconciliationRequired(
                "Hosted bootstrap checkpoint requires reconciliation"
            ) from None
        if admitted is not True:
            raise ProvisionReconciliationRequired(
                "Hosted bootstrap checkpoint was not acknowledged"
            )
        if phase != "complete":
            generation += 1

    return persist, prefix


def _completed_receipt(
    previous: dict[str, Any] | None,
    step: str,
    completed: list[dict[str, Any]],
    total: int,
) -> dict[str, Any]:
    if (
        previous is None
        or previous.get("phase") != "observed"
        or previous.get("completed") != completed
        or previous.get("step") != step
        or len(completed) != total
    ):
        raise ProvisionReconciliationRequired(
            "Hosted bootstrap completion requires retained evidence"
        )
    return deepcopy(previous)
