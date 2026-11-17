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
import os
import threading
import time
from collections.abc import Callable, Mapping
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
            cell = UmbrellaCellConfig(
                cell_id=str(item["cellId"]),
                provider=str(item["provider"]),
                organization=str(item["organization"]),
                soft_watermark=int(item["softWatermark"]),
                hard_watermark=int(item["hardWatermark"]),
                min_warm_skeletons=int(item.get("minWarmSkeletons") or 0),
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
            )
            self._cells[cell.cell_id] = cell

    def list_cells(self, *, provider: str | None = None) -> tuple[UmbrellaCellConfig, ...]:
        cells = tuple(self._cells.values())
        if provider:
            return tuple(c for c in cells if c.provider == provider)
        return cells

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
        self._replenish_callback = replenish_callback
        self._instance_claims: dict[str, str] = {}
        self._instance_lock = threading.Lock()

    def slot_spec(self, slot_id: str, *, cell_id: str | None = None) -> HostedAzureCellSlotSpec:
        cell = self._registry.azure_cell(cell_id)
        for slot in cell.slots:
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
    ) -> tuple[list[SkeletonSlotConfig], list[SkeletonSlotConfig]]:
        warm: list[SkeletonSlotConfig] = []
        reusable_for_requester: list[SkeletonSlotConfig] = []
        active: list[SkeletonSlotConfig] = []
        occupied = occupied_app_ids or set()
        for slot in cell.slots:
            process_key = f"{cell.cell_id}:{slot.slot_id}"
            claimed = (
                slot.app_id in occupied
                or slot.slot_id in self._instance_claims
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

    def reserve_slot(
        self,
        *,
        owner_id: str,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        arm_tags_by_slot: Mapping[str, Mapping[str, Any]] | None = None,
        requesting_owner_hashes: set[str] | None = None,
    ) -> tuple[UmbrellaCellConfig, SkeletonSlotConfig, UmbrellaCellCapacity]:
        """Atomically claim one unclaimed warm_standby skeleton slot inside this process."""
        cell = self._registry.azure_cell(cell_id)
        with self._process_lock, self._instance_lock:
            warm, active = self._slot_owner_claims(
                cell,
                occupied_app_ids=occupied_app_ids,
                arm_tags_by_slot=arm_tags_by_slot,
                requesting_owner_hashes=requesting_owner_hashes,
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
            self._instance_claims[chosen.slot_id] = owner_id
            self._process_claims[f"{cell.cell_id}:{chosen.slot_id}"] = owner_id
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
                self._process_claims.pop(f"{cell_id}:{slot_id}", None)
            else:
                suffix = f":{slot_id}"
                for key in [k for k in self._process_claims if k.endswith(suffix)]:
                    self._process_claims.pop(key, None)

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
        cell = self._registry.azure_cell(cell_id)

        # Always observe live ARM tags when the backend runs live or when no SQL
        # occupied-slot snapshot was supplied so incomplete/orphaned slot tags
        # isolate distinct owners while letting the same owner resume safely.
        arm_tags: dict[str, Mapping[str, Any]] = {}
        owner_hashes = {
            f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"
            for value in (spec.hushh_id, owner_id)
            if value
        }
        for slot in cell.slots:
            backend = self._backend_factory(_slot_spec(cell, slot))
            should_probe = bool(getattr(backend, "_live", False)) or (
                not hasattr(backend, "_live") and occupied_app_ids is None
            )
            if not should_probe or not hasattr(backend, "observe_slot_sync"):
                continue
            try:
                app = await asyncio.to_thread(backend.observe_slot_sync, slot.app_id)
                if isinstance(app, Mapping):
                    arm_tags[slot.slot_id] = dict(app.get("tags") or {})
            except Exception as exc:  # noqa: BLE001 - best-effort pre-reservation check
                logger.info(
                    "umbrella_pool.slot_precheck_failed slot=%s err=%s",
                    slot.slot_id,
                    type(exc).__name__,
                )

        cell, chosen, capacity = self.reserve_slot(
            owner_id=owner_id,
            cell_id=cell.cell_id,
            occupied_app_ids=occupied_app_ids,
            arm_tags_by_slot=arm_tags or None,
            requesting_owner_hashes=owner_hashes or None,
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

    def snapshot_status(
        self,
        *,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        arm_tags_by_slot: Mapping[str, Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        cells = self._registry.list_cells()
        reports: list[dict[str, Any]] = []
        for cell in cells:
            if cell_id and cell.cell_id != cell_id:
                continue
            warm, active = self._slot_owner_claims(
                cell, occupied_app_ids=occupied_app_ids, arm_tags_by_slot=arm_tags_by_slot
            )
            cap = self._registry.evaluate_capacity(
                cell, active_slots=len(active), warm_standby_slots=len(warm)
            )
            reports.append(
                {
                    "cellId": cap.cell_id,
                    "provider": cap.provider,
                    "organization": cell.organization,
                    "activeSlots": cap.active_slots,
                    "warmStandbySlots": cap.warm_standby_slots,
                    "softWatermark": cap.soft_watermark,
                    "hardWatermark": cap.hard_watermark,
                    "utilizationRatio": cap.utilization_ratio,
                    "needsCellExpansion": cap.needs_cell_expansion,
                    "admitsNewOwners": cap.admits_new_owners,
                    "slotIdsWarm": [s.slot_id for s in warm],
                    "slotIdsActive": [s.slot_id for s in active],
                }
            )
        return {"environment": deploy_lane(), "cells": reports}


__all__ = [
    "CellCapacityExceededError",
    "ClaimedSkeletonResult",
    "NoWarmSkeletonAvailableError",
    "PodSkeletonPoolService",
    "SkeletonSlotConfig",
    "UmbrellaCellCapacity",
    "UmbrellaCellConfig",
    "UmbrellaCellRegistry",
    "relay_first_cutover_status",
]
