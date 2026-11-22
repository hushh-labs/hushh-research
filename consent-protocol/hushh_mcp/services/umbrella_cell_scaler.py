# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Horizontal Umbrella Compute Cell scale-out above 80% soft watermarks (Dev lane).

Protects single-cell capacity ceilings (`40/50` Azure, `64/80` GCP) by:
1. Evaluating live active slot utilization across regional Umbrella Cells and triggering
   automatic creation of the next cell (`cell-02`, `cell-03`, ...) once every existing
   cell in that provider/region reaches `>= softWatermark` (`80%`), provided cost guard
   is healthy and subscription RBAC / IAM quotas keep clean headroom.
2. Discovering dynamically scaled-out Azure cells via a single `O(1)` subscription
   Resource Group tag query (`hussh-tenancy=hussh-hosted`, `hussh-environment=dev`)
   so new cells become immediately visible without static config edits or cold wakes.
3. Provisioning sibling Azure cells in `rg-hussh-cell-dev-<region>-<NN>` with isolated
   Key Vault, isolated StorageV2 (`Zero` soft-delete for clean erasure), and a Consumption
   Container Apps environment (`$0.00/mo` standing fixed cost), sharing the regional ACR
   & OpenAI account from `shared_resource_group` without copying secrets.
"""

from __future__ import annotations

import logging
import os
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from hushh_mcp.services import azure_federation
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.compute_backend import BACKEND_AZURE, BACKEND_GCP
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.pod_umbrella_cell_pool import UmbrellaCellConfig

logger = logging.getLogger(__name__)

_TRAILING_INDEX_RE = re.compile(r"^(.*?)-(\d+)$")
_STORAGE_TRAILING_DIGITS_RE = re.compile(r"^(.*?)(\d+)$")
_AZURE_OVERFLOW_REGIONS: tuple[str, ...] = (
    "eastus2",
    "eastus",
    "centralus",
    "westus2",
    "westus3",
    "northcentralus",
    "southcentralus",
)
_KV_DNS_POLL_DELAYS: tuple[float, ...] = (3.0, 5.0, 8.0, 12.0, 15.0, 20.0)
_LOCATION_ABBR: dict[str, str] = {
    "eastus2": "eus2",
    "eastus": "eus",
    "centralus": "cus",
    "westus2": "wus2",
    "westus3": "wus3",
    "northcentralus": "ncus",
    "southcentralus": "scus",
    "westeurope": "weu",
}


def _short_location(location: str, template_env_name: str = "") -> str:
    loc = str(location or "").strip().lower()
    if loc in _LOCATION_ABBR:
        return _LOCATION_ABBR[loc]
    # Try extracting short code from e.g. cae-hussh-cell-dev-eus2-01
    parts = [p for p in str(template_env_name or "").strip().split("-") if p]
    if len(parts) >= 2 and parts[-1].isdigit():
        return parts[-2]
    return re.sub(r"[^a-z0-9]", "", loc)[:4] or "cell"


def _cell_index(cell_id: str) -> int:
    match = _TRAILING_INDEX_RE.match(str(cell_id or "").strip())
    if not match:
        return 1
    return int(match.group(2))


def _indexed_name(
    template_name: str, next_idx: int, *, fallback_prefix: str, max_len: int = 63
) -> str:
    suffix = f"{next_idx:02d}"
    match = _TRAILING_INDEX_RE.match(str(template_name or "").strip())
    if match:
        return f"{match.group(1)}-{suffix}"[:max_len]
    digits = _STORAGE_TRAILING_DIGITS_RE.match(str(template_name or "").strip())
    if digits:
        head = digits.group(1)[: max_len - len(suffix)]
        return f"{head}{suffix}"
    clean_prefix = fallback_prefix[: max_len - len(suffix)]
    return f"{clean_prefix}{suffix}"


def _storage_account_name(_template_storage: str, location: str, next_idx: int) -> str:
    loc_tag = _short_location(location)
    return f"sthusshcelldev{loc_tag}{next_idx:02d}"[:24]


def _key_vault_name(_template_kv: str, location: str, next_idx: int) -> str:
    loc_tag = _short_location(location)
    return f"kv-h1-celldev{loc_tag}{next_idx:02d}"[:24]


def _make_next_cell_config(
    template: UmbrellaCellConfig,
    next_idx: int,
    *,
    min_warm_override: int | None = None,
) -> UmbrellaCellConfig:
    loc_slug = re.sub(r"[^a-z0-9]", "", (template.location or "eastus2").lower())
    next_cell_id = _indexed_name(
        template.cell_id,
        next_idx,
        fallback_prefix=f"cell-{template.provider[:2]}-{loc_slug}-dev-",
    )
    if template.provider != BACKEND_AZURE:
        return replace(
            template,
            cell_id=next_cell_id,
            min_warm_skeletons=0 if min_warm_override is None else max(0, int(min_warm_override)),
            slots=(),
        )

    short_loc = _short_location(template.location, template.environment_name)
    shared_rg = (template.shared_resource_group or template.resource_group).strip()
    next_rg = _indexed_name(
        template.resource_group,
        next_idx,
        fallback_prefix=f"rg-hussh-cell-dev-{template.location or 'eastus2'}-",
        max_len=90,
    )
    next_env_name = _indexed_name(
        template.environment_name,
        next_idx,
        fallback_prefix=f"cae-hussh-cell-dev-{short_loc}-",
        max_len=32,
    )
    next_st = _storage_account_name(template.storage_account, template.location, next_idx)
    next_kv = _key_vault_name(template.key_vault_name, template.location, next_idx)
    next_min_warm = (
        max(1, min(1, template.min_warm_skeletons))
        if template.min_warm_skeletons > 0
        else 0
        if min_warm_override is None
        else max(0, int(min_warm_override))
    )
    if min_warm_override is not None:
        next_min_warm = max(0, int(min_warm_override))

    env_id = (
        f"/subscriptions/{template.subscription_id}/resourceGroups/{next_rg}/"
        f"providers/Microsoft.App/managedEnvironments/{next_env_name}"
        if template.subscription_id
        else ""
    )
    return replace(
        template,
        cell_id=next_cell_id,
        resource_group=next_rg,
        shared_resource_group=shared_rg,
        environment_name=next_env_name,
        environment_id=env_id,
        storage_account=next_st,
        key_vault_name=next_kv,
        shared_cell_fixed_monthly_usd=0.0,  # Reuses cell-01 shared ACR & OpenAI endpoint.
        min_warm_skeletons=next_min_warm,
        slots=(),
    )


@dataclass(frozen=True)
class CellScaleOutDecision:
    """Result of evaluating horizontal scale-out across cells for one provider."""

    should_scale_out: bool
    reason: str
    provider: str
    evaluated_cell_count: int
    next_cell_id: str | None = None
    template_cell_id: str | None = None
    planned_config: UmbrellaCellConfig | None = None


def evaluate_horizontal_cell_scaleout(
    *,
    provider: str,
    cells: Sequence[UmbrellaCellConfig],
    active_counts_by_cell: Mapping[str, int],
    cost_guard_by_cell: Mapping[str, bool] | None = None,
    total_rbac_assignments_used: int = 0,
    max_cells: int = 16,
    min_warm_override: int | None = None,
) -> CellScaleOutDecision:
    """Decide whether every existing cell has reached >=80% soft watermark and merits cell-N+1."""
    matching = [c for c in cells if c.provider == provider]
    if not matching:
        return CellScaleOutDecision(False, "no_template_cell", provider, 0)
    if len(matching) >= max(1, int(max_cells)):
        return CellScaleOutDecision(False, "max_cells_reached", provider, len(matching))

    guard_map = cost_guard_by_cell or {}
    if any(guard_map.get(c.cell_id, True) is False for c in matching):
        return CellScaleOutDecision(False, "cost_guard_tripped", provider, len(matching))

    # Every cell in this provider cohort must be at or above its soft watermark before scaling out.
    for cell in matching:
        active = int(active_counts_by_cell.get(cell.cell_id, 0) or 0)
        if active < max(1, cell.soft_watermark):
            return CellScaleOutDecision(
                False, "headroom_below_soft_watermark", provider, len(matching)
            )

    template = matching[0]
    rbac_per_slot = 5 if provider == BACKEND_AZURE else 3
    quota_limit = 4000 if provider == BACKEND_AZURE else 3000
    projected_next_rbac = int(total_rbac_assignments_used) + (
        template.hard_watermark * rbac_per_slot
    )
    if projected_next_rbac > quota_limit:
        return CellScaleOutDecision(
            False, "subscription_rbac_quota_ceiling", provider, len(matching)
        )

    next_idx = max(_cell_index(c.cell_id) for c in matching) + 1
    existing_ids = {c.cell_id for c in matching}
    while True:
        planned = _make_next_cell_config(template, next_idx, min_warm_override=min_warm_override)
        if planned.cell_id not in existing_ids:
            break
        next_idx += 1

    return CellScaleOutDecision(
        should_scale_out=True,
        reason="all_cells_at_or_above_soft_watermark",
        provider=provider,
        evaluated_cell_count=len(matching),
        next_cell_id=planned.cell_id,
        template_cell_id=template.cell_id,
        planned_config=planned,
    )


def _cell_from_resource_group(
    template: UmbrellaCellConfig,
    rg_item: Mapping[str, Any],
) -> UmbrellaCellConfig | None:
    tags = {str(k): str(v) for k, v in (rg_item.get("tags") or {}).items() if v is not None}
    if tags.get("hussh-tenancy") != "hussh-hosted":
        return None
    if tags.get("hussh-environment") != "dev":
        return None
    cell_id = tags.get("hussh-cell-id", "").strip()
    if not cell_id.startswith("cell-az-"):
        return None
    rg_name = str(rg_item.get("name") or "").strip()
    if not rg_name:
        return None
    storage_account = tags.get("hussh-storage-account", "").strip()
    key_vault_name = tags.get("hussh-key-vault", "").strip()
    env_name = tags.get("hussh-cae-name", "").strip()
    env_id = tags.get("hussh-cae-id", "").strip()
    if not (storage_account and key_vault_name and env_name and env_id):
        # Skip partial/incomplete RG provisioning until tag publication settles.
        return None

    shared_rg = tags.get("hussh-shared-rg", "").strip() or template.resource_group
    is_sibling = bool(shared_rg and shared_rg != rg_name)
    min_warm = (
        int(tags["hussh-min-warm"])
        if tags.get("hussh-min-warm", "").isdigit()
        else (1 if is_sibling and template.min_warm_skeletons > 0 else template.min_warm_skeletons)
    )
    soft_wm = (
        int(tags["hussh-soft-watermark"])
        if tags.get("hussh-soft-watermark", "").isdigit()
        else template.soft_watermark
    )
    hard_wm = (
        int(tags["hussh-hard-watermark"])
        if tags.get("hussh-hard-watermark", "").isdigit()
        else template.hard_watermark
    )
    location = str(rg_item.get("location") or template.location).strip() or template.location
    return UmbrellaCellConfig(
        cell_id=cell_id,
        provider=BACKEND_AZURE,
        organization=template.organization,
        soft_watermark=soft_wm,
        hard_watermark=hard_wm,
        min_warm_skeletons=min_warm,
        max_warm_skeletons=template.max_warm_skeletons,
        replenish_batch_size=template.replenish_batch_size,
        shared_cell_fixed_monthly_usd=0.0 if is_sibling else template.shared_cell_fixed_monthly_usd,
        per_warm_slot_standing_monthly_usd=template.per_warm_slot_standing_monthly_usd,
        tenant_id=template.tenant_id,
        subscription_id=template.subscription_id,
        resource_group=rg_name,
        shared_resource_group=shared_rg,
        location=location,
        environment_name=env_name,
        environment_id=env_id,
        registry_server=template.registry_server,
        storage_account=storage_account,
        key_vault_name=key_vault_name,
        openai_endpoint=template.openai_endpoint,
        openai_deployment=template.openai_deployment,
        controller_client_id=template.controller_client_id,
        image_digest=template.image_digest,
        slots=(),
    )


def discover_azure_umbrella_cells_sync(
    template: UmbrellaCellConfig,
    *,
    arm_client: ArmClient | None = None,
) -> tuple[UmbrellaCellConfig, ...]:
    """Discover dynamically provisioned Dev Azure Umbrella Cells via one O(1) RG listing."""
    if deploy_lane() != "dev":
        return ()
    if template.provider != BACKEND_AZURE or not template.subscription_id:
        return ()
    arm = arm_client
    if arm is None:
        controller_client_id = (
            os.getenv("HUSSH_HOSTED_AZURE_CLIENT_ID") or template.controller_client_id
        ).strip()
        arm = ArmClient(
            lambda: (
                azure_federation.app_token(
                    template.tenant_id, client_id=controller_client_id
                ).access_token
            )
        )

    sub_groups_path = f"/subscriptions/{template.subscription_id}/resourcegroups"
    payload = arm.get(
        sub_groups_path,
        api_version=API_VERSIONS["resources"],
        op="umbrella_scaleout_discover_rgs",
    )
    items = payload.get("value") if isinstance(payload, Mapping) else None
    if not isinstance(items, list):
        return ()
    discovered: list[UmbrellaCellConfig] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        parsed = _cell_from_resource_group(template, item)
        if parsed is not None:
            discovered.append(parsed)
    discovered.sort(key=lambda c: (_cell_index(c.cell_id), c.cell_id))
    return tuple(discovered)


def _retarget_planned_cell_location(
    planned: UmbrellaCellConfig,
    location: str,
    *,
    cell_index: int | None = None,
) -> UmbrellaCellConfig:
    loc = str(location or planned.location or "eastus2").strip().lower()
    idx = cell_index if cell_index is not None else _cell_index(planned.cell_id)
    suffix = f"{idx:02d}"
    loc_slug = re.sub(r"[^a-z0-9]", "", loc) or "eastus2"
    short_loc = _short_location(loc)
    rg_name = f"rg-hussh-cell-dev-{loc_slug}-{suffix}"[:90]
    env_name = f"cae-hussh-cell-dev-{short_loc}-{suffix}"[:32]
    env_id = (
        f"/subscriptions/{planned.subscription_id}/resourceGroups/{rg_name}/"
        f"providers/Microsoft.App/managedEnvironments/{env_name}"
        if planned.subscription_id
        else ""
    )
    return replace(
        planned,
        cell_id=f"cell-az-{loc_slug}-dev-{suffix}"[:63],
        location=loc,
        resource_group=rg_name,
        environment_name=env_name,
        environment_id=env_id,
        storage_account=_storage_account_name(planned.storage_account, loc, idx),
        key_vault_name=_key_vault_name(planned.key_vault_name, loc, idx),
    )


def _put_key_vault_with_dns_settle(
    arm: ArmClient,
    kv_scope: str,
    body: dict[str, Any],
    *,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    try:
        return arm.put(
            kv_scope,
            api_version=API_VERSIONS["key_vault"],
            body=body,
            op="umbrella_scaleout_key_vault",
        )
    except ArmError as exc:
        if exc.code != "OperationReferenceMissing":
            raise
        for delay in _KV_DNS_POLL_DELAYS:
            sleep(delay)
            vault = arm.get_or_none(
                kv_scope,
                api_version=API_VERSIONS["key_vault"],
                op="umbrella_scaleout_key_vault_poll",
            )
            props = vault.get("properties") if isinstance(vault, Mapping) else {}
            state = str((props or {}).get("provisioningState") or "").strip().lower()
            if state == "succeeded":
                return dict(vault or {})
        raise


def _is_regional_cae_quota_error(exc: ArmError) -> bool:
    code = (exc.code or "").strip()
    return (
        code == "MaxNumberOfRegionalEnvironmentsInSubExceeded"
        or "MaxNumberOfRegionalEnvironmentsInSubExceeded" in str(exc)
    )


def _is_global_cae_quota_error(exc: ArmError) -> bool:
    code = (exc.code or "").strip()
    return (
        code == "MaxNumberOfGlobalEnvironmentsInSubExceeded"
        or "MaxNumberOfGlobalEnvironmentsInSubExceeded" in str(exc)
    )


def _provision_single_region_cell_sync(
    arm: ArmClient,
    template: UmbrellaCellConfig,
    candidate: UmbrellaCellConfig,
    *,
    sleep: Callable[[float], None],
    reuse_template_cae: bool = False,
) -> UmbrellaCellConfig:
    shared_rg = (
        candidate.shared_resource_group or template.resource_group or candidate.resource_group
    ).strip()
    if reuse_template_cae:
        if not template.environment_id or candidate.location != template.location:
            raise ValueError(
                f"Shared Consumption CAE reuse requires matching location and environment_id on {template.cell_id}"
            )
        env_name = template.environment_name
        env_id = template.environment_id
    else:
        env_name = candidate.environment_name
        env_id = candidate.environment_id

    base_tags: dict[str, str] = {
        "hussh-tenancy": "hussh-hosted",
        "hussh-environment": "dev",
        "hussh-cell-id": candidate.cell_id,
        "hussh-shared-rg": shared_rg,
        "hussh-storage-account": candidate.storage_account,
        "hussh-key-vault": candidate.key_vault_name,
        "hussh-cae-name": env_name,
        "hussh-soft-watermark": str(candidate.soft_watermark),
        "hussh-hard-watermark": str(candidate.hard_watermark),
        "hussh-min-warm": str(candidate.min_warm_skeletons),
        "hussh-budget-cents": "20000",
    }

    group_scope = (
        f"/subscriptions/{candidate.subscription_id}/resourceGroups/{candidate.resource_group}"
    )
    arm.put(
        group_scope,
        api_version=API_VERSIONS["resources"],
        body={"location": candidate.location, "tags": base_tags},
        op="umbrella_scaleout_rg",
    )

    if not reuse_template_cae:
        env_scope = f"{group_scope}/providers/Microsoft.App/managedEnvironments/{candidate.environment_name}"
        try:
            env_resp = arm.put(
                env_scope,
                api_version=API_VERSIONS["container_apps"],
                body={
                    "location": candidate.location,
                    "tags": base_tags,
                    "properties": {
                        "workloadProfiles": [
                            {"name": "Consumption", "workloadProfileType": "Consumption"}
                        ],
                        "appLogsConfiguration": {"destination": None},
                        "zoneRedundant": False,
                    },
                },
                op="umbrella_scaleout_cae",
            )
        except ArmError as exc:
            if _is_regional_cae_quota_error(exc) or _is_global_cae_quota_error(exc):
                arm.delete(
                    group_scope,
                    api_version=API_VERSIONS["resources"],
                    op="umbrella_scaleout_cleanup_quota_rg",
                )
            raise

        props = env_resp.get("properties") if isinstance(env_resp, Mapping) else {}
        prov_state = str((props or {}).get("provisioningState") or "").strip().lower()
        env_id = str((env_resp or {}).get("id") or env_scope).strip()
        if prov_state and prov_state != "succeeded":
            raise RuntimeError(
                f"Umbrella Cell {candidate.cell_id} CAE provisioningState={prov_state!r}"
            )

    storage_scope = (
        f"{group_scope}/providers/Microsoft.Storage/storageAccounts/{candidate.storage_account}"
    )
    arm.put(
        storage_scope,
        api_version=API_VERSIONS["storage"],
        body={
            "location": candidate.location,
            "tags": base_tags,
            "sku": {"name": "Standard_LRS"},
            "kind": "StorageV2",
            "properties": {
                "allowSharedKeyAccess": False,
                "allowBlobPublicAccess": False,
                "allowCrossTenantReplication": False,
                "defaultToOAuthAuthentication": True,
                "minimumTlsVersion": "TLS1_2",
                "supportsHttpsTrafficOnly": True,
                "publicNetworkAccess": "Enabled",
            },
        },
        op="umbrella_scaleout_storage",
    )
    arm.put(
        f"{storage_scope}/blobServices/default",
        api_version=API_VERSIONS["storage"],
        body={
            "properties": {
                "deleteRetentionPolicy": {"enabled": False},
                "containerDeleteRetentionPolicy": {"enabled": False},
                "isVersioningEnabled": False,
            }
        },
        op="umbrella_scaleout_blob_service",
    )

    kv_scope = f"{group_scope}/providers/Microsoft.KeyVault/vaults/{candidate.key_vault_name}"
    _put_key_vault_with_dns_settle(
        arm,
        kv_scope,
        {
            "location": candidate.location,
            "tags": base_tags,
            "properties": {
                "tenantId": candidate.tenant_id,
                "sku": {"family": "A", "name": "standard"},
                "enableRbacAuthorization": True,
                "enableSoftDelete": True,
                "softDeleteRetentionInDays": 90,
                "publicNetworkAccess": "Enabled",
            },
        },
        sleep=sleep,
    )

    final_tags = {**base_tags, "hussh-cae-id": env_id}
    arm.put(
        group_scope,
        api_version=API_VERSIONS["resources"],
        body={"location": candidate.location, "tags": final_tags},
        op="umbrella_scaleout_rg_tags",
    )

    logger.info(
        "umbrella_cell_scaler.cell_provisioned cell=%s rg=%s env=%s shared_rg=%s",
        candidate.cell_id,
        candidate.resource_group,
        candidate.environment_name,
        shared_rg,
    )
    return replace(
        candidate,
        shared_resource_group=shared_rg,
        environment_name=env_name,
        environment_id=env_id,
        shared_cell_fixed_monthly_usd=0.0,
    )


def provision_azure_umbrella_cell_sync(
    template: UmbrellaCellConfig,
    planned: UmbrellaCellConfig,
    *,
    arm_client: ArmClient | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> UmbrellaCellConfig:
    """Create a sibling Dev Azure Umbrella Cell RG + CAE + StorageV2 + KeyVault with regional & global-quota fallback."""
    if deploy_lane() != "dev":
        raise PermissionError("Horizontal Umbrella Cell creation is restricted to the dev lane")
    if planned.provider != BACKEND_AZURE:
        raise ValueError(f"Unsupported provider {planned.provider!r} for Azure cell provisioning")
    if not (
        planned.subscription_id
        and planned.tenant_id
        and planned.resource_group
        and planned.storage_account
        and planned.key_vault_name
        and planned.environment_name
    ):
        raise ValueError(f"Planned cell {planned.cell_id} is missing Azure coordinates")

    arm = arm_client
    if arm is None:
        controller_client_id = (
            os.getenv("HUSSH_HOSTED_AZURE_CLIENT_ID")
            or planned.controller_client_id
            or template.controller_client_id
        ).strip()
        arm = ArmClient(
            lambda: (
                azure_federation.app_token(
                    planned.tenant_id, client_id=controller_client_id
                ).access_token
            )
        )

    primary_loc = str(planned.location or "eastus2").strip().lower()
    candidates = [primary_loc, *(r for r in _AZURE_OVERFLOW_REGIONS if r != primary_loc)]
    cell_idx = _cell_index(planned.cell_id)
    last_quota_err: ArmError | None = None
    for idx, loc in enumerate(candidates):
        target_cfg = (
            planned
            if idx == 0
            else _retarget_planned_cell_location(planned, loc, cell_index=cell_idx)
        )
        try:
            return _provision_single_region_cell_sync(arm, template, target_cfg, sleep=sleep)
        except ArmError as exc:
            if _is_global_cae_quota_error(exc):
                logger.warning(
                    "umbrella_cell_scaler.global_cae_quota_reached region=%s cell=%s",
                    loc,
                    target_cfg.cell_id,
                )
                last_quota_err = exc
                if template.environment_id:
                    sibling = (
                        planned
                        if planned.location == template.location
                        else _retarget_planned_cell_location(
                            planned, template.location or primary_loc, cell_index=cell_idx
                        )
                    )
                    return _provision_single_region_cell_sync(
                        arm, template, sibling, sleep=sleep, reuse_template_cae=True
                    )
                break
            if _is_regional_cae_quota_error(exc):
                logger.warning(
                    "umbrella_cell_scaler.region_cae_quota_full region=%s cell=%s",
                    loc,
                    target_cfg.cell_id,
                )
                last_quota_err = exc
                continue
            raise
    if last_quota_err is not None:
        raise last_quota_err
    raise RuntimeError(f"Unable to provision Umbrella Cell {planned.cell_id}")


__all__ = [
    "BACKEND_GCP",
    "CellScaleOutDecision",
    "discover_azure_umbrella_cells_sync",
    "evaluate_horizontal_cell_scaleout",
    "provision_azure_umbrella_cell_sync",
]
