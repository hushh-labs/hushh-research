"""Bind a retained dev-pilot reservation to the existing private GCP spec.

The deployment object is configuration. The repository's fresh, joined admission
read supplies coordination authority immediately before provider operations.
"""

from __future__ import annotations

import asyncio
import hashlib
import threading
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, Protocol
from uuid import UUID

from hushh_mcp.managed_ai_config import load_profile, profile_hash
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment


class AdmissionRepository(Protocol):
    async def hosted_admission_current(
        self,
        *,
        owner_id: str,
        attempt_id: str,
        admission: dict,
        project_observation: dict | None = None,
    ) -> bool: ...


def deployment_from_reservation(
    spec: PodSpec, reservation: dict, *, release: dict, hub_principal: str
) -> PrivateGcpDeployment:
    """Validate public placement/model facts; this does not authorize a mutation."""
    try:
        admission = reservation["hostedAdmission"]
        assignment = admission["assignment"]
        profile = load_profile("dev")
        expiry = datetime.fromisoformat(admission["expiresAt"])
        valid = (
            reservation["phase"] == "reserved"
            and reservation["attemptId"] == spec.provision_attempt_id
            and reservation["intent"]["user_id"] == reservation["ownerId"]
            and reservation["intent"]["hushh_id"] == spec.hushh_id
            and type(admission["version"]) is int
            and admission["version"] == 1
            and admission["environment"] == "dev"
            and str(UUID(admission["policyId"])) == admission["policyId"]
            and assignment["ownerHash"]
            == "sha256:" + hashlib.sha256(reservation["ownerId"].encode()).hexdigest()
            and assignment["hushhId"] == spec.hushh_id
            and admission["sourceRevision"] == release["sourceRevision"]
            and admission["imageDigest"] == release["image"].rsplit("@", 1)[1]
            and admission["workBudgetCents"] == 20000
            and admission["cleanupReserveCents"] == 5000
            and expiry.tzinfo is not None
            and expiry > datetime.now(timezone.utc)
            and admission["modelBinding"]
            == {
                "provider": "gemini",
                "model": profile["text_model"],
                "project": profile["project"],
                "profileHash": profile_hash(profile),
            }
        )
        if not valid:
            raise ValueError
        project_number = _observed_project_number(reservation, assignment)
        deployment = PrivateGcpDeployment(
            owner=spec.hushh_id,
            hosting_mode="hussh_hosted",
            environment="dev",
            project=assignment["project"],
            region=assignment["region"],
            image=f"{assignment['region']}-docker.pkg.dev/{assignment['project']}/one-pod/consent-protocol-pod@{admission['imageDigest']}",
            hub_principal=hub_principal,
            project_number=project_number,
            inference_project=profile["project"],
            inference_model=profile["text_model"],
            inference_profile_hash=profile_hash(profile),
        )
        deployment.validate()
        deployment.require_hosted_spec(spec)
        return deployment
    except (KeyError, ValueError, TypeError, IndexError, AttributeError):
        raise ValueError("Hosted pilot reservation does not match the deployment") from None


async def bind_provision_spec(
    spec: PodSpec,
    reservation: dict,
    *,
    registry: AdmissionRepository,
    release: dict[str, Any],
    hub_principal: str,
) -> PodSpec:
    deployment = deployment_from_reservation(
        spec, reservation, release=release, hub_principal=hub_principal
    )
    owner_id, attempt_id = reservation["ownerId"], reservation["attemptId"]
    admission = deepcopy(reservation["hostedAdmission"])
    observation = deepcopy(
        reservation.get("evidence", {}).get("reserved", {}).get("projectObservation")
    )
    loop, owner_thread = asyncio.get_running_loop(), threading.get_ident()

    async def current() -> None:
        if not await registry.hosted_admission_current(
            owner_id=owner_id,
            attempt_id=attempt_id,
            admission=admission,
            project_observation=observation,
        ):
            raise RuntimeError("Hosted pilot admission changed; reconciliation required")
        deployment.validate()

    await current()

    def guard() -> None:
        if threading.get_ident() == owner_thread:
            raise RuntimeError("Hosted provider admission must execute on its worker thread")
        if not loop.is_running() or loop.is_closed():
            raise RuntimeError("Hosted admission coordinator is unavailable")
        operation = current()
        try:
            future = asyncio.run_coroutine_threadsafe(operation, loop)
        except RuntimeError:
            operation.close()
            raise RuntimeError("Hosted admission coordinator is unavailable") from None
        try:
            future.result(timeout=20)
        except TimeoutError:
            future.cancel()
            raise RuntimeError("Hosted admission observation timed out") from None

    return replace(spec, private_gcp_deployment=deployment, hosted_admission_guard=guard)


def _observed_project_number(reservation: dict, assignment: dict) -> str | None:
    observation = reservation.get("evidence", {}).get("reserved", {}).get("projectObservation")
    number: str | None = assignment["projectNumber"]
    if number is not None and not isinstance(number, str):
        raise ValueError
    if observation is None:
        return number
    if (
        not isinstance(observation, dict)
        or set(observation) != {"projectId", "projectNumber", "lifecycleState"}
        or observation["projectId"] != assignment["project"]
        or observation["lifecycleState"] != "ACTIVE"
        or not isinstance(observation["projectNumber"], str)
        or (number is not None and number != observation["projectNumber"])
    ):
        raise ValueError
    observed_number = observation["projectNumber"]
    if not isinstance(observed_number, str):
        raise ValueError
    return observed_number
