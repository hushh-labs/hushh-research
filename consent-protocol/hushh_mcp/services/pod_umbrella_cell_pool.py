# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Umbrella Compute Cells, Pre-Warmed Skeleton Pool, and Relay-First Cutover service.

Solves the two primary scaling & UX walls of 1-project / 1-environment per user:
1. **Umbrella Compute Cells**: packs multiple single-owner private pods cleanly into
   governed multi-tenant compute cells (multiple Cloud Run services per GCP cell project,
   multiple Azure Container Apps per HushOne Inc. cell environment) with strict per-slot
   storage/KMS/identity isolation and deterministic soft/hard capacity watermarks.
2. **Pre-Warmed Skeleton Pool**: keeps ``warm_standby`` pod skeletons already deployed,
   image-pulled, RBAC-settled, and Key-Vault-initialized so claiming a private pod binds an
   owner on the fly in seconds rather than waiting 4-8 minutes for cold infrastructure.
3. **Relay-First Cutover**: lets authenticated Hub->Pod relay traffic serve owner turns
   immediately after public-key publication while direct browser ingress verifies and
   promotes ``external`` -> ``direct``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from hushh_mcp.services.compute_backend import BACKEND_AZURE, BackendHandle, PodSpec
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.hosted_azure_backend import (
    HostedAzureBackend,
    HostedAzureCellSlotSpec,
)
from hushh_mcp.services.pod_key_collector import fetch_pod_public_key

logger = logging.getLogger(__name__)

_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config/dev-hosted-umbrella-cells.json"
_OVERRIDE_ENV = "HUSSH_DEV_UMBRELLA_CELLS_JSON"
_IDLE_ACTIVE_HOURLY_USD = 0.086


def _default_replenish_trigger(cell_id: str) -> None:
    if deploy_lane() != "dev":
        return
    try:
        from hushh_mcp.services.umbrella_cell_replenisher import (  # noqa: PLC0415
            trigger_umbrella_cell_replenish,
        )

        trigger_umbrella_cell_replenish(cell_id)
    except Exception:  # noqa: BLE001 - best-effort reactive wake
        logger.debug("umbrella_pool.replenish_wake_skipped", exc_info=True)


class CellCapacityExceededError(RuntimeError):
    """Raised when an Umbrella Compute Cell has reached its hard watermark."""


class NoWarmSkeletonAvailableError(RuntimeError):
    """Raised when no unclaimed warm_standby skeleton slot exists in the cell pool."""


@dataclass(frozen=True)
class SkeletonSlotConfig:
    slot_id: str
    app_name: str
    app_id: str
    fqdn: str
    identity_id: str
    identity_client_id: str
    identity_principal_id: str
    blob_url: str
    key_vault_key: str
    signing_secret_url: str


@dataclass(frozen=True)
class UmbrellaCellConfig:
    cell_id: str
    provider: str
    organization: str
    soft_watermark: int
    hard_watermark: int
    min_warm_skeletons: int
    max_warm_skeletons: int = 4
    replenish_batch_size: int = 1
    shared_cell_fixed_monthly_usd: float = 0.0
    per_warm_slot_standing_monthly_usd: float = 0.0
    tenant_id: str = ""
    subscription_id: str = ""
    resource_group: str = ""
    location: str = ""
    environment_name: str = ""
    environment_id: str = ""
    registry_server: str = ""
    storage_account: str = ""
    key_vault_name: str = ""
    openai_endpoint: str = ""
    openai_deployment: str = ""
    controller_client_id: str = ""
    image_digest: str = ""
    slots: tuple[SkeletonSlotConfig, ...] = ()
    shared_resource_group: str = ""


@dataclass(frozen=True)
class CellCostEconomics:
    cost_guard_healthy: bool
    idle_compute_hourly_usd_per_warm_slot: float
    per_warm_slot_standing_monthly_usd: float
    shared_cell_fixed_monthly_usd: float
    amortized_fixed_monthly_usd_at_soft_watermark: float
    dedicated_rg_baseline_monthly_usd: float
    fixed_overhead_reduction_pct: float
    control_plane_inspection_only: bool
    zero_scale_verified_slots: tuple[str, ...]
    subscription_rbac_assignments_used: int
    subscription_rbac_quota_limit: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "costGuardHealthy": self.cost_guard_healthy,
            "idleComputeHourlyUsdPerWarmSlot": self.idle_compute_hourly_usd_per_warm_slot,
            "perWarmSlotStandingMonthlyUsd": self.per_warm_slot_standing_monthly_usd,
            "sharedCellFixedMonthlyUsd": self.shared_cell_fixed_monthly_usd,
            "amortizedFixedMonthlyUsdPerSlotAtSoftWatermark": (
                self.amortized_fixed_monthly_usd_at_soft_watermark
            ),
            "dedicatedRgBaselineMonthlyUsd": self.dedicated_rg_baseline_monthly_usd,
            "fixedOverheadReductionPct": self.fixed_overhead_reduction_pct,
            "controlPlaneInspectionOnly": self.control_plane_inspection_only,
            "zeroScaleVerifiedSlots": list(self.zero_scale_verified_slots),
            "subscriptionRbacAssignmentsUsed": self.subscription_rbac_assignments_used,
            "subscriptionRbacQuotaLimit": self.subscription_rbac_quota_limit,
        }


def evaluate_cell_cost_economics(
    cell: UmbrellaCellConfig,
    *,
    active_slots: int,
    warm_standby_slots: int,
    provisioning_slots: int = 0,
    zero_scale_verified_slots: Sequence[str] = (),
    cost_guard_healthy: bool = True,
) -> CellCostEconomics:
    """Compute standing/idle cost posture and RBAC quota headroom for one Umbrella Cell."""
    soft = max(1, cell.soft_watermark)
    amortized = round(cell.shared_cell_fixed_monthly_usd / soft, 4)
    baseline = 5.0 if cell.provider == BACKEND_AZURE else 1.5
    reduction_pct = (
        round(max(0.0, (1.0 - (amortized / baseline)) * 100.0), 2) if baseline > 0 else 0.0
    )
    materialized = max(0, active_slots + warm_standby_slots + provisioning_slots)
    rbac_per_slot = 5 if cell.provider == BACKEND_AZURE else 3
    rbac_limit = 4000 if cell.provider == BACKEND_AZURE else 3000
    return CellCostEconomics(
        cost_guard_healthy=bool(cost_guard_healthy),
        idle_compute_hourly_usd_per_warm_slot=0.0
        if cost_guard_healthy
        else _IDLE_ACTIVE_HOURLY_USD,
        per_warm_slot_standing_monthly_usd=round(cell.per_warm_slot_standing_monthly_usd, 4),
        shared_cell_fixed_monthly_usd=round(cell.shared_cell_fixed_monthly_usd, 2),
        amortized_fixed_monthly_usd_at_soft_watermark=amortized,
        dedicated_rg_baseline_monthly_usd=baseline,
        fixed_overhead_reduction_pct=reduction_pct,
        control_plane_inspection_only=True,
        zero_scale_verified_slots=tuple(sorted(set(zero_scale_verified_slots))),
        subscription_rbac_assignments_used=materialized * rbac_per_slot,
        subscription_rbac_quota_limit=rbac_limit,
    )


def project_fleet_scale_economics(
    cells: Sequence[UmbrellaCellConfig],
    *,
    owner_tiers: Sequence[int] = (100, 1000, 10000),
) -> dict[str, Any]:
    """Project cell counts, warm buffer idle compute ($0.00/mo), and amortized fixed cost."""
    by_provider: dict[str, UmbrellaCellConfig] = {}
    for cell in cells:
        by_provider.setdefault(cell.provider, cell)

    providers: dict[str, list[dict[str, Any]]] = {}
    for provider, rep in by_provider.items():
        soft = max(1, rep.soft_watermark)
        hard = max(soft, rep.hard_watermark)
        min_warm = max(0, rep.min_warm_skeletons)
        rbac_per_slot = 5 if provider == BACKEND_AZURE else 3
        rbac_limit = 4000 if provider == BACKEND_AZURE else 3000
        baseline = 5.0 if provider == BACKEND_AZURE else 1.5
        rows: list[dict[str, Any]] = []
        for owners in owner_tiers:
            owner_count = max(1, int(owners))
            cells_needed = max(1, math.ceil(owner_count / soft))
            warm_buffer = cells_needed * min_warm
            shared_fixed = round(cells_needed * rep.shared_cell_fixed_monthly_usd, 2)
            standing_warm = round(warm_buffer * rep.per_warm_slot_standing_monthly_usd, 4)
            per_owner_fixed = round((shared_fixed + standing_warm) / owner_count, 4)
            subs_or_projects = max(1, math.ceil((cells_needed * hard * rbac_per_slot) / rbac_limit))
            rows.append(
                {
                    "targetActiveOwners": owner_count,
                    "cellsRequiredAtSoftWatermark": cells_needed,
                    "warmBufferSlotsTotal": warm_buffer,
                    "warmBufferIdleComputeMonthlyUsd": 0.0,
                    "sharedFixedMonthlyUsdTotal": shared_fixed,
                    "effectiveFixedMonthlyUsdPerOwner": per_owner_fixed,
                    "dedicatedBaselineMonthlyUsdPerOwner": baseline,
                    "subscriptionsOrProjectsRequiredUnderQuota": subs_or_projects,
                }
            )
        providers[provider] = rows
    return {"ownerTiers": [int(t) for t in owner_tiers], "providers": providers}


@dataclass(frozen=True)
class UmbrellaCellCapacity:
    cell_id: str
    provider: str
    active_slots: int
    warm_standby_slots: int
    soft_watermark: int
    hard_watermark: int
    utilization_ratio: float
    needs_cell_expansion: bool
    admits_new_owners: bool


@dataclass(frozen=True)
class ClaimedSkeletonResult:
    cell: UmbrellaCellConfig
    slot: SkeletonSlotConfig
    handle: BackendHandle
    published_keys: dict[str, str]
    claim_latency_ms: int
    relay_ready: bool
    remaining_warm_standby: int
    replenishment_recommended: bool


class UmbrellaCellRegistry:
    """Authoritative catalog and capacity evaluator for Dev Umbrella Compute Cells."""

    def __init__(self, raw_config: Mapping[str, Any] | None = None) -> None:
        if raw_config is None:
            override = os.getenv(_OVERRIDE_ENV, "").strip()
            raw_config = (
                json.loads(override) if override else json.loads(_CONFIG_PATH.read_text("utf-8"))
            )
        self._raw = dict(raw_config)
        self._cells: dict[str, UmbrellaCellConfig] = {}
        for item in raw_config.get("cells") or []:
            slots = tuple(
                SkeletonSlotConfig(
                    slot_id=str(s["slotId"]),
                    app_name=str(s["appName"]),
                    app_id=str(s["appId"]),
                    fqdn=str(s["fqdn"]),
                    identity_id=str(s["identityId"]),
                    identity_client_id=str(s["identityClientId"]),
                    identity_principal_id=str(s.get("identityPrincipalId") or ""),
                    blob_url=str(s["blobUrl"]),
                    key_vault_key=str(s["keyVaultKey"]),
                    signing_secret_url=str(s["signingSecretUrl"]),
                )
                for s in (item.get("slots") or [])
            )
            provider_str = str(item["provider"])
            min_warm = int(item.get("minWarmSkeletons") or 0)
            default_max_warm = max(min_warm + 2, 2) if min_warm > 0 else 4
            default_fixed_usd = 5.0 if provider_str == BACKEND_AZURE else 0.0
            cell = UmbrellaCellConfig(
                cell_id=str(item["cellId"]),
                provider=provider_str,
                organization=str(item["organization"]),
                soft_watermark=int(item["softWatermark"]),
                hard_watermark=int(item["hardWatermark"]),
                min_warm_skeletons=min_warm,
                max_warm_skeletons=int(item.get("maxWarmSkeletons") or default_max_warm),
                replenish_batch_size=max(1, int(item.get("replenishBatchSize") or 1)),
                shared_cell_fixed_monthly_usd=float(
                    item["sharedCellFixedMonthlyUsd"]
                    if "sharedCellFixedMonthlyUsd" in item
                    else default_fixed_usd
                ),
                per_warm_slot_standing_monthly_usd=float(
                    item.get("perWarmSlotStandingMonthlyUsd") or 0.0
                ),
                tenant_id=str(item.get("tenantId") or ""),
                subscription_id=str(item.get("subscriptionId") or ""),
                resource_group=str(item.get("resourceGroup") or ""),
                location=str(item.get("location") or ""),
                environment_name=str(item.get("environmentName") or ""),
                environment_id=str(item.get("environmentId") or ""),
                registry_server=str(item.get("registryServer") or ""),
                storage_account=str(item.get("storageAccount") or ""),
                key_vault_name=str(item.get("keyVaultName") or ""),
                openai_endpoint=str(item.get("openaiEndpoint") or ""),
                openai_deployment=str(item.get("openaiDeployment") or ""),
                controller_client_id=str(item.get("controllerClientId") or ""),
                image_digest=str(item.get("imageDigest") or ""),
                slots=slots,
                shared_resource_group=str(item.get("sharedResourceGroup") or ""),
            )
            self._cells[cell.cell_id] = cell

    def upsert_cells(self, cells: Sequence[UmbrellaCellConfig]) -> None:
        """Register dynamically scaled-out cells without clobbering static slot overrides."""
        for cell in cells:
            existing = self._cells.get(cell.cell_id)
            if existing is None:
                self._cells[cell.cell_id] = cell
            elif not existing.slots and cell.slots:
                self._cells[cell.cell_id] = cell

    def list_cells(self, *, provider: str | None = None) -> tuple[UmbrellaCellConfig, ...]:
        cells = sorted(self._cells.values(), key=lambda c: _slot_sort_key(c.cell_id))
        if provider:
            return tuple(c for c in cells if c.provider == provider)
        return tuple(cells)

    def azure_cell(self, cell_id: str | None = None) -> UmbrellaCellConfig:
        if cell_id:
            cell = self._cells.get(cell_id)
            if cell is None or cell.provider != BACKEND_AZURE:
                raise KeyError(f"Unknown hosted Azure Umbrella Cell {cell_id!r}")
            return cell
        candidates = self.list_cells(provider=BACKEND_AZURE)
        if not candidates:
            raise KeyError("No hosted Azure Umbrella Cell configured")
        return candidates[0]

    @staticmethod
    def evaluate_capacity(
        cell: UmbrellaCellConfig,
        *,
        active_slots: int,
        warm_standby_slots: int,
    ) -> UmbrellaCellCapacity:
        hard = max(1, cell.hard_watermark)
        ratio = round(active_slots / hard, 4)
        return UmbrellaCellCapacity(
            cell_id=cell.cell_id,
            provider=cell.provider,
            active_slots=active_slots,
            warm_standby_slots=warm_standby_slots,
            soft_watermark=cell.soft_watermark,
            hard_watermark=cell.hard_watermark,
            utilization_ratio=ratio,
            needs_cell_expansion=active_slots >= cell.soft_watermark,
            admits_new_owners=active_slots < cell.hard_watermark,
        )


def relay_first_cutover_status(row: Mapping[str, Any] | None) -> dict[str, Any]:
    """Summarize Relay-First cutover posture for a private pod row.

    Once ``pod_pubkey`` and an HTTPS endpoint exist on a provisioned row, Hub->Pod
    relay turns can execute immediately (even while ``ingress`` is still
    ``"external"`` awaiting CORS/wall readback promotion to ``"direct"``).
    """
    if not isinstance(row, Mapping):
        return {
            "relayReady": False,
            "directReady": False,
            "mode": "unavailable",
        }
    metadata = (
        row.get("backend_metadata") if isinstance(row.get("backend_metadata"), Mapping) else {}
    )
    url = str(metadata.get("url") or "").strip()
    ingress = str(metadata.get("ingress") or "").strip()
    readiness = (
        metadata.get("directReadiness")
        if isinstance(metadata.get("directReadiness"), Mapping)
        else {}
    )
    has_key = bool(str(row.get("pod_pubkey") or "").strip()) and bool(
        str(row.get("pod_key_id") or "").strip()
    )
    relay_ready = (
        row.get("status") == "provisioned"
        and has_key
        and url.startswith("https://")
        and "erasure" not in metadata
    )
    direct_ready = relay_ready and ingress == "direct" and readiness.get("verified") is True
    mode = "direct" if direct_ready else ("relay_first" if relay_ready else "pending")
    return {
        "relayReady": relay_ready,
        "directReady": direct_ready,
        "ingress": ingress,
        "mode": mode,
    }


def _slot_spec(cell: UmbrellaCellConfig, slot: SkeletonSlotConfig) -> HostedAzureCellSlotSpec:
    return HostedAzureCellSlotSpec(
        cell_id=cell.cell_id,
        slot_id=slot.slot_id,
        organization=cell.organization,
        tenant_id=cell.tenant_id,
        subscription_id=cell.subscription_id,
        resource_group=cell.resource_group,
        location=cell.location,
        environment_id=cell.environment_id,
        registry_server=cell.registry_server,
        image_digest=cell.image_digest,
        controller_client_id=cell.controller_client_id,
        app_name=slot.app_name,
        app_id=slot.app_id,
        fqdn=slot.fqdn,
        identity_id=slot.identity_id,
        identity_client_id=slot.identity_client_id,
        blob_url=slot.blob_url,
        key_vault_key=slot.key_vault_key,
        signing_secret_url=slot.signing_secret_url,
        openai_endpoint=cell.openai_endpoint,
        openai_deployment=cell.openai_deployment,
    )


def _slot_sort_key(slot_id: str) -> tuple[int, str]:
    digits = "".join(ch for ch in slot_id if ch.isdigit())
    return (int(digits) if digits else 10**6, slot_id)


def _cell_probe_slot_spec(cell: UmbrellaCellConfig) -> HostedAzureCellSlotSpec:
    if cell.slots:
        return _slot_spec(cell, cell.slots[0])
    return HostedAzureCellSlotSpec(
        cell_id=cell.cell_id,
        slot_id="probe",
        organization=cell.organization,
        tenant_id=cell.tenant_id,
        subscription_id=cell.subscription_id,
        resource_group=cell.resource_group,
        location=cell.location,
        environment_id=cell.environment_id,
        registry_server=cell.registry_server,
        image_digest=cell.image_digest,
        controller_client_id=cell.controller_client_id,
        app_name="probe",
        app_id="",
        fqdn="",
        identity_id="",
        identity_client_id="",
        blob_url="",
        key_vault_key="",
        signing_secret_url="",
        openai_endpoint=cell.openai_endpoint,
        openai_deployment=cell.openai_deployment,
    )


def _reconstruct_slot_from_arm_app(
    cell: UmbrellaCellConfig,
    app: Mapping[str, Any],
    static_by_id: Mapping[str, SkeletonSlotConfig],
) -> tuple[SkeletonSlotConfig, dict[str, Any], bool, bool, bool] | None:
    """Reconstruct a dynamic SkeletonSlotConfig + readiness/cost posture from ARM JSON.

    Returns ``(slot, tags, is_provisioning, is_zero_scale_verified, warm_cost_healthy)``
    or ``None`` if the ARM resource does not belong to this cell.
    """
    tags = {str(k): v for k, v in (app.get("tags") or {}).items()}
    app_name = str(app.get("name") or "").strip()
    raw_app_id = str(app.get("id") or "").strip()
    static_match: SkeletonSlotConfig | None = None
    slot_id = str(tags.get("hussh-slot-id") or "").strip()
    if slot_id and slot_id in static_by_id:
        static_match = static_by_id[slot_id]
    elif raw_app_id:
        raw_lower = raw_app_id.lower()
        for cand in static_by_id.values():
            if cand.app_id.lower() == raw_lower or cand.app_name == app_name:
                static_match = cand
                slot_id = cand.slot_id
                break

    tag_cell = str(tags.get("hussh-cell-id") or "").strip()
    if tag_cell and tag_cell != cell.cell_id:
        return None
    if not tag_cell and static_match is None:
        return None
    if not slot_id and app_name.startswith("ca-pod-"):
        slot_id = app_name.removeprefix("ca-pod-")
    if not slot_id:
        return None

    props = app.get("properties") if isinstance(app.get("properties"), Mapping) else {}
    config = props.get("configuration") if isinstance(props.get("configuration"), Mapping) else {}
    ingress = config.get("ingress") if isinstance(config.get("ingress"), Mapping) else {}
    template = props.get("template") if isinstance(props.get("template"), Mapping) else {}
    scale = template.get("scale") if isinstance(template.get("scale"), Mapping) else {}

    fqdn = str(ingress.get("fqdn") or (static_match.fqdn if static_match else "")).strip()
    uamis = (app.get("identity") or {}).get("userAssignedIdentities") or {}
    identity_id = static_match.identity_id if static_match else ""
    identity_client_id = static_match.identity_client_id if static_match else ""
    identity_principal_id = static_match.identity_principal_id if static_match else ""
    if isinstance(uamis, Mapping) and uamis:
        first_id, first_val = next(iter(uamis.items()))
        identity_id = str(first_id or identity_id).strip()
        if isinstance(first_val, Mapping):
            identity_client_id = str(first_val.get("clientId") or identity_client_id).strip()
            identity_principal_id = str(
                first_val.get("principalId") or identity_principal_id
            ).strip()

    signing_secret_url = static_match.signing_secret_url if static_match else ""
    for sec in config.get("secrets") or []:
        if isinstance(sec, Mapping) and sec.get("keyVaultUrl"):
            signing_secret_url = str(sec["keyVaultUrl"]).strip()
            break
    if not signing_secret_url and cell.key_vault_name:
        signing_secret_url = (
            f"https://{cell.key_vault_name}.vault.azure.net/secrets/pod-signing-key-{slot_id}"
        )

    blob_url = str(
        tags.get("hussh-blob-url")
        or (static_match.blob_url if static_match else "")
        or (
            f"https://{cell.storage_account}.blob.core.windows.net/pod-{slot_id}"
            if cell.storage_account
            else ""
        )
    ).strip()
    key_vault_key = str(
        tags.get("hussh-kv-key-uri") or (static_match.key_vault_key if static_match else "")
    ).strip()

    canonical_name = app_name or (static_match.app_name if static_match else f"ca-pod-{slot_id}")
    canonical_app_id = (
        static_match.app_id
        if static_match is not None
        else (
            f"/subscriptions/{cell.subscription_id}/resourceGroups/{cell.resource_group}/"
            f"providers/Microsoft.App/containerApps/{canonical_name}"
        )
    )
    reconstructed = SkeletonSlotConfig(
        slot_id=slot_id,
        app_name=canonical_name,
        app_id=canonical_app_id,
        fqdn=fqdn,
        identity_id=identity_id,
        identity_client_id=identity_client_id,
        identity_principal_id=identity_principal_id,
        blob_url=blob_url,
        key_vault_key=key_vault_key,
        signing_secret_url=signing_secret_url,
    )

    prov_state = str(props.get("provisioningState") or "").strip().lower()
    ready_rev = str(props.get("latestReadyRevisionName") or "").strip()
    pool_state = str(tags.get("hussh-pool-state") or "warm_standby").strip()
    owner_hash = str(tags.get("hussh-owner-hash") or "").strip()

    # Fake/unit-test stubs returning only {"tags": ...} leave properties omitted.
    has_arm_props = bool(props)
    is_provisioning = pool_state == "provisioning_skeleton" or (
        has_arm_props
        and (prov_state != "succeeded" or not ready_rev or not fqdn or not key_vault_key)
    )

    min_replicas = int(scale.get("minReplicas") or 0) if has_arm_props else 0
    workload_profile = str(props.get("workloadProfileName") or "Consumption")
    is_warm_unowned = not is_provisioning and pool_state in {"", "warm_standby"} and not owner_hash
    warm_cost_healthy = True
    is_zero_scale = False
    if is_warm_unowned:
        warm_cost_healthy = min_replicas == 0 and workload_profile in {"", "Consumption"}
        is_zero_scale = warm_cost_healthy
    return reconstructed, tags, is_provisioning, is_zero_scale, warm_cost_healthy


class PodSkeletonPoolService:
    """Synchronized pre-warmed skeleton claimer, watermark enforcer, and replenisher."""

    _process_lock = threading.Lock()
    _process_claims: dict[str, str] = {}

    def __init__(
        self,
        *,
        registry: UmbrellaCellRegistry | None = None,
        backend_factory: Callable[[HostedAzureCellSlotSpec], HostedAzureBackend] | None = None,
        key_fetcher: Any = None,
        clock: Callable[[], float] = time.monotonic,
        replenish_callback: Callable[[str], None] | None = None,
    ) -> None:
        self._registry = registry or UmbrellaCellRegistry()
        self._backend_factory = backend_factory or (
            lambda slot_spec: HostedAzureBackend(slot=slot_spec)
        )
        self._key_fetcher = key_fetcher or fetch_pod_public_key
        self._clock = clock
        self._replenish_callback = (
            replenish_callback if replenish_callback is not None else _default_replenish_trigger
        )
        self._instance_claims: dict[str, str] = {}
        self._instance_lock = threading.Lock()

    def list_live_cells_sync(
        self, *, provider: str | None = None
    ) -> tuple[UmbrellaCellConfig, ...]:
        """Discover dynamically scaled Dev Azure cells in O(1) and merge with static config."""
        static_azure = self._registry.list_cells(provider=BACKEND_AZURE)
        if deploy_lane() == "dev" and static_azure:
            probe_backend = self._backend_factory(_cell_probe_slot_spec(static_azure[0]))
            if bool(getattr(probe_backend, "_live", False)):
                arm = getattr(probe_backend, "_arm_client", None)
                try:
                    from hushh_mcp.services.umbrella_cell_scaler import (  # noqa: PLC0415
                        discover_azure_umbrella_cells_sync,
                    )

                    discovered = discover_azure_umbrella_cells_sync(static_azure[0], arm_client=arm)
                    if discovered:
                        self._registry.upsert_cells(discovered)
                except Exception as exc:  # noqa: BLE001 - static cells remain authoritative on probe miss
                    logger.info(
                        "umbrella_pool.cell_discovery_skipped err=%s",
                        type(exc).__name__,
                    )
        return self._registry.list_cells(provider=provider)

    def slot_spec(self, slot_id: str, *, cell_id: str | None = None) -> HostedAzureCellSlotSpec:
        try:
            cell = self._registry.azure_cell(cell_id)
        except KeyError:
            self.list_live_cells_sync(provider=BACKEND_AZURE)
            cell = self._registry.azure_cell(cell_id)
        for slot in cell.slots:
            if slot.slot_id == slot_id:
                return _slot_spec(cell, slot)
        if deploy_lane() == "dev":
            inventory = self.observe_azure_cell_inventory_sync(cell)
            for slot in inventory["slots"]:
                if slot.slot_id == slot_id:
                    return _slot_spec(cell, slot)
        raise KeyError(f"Unknown skeleton slot {slot_id!r} in cell {cell.cell_id!r}")

    @classmethod
    def reset_process_claims(cls) -> None:
        with cls._process_lock:
            cls._process_claims.clear()

    def _slot_owner_claims(
        self,
        cell: UmbrellaCellConfig,
        occupied_app_ids: set[str] | None = None,
        arm_tags_by_slot: Mapping[str, Mapping[str, Any]] | None = None,
        requesting_owner_hashes: set[str] | None = None,
        slots_override: Sequence[SkeletonSlotConfig] | None = None,
        provisioning_slot_ids: set[str] | None = None,
    ) -> tuple[list[SkeletonSlotConfig], list[SkeletonSlotConfig]]:
        warm: list[SkeletonSlotConfig] = []
        reusable_for_requester: list[SkeletonSlotConfig] = []
        active: list[SkeletonSlotConfig] = []
        occupied_lower = {
            str(item).strip().lower() for item in (occupied_app_ids or set()) if str(item).strip()
        }
        in_flight = provisioning_slot_ids or set()
        candidate_slots = slots_override if slots_override is not None else cell.slots
        for slot in candidate_slots:
            if slot.slot_id in in_flight:
                continue
            process_key = f"{cell.cell_id}:{slot.slot_id}"
            claimed = (
                slot.app_id.lower() in occupied_lower
                or process_key in self._instance_claims
                or process_key in self._process_claims
                or slot.slot_id in self._process_claims
            )
            reusable = False
            if not claimed and arm_tags_by_slot and slot.slot_id in arm_tags_by_slot:
                tags = arm_tags_by_slot[slot.slot_id]
                state = str(tags.get("hussh-pool-state") or "").strip()
                owner_hash = str(tags.get("hussh-owner-hash") or "").strip()
                if requesting_owner_hashes and owner_hash and owner_hash in requesting_owner_hashes:
                    reusable = True
                elif (state and state != "warm_standby") or owner_hash:
                    claimed = True
            if claimed:
                active.append(slot)
            elif reusable:
                reusable_for_requester.append(slot)
            else:
                warm.append(slot)
        return reusable_for_requester + warm, active

    def observe_azure_cell_inventory_sync(
        self,
        cell: UmbrellaCellConfig,
        *,
        allow_per_slot_fallback: bool = True,
    ) -> dict[str, Any]:
        """Observe live ARM slot inventory via O(1) cell listing (never wakes warm containers)."""
        static_by_id = {s.slot_id: s for s in cell.slots}
        merged_by_id: dict[str, SkeletonSlotConfig] = dict(static_by_id)
        arm_tags: dict[str, Mapping[str, Any]] = {}
        provisioning_ids: set[str] = set()
        zero_scale_verified: list[str] = []
        cost_guard_healthy = True

        backend = self._backend_factory(_cell_probe_slot_spec(cell))
        should_probe = bool(getattr(backend, "_live", False)) or not hasattr(backend, "_live")
        listed_ok = False
        if (
            should_probe
            and hasattr(backend, "list_cell_apps_sync")
            and cell.subscription_id
            and cell.resource_group
        ):
            try:
                apps = backend.list_cell_apps_sync(
                    subscription_id=cell.subscription_id,
                    resource_group=cell.resource_group,
                )
                if isinstance(apps, list):
                    listed_ok = True
                    for app in apps:
                        if not isinstance(app, Mapping):
                            continue
                        parsed = _reconstruct_slot_from_arm_app(cell, app, static_by_id)
                        if parsed is None:
                            continue
                        slot_cfg, tags, is_prov, is_zero, warm_ok = parsed
                        merged_by_id[slot_cfg.slot_id] = slot_cfg
                        arm_tags[slot_cfg.slot_id] = tags
                        if is_prov:
                            provisioning_ids.add(slot_cfg.slot_id)
                        if is_zero:
                            zero_scale_verified.append(slot_cfg.slot_id)
                        if not warm_ok:
                            cost_guard_healthy = False
            except Exception as exc:  # noqa: BLE001 - fall back cleanly in tests or unreachable ARM
                logger.info(
                    "umbrella_pool.list_cell_apps_skipped cell=%s err=%s",
                    cell.cell_id,
                    type(exc).__name__,
                )

        if (
            not listed_ok
            and should_probe
            and allow_per_slot_fallback
            and hasattr(backend, "observe_slot_sync")
        ):
            for slot in cell.slots:
                slot_backend = self._backend_factory(_slot_spec(cell, slot))
                try:
                    app = slot_backend.observe_slot_sync(slot.app_id)
                    if isinstance(app, Mapping):
                        parsed = _reconstruct_slot_from_arm_app(cell, app, static_by_id)
                        if parsed is not None:
                            slot_cfg, tags, is_prov, is_zero, warm_ok = parsed
                            merged_by_id[slot_cfg.slot_id] = slot_cfg
                            arm_tags[slot_cfg.slot_id] = tags
                            if is_prov:
                                provisioning_ids.add(slot_cfg.slot_id)
                            if is_zero:
                                zero_scale_verified.append(slot_cfg.slot_id)
                            if not warm_ok:
                                cost_guard_healthy = False
                        else:
                            arm_tags[slot.slot_id] = dict(app.get("tags") or {})
                except Exception as exc:  # noqa: BLE001
                    logger.info(
                        "umbrella_pool.slot_precheck_failed slot=%s err=%s",
                        slot.slot_id,
                        type(exc).__name__,
                    )

        ordered_slots = tuple(merged_by_id[sid] for sid in sorted(merged_by_id, key=_slot_sort_key))
        return {
            "cell": cell,
            "slots": ordered_slots,
            "arm_tags": arm_tags,
            "provisioning_slot_ids": provisioning_ids,
            "zero_scale_verified_slots": tuple(
                sorted(set(zero_scale_verified), key=_slot_sort_key)
            ),
            "cost_guard_healthy": cost_guard_healthy,
        }

    def select_admitting_azure_cell_sync(
        self,
        *,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        requesting_owner_hashes: set[str] | None = None,
    ) -> UmbrellaCellConfig:
        """Select the admitting Azure cell using bin-packing below softWatermark + spillover."""
        if cell_id:
            try:
                return self._registry.azure_cell(cell_id)
            except KeyError:
                self.list_live_cells_sync(provider=BACKEND_AZURE)
                return self._registry.azure_cell(cell_id)
        candidates = self.list_live_cells_sync(provider=BACKEND_AZURE)
        if not candidates:
            raise KeyError("No hosted Azure Umbrella Cell configured")
        if len(candidates) == 1:
            return candidates[0]

        below_soft: list[tuple[float, int, UmbrellaCellConfig]] = []
        spillover: list[tuple[float, int, UmbrellaCellConfig]] = []
        any_below_hard = False
        for idx, cell in enumerate(candidates):
            inv = self.observe_azure_cell_inventory_sync(cell)
            warm, active = self._slot_owner_claims(
                cell,
                occupied_app_ids=occupied_app_ids,
                arm_tags_by_slot=inv["arm_tags"] or None,
                requesting_owner_hashes=requesting_owner_hashes,
                slots_override=inv["slots"],
                provisioning_slot_ids=inv["provisioning_slot_ids"],
            )
            cap = self._registry.evaluate_capacity(
                cell, active_slots=len(active), warm_standby_slots=len(warm)
            )
            if cap.admits_new_owners:
                any_below_hard = True
            if cap.admits_new_owners and warm:
                if not cap.needs_cell_expansion:
                    below_soft.append((-cap.utilization_ratio, idx, cell))
                else:
                    spillover.append((cap.utilization_ratio, idx, cell))
        if below_soft:
            below_soft.sort()
            return below_soft[0][2]
        if spillover:
            spillover.sort()
            return spillover[0][2]
        if any_below_hard:
            raise NoWarmSkeletonAvailableError(
                "All admitting Azure Umbrella Cells have 0 unclaimed warm_standby skeleton slots"
            )
        raise CellCapacityExceededError("All hosted Azure Umbrella Cells reached hard watermark")

    def reserve_slot(
        self,
        *,
        owner_id: str,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        arm_tags_by_slot: Mapping[str, Mapping[str, Any]] | None = None,
        requesting_owner_hashes: set[str] | None = None,
        slots_override: Sequence[SkeletonSlotConfig] | None = None,
        provisioning_slot_ids: set[str] | None = None,
    ) -> tuple[UmbrellaCellConfig, SkeletonSlotConfig, UmbrellaCellCapacity]:
        """Atomically claim one unclaimed warm_standby skeleton slot inside this process."""
        cell = self._registry.azure_cell(cell_id)
        with self._process_lock, self._instance_lock:
            warm, active = self._slot_owner_claims(
                cell,
                occupied_app_ids=occupied_app_ids,
                arm_tags_by_slot=arm_tags_by_slot,
                requesting_owner_hashes=requesting_owner_hashes,
                slots_override=slots_override,
                provisioning_slot_ids=provisioning_slot_ids,
            )
            capacity = self._registry.evaluate_capacity(
                cell, active_slots=len(active), warm_standby_slots=len(warm)
            )
            if not capacity.admits_new_owners:
                raise CellCapacityExceededError(
                    f"Umbrella Cell {cell.cell_id} reached hard watermark ({cell.hard_watermark})"
                )
            if not warm:
                raise NoWarmSkeletonAvailableError(
                    f"Umbrella Cell {cell.cell_id} has no unclaimed warm_standby skeleton slots"
                )
            chosen = warm[0]
            claim_key = f"{cell.cell_id}:{chosen.slot_id}"
            self._instance_claims[claim_key] = owner_id
            self._process_claims[claim_key] = owner_id
            remaining = len(warm) - 1
            after_cap = self._registry.evaluate_capacity(
                cell, active_slots=len(active) + 1, warm_standby_slots=remaining
            )
            return cell, chosen, after_cap

    def release_slot_claim(self, slot_id: str, *, cell_id: str | None = None) -> None:
        with self._process_lock, self._instance_lock:
            self._instance_claims.pop(slot_id, None)
            self._process_claims.pop(slot_id, None)
            if cell_id:
                self._instance_claims.pop(f"{cell_id}:{slot_id}", None)
                self._process_claims.pop(f"{cell_id}:{slot_id}", None)
            else:
                suffix = f":{slot_id}"
                for claims in (self._instance_claims, self._process_claims):
                    for key in [k for k in claims if k.endswith(suffix)]:
                        claims.pop(key, None)

    async def claim_warm_skeleton_for_owner(
        self,
        *,
        spec: PodSpec,
        owner_id: str,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        key_poll_timeout_seconds: float = 120.0,
        key_poll_interval_seconds: float = 2.0,
    ) -> ClaimedSkeletonResult:
        """Bind a warm skeleton to ``spec.hushh_id`` and await durable key publication."""
        if deploy_lane() != "dev":
            raise PermissionError("Warm skeleton pool claiming is fenced to the dev lane")

        started = self._clock()
        owner_hashes = {
            f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"
            for value in (spec.hushh_id, owner_id)
            if value
        }
        cell = await asyncio.to_thread(
            self.select_admitting_azure_cell_sync,
            cell_id=cell_id,
            occupied_app_ids=occupied_app_ids,
            requesting_owner_hashes=owner_hashes or None,
        )
        inventory = await asyncio.to_thread(self.observe_azure_cell_inventory_sync, cell)
        arm_tags: dict[str, Mapping[str, Any]] = dict(inventory["arm_tags"])

        cell, chosen, capacity = self.reserve_slot(
            owner_id=owner_id,
            cell_id=cell.cell_id,
            occupied_app_ids=occupied_app_ids,
            arm_tags_by_slot=arm_tags or None,
            requesting_owner_hashes=owner_hashes or None,
            slots_override=inventory["slots"],
            provisioning_slot_ids=inventory["provisioning_slot_ids"],
        )

        slot_spec = _slot_spec(cell, chosen)
        backend = self._backend_factory(slot_spec)
        try:
            handle = await backend.provision(spec)
            meta = dict(handle.backend_metadata or {})
            row_probe = {
                "hushh_id": spec.hushh_id,
                "pod_signing_key_id": None,
                "backend_metadata": {"url": meta.get("url") or f"https://{chosen.fqdn}"},
            }
            published_keys: dict[str, str] | None = None
            deadline = self._clock() + max(5.0, float(key_poll_timeout_seconds))
            while True:
                keys = await self._key_fetcher(row_probe, require_identity=True)
                if (
                    isinstance(keys, dict)
                    and keys.get("podPublicKey")
                    and keys.get("podKeyId")
                    and keys.get("podSigningKey")
                    and keys.get("podSigningKeyId")
                ):
                    published_keys = keys
                    break
                if self._clock() >= deadline:
                    raise TimeoutError(
                        f"Bound skeleton slot {chosen.slot_id} did not publish owner keys in time"
                    )
                await asyncio.sleep(key_poll_interval_seconds)

            latency_ms = max(1, int(round((self._clock() - started) * 1000)))
            replenish = capacity.warm_standby_slots < cell.min_warm_skeletons
            if replenish and self._replenish_callback is not None:
                try:
                    self._replenish_callback(cell.cell_id)
                except Exception:  # noqa: BLE001 - async replenish is best effort
                    logger.info("umbrella_pool.replenish_callback_failed", exc_info=True)

            return ClaimedSkeletonResult(
                cell=cell,
                slot=chosen,
                handle=handle,
                published_keys=published_keys,
                claim_latency_ms=latency_ms,
                relay_ready=True,
                remaining_warm_standby=capacity.warm_standby_slots,
                replenishment_recommended=replenish,
            )
        except Exception:
            self.release_slot_claim(chosen.slot_id, cell_id=cell.cell_id)
            raise

    def _build_cell_report(
        self,
        cell: UmbrellaCellConfig,
        *,
        occupied_app_ids: set[str] | None = None,
        arm_tags_by_slot: Mapping[str, Mapping[str, Any]] | None = None,
        slots_override: Sequence[SkeletonSlotConfig] | None = None,
        provisioning_slot_ids: set[str] | None = None,
        zero_scale_verified_slots: Sequence[str] = (),
        cost_guard_healthy: bool = True,
    ) -> dict[str, Any]:
        warm, active = self._slot_owner_claims(
            cell,
            occupied_app_ids=occupied_app_ids,
            arm_tags_by_slot=arm_tags_by_slot,
            slots_override=slots_override,
            provisioning_slot_ids=provisioning_slot_ids,
        )
        cap = self._registry.evaluate_capacity(
            cell, active_slots=len(active), warm_standby_slots=len(warm)
        )
        prov_ids = sorted(provisioning_slot_ids or (), key=_slot_sort_key)
        target_warm = min(cell.min_warm_skeletons, cell.max_warm_skeletons)
        effective_warm = cap.warm_standby_slots + len(prov_ids)
        warm_deficit = max(0, target_warm - effective_warm)
        needs_replenishment = (
            cell.min_warm_skeletons > 0
            and warm_deficit > 0
            and (cap.active_slots + effective_warm) < cap.hard_watermark
        )
        economics = evaluate_cell_cost_economics(
            cell,
            active_slots=cap.active_slots,
            warm_standby_slots=cap.warm_standby_slots,
            provisioning_slots=len(prov_ids),
            zero_scale_verified_slots=zero_scale_verified_slots or tuple(s.slot_id for s in warm),
            cost_guard_healthy=cost_guard_healthy,
        )
        return {
            "cellId": cap.cell_id,
            "provider": cap.provider,
            "organization": cell.organization,
            "activeSlots": cap.active_slots,
            "warmStandbySlots": cap.warm_standby_slots,
            "minWarmSkeletons": cell.min_warm_skeletons,
            "maxWarmSkeletons": cell.max_warm_skeletons,
            "warmDeficit": warm_deficit,
            "needsReplenishment": needs_replenishment,
            "softWatermark": cap.soft_watermark,
            "hardWatermark": cap.hard_watermark,
            "utilizationRatio": cap.utilization_ratio,
            "needsCellExpansion": cap.needs_cell_expansion,
            "admitsNewOwners": cap.admits_new_owners,
            "slotIdsWarm": [s.slot_id for s in warm],
            "slotIdsActive": [s.slot_id for s in active],
            "slotIdsProvisioning": prov_ids,
            "costEconomics": economics.to_dict(),
        }

    @staticmethod
    def _replenisher_telemetry() -> dict[str, Any]:
        try:
            from hushh_mcp.services.umbrella_cell_replenisher import (  # noqa: PLC0415
                get_replenisher_telemetry,
            )

            return get_replenisher_telemetry()
        except Exception:  # noqa: BLE001
            return {"enabled": False}

    def snapshot_status(
        self,
        *,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        arm_tags_by_slot: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        cells = self._registry.list_cells()
        reports = [
            self._build_cell_report(
                cell,
                occupied_app_ids=occupied_app_ids,
                arm_tags_by_slot=arm_tags_by_slot,
            )
            for cell in cells
            if not cell_id or cell.cell_id == cell_id
        ]
        return {
            "environment": deploy_lane(),
            "cells": reports,
            "scaleProjection": project_fleet_scale_economics(cells),
            "replenisher": self._replenisher_telemetry(),
        }

    async def async_snapshot_status(
        self,
        *,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        arm_tags_by_slot: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Live ARM-aware snapshot discovering dynamically scaled cells & slots without waking pods."""
        if deploy_lane() == "dev" and arm_tags_by_slot is None:
            cells = await asyncio.to_thread(self.list_live_cells_sync)
        else:
            cells = self._registry.list_cells()
        reports: list[dict[str, Any]] = []
        for cell in cells:
            if cell_id and cell.cell_id != cell_id:
                continue
            if (
                cell.provider == BACKEND_AZURE
                and arm_tags_by_slot is None
                and deploy_lane() == "dev"
            ):
                inv = await asyncio.to_thread(self.observe_azure_cell_inventory_sync, cell)
                reports.append(
                    self._build_cell_report(
                        cell,
                        occupied_app_ids=occupied_app_ids,
                        arm_tags_by_slot=inv["arm_tags"] or None,
                        slots_override=inv["slots"],
                        provisioning_slot_ids=inv["provisioning_slot_ids"],
                        zero_scale_verified_slots=inv["zero_scale_verified_slots"],
                        cost_guard_healthy=bool(inv["cost_guard_healthy"]),
                    )
                )
            else:
                reports.append(
                    self._build_cell_report(
                        cell,
                        occupied_app_ids=occupied_app_ids,
                        arm_tags_by_slot=arm_tags_by_slot,
                    )
                )
        return {
            "environment": deploy_lane(),
            "cells": reports,
            "scaleProjection": project_fleet_scale_economics(cells),
            "replenisher": self._replenisher_telemetry(),
        }


__all__ = [
    "CellCapacityExceededError",
    "CellCostEconomics",
    "ClaimedSkeletonResult",
    "NoWarmSkeletonAvailableError",
    "PodSkeletonPoolService",
    "SkeletonSlotConfig",
    "UmbrellaCellCapacity",
    "UmbrellaCellConfig",
    "UmbrellaCellRegistry",
    "evaluate_cell_cost_economics",
    "project_fleet_scale_economics",
    "relay_first_cutover_status",
]
