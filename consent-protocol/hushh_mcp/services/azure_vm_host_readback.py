"""Refuse unknown/replaced VM host resources before installation or publication."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_setup_plan import ArmStep
from hushh_mcp.services.azure_vm_host_plan import VmHostPlan


class VmHostReadbackRefused(RuntimeError):
    pass


def _contains(actual: Any, expected: Any) -> bool:
    """ARM adds read-only fields and reorders named lists, never admitted policy."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and _contains(actual[key], value) for key, value in expected.items()
        )
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return False
        if all(
            isinstance(value, dict) and isinstance(value.get("name"), str) for value in expected
        ):
            names = [value["name"] for value in expected]
            observed = {value.get("name"): value for value in actual if isinstance(value, dict)}
            return len(observed) == len(names) and all(
                name in observed and _contains(observed[name], value)
                for name, value in zip(names, expected, strict=True)
            )
        return all(_contains(left, right) for left, right in zip(actual, expected, strict=True))
    return type(actual) is type(expected) and actual == expected


def require_host_resource(step: ArmStep, observed: dict) -> None:
    if (
        not isinstance(observed.get("id"), str)
        or observed["id"].casefold() != step.path.casefold()
        or (observed.get("properties") or {}).get("provisioningState") != "Succeeded"
        or not _contains(observed, step.body)
    ):
        raise VmHostReadbackRefused("VM_HOST_RESOURCE_CHANGED")
    if step.api == "virtual_machines":
        identities = (observed.get("identity") or {}).get("userAssignedIdentities") or {}
        expected = step.body["identity"]["userAssignedIdentities"]
        # No extra attached identities. Reading a template subset is insufficient
        # when another credential source could be selected by the host or pod.
        if set(identities) != set(expected) or any(
            not identity.get("clientId") or not identity.get("principalId")
            for identity in identities.values()
        ):
            raise VmHostReadbackRefused("VM_HOST_IDENTITY_CHANGED")


def verify_host_resources(plan: VmHostPlan, arm: ArmClient) -> None:
    """Read only; generic create-only replay is never the ownership proof."""
    for step in plan.steps:
        require_host_resource(step, arm.get(step.path, api_version=API_VERSIONS[step.api]))
