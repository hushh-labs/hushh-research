"""Detach a person's active agent placement while keeping the host and its data.

One person runs one active agent. Until the cloud-to-cloud move is wired, an owner
who wants their agent somewhere else needs the slot released without destroying
the agent they already have. ``deprovision`` deletes; ``needs_reinit`` asserts the
host is gone. Neither is true here, so this is its own explicit, operator-run step.

What it does, in one conditional UPDATE:

- keeps the person's identity: ``hushh_id``, phone hash, space, billing space and
  the stable A2A route;
- releases the placement: target, cloud coordinates, host metadata, pod keys,
  liveness, so the slot reads as unassigned and a new setup can publish;
- records the whole prior row (public material only: identifiers and public keys)
  under ``backend_metadata.detachedPlacements``, newest last, so resuming has every
  coordinate it needs.

The host itself is untouched: its project or subscription, its sealed log and its
durable identity stay where they are, and resuming is that cloud's existing adopt
flow. The write is fenced on the observed ``updated_at``, the provisioned status
and the external agent id, and it refuses a row under erasure or with an
unfinished provision attempt, so it can never race a lifecycle transition.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Optional

from db.db_client import get_db

DETACH_REASON_MAX = 200


@dataclass(frozen=True)
class DetachPlan:
    """What a detach would release, for the operator's dry run. Public fields only."""

    user_id: str
    hushh_id: str
    status: str
    deployment_target: Optional[str]
    cloud_project: Optional[str]
    cloud_region: Optional[str]
    host_url: Optional[str]
    pod_key_id: Optional[str]
    observed_updated_at: str
    refusal: Optional[str]


def plan_detach(row: Optional[dict], *, allow_stalled_states: bool = False) -> Optional[DetachPlan]:
    """Read-only: describe the detach, or the reason it must not run."""
    if not row:
        return None
    metadata = row.get("backend_metadata") or {}
    attempt = metadata.get("provisionAttempt") if isinstance(metadata, dict) else None
    vm_power = metadata.get("vmPower") if isinstance(metadata, dict) else None
    allowed_statuses = (
        {"provisioned", "migrating", "provisioning_failed", "needs_reinit"}
        if allow_stalled_states
        else {"provisioned"}
    )
    refusal = None
    if row.get("status") not in allowed_statuses or not row.get("external_agent_id"):
        refusal = (
            "only an assigned agent placement can be detached"
            if allow_stalled_states
            else "only a provisioned, assigned agent can be detached"
        )
    elif isinstance(metadata, dict) and "erasure" in metadata:
        refusal = "the agent is under erasure"
    elif allow_stalled_states and isinstance(metadata, dict) and metadata.get("upgradeLease"):
        refusal = "an upgrade lease is still active"
    elif (
        allow_stalled_states
        and isinstance(vm_power, dict)
        and str(vm_power.get("phase") or "").strip() not in {"", "ready"}
    ):
        refusal = "a VM power operation is still pending"
    elif isinstance(attempt, dict) and attempt.get("phase") != "provisioned":
        refusal = "a provision attempt is still unfinished"
    return DetachPlan(
        user_id=str(row.get("user_id") or ""),
        hushh_id=str(row.get("hushh_id") or ""),
        status=str(row.get("status") or ""),
        deployment_target=row.get("deployment_target"),
        cloud_project=row.get("user_cloud_project"),
        cloud_region=row.get("user_cloud_region"),
        host_url=metadata.get("url") if isinstance(metadata, dict) else None,
        pod_key_id=row.get("pod_key_id"),
        observed_updated_at=str(row.get("updated_at") or ""),
        refusal=refusal,
    )


_DETACH_SQL = """
UPDATE personal_agent_registry AS r
SET status = 'unprovisioned',
    backend = NULL,
    external_agent_id = NULL,
    region = NULL,
    provisioned_at = NULL,
    pod_pubkey = NULL,
    pod_key_id = NULL,
    pod_key_wrapping_alg = NULL,
    runtime_version = NULL,
    prompt_version = NULL,
    last_heartbeat_at = NULL,
    health_state = 'unknown',
    last_probe_at = NULL,
    liveness_failures = 0,
    last_healed_at = NULL,
    deployment_target = NULL,
    model_credential_mode = NULL,
    user_cloud_project = NULL,
    user_cloud_region = NULL,
    user_cloud_bootstrap_sa = NULL,
    user_cloud_authorized_at = NULL,
    user_cloud_tenant_id = NULL,
    user_cloud_subscription_id = NULL,
    user_cloud_resource_group = NULL,
    backend_metadata = jsonb_build_object(
        'detachedPlacements',
        coalesce(r.backend_metadata -> 'detachedPlacements', '[]'::jsonb)
        || jsonb_build_array(
            (to_jsonb(r) - 'backend_metadata')
            || jsonb_build_object(
                'backend_metadata', coalesce(r.backend_metadata, '{}'::jsonb) - 'detachedPlacements',
                'detachedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'reason', CAST(:reason AS text)
            )
        )
    ),
    updated_at = now()
WHERE r.user_id = :user_id
  AND r.status = 'provisioned'
  AND r.external_agent_id = :external_agent_id
  AND r.updated_at = CAST(:observed_updated_at AS timestamptz)
  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'erasure')
  AND (
    NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'provisionAttempt')
    OR r.backend_metadata -> 'provisionAttempt' ->> 'phase' = 'provisioned'
  )
RETURNING r.user_id, jsonb_array_length(r.backend_metadata -> 'detachedPlacements') AS detached_count
"""


_DETACH_ALLOW_STALLED_SQL = """
UPDATE personal_agent_registry AS r
SET status = 'unprovisioned',
    backend = NULL,
    external_agent_id = NULL,
    region = NULL,
    provisioned_at = NULL,
    pod_pubkey = NULL,
    pod_key_id = NULL,
    pod_key_wrapping_alg = NULL,
    runtime_version = NULL,
    prompt_version = NULL,
    last_heartbeat_at = NULL,
    health_state = 'unknown',
    last_probe_at = NULL,
    liveness_failures = 0,
    last_healed_at = NULL,
    deployment_target = NULL,
    model_credential_mode = NULL,
    user_cloud_project = NULL,
    user_cloud_region = NULL,
    user_cloud_bootstrap_sa = NULL,
    user_cloud_authorized_at = NULL,
    user_cloud_tenant_id = NULL,
    user_cloud_subscription_id = NULL,
    user_cloud_resource_group = NULL,
    backend_metadata = jsonb_build_object(
        'detachedPlacements',
        coalesce(r.backend_metadata -> 'detachedPlacements', '[]'::jsonb)
        || jsonb_build_array(
            (to_jsonb(r) - 'backend_metadata')
            || jsonb_build_object(
                'backend_metadata', coalesce(r.backend_metadata, '{}'::jsonb) - 'detachedPlacements',
                'detachedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'reason', CAST(:reason AS text)
            )
        )
    ),
    updated_at = now()
WHERE r.user_id = :user_id
  AND r.status IN ('provisioned', 'migrating', 'provisioning_failed', 'needs_reinit')
  AND r.external_agent_id = :external_agent_id
  AND r.updated_at = CAST(:observed_updated_at AS timestamptz)
  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'erasure')
  AND NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'upgradeLease')
  AND (
    NOT (coalesce(r.backend_metadata, '{}'::jsonb) ? 'provisionAttempt')
    OR r.backend_metadata -> 'provisionAttempt' ->> 'phase' = 'provisioned'
  )
RETURNING r.user_id, jsonb_array_length(r.backend_metadata -> 'detachedPlacements') AS detached_count
"""


async def detach_placement(
    *, row: dict, reason: str, db: Any = None, allow_stalled_states: bool = False
) -> Optional[dict[str, Any]]:
    """Detach the observed row. Returns ``{user_id, detached_count}`` or None if fenced out."""
    plan = plan_detach(row, allow_stalled_states=allow_stalled_states)
    if plan is None or plan.refusal:
        raise ValueError(plan.refusal if plan else "no agent record")
    reason = str(reason or "").strip()[:DETACH_REASON_MAX]
    if not reason:
        raise ValueError("a detach needs a stated reason")
    client = db or get_db()
    sql = _DETACH_ALLOW_STALLED_SQL if allow_stalled_states else _DETACH_SQL
    response = await asyncio.to_thread(
        client.execute_raw,
        sql,
        {
            "user_id": plan.user_id,
            "external_agent_id": str(row["external_agent_id"]),
            "observed_updated_at": plan.observed_updated_at,
            "reason": reason,
        },
    )
    rows = list(getattr(response, "data", None) or [])
    return dict(rows[0]) if rows else None


def plan_as_json(plan: DetachPlan) -> str:
    """A stable, public rendering of the plan for the operator script."""
    return json.dumps(plan.__dict__, indent=2, sort_keys=True, default=str)
