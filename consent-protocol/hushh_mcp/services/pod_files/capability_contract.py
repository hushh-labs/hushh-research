"""Provider dispatch within the existing Files approval and update authority."""

from __future__ import annotations

import asyncio

from . import hosted_schema_readiness as _hosted_schema_readiness
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
    """Require the complete durable executor family before managed Files is offered."""
    from db.hosted_custody_adoption import (
        HOSTED_FILES_NEW_SIGNATURES,
        HOSTED_FILES_QUALIFIED,
        HOSTED_FILES_SERVICE_ROLE_SIGNATURES,
        HOSTED_NATIVE_LOCATION_CONTRACT_QUALIFIED,
        PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED,
        QUALIFIED,
    )
    from db.hosted_custody_qualification import complete_family_qualification_sql

    if not await schema_ready(repo, 1, join_on_cancel=join_on_cancel):
        return False
    qualification_sql = complete_family_qualification_sql(
        base_family=QUALIFIED,
        files_family=HOSTED_FILES_QUALIFIED,
        upgrade_family=PERSONAL_AGENT_UPGRADE_HOST_BINDING_QUALIFIED,
        native_contract_family=HOSTED_NATIVE_LOCATION_CONTRACT_QUALIFIED,
        service_role_signatures=HOSTED_FILES_SERVICE_ROLE_SIGNATURES,
        hosted_files_new_signatures=HOSTED_FILES_NEW_SIGNATURES,
        native_contract_new_signatures=frozenset(),
        require_family=True,
    )
    return await _hosted_schema_readiness.read_hosted_family_ready(
        repo, qualification_sql=qualification_sql, join_on_cancel=join_on_cancel
    )


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
