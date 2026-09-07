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
ACTIVE_STATUSES = frozenset({"provisioning", "connecting", "provisioned", "migrating"})


def _expected_service(hushh_id: str) -> str:
    # The deterministic name provisioning would give this HusshID -- the join key.
    # Imported lazily so this module stays light and pure to import.
    from hushh_mcp.services.gcp_backend import _service_name  # noqa: PLC0415

    return _service_name(hushh_id)


def classify_fleet_registry_mismatch(
    *,
    fleet_service_names: Any,
    registry_rows: Any,
    project: str | None = None,
    region: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Given the live fleet's service names and the registry rows, return the two
    abandonment directions. Pure: no I/O, no flags, no side effects.

    Direction A -- a row that CLAIMS a host the fleet does not have: a lying row the
    retry sweep should re-drive, never silently trusted as provisioned.
    Direction B -- a live/billing service that NO active row maps to: the orphan
    only a fleet-first join can see. A candidate for reclaim.
    """
    if project is not None or region is not None:
        return _classify_scoped_inventory(fleet_service_names, registry_rows, project, region)
    # Compatibility for offline callers without deployment coordinates. The live
    # report always supplies scope and uses recorded service identities below.
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


def _classify_scoped_inventory(
    fleet_names: Any,
    rows: Any,
    project: str | None,
    region: str | None,
) -> dict[str, list[dict[str, Any]]]:
    """Report candidates only; unresolved claims suppress orphan conclusions."""
    from hushh_mcp.services.compute_backend import (  # noqa: PLC0415
        BACKEND_ANYPOINT,
        BACKEND_GCP,
        BACKEND_NULL,
        BACKEND_USER_GCP,
    )

    def text(value: Any) -> str:
        return value.strip() if isinstance(value, str) else ""

    if not text(project) or not text(region):
        raise ValueError("Fleet project and region are required")
    if not isinstance(fleet_names, list) or any(not text(name) for name in fleet_names):
        raise ValueError("Fleet service inventory unavailable")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Fleet registry inventory unavailable")
    fleet = {text(name) for name in fleet_names}
    claimed: dict[str, dict[str, Any]] = {}
    result: dict[str, list[dict[str, Any]]] = {
        "direction_a": [],
        "direction_b": [],
        "inactive_claims": [],
        "unresolved": [],
    }
    for row in rows:
        backend, status = text(row.get("backend")), text(row.get("status"))
        metadata = row.get("backend_metadata")
        external = text(row.get("external_agent_id"))
        if backend == BACKEND_ANYPOINT:
            continue
        if (
            backend in ("", BACKEND_NULL)
            and not external
            and not metadata
            and status not in ACTIVE_STATUSES
        ):
            continue
        reason = ""
        if backend not in (BACKEND_GCP, BACKEND_USER_GCP):
            reason = "unresolved_backend"
        elif (
            not isinstance(metadata, dict)
            or not text(metadata.get("project"))
            or not text(metadata.get("region"))
        ):
            reason = "unresolved_coordinates"
        elif text(metadata["project"]) != text(project) or text(metadata["region"]) != text(region):
            continue
        if reason:
            result["unresolved"].append({"reason": reason})
            continue
        if "service" in metadata and not text(metadata["service"]):
            result["unresolved"].append({"reason": "invalid_host_claim"})
            continue
        service = text(metadata.get("service")) or external
        owner = text(row.get("hushh_id"))
        if not service or not owner or not status or (external and external != service):
            result["unresolved"].append({"reason": "invalid_host_claim"})
            continue
        if service in claimed:
            result["unresolved"].append({"reason": "duplicate_host_claim", "service": service})
            continue
        claim = {"service": service, "hushh_id": owner, "status": status}
        claimed[service] = claim
        if service not in fleet and status in ACTIVE_STATUSES:
            result["direction_a"].append({"reason": "row_active_no_service", **claim})
        elif service in fleet and status not in ACTIVE_STATUSES:
            result["inactive_claims"].append({"reason": "inactive_row_has_service", **claim})
    if not result["unresolved"]:
        result["direction_b"] = [
            {"reason": "service_no_registry_claim", "service": name}
            for name in sorted(fleet - claimed.keys())
        ]
    return result


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


def suggest_adoptions(
    *, direction_b: list[dict[str, Any]], user_by_service: dict[str, str]
) -> list[dict[str, Any]]:
    """Turn Direction-B orphans (live services no active row claims) into ADOPTION
    candidates by naming the user each belongs to. Pure: no I/O, no flags.

    ``user_by_service`` is the reverse index the caller builds from
    ``byoc_setup_jobs.project_id`` (which user set up which project) crossed with the
    deterministic service name. A service with no known owner is ``unowned`` -- reported,
    never adopted, because adopting requires knowing whose identity and memory it holds.

    This is the safe, non-destructive twin of the reclaim suggestion: the worst it can do
    is propose reconnecting a user to a pod that is already theirs.
    """
    out: list[dict[str, Any]] = []
    for d in direction_b or []:
        svc = str((d or {}).get("service") or "").strip()
        if not svc:
            continue
        uid = user_by_service.get(svc)
        out.append({"service": svc, "user_id": uid, "action": "adoptable" if uid else "unowned"})
    return out


async def adopt_orphan(service_name: str, *, adopter: Any) -> dict[str, Any]:
    """Reconnect ONE orphan to its owner. The non-destructive twin of ``reclaim_orphan``:
    it needs NO flag and NO dry_run, because reconnecting can only ever RESTORE a row to a
    pod that already exists -- it never deletes, and never mints a new identity.

    ``adopter`` is the injected async callable ``(service_name) -> dict|None`` that does
    the real adoption (in practice ``PersonalAgentProvisioningService.adopt_orphan`` bound
    to the owning user). ``None`` means nothing adoptable was found -- reported as
    ``unresolved``, not an error."""
    name = str(service_name or "").strip()
    if not name:
        return {"service": name, "action": "skipped", "reason": "no_service"}
    result = await adopter(name)
    if result is None:
        return {"service": name, "action": "unresolved", "adopted": False}
    return {"service": name, "action": "adopted", "adopted": True, **result}


__all__ = [
    "ACTIVE_STATUSES",
    "adopt_orphan",
    "classify_fleet_registry_mismatch",
    "reclaim_orphan",
    "suggest_adoptions",
]
