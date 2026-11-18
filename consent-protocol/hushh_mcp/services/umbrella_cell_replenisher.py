# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Autonomous warm-skeleton replenisher & cost-guarded scaler for Umbrella Compute Cells.

Maintains warm, instant-claim (``~20s``) private agent standby capacity across
``HushOne Inc.`` Umbrella Compute Cells at ``$0.00/hr`` idle compute cost by:
1. Observing live cell inventory via a single ``O(1)`` ARM listing (zero data-plane
   HTTP wake probes that would scale standby containers above ``0`` replicas).
2. Enforcing a fail-closed cost circuit breaker (refusing to provision new slots if any
   existing warm standby slot drifts off ``minReplicas=0`` / ``Consumption``).
3. Minting missing ``slotNN`` identities, isolated Blob containers, create-only Key
   Vault keys/secrets, 5 narrowest-scope RBAC grants, and virgin ``minReplicas=0``
   Container Apps in Dev, serialized fleet-wide via ``UMBRELLA_CELL_REPLENISH``.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import secrets
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from hushh_mcp.runtime_settings import (
    pod_mode,
    umbrella_cell_replenisher_enabled,
)
from hushh_mcp.services import azure_federation
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.azure_setup_roles import (
    ROLE_ACR_PULL,
    ROLE_COGNITIVE_SERVICES_OPENAI_USER,
    ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER,
    ROLE_KEY_VAULT_SECRETS_USER,
    ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR,
    role_assignment_body,
    role_assignment_path,
)
from hushh_mcp.services.compute_backend import BACKEND_AZURE
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.fleet_sweep_lock import FleetSweepLock, fleet_turn
from hushh_mcp.services.hosted_azure_backend import (
    HostedAzureBackend,
    HostedAzureCellSlotSpec,
)
from hushh_mcp.services.pod_umbrella_cell_pool import (
    PodSkeletonPoolService,
    SkeletonSlotConfig,
    UmbrellaCellConfig,
    UmbrellaCellRegistry,
)

logger = logging.getLogger(__name__)

_RBAC_SETTLE_DELAYS: tuple[float, ...] = (3.0, 6.0, 10.0, 15.0, 20.0, 30.0)
_CONTAINER_APP_SETTLE_DELAYS: tuple[float, ...] = (5.0, 10.0, 15.0, 25.0)
_BACKOFF_SCHEDULE_SECONDS: tuple[float, ...] = (120.0, 300.0, 900.0)
_MIN_WAKE_INTERVAL_SECONDS = 10.0
_DEFAULT_INTERVAL_SECONDS = 180.0
_DEFAULT_INITIAL_DELAY_SECONDS = 15.0

_WAKE_LOCK = threading.Lock()
_WAKE_LOOP: asyncio.AbstractEventLoop | None = None
_WAKE_EVENT: asyncio.Event | None = None

_TELEMETRY_LOCK = threading.Lock()
_TELEMETRY: dict[str, Any] = {
    "runsTotal": 0,
    "slotsCreatedTotal": 0,
    "lastRunAt": None,
    "lastOutcome": "never_run",
    "lastCreatedSlots": [],
    "cellBackoffUntil": {},
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize_err(exc: BaseException) -> str:
    return f"{type(exc).__name__}:{str(exc).split('http', 1)[0][:120]}".strip(":")


def _register_wake_event(loop: asyncio.AbstractEventLoop, event: asyncio.Event) -> None:
    global _WAKE_LOOP, _WAKE_EVENT
    with _WAKE_LOCK:
        _WAKE_LOOP = loop
        _WAKE_EVENT = event


def trigger_umbrella_cell_replenish(cell_id: str | None = None) -> None:
    """Wake the background replenisher loop promptly without blocking the request path."""
    del cell_id  # Every cell deficit is evaluated atomically under the fleet sweep lock.
    with _WAKE_LOCK:
        loop = _WAKE_LOOP
        event = _WAKE_EVENT
    if loop is None or event is None or loop.is_closed():
        return
    try:
        running = asyncio.get_running_loop()
        if running is loop:
            event.set()
            return
    except RuntimeError:
        pass
    try:
        loop.call_soon_threadsafe(event.set)
    except RuntimeError:
        pass


def get_replenisher_telemetry() -> dict[str, Any]:
    """Return a JSON-safe snapshot of replenisher posture and counters."""
    with _TELEMETRY_LOCK:
        snapshot = copy.deepcopy(_TELEMETRY)
    snapshot["enabled"] = umbrella_cell_replenisher_enabled()
    snapshot["intervalSeconds"] = _DEFAULT_INTERVAL_SECONDS
    return snapshot


def allocate_next_slot_ids(
    cell: UmbrellaCellConfig,
    *,
    active_slot_ids: Iterable[str],
    warm_slot_ids: Iterable[str],
    provisioning_slot_ids: Iterable[str] = (),
    cost_guard_healthy: bool = True,
) -> list[str]:
    """Choose deterministic next ``slotNN`` IDs to mint without violating watermarks or cost guard."""
    if not cost_guard_healthy or cell.min_warm_skeletons <= 0:
        return []
    active_set = set(active_slot_ids)
    warm_set = set(warm_slot_ids)
    prov_set = set(provisioning_slot_ids)
    used = active_set | warm_set | prov_set

    effective_warm = len(warm_set) + len(prov_set)
    target_warm = min(cell.min_warm_skeletons, max(0, cell.max_warm_skeletons))
    deficit = max(0, target_warm - effective_warm)
    if deficit <= 0:
        return []

    total_materialized = len(active_set) + effective_warm
    remaining_hard = max(0, cell.hard_watermark - total_materialized)
    to_mint = min(deficit, remaining_hard, max(1, cell.replenish_batch_size))
    if to_mint <= 0:
        return []

    chosen: list[str] = []
    for idx in range(1, cell.hard_watermark + 1):
        candidate = f"slot{idx:02d}"
        if candidate not in used:
            chosen.append(candidate)
            used.add(candidate)
            if len(chosen) >= to_mint:
                break
    return chosen


def _role_conflict_exists(exc: ArmError) -> bool:
    code = (exc.code or "").lower()
    msg = (exc.message or "").lower()
    return code == "roleassignmentexists" or (exc.kind == "conflict" and "already exists" in msg)


def _is_transient_container_app_rbac_error(exc: ArmError) -> bool:
    hay = f"{exc.code} {exc.message}".lower()
    if exc.kind == "throttled":
        return True
    transient_tokens = (
        "anotheroperationinprogress",
        "operationinprogress",
        "secretinitialization",
        "containerappsecret",
        "keyvault",
        "imagepull",
        "unauthorized",
        "acrpull",
        "identity",
        "principalnotfound",
    )
    return any(tok in hay for tok in transient_tokens)


def _assign_role_idempotent(
    arm: ArmClient,
    *,
    scope: str,
    role_guid: str,
    principal_id: str,
    op: str,
    sleep: Callable[[float], None],
) -> None:
    subscription_prefix = "/".join(scope.split("/", 3)[:3])
    role_def_id = (
        f"{subscription_prefix}/providers/Microsoft.Authorization/roleDefinitions/{role_guid}"
    )
    path = role_assignment_path(scope, role_guid, principal_id)
    body = role_assignment_body(role_def_id, principal_id)
    for delay in (*_RBAC_SETTLE_DELAYS, None):
        try:
            arm.put(path, api_version=API_VERSIONS["authorization"], body=body, op=op)
            return
        except ArmError as exc:
            if _role_conflict_exists(exc):
                return
            if exc.code != "PrincipalNotFound" or delay is None:
                raise
            sleep(delay)


def _extract_host_prefix(endpoint_or_host: str) -> str:
    raw = str(endpoint_or_host or "").strip()
    if not raw:
        return ""
    host = raw.split("//", 1)[-1].split("/", 1)[0]
    return host.split(".", 1)[0].strip()


def _create_only_key_uri(arm: ArmClient, key_path: str, cell_kv_name: str, key_name: str) -> str:
    existing = arm.get_or_none(
        key_path, api_version=API_VERSIONS["key_vault"], op="replenish_key_check"
    )
    if existing is None:
        existing = arm.put(
            key_path,
            api_version=API_VERSIONS["key_vault"],
            body={
                "properties": {
                    "kty": "RSA",
                    "keySize": 2048,
                    "keyOps": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
                }
            },
            op="replenish_key_create",
        )
    props = existing.get("properties") if isinstance(existing, Mapping) else {}
    uri = str((props or {}).get("keyUriWithVersion") or "").strip()
    if not uri:
        refetched = arm.get(
            key_path, api_version=API_VERSIONS["key_vault"], op="replenish_key_readback"
        )
        uri = str((refetched.get("properties") or {}).get("keyUriWithVersion") or "").strip()
    if not uri:
        raise RuntimeError(
            f"Key Vault key {cell_kv_name}/{key_name} returned empty keyUriWithVersion"
        )
    return uri


def _create_only_signing_secret(arm: ArmClient, secret_path: str) -> None:
    existing = arm.get_or_none(
        secret_path, api_version=API_VERSIONS["key_vault"], op="replenish_secret_check"
    )
    if existing is not None:
        return
    secret_val = secrets.token_urlsafe(48)
    try:
        arm.put(
            secret_path,
            api_version=API_VERSIONS["key_vault"],
            body={"properties": {"value": secret_val, "contentType": "text/plain"}},
            op="replenish_secret_create",
        )
    finally:
        secret_val = ""


def provision_azure_warm_skeleton_sync(
    cell: UmbrellaCellConfig,
    slot_id: str,
    *,
    arm_client: ArmClient | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> SkeletonSlotConfig:
    """Provision one isolated, zero-owner, scale-to-zero ``warm_standby`` Azure cell slot."""
    if deploy_lane() != "dev":
        raise PermissionError("Warm skeleton provisioning is restricted to the dev lane")
    if cell.provider != BACKEND_AZURE:
        raise ValueError(f"Unsupported provider {cell.provider!r} for Azure skeleton minting")
    if not (
        cell.tenant_id
        and cell.subscription_id
        and cell.resource_group
        and cell.environment_id
        and cell.storage_account
        and cell.key_vault_name
        and cell.registry_server
        and cell.image_digest
    ):
        raise ValueError(f"Umbrella Cell {cell.cell_id} is missing Azure provisioning coordinates")

    arm = arm_client
    if arm is None:
        client_id = (os.getenv("HUSSH_HOSTED_AZURE_CLIENT_ID") or cell.controller_client_id).strip()
        arm = ArmClient(
            lambda: azure_federation.app_token(cell.tenant_id, client_id=client_id).access_token,
            sleep=sleep,
        )

    group_scope = f"/subscriptions/{cell.subscription_id}/resourceGroups/{cell.resource_group}"
    identity_name = f"id-pod-{slot_id}"
    identity_path = (
        f"{group_scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/{identity_name}"
    )
    container_name = f"pod-{slot_id}"
    container_path = (
        f"{group_scope}/providers/Microsoft.Storage/storageAccounts/"
        f"{cell.storage_account}/blobServices/default/containers/{container_name}"
    )
    vault_scope = f"{group_scope}/providers/Microsoft.KeyVault/vaults/{cell.key_vault_name}"
    key_name = f"pod-log-key-{slot_id}"
    key_path = f"{vault_scope}/keys/{key_name}"
    secret_name = f"pod-signing-key-{slot_id}"
    secret_path = f"{vault_scope}/secrets/{secret_name}"
    acr_name = _extract_host_prefix(cell.registry_server)
    acr_scope = f"{group_scope}/providers/Microsoft.ContainerRegistry/registries/{acr_name}"
    openai_name = _extract_host_prefix(cell.openai_endpoint)
    openai_scope = (
        f"{group_scope}/providers/Microsoft.CognitiveServices/accounts/{openai_name}"
        if openai_name
        else ""
    )
    app_name = f"ca-pod-{slot_id}"
    app_path = f"{group_scope}/providers/Microsoft.App/containerApps/{app_name}"

    uami = arm.put(
        identity_path,
        api_version=API_VERSIONS["managed_identity"],
        body={
            "location": cell.location,
            "tags": {
                "hussh-tenancy": "hussh-hosted",
                "hussh-cell-id": cell.cell_id,
                "hussh-slot-id": slot_id,
            },
        },
        op="replenish_identity",
    )
    uami_props = uami.get("properties") or {}
    client_id = str(uami_props.get("clientId") or "").strip()
    principal_id = str(uami_props.get("principalId") or "").strip()
    if not client_id or not principal_id:
        raise RuntimeError(f"Managed identity {identity_name} did not return client/principal IDs")

    arm.put(
        container_path,
        api_version=API_VERSIONS["storage"],
        body={"properties": {"publicAccess": "None"}},
        op="replenish_blob_container",
    )
    key_uri_with_version = _create_only_key_uri(arm, key_path, cell.key_vault_name, key_name)
    _create_only_signing_secret(arm, secret_path)

    role_grants: list[tuple[str, str, str]] = [
        (key_path, ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER, "replenish_rbac_kv_key"),
        (secret_path, ROLE_KEY_VAULT_SECRETS_USER, "replenish_rbac_kv_secret"),
        (container_path, ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR, "replenish_rbac_blob"),
        (acr_scope, ROLE_ACR_PULL, "replenish_rbac_acr"),
    ]
    if openai_scope:
        role_grants.append(
            (openai_scope, ROLE_COGNITIVE_SERVICES_OPENAI_USER, "replenish_rbac_openai")
        )
    for scope, role_guid, op in role_grants:
        _assign_role_idempotent(
            arm,
            scope=scope,
            role_guid=role_guid,
            principal_id=principal_id,
            op=op,
            sleep=sleep,
        )

    blob_url = f"https://{cell.storage_account}.blob.core.windows.net/{container_name}"
    signing_secret_url = f"https://{cell.key_vault_name}.vault.azure.net/secrets/{secret_name}"
    slot_spec = HostedAzureCellSlotSpec(
        cell_id=cell.cell_id,
        slot_id=slot_id,
        organization=cell.organization,
        tenant_id=cell.tenant_id,
        subscription_id=cell.subscription_id,
        resource_group=cell.resource_group,
        location=cell.location,
        environment_id=cell.environment_id,
        registry_server=cell.registry_server,
        image_digest=cell.image_digest,
        controller_client_id=cell.controller_client_id,
        app_name=app_name,
        app_id=app_path,
        fqdn="",
        identity_id=identity_path,
        identity_client_id=client_id,
        blob_url=blob_url,
        key_vault_key=key_uri_with_version,
        signing_secret_url=signing_secret_url,
        openai_endpoint=cell.openai_endpoint,
        openai_deployment=cell.openai_deployment,
    )
    app_body = HostedAzureBackend(
        slot=slot_spec, arm_client=arm, live=True
    ).render_warm_standby_config()

    app_resp: dict[str, Any] = {}
    for delay in (*_CONTAINER_APP_SETTLE_DELAYS, None):
        try:
            app_resp = arm.put(
                app_path,
                api_version=API_VERSIONS["container_apps"],
                body=app_body,
                op="replenish_warm_container_app",
            )
            break
        except ArmError as exc:
            if not _is_transient_container_app_rbac_error(exc) or delay is None:
                raise
            sleep(delay)

    props = app_resp.get("properties") or {}
    prov_state = str(props.get("provisioningState") or "").strip().lower()
    ready_rev = str(props.get("latestReadyRevisionName") or "").strip()
    fqdn = str(((props.get("configuration") or {}).get("ingress") or {}).get("fqdn") or "").strip()
    if prov_state != "succeeded" or not ready_rev or not fqdn:
        raise RuntimeError(
            f"Warm standby container app {app_name} not ready (state={prov_state!r}, rev={ready_rev!r})"
        )

    return SkeletonSlotConfig(
        slot_id=slot_id,
        app_name=app_name,
        app_id=app_path,
        fqdn=fqdn,
        identity_id=identity_path,
        identity_client_id=client_id,
        identity_principal_id=principal_id,
        blob_url=blob_url,
        key_vault_key=key_uri_with_version,
        signing_secret_url=signing_secret_url,
    )


def _discover_occupied_ids_best_effort(db: Any) -> set[str] | None:
    if db is None:
        return None
    try:
        from hushh_mcp.services.hosted_azure_migration_provisioner import (  # noqa: PLC0415
            _discover_occupied_app_ids,
        )

        return _discover_occupied_app_ids(db)
    except OSError as exc:
        if "Database credentials not set" in str(exc):
            return None
        raise
    except Exception:  # noqa: BLE001 - DB outage falls back safely to ARM tags
        logger.warning("umbrella_cell_replenisher.occupied_query_failed", exc_info=True)
        return None


@dataclass(frozen=True)
class ReplenishPassReport:
    skipped: bool
    reason: str
    created_slots: tuple[str, ...]
    errors: tuple[str, ...]


class UmbrellaCellReplenisher:
    """Autonomous background coordinator keeping cell warm standby pools topped up."""

    def __init__(
        self,
        *,
        registry: UmbrellaCellRegistry | None = None,
        pool: PodSkeletonPoolService | None = None,
        occupied_loader: Callable[[], set[str] | None] | None = None,
        provisioner: Callable[[UmbrellaCellConfig, str], SkeletonSlotConfig] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._registry = registry or UmbrellaCellRegistry()
        self._pool = pool or PodSkeletonPoolService(registry=self._registry)
        self._occupied_loader = occupied_loader
        self._provisioner = provisioner or provision_azure_warm_skeleton_sync
        self._clock = clock
        self._backoff_failures: dict[str, int] = {}
        self._backoff_until: dict[str, float] = {}

    def _default_occupied_loader(self) -> set[str] | None:
        from db.db_client import get_db  # noqa: PLC0415

        return _discover_occupied_ids_best_effort(get_db())

    def _record_backoff(self, cell_id: str, now: float) -> float:
        failures = self._backoff_failures.get(cell_id, 0) + 1
        self._backoff_failures[cell_id] = failures
        wait_s = _BACKOFF_SCHEDULE_SECONDS[min(failures - 1, len(_BACKOFF_SCHEDULE_SECONDS) - 1)]
        until = now + wait_s
        self._backoff_until[cell_id] = until
        return until

    async def replenish_once(self) -> ReplenishPassReport:
        if pod_mode():
            return ReplenishPassReport(True, "pod_mode", (), ())
        if deploy_lane() != "dev":
            return ReplenishPassReport(True, "non_dev_lane", (), ())
        if not umbrella_cell_replenisher_enabled():
            return ReplenishPassReport(True, "disabled", (), ())

        loader = self._occupied_loader or self._default_occupied_loader
        occupied_app_ids = await asyncio.to_thread(loader)

        created: list[str] = []
        errors: list[str] = []
        now = self._clock()
        azure_cells = self._registry.list_cells(provider=BACKEND_AZURE)

        for cell in azure_cells:
            backoff_until = self._backoff_until.get(cell.cell_id, 0.0)
            if now < backoff_until:
                logger.info(
                    "umbrella_cell_replenisher.cell_backoff cell=%s remaining_s=%d",
                    cell.cell_id,
                    int(backoff_until - now),
                )
                continue
            try:
                inv = await asyncio.to_thread(self._pool.observe_azure_cell_inventory_sync, cell)
                warm, active = self._pool._slot_owner_claims(
                    cell,
                    occupied_app_ids=occupied_app_ids,
                    arm_tags_by_slot=inv["arm_tags"] or None,
                    slots_override=inv["slots"],
                    provisioning_slot_ids=inv["provisioning_slot_ids"],
                )
                to_mint = allocate_next_slot_ids(
                    cell,
                    active_slot_ids=[s.slot_id for s in active],
                    warm_slot_ids=[s.slot_id for s in warm],
                    provisioning_slot_ids=inv["provisioning_slot_ids"],
                    cost_guard_healthy=bool(inv["cost_guard_healthy"]),
                )
                if not inv["cost_guard_healthy"]:
                    logger.warning(
                        "umbrella_cell_replenisher.cost_guard_tripped cell=%s",
                        cell.cell_id,
                    )
                for slot_id in to_mint:
                    minted = await asyncio.to_thread(self._provisioner, cell, slot_id)
                    created.append(f"{cell.cell_id}:{minted.slot_id}")
                    logger.info(
                        "umbrella_cell_replenisher.slot_provisioned cell=%s slot=%s",
                        cell.cell_id,
                        minted.slot_id,
                    )
                self._backoff_failures.pop(cell.cell_id, None)
                self._backoff_until.pop(cell.cell_id, None)
            except Exception as exc:  # noqa: BLE001 - isolate per cell with backoff
                self._record_backoff(cell.cell_id, now)
                err_tag = f"{cell.cell_id}:{_sanitize_err(exc)}"
                errors.append(err_tag)
                logger.warning(
                    "umbrella_cell_replenisher.cell_failed cell=%s err=%s",
                    cell.cell_id,
                    _sanitize_err(exc),
                )

        outcome = "error" if errors and not created else ("replenished" if created else "steady")
        with _TELEMETRY_LOCK:
            _TELEMETRY["runsTotal"] += 1
            _TELEMETRY["slotsCreatedTotal"] += len(created)
            _TELEMETRY["lastRunAt"] = _now_iso()
            _TELEMETRY["lastOutcome"] = outcome
            _TELEMETRY["lastCreatedSlots"] = list(created)
            _TELEMETRY["cellBackoffUntil"] = {
                cid: round(max(0.0, until - now), 1)
                for cid, until in self._backoff_until.items()
                if until > now
            }
        return ReplenishPassReport(False, outcome, tuple(created), tuple(errors))


async def _replenisher_loop(
    replenisher: UmbrellaCellReplenisher,
    interval_seconds: float,
    initial_delay_seconds: float,
    sweep_lock: Optional[FleetSweepLock] = None,
) -> None:
    loop = asyncio.get_running_loop()
    wake_event = asyncio.Event()
    _register_wake_event(loop, wake_event)
    logger.info(
        "umbrella_cell_replenisher.started interval_s=%.1f initial_delay_s=%.1f",
        interval_seconds,
        initial_delay_seconds,
    )
    try:
        if initial_delay_seconds > 0:
            try:
                await asyncio.wait_for(wake_event.wait(), timeout=initial_delay_seconds)
            except asyncio.TimeoutError:
                pass
            wake_event.clear()

        while True:
            enabled = (
                not pod_mode() and deploy_lane() == "dev" and umbrella_cell_replenisher_enabled()
            )
            async with fleet_turn(sweep_lock if enabled else None) as mine:
                if enabled and mine:
                    try:
                        await replenisher.replenish_once()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.exception("umbrella_cell_replenisher.unhandled_error")

            try:
                await asyncio.wait_for(wake_event.wait(), timeout=interval_seconds)
                wake_event.clear()
                await asyncio.sleep(_MIN_WAKE_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass
    except asyncio.CancelledError:
        logger.info("umbrella_cell_replenisher.cancelled")
        return


def start_umbrella_cell_replenisher_loop(
    *,
    replenisher: UmbrellaCellReplenisher | None = None,
    interval_seconds: float = _DEFAULT_INTERVAL_SECONDS,
    initial_delay_seconds: float = _DEFAULT_INITIAL_DELAY_SECONDS,
    sweep_lock: Optional[FleetSweepLock] = None,
) -> asyncio.Task[Any] | None:
    """Attach the fleet-serialized Umbrella Cell replenisher task in Dev mode only."""
    if pod_mode() or not umbrella_cell_replenisher_enabled():
        return None
    worker = replenisher or UmbrellaCellReplenisher()
    return asyncio.create_task(
        _replenisher_loop(worker, interval_seconds, initial_delay_seconds, sweep_lock),
        name="umbrella-cell-replenisher",
    )


__all__ = [
    "ReplenishPassReport",
    "UmbrellaCellReplenisher",
    "allocate_next_slot_ids",
    "get_replenisher_telemetry",
    "provision_azure_warm_skeleton_sync",
    "start_umbrella_cell_replenisher_loop",
    "trigger_umbrella_cell_replenish",
]
