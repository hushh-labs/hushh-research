"""Owner-bound compute observation and memory fencing for reserved erasure."""

from __future__ import annotations

import asyncio
from typing import Any, Protocol, cast

from hushh_mcp.services.compute_backend import PodSpec


class _Owner(Protocol):
    _registry: Any

    def _backend_for(self, spec: PodSpec) -> Any: ...


def _require_reservation(user_id: str, reservation: dict) -> tuple[dict, dict]:
    if (
        not isinstance(reservation, dict)
        or reservation.get("ownerId") != user_id
        or reservation.get("version") != 1
        or reservation.get("phase") != "reserved"
        or not isinstance(reservation.get("attemptId"), str)
        or not reservation["attemptId"]
    ):
        raise RuntimeError("erasure reservation unavailable")
    row = reservation.get("registrySnapshot")
    if not isinstance(row, dict) or row.get("user_id") != user_id:
        raise RuntimeError("erasure host snapshot unavailable")
    return row, row.get("backend_metadata") or {}


async def _retained_hosted_settlement(
    owner: _Owner, user_id: str, reservation: dict, row: dict, metadata: dict
) -> tuple[dict, bool, dict | None]:
    witness = metadata.get("hostedFilesExecutor")
    hosted = (
        row.get("deployment_target") == "gcp"
        and metadata.get("tenancy", "hussh-hosted") == "hussh-hosted"
    )
    if metadata.get("upgradeLease") is not None and not hosted:
        raise RuntimeError("erasure compute attempt unresolved")
    settled = False
    provider_settlement = None
    if not hosted or (metadata.get("upgradeLease") is None and not isinstance(witness, dict)):
        return reservation, settled, provider_settlement
    current = await owner._registry.get(user_id)
    latest = ((current or {}).get("backend_metadata") or {}).get("erasure")
    if (
        not isinstance(latest, dict)
        or latest.get("attemptId") != reservation.get("attemptId")
        or latest.get("ownerId") != reservation.get("ownerId")
        or latest.get("hushhId") != reservation.get("hushhId")
        or latest.get("registrySnapshot") != row
    ):
        raise RuntimeError("erasure reservation changed")
    is_settled = getattr(owner._registry, "hosted_files_queue_erasure_settled", None)
    if is_settled is None or not await is_settled(reservation=latest):
        raise RuntimeError("erasure compute attempt unresolved")
    intent = latest.get("lateFilesReplacementIntent") or (
        witness.get("replacementIntent") if isinstance(witness, dict) else None
    )
    if intent is not None:
        provider_settlement = latest.get("lateFilesProviderSettlement") or witness.get(
            "providerSettlement"
        )
        if not isinstance(provider_settlement, dict):
            raise RuntimeError("erasure provider settlement unavailable")
    return latest, True, provider_settlement


async def _observe_reserved_target(
    owner: _Owner,
    user_id: str,
    reservation: dict,
    row: dict,
    metadata: dict,
    *,
    hosted_files_settled: bool,
) -> tuple[PodSpec, Any, dict, str]:
    if row.get("status") != "provisioned":
        raise RuntimeError("erasure host snapshot unavailable")
    if metadata.get("upgradeLease") is not None and not hosted_files_settled:
        raise RuntimeError("erasure compute attempt unresolved")
    if not metadata.get("serviceUid"):
        raise RuntimeError("erasure compute attempt unresolved")
    hushh_id = row.get("hushh_id")
    if not hushh_id or hushh_id != reservation.get("hushhId"):
        raise RuntimeError("erasure owner identity unavailable")
    from hushh_mcp.services.compute_backend_resolution import cleanup_spec

    spec = cleanup_spec(row, registry=owner._registry)
    backend = owner._backend_for(spec)
    observe = getattr(backend, "observe_erasure_target", None)
    if observe is None or getattr(backend, "backend_id", None) != row.get("backend"):
        raise RuntimeError("erasure backend observation unavailable")
    target = await observe(spec)
    if (
        target.get("serviceUid") != metadata["serviceUid"]
        or target.get("service") != (metadata.get("service") or row.get("external_agent_id"))
        or target.get("podUrl") != str(metadata.get("url") or "").rstrip("/")
    ):
        raise RuntimeError("erasure compute observation mismatch")
    current = await owner._registry.get(user_id)
    if (
        not current
        or current.get("status") != "suspended"
        or (current.get("backend_metadata") or {}).get("erasure") != reservation
    ):
        raise RuntimeError("erasure reservation changed")
    return spec, backend, target, hushh_id


async def _fence_and_retain_memory(
    owner: _Owner, user_id: str, reservation: dict, target: dict, *, hushh_id: str
) -> dict:
    from hushh_mcp.services.pod_migration_transport import (
        fence_for_erasure,
        observe_memory_for_erasure,
    )

    payload = {
        "hushhId": hushh_id,
        "attemptId": reservation["attemptId"],
        "service": target["service"],
        "serviceUid": target["serviceUid"],
        "revision": target["revision"],
    }
    await asyncio.to_thread(fence_for_erasure, pod_url=target["podUrl"], payload=payload)
    receipt = await asyncio.to_thread(
        observe_memory_for_erasure, pod_url=target["podUrl"], payload=payload
    )
    retain = getattr(owner._registry, "retain_erasure_memory_binding", None)
    if retain is None or not await retain(
        user_id=user_id, reservation=reservation, receipt=receipt
    ):
        raise RuntimeError("erasure memory binding retention unconfirmed")
    observed = await owner._registry.get(user_id)
    saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
    if (
        not observed
        or observed.get("status") != "suspended"
        or saved.get("ownerId") != user_id
        or saved.get("attemptId") != reservation["attemptId"]
        or saved.get("memoryBinding") != receipt
    ):
        raise RuntimeError("erasure memory binding readback unconfirmed")
    return cast(dict, receipt)


def _require_creation_provenance(
    user_id: str, metadata: dict, receipt: dict, target: dict, backend: Any, spec: PodSpec
) -> dict:
    attempt = metadata.get("provisionAttempt") or {}
    creation = ((attempt.get("evidence") or {}).get("host_requested") or {}).get(
        "creationAcknowledgement"
    ) or {}
    if (
        attempt.get("version") != 1
        or attempt.get("ownerId") != user_id
        or attempt.get("phase") != "provisioned"
        or type(creation.get("initialGeneration")) is not int
        or creation["initialGeneration"] != 1
        or not isinstance(creation.get("initialImage"), str)
        or not receipt["memoryBinding"].get("creationProvenance")
        or creation.get("serviceUid") != target["serviceUid"]
    ):
        raise RuntimeError("erasure runtime creation provenance unavailable")
    if any(creation.get(key) != value for key, value in backend.provision_target_for(spec).items()):
        raise RuntimeError("erasure creation target changed")
    return cast(dict, creation)


async def _verify_runtime_settlement(
    backend: Any,
    spec: PodSpec,
    target: dict,
    creation: dict,
    provider_settlement: dict | None,
) -> dict:
    runtime = await backend.observe_erasure_runtime(spec)
    identity_changed = any(runtime.get(key) != value for key, value in target.items())
    if provider_settlement is not None:
        settled = provider_settlement
        if (
            identity_changed
            or settled.get("service") != target.get("service")
            or settled.get("serviceUid") != target.get("serviceUid")
            or settled.get("revision") != target.get("revision")
            or type(settled.get("generation")) is not int
            or type(settled.get("observedGeneration")) is not int
            or settled.get("observedGeneration") != settled.get("generation")
            or runtime.get("generation") != settled.get("generation")
            or runtime.get("image") != settled.get("image")
            or settled.get("image") != settled.get("targetImage")
        ):
            raise RuntimeError("erasure runtime provider settlement changed")
    elif (
        identity_changed
        or runtime.get("generation") != creation["initialGeneration"]
        or runtime.get("image") != creation["initialImage"]
    ):
        raise RuntimeError("erasure runtime creation identity changed")
    return cast(dict, runtime)


async def fence_reserved_erasure(owner: _Owner, *, user_id: str, reservation: dict) -> dict:
    row, metadata = _require_reservation(user_id, reservation)
    reservation, hosted_files_settled, provider_settlement = await _retained_hosted_settlement(
        owner, user_id, reservation, row, metadata
    )
    spec, backend, target, hushh_id = await _observe_reserved_target(
        owner,
        user_id,
        reservation,
        row,
        metadata,
        hosted_files_settled=hosted_files_settled,
    )
    receipt = await _fence_and_retain_memory(owner, user_id, reservation, target, hushh_id=hushh_id)
    creation = _require_creation_provenance(user_id, metadata, receipt, target, backend, spec)
    runtime = await _verify_runtime_settlement(backend, spec, target, creation, provider_settlement)
    return {**receipt, "runtime": runtime}
