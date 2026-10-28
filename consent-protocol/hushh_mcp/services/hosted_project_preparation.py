"""Prepare assigned projects through the existing operation, one durable step at a time."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired

Observation = Callable[[], Awaitable[dict[str, Any]]]


async def prepare_project_step(
    journal: HostedPodJournal,
    reservation: dict,
    *,
    step: str,
    mutate: Observation,
    observe: Observation,
) -> dict:
    """An unresolved intent permits observation only, never a repeated mutation."""
    _require_preparation_contract(reservation)
    admission = reservation["hostedAdmission"]
    steps = admission["assignment"]["preparationContract"]["steps"]
    prior = deepcopy(reservation.get("evidence", {}).get("reserved", {}).get("hostedPreparation"))
    completed = list((prior or {}).get("completed", []))
    generation = int((prior or {}).get("generation", 0))
    if step not in steps or [item["step"] for item in completed] != steps[: len(completed)]:
        raise ProvisionReconciliationRequired("Managed preparation order changed")
    if any(item.get("ok") is not True for item in completed):
        raise ProvisionReconciliationRequired(
            "Managed preparation failure requires cleanup or reconciliation"
        )
    index = steps.index(step)
    if index < len(completed):
        return deepcopy(completed[index])
    if index != len(completed) or (prior and prior.get("phase") not in {"observed", "intent"}):
        raise ProvisionReconciliationRequired("Managed preparation prefix requires reconciliation")
    binding = {
        "version": 1,
        "ownerId": reservation["ownerId"],
        "attemptId": reservation["attemptId"],
        "planDigest": admission["preparationContractHash"],
        "step": step,
    }
    if prior and prior["phase"] == "intent":
        if prior["step"] != step:
            raise ProvisionReconciliationRequired("Another preparation step is unresolved")
        result = await observe()
    else:
        if not await journal.current(
            owner_id=reservation["ownerId"],
            attempt_id=reservation["attemptId"],
            admission=admission,
            project_observation=reservation.get("evidence", {})
            .get("reserved", {})
            .get("projectObservation"),
        ):
            raise ProvisionReconciliationRequired("Managed preparation admission changed")
        await _publish(journal, binding, generation, "intent", completed)
        generation += 1
        result = await mutate()
    if result.get("step") != step or result.get("ok") is not True:
        raise ProvisionReconciliationRequired("Provider preparation outcome is not qualified")
    await _publish(journal, binding, generation, "observed", [*completed, result])
    return result


async def _publish(
    journal: HostedPodJournal, binding: dict, generation: int, phase: str, completed: list
) -> None:
    if not await journal.publish(
        kind="preparation",
        owner_id=binding["ownerId"],
        attempt_id=binding["attemptId"],
        checkpoint={
            **binding,
            "expectedGeneration": generation,
            "generation": generation + 1,
            "phase": phase,
            "completed": completed,
        },
    ):
        raise ProvisionReconciliationRequired("Managed preparation checkpoint was not retained")


def _require_preparation_contract(reservation: dict) -> None:
    import re

    assignment = reservation["hostedAdmission"]["assignment"]
    project, region = assignment["project"], assignment["region"]
    plan = assignment["bootstrapContract"]["plan"]
    identity = plan["federation"]["impersonation"]
    bootstrap = identity["bootstrap_service_account"]
    caller = identity["granted_to"]
    if (
        plan["target"] != {"project": project, "region": region}
        or plan.get("tenancy") != "hussh-hosted"
        or not re.fullmatch(
            r"[a-z][a-z0-9-]{4,28}[a-z0-9]@" + re.escape(project) + r"\.iam\.gserviceaccount\.com",
            bootstrap,
        )
        or not re.fullmatch(
            r"[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com",
            caller,
        )
        or project == caller.split("@", 1)[1].removesuffix(".iam.gserviceaccount.com")
        or project == reservation["hostedAdmission"]["modelBinding"]["project"]
    ):
        raise ProvisionReconciliationRequired("Managed preparation has no safe cleanup assignment")
