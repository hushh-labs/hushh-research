"""Fleet-first orphan reconciliation: the one check that catches a billing pod
with NO registry row.

Every existing reconciler is registry-FIRST -- it walks rows and asks about their
hosts, so it is blind to a live, billing Cloud Run service that has no row at all
(a pod that outlived its account delete, or whose row was lost). This is
fleet-first: it enumerates the live fleet and OUTER-JOINs the registry on the
deterministic service name, catching BOTH abandonment directions.

Report-only by construction. The classification is pure and consults no flag, so a
report run can never destroy anything. The destructive reclaim (deleting billing
compute in a possibly customer-owned project) is a SEPARATE call, gated on
``personal_agent_fleet_reclaim_enabled`` (default off) AND an explicit
``dry_run=False`` -- two independent guards, because this deletes someone's compute.
"""

from __future__ import annotations

from typing import Any

#: Registry statuses that SHOULD own a live host. A row in one of these with no
#: service in the fleet is a lying row (Direction A); a live service that no row in
#: one of these states claims is an orphan (Direction B).
ACTIVE_STATUSES = frozenset({"provisioning", "connecting", "provisioned"})


def _expected_service(hushh_id: str) -> str:
    # The deterministic name provisioning would give this HusshID -- the join key.
    # Imported lazily so this module stays light and pure to import.
    from hushh_mcp.services.gcp_backend import _service_name  # noqa: PLC0415

    return _service_name(hushh_id)


def classify_fleet_registry_mismatch(
    *, fleet_service_names: Any, registry_rows: Any
) -> dict[str, list[dict[str, Any]]]:
    """Given the live fleet's service names and the registry rows, return the two
    abandonment directions. Pure: no I/O, no flags, no side effects.

    Direction A -- a row that CLAIMS a host the fleet does not have: a lying row the
    retry sweep should re-drive, never silently trusted as provisioned.
    Direction B -- a live/billing service that NO active row maps to: the orphan
    only a fleet-first join can see. A candidate for reclaim.
    """
    fleet = {str(n).strip() for n in (fleet_service_names or []) if str(n).strip()}
    claimed: dict[str, dict[str, Any]] = {}
    direction_a: list[dict[str, Any]] = []
    for row in registry_rows or []:
        status = str((row or {}).get("status") or "").strip()
        hushh_id = str((row or {}).get("hushh_id") or "").strip()
        if not hushh_id or status not in ACTIVE_STATUSES:
            continue
        svc = _expected_service(hushh_id)
        claimed[svc] = row
        if svc not in fleet:
            direction_a.append(
                {
                    "reason": "row_active_no_service",
                    "service": svc,
                    "hushh_id": hushh_id,
                    "status": status,
                }
            )
    direction_b = [
        {"reason": "service_no_active_row", "service": svc}
        for svc in sorted(fleet)
        if svc not in claimed
    ]
    return {"direction_a": direction_a, "direction_b": direction_b}


async def reclaim_orphan(
    service_name: str,
    *,
    deleter: Any,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Reclaim ONE Direction-B orphan. Destroys nothing unless BOTH guards open:
    ``dry_run=False`` AND ``personal_agent_fleet_reclaim_enabled()``. Otherwise it
    reports the action it WOULD take and returns without calling ``deleter``.

    ``deleter`` is the async callable that actually deletes the Cloud Run service
    (injected so this is testable without a live backend, and so the destructive
    dependency is explicit at the call site)."""
    from hushh_mcp.runtime_settings import (  # noqa: PLC0415
        personal_agent_fleet_reclaim_enabled,
    )

    name = str(service_name or "").strip()
    if not name:
        return {"service": name, "action": "skipped", "reason": "no_service"}
    if dry_run or not personal_agent_fleet_reclaim_enabled():
        return {"service": name, "action": "would_reclaim", "deleted": False}
    await deleter(name)
    return {"service": name, "action": "reclaimed", "deleted": True}


__all__ = ["ACTIVE_STATUSES", "classify_fleet_registry_mismatch", "reclaim_orphan"]
