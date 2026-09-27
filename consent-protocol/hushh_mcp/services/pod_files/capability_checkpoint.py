"""Serial Files bootstrap receipts within the existing pod upgrade operation."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from copy import deepcopy

from hushh_mcp.services.byoc_substrate import SubstrateReceipt, plan_digest
from hushh_mcp.services.pod_files.capability_bootstrap import FilesCapabilityBootstrap
from hushh_mcp.services.pod_files.capability_update import FilesCapabilityPlan


def _union(left: list, right: list) -> list:
    result = deepcopy(left)
    for item in right:
        if item not in result:
            result.append(deepcopy(item))
    return result


def extend_inventory(original: dict, plan: FilesCapabilityPlan, completed: list[dict]) -> dict:
    """Retain obligations before a provider call; only qualified receipts afterward."""
    delta = plan.substrate_plan()
    resources = _union(
        original["plannedResources"],
        [{"type": item["type"], "id": item["id"]} for item in delta["resources"]],
    )
    bindings = _union(
        original.get("plannedBindings", []),
        [{key: item[key] for key in ("member", "role", "on")} for item in delta["iam"]],
    )
    observations = [
        item["resourceObservation"] for item in completed if item.get("resourceObservation")
    ]
    iam = [binding for item in completed for binding in item.get("bindingObservations", [])]
    qualified = SubstrateReceipt(
        applied=False,
        tenant_ref=original["tenantRef"],
        planned_resources=resources,
        resource_observations=observations,
        binding_observations=iam,
    ).as_record()
    if (
        qualified.get("resourceObservations", []) != observations
        or qualified.get("bindingObservations", []) != iam
    ):
        raise ValueError("Files bootstrap returned unqualified observations")
    resource_observations = _union(original.get("resourceObservations", []), observations)
    seen = {}
    for item in resource_observations:
        identity = (item["type"], item["id"])
        if identity in seen and seen[identity] != item:
            raise ValueError("Files bootstrap resource incarnation conflict")
        seen[identity] = item
    return {
        **original,
        "applied": False,
        "plannedResources": resources,
        "plannedBindings": bindings,
        "resourceIds": sorted(
            set(original.get("resourceIds", [])) | {item["id"] for item in resources}
        ),
        "planDigest": plan_digest({"resources": resources}),
        "resourceObservations": resource_observations,
        "bindingObservations": _union(original.get("bindingObservations", []), iam),
    }


class FilesUpgradeCheckpoint:
    """Validate one call at a time. Persistence remains the caller's authority."""

    def __init__(
        self,
        *,
        plan: FilesCapabilityPlan,
        operation_id: str,
        attempt_id: str,
        original_inventory: dict,
        previous: dict | None = None,
    ):
        self.plan, self.operation_id, self.attempt_id = plan, operation_id, attempt_id
        self.original = deepcopy(original_inventory)
        self.previous = deepcopy(previous)
        self.calls = FilesCapabilityBootstrap(capability=plan).plan_calls(plan.substrate_plan())
        if self.previous is not None and any(
            self.previous.get(key) != value
            for key, value in {
                "version": 1,
                "planDigest": plan.digest,
                "operationId": operation_id,
                "attemptId": attempt_id,
            }.items()
        ):
            raise ValueError("Files checkpoint belongs to another approved operation")

    def prepare(self, phase: str, step: str, completed: list[dict]) -> tuple[dict, dict]:
        previous = self.previous
        count = len(completed)
        if phase == "intent":
            if previous is None and completed:
                raise ValueError("Files bootstrap has no acknowledged prefix")
            if count >= len(self.calls) or self.calls[count]["step"] != step:
                raise ValueError("Files bootstrap step is outside the approved sequence")
            if previous is not None and (
                previous["phase"] != "observed"
                or previous["completed"] != completed
                or completed[-1].get("ok") is not True
            ):
                raise ValueError("Files bootstrap requires reconciliation before another step")
        elif phase == "observed":
            if (
                not previous
                or previous["phase"] != "intent"
                or previous["step"] != step
                or completed[:-1] != previous["completed"]
                or not completed
                or completed[-1].get("step") != step
            ):
                raise ValueError("Files bootstrap acknowledgement has no matching intent")
        else:
            raise ValueError("Unknown Files bootstrap phase")
        for result in completed:
            if (
                set(result)
                - {"step", "ok", "status", "skipped", "resourceObservation", "bindingObservations"}
                or type(result.get("ok")) is not bool
                or type(result.get("status")) is not int
            ):
                raise ValueError("Files bootstrap result is not a bounded receipt")
        checkpoint = {
            "version": 1,
            "planDigest": self.plan.digest,
            "operationId": self.operation_id,
            "attemptId": self.attempt_id,
            "phase": phase,
            "step": step,
            "completed": deepcopy(completed),
        }
        inventory = extend_inventory(self.original, self.plan, completed)
        if (
            phase == "observed"
            and count == len(self.calls)
            and all(item["ok"] for item in completed)
        ):
            inventory["applied"] = True
        return checkpoint, inventory

    def acknowledge(self, checkpoint: dict) -> None:
        # Call only after the existing registry CAS succeeds.
        self.previous = deepcopy(checkpoint)

    @property
    def complete(self) -> bool:
        previous = self.previous or {}
        completed = previous.get("completed", [])
        return (
            previous.get("phase") == "observed"
            and len(completed) == len(self.calls)
            and [item.get("step") for item in completed] == [call["step"] for call in self.calls]
            and all(item.get("ok") is True for item in completed)
        )


def bind_checkpoint_persistence(
    checkpoint: FilesUpgradeCheckpoint,
    *,
    owner_loop: asyncio.AbstractEventLoop,
    publish: Callable[[dict, dict], Awaitable[None]],
    retain_late: Callable[[dict], Awaitable[None]],
) -> Callable[[str, str, list[dict]], None]:
    """Bind the synchronous provider to acknowledged owner-loop authority."""

    def persist(phase: str, step: str, completed: list[dict]) -> None:
        observation, inventory = checkpoint.prepare(phase, step, completed)

        async def write() -> None:
            try:
                await publish(observation, inventory)
            except RuntimeError:
                if phase == "observed":
                    await retain_late(observation)
                # Retaining obligations after erasure never permits another step.
                raise

        asyncio.run_coroutine_threadsafe(write(), owner_loop).result(timeout=30)
        checkpoint.acknowledge(observation)
        if phase == "observed" and completed[-1].get("ok") is not True:
            raise RuntimeError("Files activation requires reconciliation")

    return persist
