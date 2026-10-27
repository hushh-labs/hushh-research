"""Existing grant-erasure protocol behind the provisioning facade.

No new ledger: reserve, append, provider acknowledgement and observed absence stay
in the owner/attempt-bound registry journal.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any


async def _reserve(registry: Any, user_id: str) -> tuple[dict, dict, str]:
    from hushh_mcp.services.compute_backend_resolution import frozen_cleanup_coordinates

    current = await registry.get(user_id)
    reservation = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
    snapshot = reservation.get("registrySnapshot") or {}
    reserve = getattr(registry, "reserve_erasure_grant_release", None)
    if (
        not current
        or current.get("status") != "suspended"
        or reservation.get("ownerId") != user_id
        or snapshot.get("user_id") != user_id
        or reserve is None
        or not await reserve(user_id=user_id, reservation=reservation)
    ):
        raise RuntimeError("runtime grant erasure reservation unavailable")
    current = await registry.get(user_id)
    saved = ((current or {}).get("backend_metadata") or {}).get("erasure") or {}
    attempt = reservation["attemptId"]
    if (
        not current
        or current.get("status") != "suspended"
        or saved.get("ownerId") != user_id
        or saved.get("attemptId") != attempt
        or saved.get("registrySnapshot") != snapshot
        or saved.get("grantRelease")
        != {
            "ownerId": user_id,
            "attemptId": attempt,
            "project": frozen_cleanup_coordinates(snapshot)[0],
            "status": "reserved",
        }
    ):
        raise RuntimeError("runtime grant reservation readback unconfirmed")
    return saved, snapshot, attempt


def _evidence(saved: dict, *, repository: bool, quota: bool) -> tuple[dict, dict]:
    inventory = saved.get("substrateInventory") or {}
    identity = (saved.get("writerDisabled") or {}).get("runtimeIdentity") or {}
    if repository:
        observations = [
            o
            for o in inventory.get("resourceObservations", [])
            if isinstance(o, dict)
            and o.get("type") == "artifact_repository"
            and o.get("id") == "one-pod"
            and o.get("disposition") == "created"
        ]
        if len(observations) != 1:
            raise RuntimeError("repository grant creation provenance unresolved")
        identity = observations[0].get("identity") or {}
    bindings = [
        b
        for b in inventory.get("bindingObservations", [])
        if isinstance(b, dict)
        and b.get("step")
        == (
            "artifact_repo_grant_copy_writer"
            if repository
            else "iam_pod_sa_quota"
            if quota
            else "iam_pod_sa_vertex"
        )
        and (repository or b.get("member") == f"serviceAccount:{identity.get('email')}")
    ]
    if len(bindings) != 1:
        raise RuntimeError("runtime grant provenance unresolved")
    evidence = {
        "repositoryIdentity" if repository else "runtimeIdentity": identity,
        "bindingObservation": bindings[0],
    }
    return inventory, evidence


async def erase_reserved_grant(
    *,
    registry: Any,
    backend_for: Callable[[dict], Any],
    user_id: str,
    repository: bool,
    quota: bool = False,
) -> None:
    from hushh_mcp.runtime_settings import personal_agent_substrate_teardown_enabled

    if not personal_agent_substrate_teardown_enabled():
        raise RuntimeError("runtime grant erasure guarded")
    state_key = "repositoryGrantErasure" if repository else "runtimeGrantErasure"
    retain_name = (
        "retain_erasure_repository_grant_receipt"
        if repository
        else "retain_erasure_runtime_grant_receipt"
    )
    retain = getattr(registry, retain_name, None)
    if retain is None:
        raise RuntimeError("runtime grant erasure persistence unavailable")
    saved, snapshot, attempt = await _reserve(registry, user_id)
    inventory, evidence = _evidence(saved, repository=repository, quota=quota)
    erase = getattr(
        backend_for(snapshot),
        "erase_repository_grant" if repository else "erase_runtime_grant",
        None,
    )
    if erase is None:
        raise RuntimeError("runtime grant erasure unsupported")
    loop = asyncio.get_running_loop()

    async def append(stage: str, raw: dict) -> bool:
        observed = await registry.get(user_id)
        state = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
        if (
            not observed
            or observed.get("status") != "suspended"
            or state.get("ownerId") != user_id
            or state.get("attemptId") != attempt
            or state.get("registrySnapshot") != snapshot
            or state.get("substrateInventory") != inventory
        ):
            return False
        receipt = {**raw, "ownerId": user_id, "attemptId": attempt}
        if not await retain(user_id=user_id, reservation=state, stage=stage, receipt=receipt):
            return False
        observed = await registry.get(user_id)
        state = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
        return bool(
            observed
            and observed.get("status") == "suspended"
            and state.get("ownerId") == user_id
            and state.get("attemptId") == attempt
            and (
                (state.get(state_key) or {}).get("quota", {})
                if quota
                else (state.get(state_key) or {})
            ).get(stage)
            == receipt
        )

    def checkpoint(stage: str, raw: dict) -> bool:
        return asyncio.run_coroutine_threadsafe(append(stage, raw), loop).result(timeout=30)

    states = _recovery_state(
        saved.get(state_key) or {}, user_id=user_id, attempt=attempt, quota=quota
    )
    await erase(evidence=evidence, state=states, retain_receipt=checkpoint)


def _recovery_state(journal: dict, *, user_id: str, attempt: str, quota: bool) -> dict:
    states = {}
    journal = (
        journal.get("quota", {})
        if quota
        else {stage: receipt for stage, receipt in journal.items() if stage != "quota"}
    )
    for stage, receipt in journal.items():
        if (
            not isinstance(receipt, dict)
            or receipt.get("ownerId") != user_id
            or receipt.get("attemptId") != attempt
        ):
            raise RuntimeError("runtime grant recovery owner unverified")
        states[stage] = {k: v for k, v in receipt.items() if k not in {"ownerId", "attemptId"}}
    return states
