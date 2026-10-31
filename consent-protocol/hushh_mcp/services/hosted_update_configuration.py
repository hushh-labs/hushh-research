"""Preserve operating choices without accepting drift in managed custody."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.private_gcp_deployment import (
    HOSTING_ENV,
    PrivateGcpDeployment,
    _private_resource_environment,
)


def require_update_observation(existing: dict, spec: PodSpec, *, runtime: str) -> None:
    actual = existing.get("spec", {}).get("template", {}).get("spec", {}).get("serviceAccountName")
    if actual != runtime:
        raise ValueError("pod runtime identity changed; reconcile before updating")
    deployment = spec.private_gcp_deployment
    if deployment is None:
        return
    installed = getattr(spec.hosted_admission_guard, "installed_image", None)
    if not installed:
        raise ValueError("Managed installed image evidence unavailable")
    replace(deployment, image=installed).verify_observation(existing)
    _require_custody_configuration(existing, replace(deployment, image=installed))


def _require_custody_configuration(
    service: dict, deployment: PrivateGcpDeployment, *, frozen: bool = False
) -> None:
    entries = service["spec"]["template"]["spec"]["containers"][0]["env"]
    actual = {entry["name"]: entry for entry in entries}
    expected = _private_resource_environment(deployment, immutable=True, frozen=frozen)
    if len(actual) != len(entries) or any(
        actual.get(entry["name"]) != entry for entry in expected if entry["name"] != HOSTING_ENV
    ):
        raise ValueError("Managed custody or inference configuration changed")


def require_preserved_private_configuration(
    desired: dict[str, Any], *, frozen: bool = False
) -> None:
    entries = desired["spec"]["template"]["spec"]["containers"][0]["env"]
    markers = [entry.get("value") for entry in entries if entry["name"] == HOSTING_ENV]
    if not markers:
        return
    if len(markers) != 1:
        raise ValueError("Private deployment marker is ambiguous")
    deployment = PrivateGcpDeployment.decode(markers[0], frozen=frozen)
    if deployment.hosting_mode == "hussh_hosted":
        deployment.verify_observation(desired, require_uid=False, frozen=frozen)
        _require_custody_configuration(desired, deployment, frozen=frozen)
