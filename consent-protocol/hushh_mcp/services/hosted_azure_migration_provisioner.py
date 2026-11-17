# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Live zero-loss migration provisioner from BYOC/GCP onto HushOne Inc. Hosted Azure.

Implements ``DestinationProvisioner`` (``prepare``, ``create``, ``collect_key``,
``teardown``) backed by ``PodSkeletonPoolService`` + ``HostedAzureBackend``, and
executes the full 10-stage ``run_migration`` chain:
1. Lock/freeze source pod via ``PodMigrationJobRepo`` + ``PodUpgradeHandoffClient``
2. Claim a pre-warmed ``warm_standby`` skeleton slot inside ``HushOne Inc.``
3. Collect destination pod's X25519 + Ed25519 public keys directly from slot URL
4. Export sealed ciphertext bundle from source and import into destination
5. Verify byte-identical ``source_head_sha == target_head_sha`` and ``record_count``
   without Hub plaintext decryption
6. Atomically flip ``personal_agent_registry`` (`deployment_target="azure"`), archiving
   prior coordinates into ``detachedPlacements`` with a 14-day non-destructive grace
   period and preserving monotonic device-binding & endpoint version floors
7. Non-destructively release source handoff (retaining owner's resource group during
   the 14-day grace window) and immediately promote ``external`` -> ``direct`` ingress.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import secrets
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from hushh_mcp.services import pod_migration_transport
from hushh_mcp.services.compute_backend import BACKEND_AZURE, PodSpec
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.pod_connector_keypair_service import WRAPPING_ALG
from hushh_mcp.services.pod_external_ingress_admission import admit_external_ingress_if_due
from hushh_mcp.services.pod_migration_live_steps import (
    LiveMigrationSteps,
    MigrationContext,
)
from hushh_mcp.services.pod_migration_service import (
    PodMigrationJobRepo,
    new_job_id,
    run_migration,
)
from hushh_mcp.services.pod_umbrella_cell_pool import (
    ClaimedSkeletonResult,
    PodSkeletonPoolService,
    relay_first_cutover_status,
)
from hushh_mcp.services.pod_upgrade_handoff import PodUpgradeHandoffClient

logger = logging.getLogger(__name__)

_DEFAULT_SOURCE_GRACE_DAYS = 14


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _grace_reap_iso(days: int = _DEFAULT_SOURCE_GRACE_DAYS) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _owner_hash(owner_id: str) -> str:
    return "sha256:" + hashlib.sha256(owner_id.encode("utf-8")).hexdigest()


def _superseded_bindings(metadata: dict[str, Any], *, now_iso: str) -> dict[str, Any]:
    """Preserve monotonic device binding versions while invalidating stale envelopes."""
    previous = metadata.get("bindings")
    if not isinstance(previous, dict):
        return {}
    superseded: dict[str, Any] = {}
    for device_id, record in previous.items():
        if isinstance(record, dict):
            superseded[str(device_id)] = {
                "version": int(record.get("version") or 0),
                "supersededAt": now_iso,
            }
    return superseded


def build_hosted_azure_switch_metadata(
    *,
    previous_row: dict[str, Any],
    claimed: ClaimedSkeletonResult,
    service_uid: str,
    migration_mode: str = "lossless_commit_log",
    now_iso: str | None = None,
) -> dict[str, Any]:
    """Build the clean Hussh-Hosted Azure metadata + archived detachedPlacements."""
    timestamp = now_iso or _now_iso()
    old_meta = (
        copy.deepcopy(previous_row.get("backend_metadata"))
        if isinstance(previous_row.get("backend_metadata"), dict)
        else {}
    )
    prior_detached = list(old_meta.get("detachedPlacements") or [])
    detached_entry = {
        "detachedAt": timestamp,
        "graceDays": _DEFAULT_SOURCE_GRACE_DAYS,
        "graceReapAfter": _grace_reap_iso(),
        "reason": "migrated_to_hussh_hosted_azure",
        "deploymentTarget": previous_row.get("deployment_target"),
        "deployment_target": previous_row.get("deployment_target"),
        "backend": previous_row.get("backend"),
        "external_agent_id": previous_row.get("external_agent_id"),
        "a2a_route": previous_row.get("a2a_route"),
        "user_cloud_project": previous_row.get("user_cloud_project"),
        "user_cloud_region": previous_row.get("user_cloud_region"),
        "user_cloud_tenant_id": previous_row.get("user_cloud_tenant_id"),
        "user_cloud_subscription_id": previous_row.get("user_cloud_subscription_id"),
        "user_cloud_resource_group": previous_row.get("user_cloud_resource_group"),
        "backend_metadata": {
            key: value for key, value in old_meta.items() if key != "detachedPlacements"
        },
    }
    prior_detached.append(detached_entry)

    handle_meta = dict(claimed.handle.backend_metadata or {})
    pod_url = str(handle_meta.get("url") or f"https://{claimed.slot.fqdn}").strip().rstrip("/")
    image_digest = str(handle_meta.get("image_digest") or claimed.cell.image_digest).strip()
    image = str(
        handle_meta.get("image")
        or f"{claimed.cell.registry_server}/consent-protocol-pod@{image_digest}"
    ).strip()

    admission = {
        "version": 1,
        "environment": "dev",
        "ownerId": str(previous_row.get("user_id") or "").strip(),
        "ownerHash": _owner_hash(str(previous_row.get("user_id") or "").strip()),
        "hushhId": str(previous_row.get("hushh_id") or "").strip(),
        "tenantId": claimed.cell.tenant_id.lower(),
        "subscriptionId": claimed.cell.subscription_id.lower(),
        "resourceGroup": claimed.cell.resource_group,
        "location": claimed.cell.location.lower(),
        "cellId": claimed.cell.cell_id,
        "slotId": claimed.slot.slot_id,
        "appName": claimed.slot.app_name,
        "serviceUid": service_uid,
        "url": pod_url,
        "identityId": claimed.slot.identity_id,
        "identityClientId": claimed.slot.identity_client_id.lower(),
        "registryServer": claimed.cell.registry_server,
        "imageDigest": image_digest,
        "claimLatencyMs": claimed.claim_latency_ms,
        "migrationMode": migration_mode,
        "admittedAt": timestamp,
    }

    superseded = _superseded_bindings(old_meta, now_iso=timestamp)

    return {
        "tenancy": "hussh-hosted",
        "provider": "azure",
        "ingress": "external",
        "cellId": claimed.cell.cell_id,
        "slotId": claimed.slot.slot_id,
        "service": claimed.slot.app_name,
        "serviceUid": service_uid,
        "revision": str(handle_meta.get("revision") or ""),
        "url": pod_url,
        "image": image,
        "image_digest": image_digest,
        "endpointVersion": int(old_meta.get("endpointVersion") or 0) + 1,
        "claimLatencyMs": claimed.claim_latency_ms,
        "migrationMode": migration_mode,
        "relayFirst": True,
        "hostedAzureAdmission": admission,
        "detachedPlacements": prior_detached,
        **({"bindings": superseded} if superseded else {}),
    }


def _switch_over_sql(
    db: Any,
    *,
    user_id: str,
    hushh_id: str,
    claimed: ClaimedSkeletonResult,
    service_uid: str,
    migration_mode: str = "lossless_commit_log",
) -> dict[str, Any]:
    """Atomically flip ``personal_agent_registry`` from migrating source -> hosted Azure."""
    from sqlalchemy import text

    now_iso = _now_iso()
    keys = claimed.published_keys

    def commit() -> dict[str, Any]:
        with db.engine.begin() as conn:
            conn.execute(text("SET LOCAL statement_timeout = '5s'"))
            conn.execute(text("SET LOCAL lock_timeout = '2s'"))
            # Acquire owner advisory locks in canonical 171 -> 198 order so non-blocking
            # guard_azure_vm_power_registry() triggers never trip on short worker overlaps.
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock(hashtextextended(:user_id, 171)), "
                    "pg_advisory_xact_lock(hashtextextended(:user_id, 198))"
                ),
                {"user_id": user_id},
            )
            owner = (
                conn.execute(
                    text(
                        "SELECT * FROM public.personal_agent_registry "
                        "WHERE user_id = :user_id FOR UPDATE"
                    ),
                    {"user_id": user_id},
                )
                .mappings()
                .one_or_none()
            )
            if owner is None or owner["status"] != "migrating" or owner["hushh_id"] != hushh_id:
                raise RuntimeError("owner row is no longer locked in migrating state")

            previous = dict(owner)
            new_metadata = build_hosted_azure_switch_metadata(
                previous_row=previous,
                claimed=claimed,
                service_uid=service_uid,
                migration_mode=migration_mode,
                now_iso=now_iso,
            )
            current_mode = str(previous.get("model_credential_mode") or "").strip()
            model_mode = (
                current_mode
                if current_mode in {"byok_per_turn", "user_azure_mi"}
                else "byok_per_turn"
            )
            pod_url = str(new_metadata["url"])

            updated = (
                conn.execute(
                    text(
                        """
                        UPDATE public.personal_agent_registry
                        SET deployment_target = 'azure',
                            backend = 'azure',
                            external_agent_id = :external_agent_id,
                            a2a_route = :a2a_route,
                            status = 'provisioned',
                            placement_epoch = coalesce(placement_epoch, 0) + 1,
                            identity_mode = 'signed',
                            model_credential_mode = :model_credential_mode,
                            pod_pubkey = :pod_pubkey,
                            pod_key_id = :pod_key_id,
                            pod_key_wrapping_alg = :pod_key_wrapping_alg,
                            pod_signing_pubkey = :pod_signing_pubkey,
                            pod_signing_key_id = :pod_signing_key_id,
                            user_cloud_project = NULL,
                            user_cloud_region = NULL,
                            user_cloud_bootstrap_sa = NULL,
                            user_cloud_authorized_at = NULL,
                            user_cloud_tenant_id = NULL,
                            user_cloud_subscription_id = NULL,
                            user_cloud_resource_group = NULL,
                            backend_metadata = CAST(:backend_metadata AS jsonb),
                            updated_at = clock_timestamp()
                        WHERE user_id = :user_id
                          AND hushh_id = :hushh_id
                          AND status = 'migrating'
                        RETURNING *
                        """
                    ),
                    {
                        "user_id": user_id,
                        "hushh_id": hushh_id,
                        "external_agent_id": claimed.slot.app_id,
                        "a2a_route": pod_url,
                        "model_credential_mode": model_mode,
                        "pod_pubkey": keys["podPublicKey"],
                        "pod_key_id": keys["podKeyId"],
                        "pod_key_wrapping_alg": keys.get("podKeyWrappingAlg") or WRAPPING_ALG,
                        "pod_signing_pubkey": keys["podSigningKey"],
                        "pod_signing_key_id": keys["podSigningKeyId"],
                        "backend_metadata": json.dumps(new_metadata),
                    },
                )
                .mappings()
                .one_or_none()
            )
            if updated is None:
                raise RuntimeError("hosted azure registry switch-over matched zero rows")
            return dict(updated)

    return commit()


def _discover_occupied_app_ids(db: Any) -> set[str] | None:
    """Return claimed Azure slot app IDs from personal_agent_registry when SQL engine exists."""
    if not hasattr(db, "engine"):
        return None
    from sqlalchemy import text

    with db.engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT external_agent_id FROM public.personal_agent_registry "
                "WHERE deployment_target = 'azure' AND external_agent_id IS NOT NULL"
            )
        ).scalars()
        return {str(val).strip() for val in rows if str(val or "").strip()}


class HostedAzureDestinationProvisioner:
    """``DestinationProvisioner`` claiming a warm skeleton inside HushOne Inc. Azure."""

    def __init__(
        self,
        *,
        user_id: str,
        spec: PodSpec,
        pool: PodSkeletonPoolService | None = None,
        cell_id: str | None = None,
        occupied_app_ids: set[str] | None = None,
        service_uid: str | None = None,
    ) -> None:
        self._user_id = user_id
        self._service_uid = (
            service_uid or spec.expected_service_uid or ""
        ).strip() or secrets.token_hex(16)
        self._spec = PodSpec(
            hushh_id=spec.hushh_id,
            phone_e164_hash=spec.phone_e164_hash,
            pod_pubkey=spec.pod_pubkey,
            region=spec.region,
            tier=spec.tier,
            billing_space_id=spec.billing_space_id,
            runtime_version=spec.runtime_version,
            prompt_version=spec.prompt_version,
            expected_service_uid=self._service_uid,
            deployment_target=BACKEND_AZURE,
            model_credential_mode=spec.model_credential_mode,
        )
        self._pool = pool or PodSkeletonPoolService()
        self._cell_id = cell_id
        self._occupied_app_ids = occupied_app_ids
        self.claimed: ClaimedSkeletonResult | None = None

    async def prepare(self) -> None:
        # Umbrella cell substrates (ACR, Storage, Key Vault, Consumption CAE) are
        # pre-provisioned in HushOne Inc.; verify target cell exists in dev.
        self._pool._registry.azure_cell(self._cell_id)

    async def create(self) -> str:
        claimed = await self._pool.claim_warm_skeleton_for_owner(
            spec=self._spec,
            owner_id=self._user_id,
            cell_id=self._cell_id,
            occupied_app_ids=self._occupied_app_ids,
        )
        self.claimed = claimed
        meta = dict(claimed.handle.backend_metadata or {})
        return str(meta.get("url") or f"https://{claimed.slot.fqdn}").strip().rstrip("/")

    async def collect_key(self) -> tuple[str, str]:
        if self.claimed is None:
            raise RuntimeError("skeleton slot must be claimed before collecting key")
        keys = self.claimed.published_keys
        return str(keys["podPublicKey"]), str(keys["podKeyId"])

    async def teardown(self) -> None:
        if self.claimed is not None:
            self._pool.release_slot_claim(self.claimed.slot.slot_id)


_BUSY_RETRY_DELAYS: tuple[float, ...] = (0.15, 0.35, 0.75)


class _BusyRetryRegistryAdapter:
    """Retry transient owner advisory-lock contention on registry transitions."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    async def begin_migration(self, user_id: str) -> bool:
        for delay in (*_BUSY_RETRY_DELAYS, None):
            try:
                return bool(await self._inner.begin_migration(user_id))
            except Exception as exc:
                if "VM placement is busy" not in str(exc) or delay is None:
                    raise
                await asyncio.sleep(delay)
        return False  # pragma: no cover

    async def end_migration(self, user_id: str, *, status: str = "provisioned") -> bool:
        for delay in (*_BUSY_RETRY_DELAYS, None):
            try:
                return bool(await self._inner.end_migration(user_id, status=status))
            except Exception as exc:
                if "VM placement is busy" not in str(exc) or delay is None:
                    raise
                await asyncio.sleep(delay)
        return False  # pragma: no cover

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _default_prewarm_source_health(source_url: str) -> None:
    """Wake scale-to-zero source Container Apps / Cloud Run services before handoff."""
    import time

    import requests  # type: ignore[import-untyped]

    health_url = f"{source_url.rstrip('/')}/health"
    for attempt in range(2):
        try:
            resp = requests.get(health_url, timeout=(10.0, 45.0), allow_redirects=False)
            if int(getattr(resp, "status_code", 0) or 0) == 200:
                return
        except Exception as exc:  # noqa: BLE001 - best-effort wakeup before auth probe
            logger.info(
                "hosted_azure_migration.prewarm_attempt attempt=%d err=%s",
                attempt + 1,
                type(exc).__name__,
            )
        if attempt == 0:
            time.sleep(2.0)


def _probe_source_upgrade_status(handoff: Any) -> dict[str, Any] | None:
    """Query /api/one/pod/upgrade/status with one scale-to-zero wakeup retry."""
    import time

    for attempt in range(2):
        try:
            status = handoff._request("GET", "/api/one/pod/upgrade/status")
            if isinstance(status, dict):
                return status
        except Exception as exc:  # noqa: BLE001 - fall back cleanly or retry wakeup
            logger.info(
                "hosted_azure_migration.status_probe_attempt attempt=%d err=%s",
                attempt + 1,
                type(exc).__name__,
            )
        if attempt == 0:
            time.sleep(2.0)
    return None


def _discover_source_incarnation(handoff: Any, metadata: dict[str, Any]) -> str:
    status = _probe_source_upgrade_status(handoff)
    if isinstance(status, dict) and str(status.get("incarnation") or "").strip():
        return str(status["incarnation"]).strip()
    # Never fall back to metadata["serviceUid"] (Hub UUID, not container revision);
    # only an explicit serving revision is a valid pod incarnation guard.
    return str(metadata.get("revision") or "").strip()


class HostedAzureFreshFallbackSteps(LiveMigrationSteps):
    """Live migration steps with explicit opt-in fallback on HTTP 400 custody refusals.

    Older BYOC pods carrying source-DEK-sealed ``agent_memory`` / ``agent_memory_fact``
    records intentionally refuse whole-log export (HTTP 400) so ciphertext is never
    re-sealed into an unreadable state. When ``allow_fresh_pod_log=True`` is explicitly
    requested, ONLY ``POD_REFUSED_400`` admits a fresh pod commit log while retaining the
    untouched BYOC resource group under the 14-day grace period; network, auth, and 5xx
    errors still fail closed before switch-over.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.fresh_pod_log_fallback_used: bool = False

    async def export_source(self, public_key: str, key_id: str) -> dict[str, Any]:
        try:
            return dict(await super().export_source(public_key, key_id))
        except pod_migration_transport.PodMigrationTransportError as exc:
            if exc.code != "POD_REFUSED_400":
                raise
            logger.warning(
                "hosted_azure_migration.fresh_pod_log_fallback user=%s",
                self._ctx.user_id,
            )
            self.fresh_pod_log_fallback_used = True
            return {
                "bundle": {"_freshPodLogFallback": True},
                "headSha": "0" * 64,
                "recordCount": 0,
            }

    async def import_destination(self, bundle: dict[str, Any]) -> dict[str, Any]:
        if bundle.get("_freshPodLogFallback") is True:
            zero_sha = "0" * 64
            return {
                "headSha": zero_sha,
                "recordCount": 0,
                "sourceHeadSha": zero_sha,
                "matchesSource": True,
            }
        return dict(await super().import_destination(bundle))


async def execute_owner_migration_to_hosted_azure(
    user_id: str,
    *,
    db: Any = None,
    registry_repo: Any = None,
    job_repo: PodMigrationJobRepo | None = None,
    pool: PodSkeletonPoolService | None = None,
    cell_id: str | None = None,
    allow_fresh_pod_log: bool = False,
    handoff_factory: Callable[[str, str], Any] | None = None,
    prewarm_fn: Callable[[str], None] | None = None,
    transport: Any = pod_migration_transport,
    token_minter: Any = None,
    admit_direct_fn: Any = admit_external_ingress_if_due,
) -> dict[str, Any]:
    """Migrate an owner's active pod onto a HushOne Inc. pre-warmed Azure skeleton."""
    if deploy_lane() != "dev":
        raise PermissionError("Hosted Azure migration is restricted to dev")

    if db is None:
        from db.db_client import get_db

        db = get_db()
    if registry_repo is None:
        from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

        registry_repo = PersonalAgentRegistryRepo(client=db)
    wrapped_registry = _BusyRetryRegistryAdapter(registry_repo)
    jobs = job_repo or PodMigrationJobRepo(client=db)
    skeleton_pool = pool or PodSkeletonPoolService()

    row = await wrapped_registry.get(user_id)
    if not isinstance(row, dict):
        raise ValueError("Personal agent registry row not found")

    source_target = str(row.get("deployment_target") or "").strip()
    if source_target not in {"user_azure", "user_gcp", "gcp"}:
        raise ValueError(f"Unsupported source deployment target {source_target!r} for Azure move")

    metadata = row.get("backend_metadata") if isinstance(row.get("backend_metadata"), dict) else {}
    source_url = str(metadata.get("url") or row.get("a2a_route") or "").strip().rstrip("/")
    source_service = str(metadata.get("service") or row.get("external_agent_id") or "").strip()
    hushh_id = str(row.get("hushh_id") or "").strip()
    if not source_url.startswith("https://") or not hushh_id:
        raise ValueError("Source pod endpoint or HusshID unavailable")

    handoff = (
        handoff_factory(source_url, hushh_id)
        if handoff_factory is not None
        else PodUpgradeHandoffClient(url=source_url, hushh_id=hushh_id)
    )

    prewarmed = False

    async def _ensure_source_prewarmed() -> None:
        nonlocal prewarmed
        if prewarmed:
            return
        prewarmed = True
        if prewarm_fn is not None:
            await asyncio.to_thread(prewarm_fn, source_url)
        elif handoff_factory is None and source_url.startswith("https://"):
            await asyncio.to_thread(_default_prewarm_source_health, source_url)

    if row.get("status") == "migrating":
        prior_job = await jobs.get(user_id)
        prior_job_id = str((prior_job or {}).get("job_id") or "").strip()
        if (
            isinstance(prior_job, dict)
            and prior_job_id
            and prior_job.get("status") == "failed"
            and prior_job.get("error_code") == "FREEZE_OUTCOME_UNKNOWN"
            and prior_job.get("stage") in {"freezing", "starting"}
        ):
            await _ensure_source_prewarmed()
            live_status = await asyncio.to_thread(_probe_source_upgrade_status, handoff)
            if (
                isinstance(live_status, dict)
                and live_status.get("state") == "accepting"
                and not live_status.get("operationId")
            ):
                await wrapped_registry.end_migration(user_id, status="provisioned")
                await jobs.finish(
                    user_id=user_id,
                    job_id=prior_job_id,
                    status="failed",
                    error_code="FREEZE_RECONCILED",
                    error_message=(
                        "Source pod confirmed unfenced (accepting); reconciled pre-freeze state."
                    ),
                )
                reloaded = await wrapped_registry.get(user_id)
                if isinstance(reloaded, dict):
                    row = reloaded
        elif (
            isinstance(prior_job, dict)
            and prior_job_id
            and prior_job.get("status") == "failed"
            and prior_job.get("error_code") == "SWITCH_OUTCOME_UNKNOWN"
            and prior_job.get("stage") == "switching_over"
            and source_target != BACKEND_AZURE
        ):
            # Authoritative registry proves switch-over rolled back and never moved
            # deployment_target to 'azure'. Release any active drain on the source pod
            # before restoring 'provisioned' so the retry can proceed cleanly.
            await _ensure_source_prewarmed()
            live_status = await asyncio.to_thread(_probe_source_upgrade_status, handoff)
            if (
                isinstance(live_status, dict)
                and live_status.get("state") in {"draining", "idle"}
                and str(live_status.get("operationId") or "").strip()
                and str(live_status.get("incarnation") or "").strip()
            ):
                live_status = await asyncio.to_thread(
                    handoff.release,
                    operation_id=str(live_status["operationId"]).strip(),
                    incarnation=str(live_status["incarnation"]).strip(),
                )
            if (
                isinstance(live_status, dict)
                and live_status.get("state") == "accepting"
                and not live_status.get("operationId")
            ):
                await wrapped_registry.end_migration(user_id, status="provisioned")
                await jobs.finish(
                    user_id=user_id,
                    job_id=prior_job_id,
                    status="failed",
                    error_code="SWITCH_RECONCILED_PRE_COMMIT",
                    error_message=(
                        "Authoritative registry remained on source; source drain released "
                        "and pre-switch state reconciled."
                    ),
                )
                reloaded = await wrapped_registry.get(user_id)
                if isinstance(reloaded, dict):
                    row = reloaded

    if row.get("status") != "provisioned":
        raise ValueError(f"Agent must be provisioned before moving (status={row.get('status')!r})")

    await _ensure_source_prewarmed()
    source_incarnation = await asyncio.to_thread(_discover_source_incarnation, handoff, metadata)
    if not source_incarnation:
        raise ValueError(
            "Could not determine live source pod incarnation "
            "(pod may still be waking from scale-to-zero); please retry"
        )

    op_id = f"op_{secrets.token_hex(16)}"
    cell = skeleton_pool._registry.azure_cell(cell_id)
    job_id = new_job_id()
    await jobs.start(
        user_id=user_id,
        job_id=job_id,
        hushh_id=hushh_id,
        target_project=cell.cell_id,
        target_region=cell.location,
        source_pod_url=source_url,
        source_service=source_service,
    )

    spec = PodSpec(
        hushh_id=hushh_id,
        phone_e164_hash=str(row.get("phone_e164_hash") or ""),
        pod_pubkey=str(row.get("pod_pubkey") or ""),
        region=cell.location,
        billing_space_id=row.get("billing_space_id"),
        runtime_version=row.get("runtime_version"),
        prompt_version=row.get("prompt_version"),
        deployment_target=BACKEND_AZURE,
        model_credential_mode=row.get("model_credential_mode"),
    )
    occupied_app_ids = await asyncio.to_thread(_discover_occupied_app_ids, db)
    provisioner = HostedAzureDestinationProvisioner(
        user_id=user_id,
        spec=spec,
        pool=skeleton_pool,
        cell_id=cell.cell_id,
        occupied_app_ids=occupied_app_ids,
    )

    switched_row: dict[str, Any] | None = None
    steps: LiveMigrationSteps

    def _resolved_migration_mode() -> str:
        return (
            "fresh_pod_log_with_source_grace"
            if getattr(steps, "fresh_pod_log_fallback_used", False)
            else "lossless_commit_log"
        )

    async def _do_switch_over(_destination_url: str) -> None:
        nonlocal switched_row
        if provisioner.claimed is None:
            raise RuntimeError("No claimed skeleton available at switch-over")
        mode = _resolved_migration_mode()
        if hasattr(db, "engine"):
            switched_row = await asyncio.to_thread(
                _switch_over_sql,
                db,
                user_id=user_id,
                hushh_id=hushh_id,
                claimed=provisioner.claimed,
                service_uid=provisioner._service_uid,
                migration_mode=mode,
            )
        else:
            # Test seam when running against an in-memory fake DB without SQLAlchemy engine.
            switcher = getattr(registry_repo, "switch_over_hosted_azure", None)
            if switcher is None:
                raise RuntimeError("No switch-over handler available on test registry")
            switched_row = await switcher(
                user_id=user_id,
                hushh_id=hushh_id,
                claimed=provisioner.claimed,
                service_uid=provisioner._service_uid,
            )
            if isinstance(switched_row, dict) and isinstance(
                switched_row.get("backend_metadata"), dict
            ):
                switched_row["backend_metadata"]["migrationMode"] = mode
                admission = switched_row["backend_metadata"].get("hostedAzureAdmission")
                if isinstance(admission, dict):
                    admission["migrationMode"] = mode

    def _non_destructive_source_grace() -> None:
        # Preserve owner's personal BYOC Resource Group for the 14-day grace period;
        # release the old pod's drain safely so it can still be audited if needed.
        try:
            handoff.release(operation_id=op_id, incarnation=source_incarnation)
        except Exception:  # noqa: BLE001 - source host is detached; 14-day grace governs cleanup
            logger.info("hosted_azure_migration.source_grace_retained")

    ctx = MigrationContext(
        user_id=user_id,
        hushh_id=hushh_id,
        source_pod_url=source_url,
        source_service=source_service,
        operation_id=op_id,
        source_incarnation=source_incarnation,
    )
    steps_cls = HostedAzureFreshFallbackSteps if allow_fresh_pod_log else LiveMigrationSteps
    steps = steps_cls(
        ctx,
        registry=wrapped_registry,
        provisioner=provisioner,
        transport=transport,
        reap=_non_destructive_source_grace,
        switch_over=_do_switch_over,
        token_minter=token_minter,
        handoff=handoff,
    )

    terminal = await run_migration(
        user_id=user_id,
        job_id=job_id,
        steps=steps,
        repo=jobs,
    )

    direct_promoted = False
    if terminal == "succeeded" and switched_row is not None and admit_direct_fn is not None:
        direct_promoted = bool(await admit_direct_fn(switched_row, db=db))
        if direct_promoted:
            refreshed = await wrapped_registry.get(user_id)
            if isinstance(refreshed, dict):
                switched_row = refreshed

    job = await jobs.get(user_id)
    claimed = provisioner.claimed
    return {
        "jobId": job_id,
        "status": terminal,
        "cellId": cell.cell_id,
        "slotId": claimed.slot.slot_id if claimed else None,
        "claimLatencyMs": claimed.claim_latency_ms if claimed else None,
        "migrationMode": _resolved_migration_mode(),
        "directPromoted": direct_promoted,
        "cutover": relay_first_cutover_status(switched_row),
        "job": job,
    }


async def get_owner_hosted_azure_migration_status(
    user_id: str,
    *,
    db: Any = None,
    registry_repo: Any = None,
    job_repo: PodMigrationJobRepo | None = None,
    pool: PodSkeletonPoolService | None = None,
) -> dict[str, Any]:
    if db is None:
        from db.db_client import get_db

        db = get_db()
    if registry_repo is None:
        from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

        registry_repo = PersonalAgentRegistryRepo(client=db)
    jobs = job_repo or PodMigrationJobRepo(client=db)
    skeleton_pool = pool or PodSkeletonPoolService()

    row = await registry_repo.get(user_id)
    job = await jobs.get(user_id)
    metadata = (
        row.get("backend_metadata")
        if isinstance(row, dict) and isinstance(row.get("backend_metadata"), dict)
        else {}
    )
    occupied_app_ids = await asyncio.to_thread(_discover_occupied_app_ids, db)
    return {
        "job": job,
        "deploymentTarget": (row or {}).get("deployment_target"),
        "registryStatus": (row or {}).get("status"),
        "directReadiness": metadata.get("directReadiness"),
        "cutover": relay_first_cutover_status(row),
        "cellPool": skeleton_pool.snapshot_status(occupied_app_ids=occupied_app_ids),
    }


async def get_hosted_umbrella_cells_snapshot(
    cell_id: str | None = None,
    *,
    db: Any = None,
    pool: PodSkeletonPoolService | None = None,
) -> dict[str, Any]:
    """Return Umbrella Compute Cell capacity watermarks and occupied/warm slots."""
    if db is None:
        from db.db_client import get_db

        db = get_db()
    skeleton_pool = pool or PodSkeletonPoolService()
    try:
        occupied_app_ids = await asyncio.to_thread(_discover_occupied_app_ids, db)
    except OSError as exc:
        if "Database credentials not set" not in str(exc):
            raise
        occupied_app_ids = None
    return skeleton_pool.snapshot_status(cell_id=cell_id, occupied_app_ids=occupied_app_ids)


__all__ = [
    "HostedAzureDestinationProvisioner",
    "build_hosted_azure_switch_metadata",
    "execute_owner_migration_to_hosted_azure",
    "get_hosted_umbrella_cells_snapshot",
    "get_owner_hosted_azure_migration_status",
]
