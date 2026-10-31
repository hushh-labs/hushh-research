"""Expand recorded retained placements without deriving ownership from names."""

from __future__ import annotations

from typing import Any


def validate_fleet_scope(fleet_names: Any, rows: Any, project: Any, region: Any) -> None:
    """Missing inventory cannot establish absence of an ownership claim."""
    if any(not isinstance(value, str) or not value.strip() for value in (project, region)):
        raise ValueError("Fleet project and region are required")
    if not isinstance(fleet_names, list) or any(
        not isinstance(name, str) or not name.strip() for name in fleet_names
    ):
        raise ValueError("Fleet service inventory unavailable")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Fleet registry inventory unavailable")


def resolve_gcp_claim(
    row: dict[str, Any], project: str, region: str
) -> tuple[str, dict[str, str] | None]:
    """Validate recorded host coordinates; unrelated regions produce no claim."""
    from hushh_mcp.services.compute_backend import BACKEND_GCP, BACKEND_USER_GCP  # noqa: PLC0415

    def text(value: Any) -> str:
        return value.strip() if isinstance(value, str) else ""

    metadata = row.get("backend_metadata")
    if text(row.get("backend")) not in (BACKEND_GCP, BACKEND_USER_GCP):
        return "unresolved_backend", None
    if (
        not isinstance(metadata, dict)
        or not text(metadata.get("project"))
        or not text(metadata.get("region"))
    ):
        return "unresolved_coordinates", None
    if text(metadata["project"]) != project.strip() or text(metadata["region"]) != region.strip():
        return "", None
    if "service" in metadata and not text(metadata["service"]):
        return "invalid_host_claim", None
    external = text(row.get("external_agent_id"))
    service = text(metadata.get("service")) or external
    owner, status = text(row.get("hushh_id")), text(row.get("status"))
    if not service or not owner or not status or (external and external != service):
        return "invalid_host_claim", None
    return "", {"service": service, "hushh_id": owner, "status": status}


def expand_retained_claims(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Malformed, conflicting or over-deep evidence must hold orphan reporting."""
    expanded: list[dict[str, Any]] = []

    def emit(row: dict[str, Any], budget: list[int]) -> bool:
        if budget[0] <= 0:
            if budget[0] == 0:
                expanded.append({"claim_source": "invalid_retained"})
                budget[0] = -1
            return False
        budget[0] -= 1
        expanded.append(row)
        return True

    def visit(
        row: dict[str, Any], budget: list[int], owner: str | None = None, depth: int = 0
    ) -> bool:
        if depth > 4 or (owner is not None and row.get("hushh_id") != owner):
            return emit({"claim_source": "invalid_retained"}, budget)
        if not emit(row, budget):
            return False
        metadata = row.get("backend_metadata")
        if not isinstance(metadata, dict):
            if row.get("backend") not in (None, "", "null") or metadata:
                emit({"claim_source": "invalid_retained"}, budget)
            return True
        detached = metadata.get("detachedPlacements", [])
        if (
            not isinstance(detached, list)
            or len(detached) > 128
            or any(not isinstance(item, dict) for item in detached)
        ):
            emit({"claim_source": "invalid_retained"}, budget)
            return True
        for retained in detached:
            if not visit(
                {**retained, "status": "retained", "claim_source": "detached"},
                budget,
                row.get("hushh_id"),
                depth + 1,
            ):
                break
        erasure = metadata.get("erasure")
        if "erasure" in metadata and (
            not isinstance(erasure, dict) or "registrySnapshot" not in erasure
        ):
            emit({"claim_source": "invalid_retained"}, budget)
        elif isinstance(erasure, dict):
            snapshot = erasure["registrySnapshot"]
            if isinstance(snapshot, dict):
                visit(
                    {**snapshot, "status": "retained", "claim_source": "erasure"},
                    budget,
                    row.get("hushh_id"),
                    depth + 1,
                )
            else:
                emit({"claim_source": "invalid_retained"}, budget)
        return True

    for row in rows:
        visit(row, [256])
    return expanded


FLEET_CLAIMS_SQL = """
SELECT hushh_id, status, backend, external_agent_id, backend_metadata,
       'primary' AS claim_source, NULL AS source_service
FROM personal_agent_registry
UNION ALL
SELECT hushh_id, 'retained', backend, external_agent_id, backend_metadata,
       'standby', NULL
FROM personal_agent_standby_placements
UNION ALL
SELECT hushh_id, status, NULL, NULL, NULL, 'migration_pending', source_service
FROM pod_migration_jobs WHERE status IS DISTINCT FROM 'succeeded'
"""
