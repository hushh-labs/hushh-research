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


async def schema_ready(repo, version: int) -> bool:
    if version == 1:
        check = getattr(repo, "files_upgrade_admission_ready", None)
        return check is not None and await check()
    check = getattr(repo, "files_capability_admission_ready", None)
    return check is not None and await check(version)


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
