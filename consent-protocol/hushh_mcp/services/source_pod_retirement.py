# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Automated 14-day two-key source-pod retirement policy (Dev lane).

Enforces the two-key post-migration retirement contract:
1. Owners never lose their prior pod during the 14-day grace window (`graceReapAfter`),
   and un-dated founder/legacy entries without an explicit `graceReapAfter` are never
   touched automatically.
2. Retirement executes **only** after BOTH:
   - the 14-day safety window expires (`now >= graceReapAfter`), AND
   - the owner explicitly confirms satisfaction with their new pod (`ownerConfirmed=True`).
3. Sovereign BYOC clouds (`user_azure`, `user_gcp`) respect Hussh's zero-delete trust
   boundary: Hussh revokes only its own observer RBAC bindings (never deleting the
   owner's resource group, storage, or Key Vault) and surfaces cleanup readiness.
4. Hub Postgres `backend_metadata.detachedPlacements` elements remain 100% immutable so
   retention constraint triggers never trip; retirement ledger state lives strictly under
   sibling key `backend_metadata.sourcePodRetirements`.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import math
import os
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import google.auth
import google.auth.transport.requests
import requests

from hushh_mcp.runtime_settings import (
    pod_mode,
    source_pod_retirement_sweep_enabled,
)
from hushh_mcp.services import azure_federation
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient, ArmError
from hushh_mcp.services.dev_simulation_guard import deploy_lane
from hushh_mcp.services.fleet_sweep_lock import FleetSweepLock, fleet_turn
from hushh_mcp.services.hosted_azure_backend import HostedAzureBackend
from hushh_mcp.services.pod_umbrella_cell_pool import (
    PodSkeletonPoolService,
    UmbrellaCellRegistry,
)

logger = logging.getLogger(__name__)

_DEFAULT_INTERVAL_SECONDS = 600.0
_DEFAULT_INITIAL_DELAY_SECONDS = 30.0
_MIN_WAKE_INTERVAL_SECONDS = 10.0
_BACKOFF_SCHEDULE_SECONDS: tuple[float, ...] = (300.0, 900.0, 3600.0)
_ALLOWED_PRIMARY_STATUS = "provisioned"
_TERMINAL_RETIREMENT_STATUSES = frozenset(
    {
        "retired_hussh_hosted_azure_slot",
        "retired_hussh_hosted_gcp",
        "retired_byoc_observer_revoked",
    }
)

_WAKE_LOCK = threading.Lock()
_WAKE_LOOP: asyncio.AbstractEventLoop | None = None
_WAKE_EVENT: asyncio.Event | None = None


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso(now: datetime | None = None) -> str:
    return (now or _now_dt()).isoformat()


def _parse_iso(raw: object) -> datetime | None:
    if not isinstance(raw, str):
        return None
    val = raw.strip()
    if not val:
        return None
    if val.endswith("Z"):
        val = val[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(val)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _owner_hash(value: str) -> str:
    return "sha256:" + hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def _register_wake_event(loop: asyncio.AbstractEventLoop, event: asyncio.Event) -> None:
    global _WAKE_LOOP, _WAKE_EVENT
    with _WAKE_LOCK:
        _WAKE_LOOP = loop
        _WAKE_EVENT = event


def trigger_source_pod_retirement_sweep() -> None:
    """Wake the source-pod retirement sweeper promptly when an owner confirms post-grace."""
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


def compute_placement_id(entry: Mapping[str, Any]) -> str:
    """Deterministic opaque handle for one grace-governed detached placement."""
    detached_at = str(entry.get("detachedAt") or "").strip()
    backend = str(entry.get("backend") or "").strip()
    target = str(entry.get("deployment_target") or entry.get("deploymentTarget") or "").strip()
    ext_id = str(entry.get("external_agent_id") or "").strip()
    digest = hashlib.sha256(
        f"{detached_at}|{backend}|{target}|{ext_id}".encode("utf-8")
    ).hexdigest()
    return f"ret_{digest[:24]}"


def _source_descriptor(entry: Mapping[str, Any]) -> tuple[str, str, str, str, str]:
    target = str(entry.get("deployment_target") or entry.get("deploymentTarget") or "").strip()
    if target == "gcp":
        project = str(entry.get("user_cloud_project") or "").strip()
        return ("gcp", "gcp", "hussh_pods", "Hussh Pods · Google Cloud", project)
    if target == "azure":
        cell = str(
            (
                (entry.get("backend_metadata") or {})
                if isinstance(entry.get("backend_metadata"), Mapping)
                else {}
            ).get("cellId")
            or ""
        ).strip()
        return ("azure", "azure", "hussh_pods", "Hussh Pods · Microsoft Azure", cell)
    if target == "user_azure":
        rg = str(entry.get("user_cloud_resource_group") or "").strip()
        return ("user_azure", "azure", "byoc", "Your Azure", rg)
    if target == "user_gcp":
        project = str(entry.get("user_cloud_project") or "").strip()
        return ("user_gcp", "gcp", "byoc", "Your Google Cloud", project)
    return (target or "unknown", "unknown", "byoc", "Prior Cloud", "")


@dataclass(frozen=True)
class GraceDetachedPlacement:
    placement_id: str
    entry: Mapping[str, Any]
    detached_at: str
    grace_reap_after: str
    reap_at: datetime
    source_target: str
    source_provider: str
    source_kind: str
    source_label: str
    resource_hint: str


def iter_grace_governed_detached_placements(
    row: Mapping[str, Any] | None,
) -> list[GraceDetachedPlacement]:
    """Return detached placements carrying an explicit 14-day ``graceReapAfter`` timestamp."""
    if not isinstance(row, Mapping):
        return []
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, Mapping):
        return []
    detached = metadata.get("detachedPlacements")
    if not isinstance(detached, Sequence) or isinstance(detached, (str, bytes)):
        return []
    items: list[GraceDetachedPlacement] = []
    for entry in detached:
        if not isinstance(entry, Mapping):
            continue
        reap_raw = str(entry.get("graceReapAfter") or "").strip()
        reap_dt = _parse_iso(reap_raw)
        if reap_dt is None:
            # Explicit hold entries (no graceReapAfter) stay preserved untouched.
            continue
        target, provider, kind, label, hint = _source_descriptor(entry)
        items.append(
            GraceDetachedPlacement(
                placement_id=compute_placement_id(entry),
                entry=entry,
                detached_at=str(entry.get("detachedAt") or "").strip(),
                grace_reap_after=reap_raw,
                reap_at=reap_dt,
                source_target=target,
                source_provider=provider,
                source_kind=kind,
                source_label=label,
                resource_hint=hint,
            )
        )
    return items


def build_source_retirement_items(
    row: Mapping[str, Any] | None,
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Project clean non-PII UI/API status for an owner's grace-governed prior placements."""
    if not isinstance(row, Mapping):
        return []
    current = now or _now_dt()
    metadata = (
        row.get("backend_metadata") if isinstance(row.get("backend_metadata"), Mapping) else {}
    )
    ledger = (
        metadata.get("sourcePodRetirements")
        if isinstance(metadata.get("sourcePodRetirements"), Mapping)
        else {}
    )
    items: list[dict[str, Any]] = []
    for gp in iter_grace_governed_detached_placements(row):
        rec = (
            ledger.get(gp.placement_id) if isinstance(ledger.get(gp.placement_id), Mapping) else {}
        )
        owner_confirmed = bool(rec.get("ownerConfirmed") is True)
        grace_expired = current >= gp.reap_at
        seconds_left = max(0.0, (gp.reap_at - current).total_seconds())
        days_remaining = int(math.ceil(seconds_left / 86400.0)) if seconds_left > 0 else 0
        recorded_status = str(rec.get("status") or "").strip()
        if (
            recorded_status in _TERMINAL_RETIREMENT_STATUSES
            or recorded_status == "retirement_backoff"
        ):
            status = recorded_status
        elif owner_confirmed and grace_expired:
            status = "ready_for_retirement"
        elif owner_confirmed:
            status = "owner_confirmed"
        else:
            status = "awaiting_owner_confirmation"

        items.append(
            {
                "placementId": gp.placement_id,
                "sourceTarget": gp.source_target,
                "sourceProvider": gp.source_provider,
                "sourceKind": gp.source_kind,
                "sourceLabel": gp.source_label,
                "resourceHint": gp.resource_hint,
                "detachedAt": gp.detached_at,
                "graceReapAfter": gp.grace_reap_after,
                "daysRemaining": days_remaining,
                "graceExpired": grace_expired,
                "ownerConfirmed": owner_confirmed,
                "confirmedAt": rec.get("confirmedAt"),
                "retiredAt": rec.get("retiredAt"),
                "status": status,
                "ownerCloudCleanupReady": bool(rec.get("ownerCloudCleanupReady") is True),
                "revokedRoleAssignmentCount": int(rec.get("revokedRoleAssignmentCount") or 0),
                "retirableAtTimestamp": gp.grace_reap_after,
            }
        )
    return items


def get_owner_source_pod_retirement_status_from_row(
    row: Mapping[str, Any] | None,
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Pure synchronous projection helper for embedding inside migration status."""
    return build_source_retirement_items(row, now=now)


def _persist_retirements_sql(
    db: Any,
    *,
    user_id: str,
    mutator: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    """Atomically update ``backend_metadata.sourcePodRetirements`` under ordered advisory locks."""
    from sqlalchemy import text

    with db.engine.begin() as conn:
        conn.execute(text("SET LOCAL statement_timeout = '5s'"))
        conn.execute(text("SET LOCAL lock_timeout = '2s'"))
        conn.execute(
            text(
                "SELECT pg_advisory_xact_lock(hashtextextended(:user_id, 171)), "
                "pg_advisory_xact_lock(hashtextextended(:user_id, 198))"
            ),
            {"user_id": user_id},
        )
        row = (
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
        if row is None:
            raise ValueError("Personal agent registry row not found")
        row_dict = dict(row)
        metadata = row_dict.get("backend_metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        if row_dict.get("status") != _ALLOWED_PRIMARY_STATUS or "erasure" in metadata:
            raise ValueError("Active provisioned agent required before updating source retirement")
        current_ledger = copy.deepcopy(metadata.get("sourcePodRetirements"))
        if not isinstance(current_ledger, dict):
            current_ledger = {}
        updated_ledger = mutator(row_dict, current_ledger)
        updated = (
            conn.execute(
                text(
                    """
                    UPDATE public.personal_agent_registry
                    SET backend_metadata = jsonb_set(
                            coalesce(backend_metadata, '{}'::jsonb),
                            '{sourcePodRetirements}',
                            CAST(:retirements AS jsonb),
                            true
                        ),
                        updated_at = clock_timestamp()
                    WHERE user_id = :user_id
                    RETURNING *
                    """
                ),
                {"user_id": user_id, "retirements": json.dumps(updated_ledger)},
            )
            .mappings()
            .one()
        )
        return dict(updated)


async def get_owner_source_pod_retirement_status(
    user_id: str,
    *,
    db: Any = None,
    registry_repo: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    if deploy_lane() != "dev":
        raise PermissionError("Source pod retirement is restricted to the dev lane")
    if registry_repo is None:
        if db is None:
            from db.db_client import get_db

            db = get_db()
        from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

        registry_repo = PersonalAgentRegistryRepo(client=db)
    row = await registry_repo.get(user_id)
    items = build_source_retirement_items(row, now=now)
    return {
        "environment": deploy_lane(),
        "items": items,
        "hasPendingConfirmation": any(not it["ownerConfirmed"] for it in items),
    }


async def confirm_owner_source_pod_retirement(
    user_id: str,
    *,
    placement_id: str | None = None,
    db: Any = None,
    registry_repo: Any = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record explicit owner confirmation that their new pod satisfies comfort before retirement."""
    if deploy_lane() != "dev":
        raise PermissionError("Source pod retirement is restricted to the dev lane")
    if db is None:
        from db.db_client import get_db

        db = get_db()

    current_time = now or _now_dt()
    now_iso = _now_iso(current_time)

    def _apply(row_dict: dict[str, Any], ledger: dict[str, Any]) -> dict[str, Any]:
        candidates = iter_grace_governed_detached_placements(row_dict)
        if not candidates:
            raise ValueError("No grace-governed prior pod placement found")
        chosen: GraceDetachedPlacement | None = None
        if placement_id:
            for item in candidates:
                if item.placement_id == placement_id:
                    chosen = item
                    break
            if chosen is None:
                raise ValueError("Unknown prior pod placement identifier")
        else:
            # Select latest unretired grace-governed placement (falling back to latest item).
            for item in reversed(candidates):
                existing = ledger.get(item.placement_id)
                if (
                    not isinstance(existing, Mapping)
                    or existing.get("status") not in _TERMINAL_RETIREMENT_STATUSES
                ):
                    chosen = item
                    break
            if chosen is None:
                chosen = candidates[-1]

        rec = dict(ledger.get(chosen.placement_id) or {})
        if rec.get("status") in _TERMINAL_RETIREMENT_STATUSES:
            return ledger

        grace_expired = current_time >= chosen.reap_at
        if not rec.get("ownerConfirmed"):
            rec["ownerConfirmed"] = True
            rec["confirmedAt"] = now_iso
            rec["confirmedPlacementEpoch"] = int(row_dict.get("placement_epoch") or 0)
            rec["sourceTarget"] = chosen.source_target
            rec["graceReapAfter"] = chosen.grace_reap_after
        rec["status"] = "ready_for_retirement" if grace_expired else "owner_confirmed"
        ledger[chosen.placement_id] = rec
        return ledger

    if hasattr(db, "engine"):
        updated_row = await asyncio.to_thread(
            _persist_retirements_sql, db, user_id=user_id, mutator=_apply
        )
    else:
        if registry_repo is None or not hasattr(registry_repo, "update_source_retirements"):
            raise RuntimeError("No SQL engine or test registry mutator provided")
        updated_row = await registry_repo.update_source_retirements(user_id=user_id, mutator=_apply)

    items = build_source_retirement_items(updated_row, now=current_time)
    if any(
        it["ownerConfirmed"] and it["graceExpired"] and not str(it["status"]).startswith("retired_")
        for it in items
    ):
        trigger_source_pod_retirement_sweep()
    return {
        "environment": deploy_lane(),
        "items": items,
        "confirmedPlacementId": placement_id
        or next((it["placementId"] for it in reversed(items) if it["ownerConfirmed"]), None),
    }


def _find_matching_hosted_azure_slot(
    external_agent_id: str,
    pool: PodSkeletonPoolService,
) -> tuple[Any, Any] | None:
    target_lower = str(external_agent_id or "").strip().lower()
    if not target_lower:
        return None
    for cell in pool.list_live_cells_sync(provider="azure"):
        for slot in cell.slots:
            if slot.app_id.lower() == target_lower:
                return cell, slot
        try:
            inv = pool.observe_azure_cell_inventory_sync(cell)
            for slot in inv["slots"]:
                if slot.app_id.lower() == target_lower:
                    return cell, slot
        except Exception:  # noqa: BLE001
            continue
    return None


def _retire_hosted_azure_slot_sync(
    *,
    user_id: str,
    row: Mapping[str, Any],
    gp: GraceDetachedPlacement,
    active_external_ids: set[str],
    pool: PodSkeletonPoolService | None = None,
    arm_client: ArmClient | None = None,
) -> dict[str, Any]:
    ext_id = str(gp.entry.get("external_agent_id") or "").strip()
    if not ext_id:
        return {"status": "retired_hussh_hosted_azure_slot", "alreadyAbsent": True}
    if ext_id.lower() in active_external_ids:
        raise RuntimeError(f"Refusing to recycle slot {ext_id}: still bound to active primary row")

    skeleton_pool = pool or PodSkeletonPoolService(registry=UmbrellaCellRegistry())
    matched = _find_matching_hosted_azure_slot(ext_id, skeleton_pool)
    if matched is None:
        return {"status": "retired_hussh_hosted_azure_slot", "alreadyAbsent": True}
    cell, slot = matched

    arm = arm_client
    if arm is None:
        controller_client_id = (
            os.getenv("HUSSH_HOSTED_AZURE_CLIENT_ID") or cell.controller_client_id
        ).strip()
        arm = ArmClient(
            lambda: (
                azure_federation.app_token(
                    cell.tenant_id, client_id=controller_client_id
                ).access_token
            )
        )

    existing = arm.get_or_none(
        slot.app_id,
        api_version=API_VERSIONS["container_apps"],
        op="source_retirement_observe_slot",
    )
    if existing is None:
        return {"status": "retired_hussh_hosted_azure_slot", "alreadyAbsent": True}

    tags = existing.get("tags") if isinstance(existing.get("tags"), Mapping) else {}
    observed_hash = str((tags or {}).get("hussh-owner-hash") or "").strip()
    hushh_id = str(gp.entry.get("hushh_id") or row.get("hushh_id") or "").strip()
    allowed_hashes = {
        h for h in (_owner_hash(user_id), _owner_hash(hushh_id) if hushh_id else "") if h
    }
    if observed_hash and observed_hash not in allowed_hashes:
        raise RuntimeError("Refusing slot recycle: slot owner hash belongs to another owner")

    backend = HostedAzureBackend(
        slot=skeleton_pool.slot_spec(slot.slot_id, cell_id=cell.cell_id),
        arm_client=arm,
        live=True,
    )
    warm_body = backend.render_warm_standby_config()
    arm.put(
        slot.app_id,
        api_version=API_VERSIONS["container_apps"],
        body=warm_body,
        op="source_retirement_recycle_slot",
    )
    return {
        "status": "retired_hussh_hosted_azure_slot",
        "recycledSlotId": slot.slot_id,
        "recycledCellId": cell.cell_id,
    }


def _retire_byoc_azure_observer_sync(
    *,
    gp: GraceDetachedPlacement,
    arm_client: ArmClient | None = None,
) -> dict[str, Any]:
    """Revoke only Hussh observer/removal role assignments on owner RG; never delete resources."""
    tenant_id = str(gp.entry.get("user_cloud_tenant_id") or "").strip()
    subscription_id = str(gp.entry.get("user_cloud_subscription_id") or "").strip()
    rg = str(gp.entry.get("user_cloud_resource_group") or "").strip()
    if not (tenant_id and subscription_id and rg):
        return {
            "status": "retired_byoc_observer_revoked",
            "ownerCloudCleanupReady": True,
            "revokedRoleAssignmentCount": 0,
        }

    token_bundle = azure_federation.app_token(tenant_id) if arm_client is None else None
    hussh_oid = str(
        getattr(token_bundle, "object_id", "") or os.getenv("HUSSH_AZURE_APP_OBJECT_ID", "")
    ).strip()
    arm = arm_client or ArmClient(lambda: token_bundle.access_token)  # type: ignore[union-attr]

    scope = f"/subscriptions/{subscription_id}/resourceGroups/{rg}"
    list_path = f"{scope}/providers/Microsoft.Authorization/roleAssignments"
    revoked = 0
    try:
        listing = arm.get_or_none(
            list_path,
            api_version=API_VERSIONS["authorization"],
            op="source_retirement_list_byoc_roles",
        )
    except ArmError as exc:
        if exc.kind in {"forbidden", "unauthorized"}:
            return {
                "status": "retired_byoc_observer_revoked",
                "ownerCloudCleanupReady": True,
                "revokedRoleAssignmentCount": 0,
                "alreadyRevokedByOwner": True,
            }
        raise

    for assignment in (listing or {}).get("value") or []:
        if not isinstance(assignment, Mapping):
            continue
        props = (
            assignment.get("properties")
            if isinstance(assignment.get("properties"), Mapping)
            else {}
        )
        principal_id = str((props or {}).get("principalId") or "").strip()
        assign_id = str(assignment.get("id") or "").strip()
        if not assign_id or (hussh_oid and principal_id.lower() != hussh_oid.lower()):
            continue
        try:
            if arm.delete(
                assign_id,
                api_version=API_VERSIONS["authorization"],
                op="source_retirement_revoke_byoc_role",
            ):
                revoked += 1
        except ArmError as exc:
            if exc.kind not in {"not_found", "forbidden"}:
                raise
    return {
        "status": "retired_byoc_observer_revoked",
        "ownerCloudCleanupReady": True,
        "revokedRoleAssignmentCount": revoked,
    }


def _default_gcp_hosted_retirer(
    _user_id: str,
    gp: GraceDetachedPlacement,
    active_external_ids: set[str],
) -> dict[str, Any]:
    service = str(gp.entry.get("external_agent_id") or "").strip()
    if service and service.lower() in active_external_ids:
        raise RuntimeError("Refusing to delete Cloud Run service still active on primary row")
    project = str(gp.entry.get("user_cloud_project") or "").strip()
    region = str(gp.entry.get("user_cloud_region") or "us-central1").strip()
    dev_project = str(os.getenv("GOOGLE_CLOUD_PROJECT") or "hushh-pda-dev").strip()
    if project and service and project == dev_project:
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(google.auth.transport.requests.Request())
        url = f"https://run.googleapis.com/v2/projects/{project}/locations/{region}/services/{service}"
        resp = requests.delete(
            url,
            headers={"Authorization": f"Bearer {creds.token}"},
            timeout=30,
        )
        if resp.status_code not in (200, 202, 204, 404):
            raise RuntimeError(f"Cloud Run service deletion returned HTTP {resp.status_code}")
    return {"status": "retired_hussh_hosted_gcp"}


def _load_retirement_candidates_sql(db: Any) -> tuple[list[dict[str, Any]], set[str]]:
    from sqlalchemy import text

    with db.engine.connect() as conn:
        active_rows = conn.execute(
            text(
                "SELECT external_agent_id FROM public.personal_agent_registry "
                "WHERE external_agent_id IS NOT NULL"
            )
        ).scalars()
        active_external_ids = {str(v).strip().lower() for v in active_rows if str(v or "").strip()}
        candidate_rows = (
            conn.execute(
                text(
                    "SELECT user_id, hushh_id, status, placement_epoch, backend_metadata "
                    "FROM public.personal_agent_registry "
                    "WHERE status = 'provisioned' "
                    "AND NOT (coalesce(backend_metadata, '{}'::jsonb) ? 'erasure') "
                    "AND jsonb_typeof(backend_metadata->'detachedPlacements') = 'array' "
                    "AND jsonb_array_length(backend_metadata->'detachedPlacements') > 0"
                )
            )
            .mappings()
            .all()
        )
        return [dict(r) for r in candidate_rows], active_external_ids


@dataclass(frozen=True)
class RetirementPassReport:
    skipped: bool
    reason: str
    retired_ids: tuple[str, ...]
    errors: tuple[str, ...]


class SourcePodRetirementSweeper:
    """Two-key 14-day source-pod retirement worker (grace expiry AND owner confirmation)."""

    def __init__(
        self,
        *,
        db: Any = None,
        pool: PodSkeletonPoolService | None = None,
        arm_client: ArmClient | None = None,
        byoc_arm_client: ArmClient | None = None,
        gcp_hosted_retirer: Callable[[str, GraceDetachedPlacement, set[str]], dict[str, Any]]
        | None = None,
        clock: Callable[[], datetime] = _now_dt,
        monotonic_clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._db = db
        self._pool = pool
        self._arm_client = arm_client
        self._byoc_arm_client = byoc_arm_client
        self._gcp_hosted_retirer = gcp_hosted_retirer or _default_gcp_hosted_retirer
        self._clock = clock
        self._monotonic_clock = monotonic_clock
        self._backoff_failures: dict[str, int] = {}
        self._backoff_until: dict[str, float] = {}

    def _get_db(self) -> Any:
        if self._db is not None:
            return self._db
        from db.db_client import get_db

        return get_db()

    async def sweep_once(self) -> RetirementPassReport:
        if pod_mode():
            return RetirementPassReport(True, "pod_mode", (), ())
        if deploy_lane() != "dev":
            return RetirementPassReport(True, "non_dev_lane", (), ())
        if not source_pod_retirement_sweep_enabled():
            return RetirementPassReport(True, "disabled", (), ())

        db = self._get_db()
        rows, active_external_ids = await asyncio.to_thread(_load_retirement_candidates_sql, db)
        now_dt = self._clock()
        now_iso = _now_iso(now_dt)
        now_mono = self._monotonic_clock()
        retired: list[str] = []
        errors: list[str] = []

        for row in rows:
            user_id = str(row.get("user_id") or "").strip()
            if not user_id:
                continue
            metadata = (
                row.get("backend_metadata")
                if isinstance(row.get("backend_metadata"), Mapping)
                else {}
            )
            ledger = (
                metadata.get("sourcePodRetirements")
                if isinstance(metadata.get("sourcePodRetirements"), Mapping)
                else {}
            )
            for gp in iter_grace_governed_detached_placements(row):
                rec = ledger.get(gp.placement_id)
                if not isinstance(rec, Mapping):
                    continue
                if rec.get("ownerConfirmed") is not True:
                    continue
                if str(rec.get("status") or "") in _TERMINAL_RETIREMENT_STATUSES:
                    continue
                if now_dt < gp.reap_at:
                    continue
                if now_mono < self._backoff_until.get(gp.placement_id, 0.0):
                    continue

                try:
                    if gp.source_target == "azure":
                        outcome = await asyncio.to_thread(
                            _retire_hosted_azure_slot_sync,
                            user_id=user_id,
                            row=row,
                            gp=gp,
                            active_external_ids=active_external_ids,
                            pool=self._pool,
                            arm_client=self._arm_client,
                        )
                    elif gp.source_target == "gcp":
                        outcome = await asyncio.to_thread(
                            self._gcp_hosted_retirer,
                            user_id,
                            gp,
                            active_external_ids,
                        )
                    elif gp.source_target == "user_azure":
                        outcome = await asyncio.to_thread(
                            _retire_byoc_azure_observer_sync,
                            gp=gp,
                            arm_client=self._byoc_arm_client,
                        )
                    else:
                        outcome = {
                            "status": "retired_byoc_observer_revoked",
                            "ownerCloudCleanupReady": True,
                        }

                    def _record_retired(
                        _row_dict: dict[str, Any],
                        cur_ledger: dict[str, Any],
                        *,
                        _pid: str = gp.placement_id,
                        _out: dict[str, Any] = outcome,
                    ) -> dict[str, Any]:
                        entry_rec = dict(cur_ledger.get(_pid) or {})
                        entry_rec.update(_out)
                        entry_rec["retiredAt"] = now_iso
                        entry_rec.pop("backoffFailures", None)
                        cur_ledger[_pid] = entry_rec
                        return cur_ledger

                    await asyncio.to_thread(
                        _persist_retirements_sql,
                        db,
                        user_id=user_id,
                        mutator=_record_retired,
                    )
                    self._backoff_failures.pop(gp.placement_id, None)
                    self._backoff_until.pop(gp.placement_id, None)
                    retired.append(gp.placement_id)
                    logger.info(
                        "source_pod_retirement.retired placement_id=%s target=%s status=%s",
                        gp.placement_id,
                        gp.source_target,
                        outcome.get("status"),
                    )
                except Exception as exc:  # noqa: BLE001 - isolate failure with backoff
                    failures = self._backoff_failures.get(gp.placement_id, 0) + 1
                    self._backoff_failures[gp.placement_id] = failures
                    wait_s = _BACKOFF_SCHEDULE_SECONDS[
                        min(failures - 1, len(_BACKOFF_SCHEDULE_SECONDS) - 1)
                    ]
                    self._backoff_until[gp.placement_id] = now_mono + wait_s
                    err_name = type(exc).__name__
                    errors.append(f"{gp.placement_id}:{err_name}")
                    logger.warning(
                        "source_pod_retirement.failed placement_id=%s err=%s",
                        gp.placement_id,
                        err_name,
                    )

        reason = "error" if errors and not retired else ("retired" if retired else "steady")
        return RetirementPassReport(False, reason, tuple(retired), tuple(errors))


async def _retirement_loop(
    sweeper: SourcePodRetirementSweeper,
    interval_seconds: float,
    initial_delay_seconds: float,
    sweep_lock: Optional[FleetSweepLock] = None,
) -> None:
    loop = asyncio.get_running_loop()
    wake_event = asyncio.Event()
    _register_wake_event(loop, wake_event)
    logger.info(
        "source_pod_retirement.started interval_s=%.1f initial_delay_s=%.1f",
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
                not pod_mode() and deploy_lane() == "dev" and source_pod_retirement_sweep_enabled()
            )
            async with fleet_turn(sweep_lock if enabled else None) as mine:
                if enabled and mine:
                    try:
                        await sweeper.sweep_once()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.exception("source_pod_retirement.unhandled_error")

            try:
                await asyncio.wait_for(wake_event.wait(), timeout=interval_seconds)
                wake_event.clear()
                await asyncio.sleep(_MIN_WAKE_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass
    except asyncio.CancelledError:
        logger.info("source_pod_retirement.cancelled")
        return


def start_source_pod_retirement_loop(
    *,
    sweeper: SourcePodRetirementSweeper | None = None,
    interval_seconds: float = _DEFAULT_INTERVAL_SECONDS,
    initial_delay_seconds: float = _DEFAULT_INITIAL_DELAY_SECONDS,
    sweep_lock: Optional[FleetSweepLock] = None,
) -> asyncio.Task[Any] | None:
    """Attach the fleet-serialized 14-day source-pod retirement worker in Dev mode only."""
    if pod_mode() or not source_pod_retirement_sweep_enabled():
        return None
    worker = sweeper or SourcePodRetirementSweeper()
    return asyncio.create_task(
        _retirement_loop(worker, interval_seconds, initial_delay_seconds, sweep_lock),
        name="source-pod-retirement",
    )


__all__ = [
    "GraceDetachedPlacement",
    "RetirementPassReport",
    "SourcePodRetirementSweeper",
    "build_source_retirement_items",
    "compute_placement_id",
    "confirm_owner_source_pod_retirement",
    "get_owner_source_pod_retirement_status",
    "get_owner_source_pod_retirement_status_from_row",
    "iter_grace_governed_detached_placements",
    "start_source_pod_retirement_loop",
    "trigger_source_pod_retirement_sweep",
]
