"""Native Memory inventory; unsupported capability domains are separate evidence."""

from __future__ import annotations

import re

from hushh_mcp.services import hosted_engine_location_contract as location_contract
from hushh_mcp.services.hosted_native_inventory import (
    NativeInventoryReadError,
    NativeProjectInventory,
)
from hushh_mcp.services.provision_attempt import ProvisionReconciliationRequired


def observe_memory_absence(
    reader: NativeProjectInventory,
    *,
    assigned_region: str,
    creation: dict,
    retained_locations: tuple[str, ...] = (),
    managed_context: dict | None = None,
) -> dict:
    """Fence writers separately; this proves reads, not permission to erase."""
    project_identity = reader.project_identity(creation)
    native = reader.locations("aiplatform")
    locations = sorted(set(native) | {"global", assigned_region} | set(retained_locations))
    if any(not re.fullmatch(r"[a-z][a-z0-9-]{0,62}", location) for location in locations):
        raise ProvisionReconciliationRequired("Native memory location is invalid")
    # Probe ca first; a real successful endpoint always takes precedence over N/A.
    ordered = (["ca"] if "ca" in locations else []) + [loc for loc in locations if loc != "ca"]
    coverage = [
        _location_observation(
            reader, location, project_identity, creation, managed_context, retained_locations
        )
        for location in ordered
    ]
    final_identity = reader.project_identity(creation)
    if any(
        final_identity.get(key) != project_identity.get(key)
        for key in ("projectId", "projectNumber", "createTime", "labels")
    ):
        raise ProvisionReconciliationRequired("Native memory project identity changed")
    return {
        "projectNumber": reader.number,
        "locations": locations,
        "engines": [],
        "complete": True,
        "status": "observed_absent",
        "coverage": coverage,
        "locationCatalogue": {
            "projectNumber": reader.number,
            "locations": native,
            "paginationComplete": True,
        },
    }


def _location_observation(
    reader: NativeProjectInventory,
    location: str,
    native_project: dict,
    creation: dict,
    context: dict | None,
    retained: tuple[str, ...],
) -> dict:
    host, url = _endpoint(reader.project, location)
    observed_at = location_contract.utc_now()
    extra = None
    if location == "ca":
        first = reader.response(url, {})
        if first.status_code == 404:
            extra = location_contract.ca_not_applicable(
                project=reader.project,
                number=reader.number,
                native=native_project,
                creation=creation,
                context=context,
                retained_locations=retained,
                endpoint=url,
                observed_at=observed_at,
            )
        elif first.status_code != 200:
            raise NativeInventoryReadError(first.status_code, host, location)
        else:
            body = reader.body(first)
            if body.get("error") or not isinstance(body.get("reasoningEngines", []), list):
                raise ProvisionReconciliationRequired("Native CA memory response is unverified")
            if body.get("reasoningEngines"):
                raise ProvisionReconciliationRequired("Native memory resources remain")
    if extra is None:
        # Once any native200 establishes a real collection, a later-page404
        # is an incomplete inventory, never an applicability classification.
        engines = reader.pages(url, "reasoningEngines")
        if engines:
            raise ProvisionReconciliationRequired("Native memory resources remain")
        status, pages = "listed_empty", reader.coverage[-1]["pages"]
        extra = {}
    else:
        status, pages = "not_applicable", 0
    return {
        "location": location,
        "projectNumber": reader.number,
        "status": status,
        "apiVersion": "v1beta1",
        "pages": pages,
        "observedAt": observed_at.isoformat(),
        **extra,
    }


def _endpoint(project: str, location: str) -> tuple[str, str]:
    host = (
        "aiplatform.googleapis.com"
        if location == "global"
        else f"aiplatform.{location}.rep.googleapis.com"
        if location in {"us", "eu"}
        else f"{location}-aiplatform.googleapis.com"
    )
    return host, f"https://{host}/v1beta1/projects/{project}/locations/{location}/reasoningEngines"
