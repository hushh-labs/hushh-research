"""Tear down a BYOC tenant's substrate -- DARK by construction.

The substrate ensurer (byoc_substrate.py) self-names the gap: it records a receipt
of WHAT was created but has no teardown, so account deletion leaves the user's KMS
key, CMEK bucket, SA, Pub/Sub, and scheduler in their project. This closes it, but
behind two independent guards, because it DESTROYS THE USER'S SEALED HOLDINGS in a
customer-owned project, irreversibly (a KMS key cannot be un-destroyed):

  1. ``personal_agent_substrate_teardown_enabled()`` -- founder flag, default off; and
  2. an explicit ``dry_run=False`` at the call site.

With either guard closed, the executor returns the PLAN of what it would delete and
touches nothing. The plan itself is pure and consults no flag, so planning is always
safe.
"""

from __future__ import annotations

from typing import Any

# Dependency-safe teardown order (LOWER runs first). Reverse of creation, so a
# resource is deleted only after whatever depends on it is gone. KMS is LAST and
# is a version-destroy, not a delete -- the keyring/key resource itself is
# permanent in GCP; only key versions can be scheduled for destruction.
_TEARDOWN_PRIORITY = {
    "scheduler_job": 10,
    "pubsub_subscription": 20,
    "pubsub_topic": 30,
    "secret": 40,
    "gcs_object": 50,
    "gcs_bucket": 60,
    "iam_binding": 70,
    "service_account": 80,
    "kms_key": 100,
    "kms_keyring": 110,
}


def plan_teardown(resources: Any) -> list[dict[str, Any]]:
    """Order a plan's resources into a dependency-safe teardown sequence. Pure.

    Each input is a ``{"type": ..., "id": ...}`` from the substrate plan. Unknown
    types sort last (before nothing depends on them being handled specially), so a
    new resource kind is never silently dropped from a teardown."""
    actions: list[dict[str, Any]] = []
    for r in resources or []:
        if not isinstance(r, dict):
            continue
        rtype = str(r.get("type") or "").strip()
        rid = str(r.get("id") or "").strip()
        if not rid:
            continue
        actions.append(
            {
                "type": rtype or "unknown",
                "id": rid,
                "op": "destroy_versions" if rtype == "kms_key" else "delete",
            }
        )
    actions.sort(key=lambda a: _TEARDOWN_PRIORITY.get(a["type"], 90))
    return actions


async def execute_teardown(
    actions: Any,
    *,
    deleter: Any,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Run a teardown plan. Destroys NOTHING unless BOTH guards open:
    ``dry_run=False`` AND ``personal_agent_substrate_teardown_enabled()``. Otherwise
    it returns the plan it WOULD run and calls ``deleter`` for nothing.

    ``deleter`` is the injected async callable ``(action) -> None`` that performs the
    real GCP delete -- injected so the destructive dependency is explicit at the call
    site and this stays testable without touching a customer's project."""
    from hushh_mcp.runtime_settings import (  # noqa: PLC0415
        personal_agent_substrate_teardown_enabled,
    )

    plan = list(actions or [])
    live = (not dry_run) and personal_agent_substrate_teardown_enabled()
    if not live:
        return {"executed": False, "reason": "guarded", "planned": plan, "deleted": []}
    deleted: list[dict[str, Any]] = []
    for action in plan:
        await deleter(action)
        deleted.append(action)
    return {"executed": True, "planned": plan, "deleted": deleted}


__all__ = ["plan_teardown", "execute_teardown"]
