"""Provider dispatch within the existing Files approval and update authority."""

from __future__ import annotations

import asyncio

from .capability_checkpoint import FilesUpgradeCheckpoint
from .capability_update import FilesCapabilityPlan


def decode_plan(encoded: dict):
    if isinstance(encoded, dict) and encoded.get("version") == 2:
        from .azure_capability import AzureFilesCapabilityPlan

        return AzureFilesCapabilityPlan.model_validate(encoded)
    return FilesCapabilityPlan.model_validate(encoded)


def checkpoint_for(*, plan, metadata: dict, operation_id: str, attempt_id: str):
    kind = FilesUpgradeCheckpoint
    if plan.version == 2:
        from .azure_checkpoint import AzureFilesUpgradeCheckpoint

        kind = AzureFilesUpgradeCheckpoint
    return kind(
        plan=plan,
        operation_id=operation_id,
        attempt_id=attempt_id,
        original_inventory=metadata.get(kind.inventory_key, {}),
        previous=metadata.get("filesUpgradeCheckpoint"),
    )


async def admission_ready(repo, plan) -> bool:
    return await schema_ready(repo, plan.version)


async def schema_ready(repo, version: int, *, join_on_cancel: bool = False) -> bool:
    if version == 1:
        check = getattr(repo, "files_upgrade_admission_ready", None)
        return check is not None and await (
            check(join_on_cancel=True) if join_on_cancel else check()
        )
    check = getattr(repo, "files_capability_admission_ready", None)
    return check is not None and await check(version)


async def hosted_schema_ready(repo, *, join_on_cancel: bool = False) -> bool:
    """Fail closed until hosted Files and interrupted erasure share a reviewed contract.

    A late provider receipt does not by itself prove that every upgrade executor
    has drained.  The custody family must include an independently qualified
    settlement predicate and the erasure functions that enforce it before this
    capability can be offered or applied.
    """
    from db.hosted_custody_adoption import QUALIFIED

    if not await schema_ready(repo, 1, join_on_cancel=join_on_cancel):
        return False
    signatures = (
        "private_gcp_coordinates(jsonb)",
        "valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)",
        "hosted_pod_upgrade_admitted(text,text,jsonb,boolean)",
        "hosted_files_queue_erasure_settled(jsonb)",
        "valid_erasure_memory_binding(jsonb,jsonb)",
        "valid_erasure_substrate_inventory(jsonb,jsonb)",
        "personal_agent_erasure_complete(text)",
    )
    if any(signature not in QUALIFIED for signature in signatures):
        return False
    values = ",".join(f"(:signature{i},:digest{i})" for i in range(len(signatures)))
    params = {
        key: value
        for i, signature in enumerate(signatures)
        for key, value in (
            (f"signature{i}", "public." + signature),
            (f"digest{i}", QUALIFIED[signature]),
        )
    }
    query = (
        "SELECT COALESCE(bool_and(to_regprocedure(signature) IS NOT NULL AND "
        "encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(signature)), 'UTF8')), 'hex') "
        "= digest), false) AS ready FROM (VALUES " + values + ") AS required(signature, digest)"
    )
    try:
        from .managed_worker import database_thread

        result = await database_thread(
            repo._db().execute_raw, query, params, join_on_cancel=join_on_cancel
        )
    except Exception:
        return False
    return bool(result.data and result.data[0].get("ready") is True)


async def provider_schema_ready(client, version: int) -> bool:
    if version != 2:
        return False
    present = await asyncio.to_thread(
        client.execute_raw,
        "SELECT to_regprocedure('public.azure_files_upgrade_admission_ready()') IS NOT NULL AS ready",
        {},
    )
    if not (present.data and present.data[0].get("ready") is True):
        return False
    result = await asyncio.to_thread(
        client.execute_raw, "SELECT public.azure_files_upgrade_admission_ready() AS ready", {}
    )
    return bool(result.data and result.data[0].get("ready") is True)
