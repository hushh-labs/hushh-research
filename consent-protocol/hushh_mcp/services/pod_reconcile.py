"""Report live GCP hosts against current and retained ownership claims.

The scoped report uses recorded coordinates, preserves detached/standby/erasure
claims and holds orphan conclusions when evidence is incomplete. Name derivation
remains only for offline compatibility callers without cloud coordinates.

Classification is pure and never deletes. Separate reclaim requires both
``personal_agent_fleet_reclaim_enabled`` and explicit ``dry_run=False``.
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
        BACKEND_NULL,
        BACKEND_USER_AZURE,
    )
    from hushh_mcp.services.pod_fleet_claims import (  # noqa: PLC0415
        expand_retained_claims,
        resolve_gcp_claim,
        validate_fleet_scope,
    )

    def text(value: Any) -> str:
        return value.strip() if isinstance(value, str) else ""

    validate_fleet_scope(fleet_names, rows, project, region)
    fleet = {text(name) for name in fleet_names}
    claimed: dict[str, dict[str, Any]] = {}
    result: dict[str, list[dict[str, Any]]] = {
        "direction_a": [],
        "direction_b": [],
        "inactive_claims": [],
        "unresolved": [],
    }
    for row in expand_retained_claims(rows):
        source = row.get("claim_source")
        if source in ("invalid_retained", "migration_pending"):
            result["unresolved"].append({"reason": "unresolved_retained_claim", "source": source})
            continue
        backend, status = text(row.get("backend")), text(row.get("status"))
        metadata = row.get("backend_metadata")
        external = text(row.get("external_agent_id"))
        if (
            backend in ("", BACKEND_NULL)
            and not external
            and (
                not metadata
                or (isinstance(metadata, dict) and set(metadata) <= {"detachedPlacements"})
            )
            and status not in ACTIVE_STATUSES
        ):
            continue
        if backend == BACKEND_USER_AZURE:
            continue  # A known Azure host cannot claim a GCP service; retained claims were expanded.
        reason, claim = resolve_gcp_claim(row, project, region)
        if reason:
            result["unresolved"].append({"reason": reason})
            continue
        if claim is None:
            continue
        service, owner = claim["service"], claim["hushh_id"]
        if (
            service in claimed
            and source in ("detached", "erasure")
            and claimed[service]["hushh_id"] == owner
        ):
            continue  # The erasure snapshot may repeat its current, preserved host.
        if service in claimed:
            result["unresolved"].append({"reason": "duplicate_host_claim", "service": service})
            continue
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
