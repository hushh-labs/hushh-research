"""Conditional cloud coordinates behind the registry's existing public facade."""

from datetime import datetime, timezone
from typing import Any


class PodAssignmentPreserved(ValueError):
    """Onboarding cannot replace an assigned or in-progress runtime."""


def record_cloud(
    db: Any,
    *,
    user_id: str,
    project: str,
    deployment_target: str,
    model_credential_mode: str,
    region: str | None,
    bootstrap_sa: str | None,
    authorized: bool,
) -> bool:
    project = str(project or "").strip()
    if not project:
        raise ValueError("a user cloud needs a project id -- it is never inferred")
    rows = (
        db.table("personal_agent_registry")
        .select("*")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return False
    observed = dict(rows[0])
    coordinates = {
        "user_cloud_project": project,
        "deployment_target": deployment_target,
        "model_credential_mode": model_credential_mode,
    }
    if region:
        coordinates["user_cloud_region"] = str(region).strip()
    if bootstrap_sa:
        coordinates["user_cloud_bootstrap_sa"] = str(bootstrap_sa).strip()
    unassigned = not observed.get("external_agent_id") and observed.get("status") in {
        "pending",
        "unprovisioned",
        "logical",
    }
    if not unassigned and any(observed.get(key) != value for key, value in coordinates.items()):
        raise PodAssignmentPreserved("An existing pod requires an explicit migration")
    values = dict(coordinates)
    if authorized:
        values["user_cloud_authorized_at"] = datetime.now(timezone.utc).isoformat()
    elif observed.get("user_cloud_project") != project:
        values["user_cloud_authorized_at"] = None
    values["updated_at"] = datetime.now(timezone.utc).isoformat()
    # Compare the lifecycle and every placement field in the UPDATE itself. A
    # concurrent provision, migration or changed choice cannot pass a stale read.
    query = db.table("personal_agent_registry").update(values).eq("user_id", user_id)
    for key in (
        "status",
        "external_agent_id",
        "pod_key_id",
        "user_cloud_project",
        "user_cloud_region",
        "user_cloud_bootstrap_sa",
        "deployment_target",
        "model_credential_mode",
        "user_cloud_authorized_at",
    ):
        value = observed.get(key)
        query = query.is_(key, None) if value is None else query.eq(key, value)
    if not query.execute().data:
        raise PodAssignmentPreserved("Cloud assignment changed during authorization")
    return True
