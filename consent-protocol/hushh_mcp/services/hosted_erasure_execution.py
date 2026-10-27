"""Managed erasure coordinates operator work without giving its credentials to the hub."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Protocol, cast

from hushh_mcp.services.hosted_gcp_placement import has_hosted_evidence
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


class ManagedErasureOperator(Protocol):
    async def preparation(self, *, user_id: str, reservation: dict) -> None: ...
    async def model_grants(self, *, user_id: str, reservation: dict) -> None: ...
    async def retirement(self, *, user_id: str, reservation: dict) -> None: ...


async def managed_erasure_step(
    service: Any, *, user_id: str, stage: str, reservation: dict | None = None
) -> bool:
    """Route only verified managed snapshots; SQL remains completion authority."""
    snapshot = (reservation or {}).get("registrySnapshot")
    if isinstance(snapshot, dict) and not has_hosted_evidence(snapshot):
        return False
    row = await service._registry.get(user_id)
    saved = ((row or {}).get("backend_metadata") or {}).get("erasure") or {}
    if reservation is not None and (
        saved.get("attemptId") != reservation.get("attemptId")
        or saved.get("registrySnapshot") != reservation.get("registrySnapshot")
    ):
        raise ProvisionReconciliationRequired("Managed erasure reservation changed")
    if not has_hosted_evidence(saved.get("registrySnapshot")):
        return False
    if row.get("status") != "suspended" or saved.get("ownerId") != user_id:
        raise ProvisionReconciliationRequired("Managed erasure owner changed")
    queries = {
        "preparation": "SELECT public.managed_preparation_cleanup_coordinates(CAST(:r AS jsonb)) AS coordinates, public.valid_managed_preparation_cleanup(CAST(:r AS jsonb),'deletion',CAST(:r AS jsonb)->'managedPreparationCleanup'->'deletion') IS TRUE AS complete",
        "model_grants": "SELECT public.erasure_managed_model_grants_complete(CAST(:r AS jsonb)) IS TRUE AS complete",
        "retirement": "SELECT public.valid_erasure_managed_project_retirement(CAST(:r AS jsonb),'deletion',CAST(:r AS jsonb)->'managedProjectRetirement'->'deletion') IS TRUE AS complete",
    }
    if stage not in queries:
        raise ValueError("Unsupported managed erasure stage")

    async def check() -> dict:
        response = await asyncio.to_thread(
            service._registry._db().execute_raw, queries[stage], {"r": json.dumps(saved)}
        )
        if not response.data or len(response.data) != 1:
            raise ProvisionReconciliationRequired("Managed erasure evidence unavailable")
        return cast(dict, response.data[0])

    evidence = await check()
    if stage == "preparation" and evidence.get("coordinates") is None:
        return False
    if evidence.get("complete") is True:
        return True
    operator = getattr(service, "_managed_erasure", None)
    if operator is None:
        raise ProvisionReconciliationRequired("Managed erasure awaits its retained operator stage")
    await getattr(operator, stage)(user_id=user_id, reservation=saved)
    row = await service._registry.get(user_id)
    current = ((row or {}).get("backend_metadata") or {}).get("erasure") or {}
    if current.get("attemptId") != saved.get("attemptId") or current.get(
        "registrySnapshot"
    ) != saved.get("registrySnapshot"):
        raise ProvisionReconciliationRequired("Managed erasure changed during operator work")
    saved = current
    if (await check()).get("complete") is not True:
        raise ProvisionReconciliationRequired("Managed erasure operator evidence incomplete")
    return True
