"""Erase a private agent whose home the hub may not delete from: the owner-access path.

When the person's own cloud account holds the agent, the hub holds no delete
authority there, by design. Such a backend declares ``OwnerAccessErasableBackend``,
and erasure becomes: the pod crypto-erases itself behind the erasure fence (the
hub's proof call), the backend revokes the pod's access and then the hub's own,
last, and the receipt naming what the person still holds is retained on the
registry row under the reserved attempt, like every other erasure receipt.

This completes nothing by itself. The existing account-erasure guard still decides,
so while the person's resources remain the account stays refused (fail-closed), now
with a receipt that says exactly what is left and how to delete it.

Provider-neutral by construction: the capability selects this path, never a
provider id (``tests/test_deployment_boundary_holds.py`` polices this module).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from hushh_mcp.services.compute_backend import (
    OwnerAccessErasableBackend,
    PodSpec,
    adoption_expectations,
)
from hushh_mcp.services.user_cloud_service import spec_coordinates_from_row

logger = logging.getLogger(__name__)

RECEIPT_FIELD = "ownerAccessErasure"


def _snapshot_spec(row: dict[str, Any]) -> PodSpec:
    metadata = row.get("backend_metadata") if isinstance(row.get("backend_metadata"), dict) else {}
    return PodSpec(
        hushh_id=str(row.get("hushh_id") or ""),
        phone_e164_hash=str(row.get("phone_e164_hash") or ""),
        pod_pubkey=str(row.get("pod_pubkey") or ""),
        billing_space_id=row.get("billing_space_id"),
        expected_service_uid=metadata.get("serviceUid"),
        deployment_target=row.get("deployment_target"),
        model_credential_mode=row.get("model_credential_mode"),
        **spec_coordinates_from_row(row),
        **adoption_expectations(metadata),
    )


def owner_access_backend(
    service: Any, row: Any
) -> Optional[tuple[OwnerAccessErasableBackend, PodSpec]]:
    """The reserved row's backend when it can only revoke access; else None.

    None hands the reservation to the existing erasure chain unchanged. A row whose
    backend cannot even be resolved is that chain's to refuse, exactly as before.
    """
    if not isinstance(row, dict) or not row.get("deployment_target"):
        return None
    spec = _snapshot_spec(row)
    try:
        backend = service._backend_for(spec)
    except Exception:  # noqa: BLE001 - see docstring: the existing chain refuses it
        return None
    if not isinstance(backend, OwnerAccessErasableBackend):
        return None
    return backend, spec


def _require_reserved(
    reservation: dict[str, Any], *, user_id: str, row: dict[str, Any], backend: Any
) -> dict[str, Any]:
    """The same admission the existing fence applies, on the immutable snapshot."""
    metadata = row.get("backend_metadata")
    if (
        reservation.get("ownerId") != user_id
        or reservation.get("version") != 1
        or reservation.get("phase") != "reserved"
        or not isinstance(reservation.get("attemptId"), str)
        or not reservation["attemptId"]
        or row.get("user_id") != user_id
        or row.get("status") != "provisioned"
        or not row.get("hushh_id")
        or row.get("hushh_id") != reservation.get("hushhId")
        or not isinstance(metadata, dict)
        or metadata.get("upgradeLease") is not None
        or not metadata.get("serviceUid")
        or getattr(backend, "backend_id", None) != row.get("backend")
    ):
        raise RuntimeError("owner-access erasure reservation unavailable")
    return metadata


async def _erase(
    service: Any,
    *,
    user_id: str,
    reservation: dict[str, Any],
    row: dict[str, Any],
    backend: OwnerAccessErasableBackend,
    spec: PodSpec,
) -> dict[str, Any]:
    from hushh_mcp.services.pod_migration_transport import crypto_erase_for_erasure

    metadata = row["backend_metadata"]
    target = await backend.observe_erasure_target(spec)
    if target.get("serviceUid") != metadata["serviceUid"] or target.get("podUrl") != str(
        metadata.get("url") or ""
    ).rstrip("/"):
        raise RuntimeError("owner-access erasure observation mismatch")
    current = await service._registry.get(user_id)
    if (
        not current
        or current.get("status") != "suspended"
        or (current.get("backend_metadata") or {}).get("erasure") != reservation
    ):
        raise RuntimeError("erasure reservation changed")
    payload = {
        "hushhId": row["hushh_id"],
        "attemptId": reservation["attemptId"],
        "service": target["service"],
        "serviceUid": target["serviceUid"],
        "revision": target["revision"],
    }

    async def crypto_erase() -> dict:
        return await asyncio.to_thread(
            crypto_erase_for_erasure, pod_url=target["podUrl"], payload=payload
        )

    return await backend.erase_owner_access(spec, crypto_erase=crypto_erase)


async def _retain(
    service: Any, *, user_id: str, reservation: dict[str, Any], receipt: dict[str, Any]
) -> None:
    retain = getattr(service._registry, "retain_erasure_owner_access", None)
    if retain is None or not await retain(
        user_id=user_id, reservation=reservation, receipt=receipt
    ):
        raise RuntimeError("owner-access erasure receipt retention unconfirmed")
    observed = await service._registry.get(user_id)
    saved = ((observed or {}).get("backend_metadata") or {}).get("erasure") or {}
    if saved.get("attemptId") != reservation["attemptId"] or saved.get(RECEIPT_FIELD) != receipt:
        raise RuntimeError("owner-access erasure receipt readback unconfirmed")


async def erase_reserved_owner_access(
    service: Any, *, user_id: str, reservation: dict[str, Any]
) -> bool:
    """False when the reserved backend lacks the capability; True once the guard passes.

    Idempotent per attempt: a receipt already retained is never re-requested, so a
    retry goes straight to the account guard, which still refuses while anything
    remains. Any refusal raises and the caller keeps the account fail-closed.
    """
    row = reservation.get("registrySnapshot") if isinstance(reservation, dict) else None
    resolved = owner_access_backend(service, row)
    if resolved is None:
        return False
    backend, spec = resolved
    _require_reserved(reservation, user_id=user_id, row=row, backend=backend)
    if reservation.get(RECEIPT_FIELD) is None:
        receipt = await _erase(
            service, user_id=user_id, reservation=reservation, row=row, backend=backend, spec=spec
        )
        await _retain(service, user_id=user_id, reservation=reservation, receipt=receipt)
        logger.info(
            "personal_agent.owner_access_erased remaining=%d",
            len(receipt.get("remainingResources") or []),
        )
    from hushh_mcp.services.account_service import AccountService  # noqa: PLC0415

    await asyncio.to_thread(
        AccountService().assert_personal_agent_external_resources_absent, user_id
    )
    return True


__all__ = ["RECEIPT_FIELD", "erase_reserved_owner_access", "owner_access_backend"]
