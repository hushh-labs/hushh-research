"""Exact Azure cleanup inventory from the existing authored setup plan.

This module confers no deletion authority. The owner approves the immutable
inventory through the account-deletion operation; fresh delegated authority and
provider identity readback are required by the executor before any deletion.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from hushh_mcp.services.azure_agent_setup import binding_is_valid
from hushh_mcp.services.azure_container_app_renderer import INCARNATION_TAG
from hushh_mcp.services.azure_setup_applier import resolve
from hushh_mcp.services.azure_setup_plan import (
    API_VERSIONS,
    BINDING_TAG,
    HUSSH_PRINCIPAL,
    NONCE_TAG,
    POD_PRINCIPAL,
    PlanInputs,
    Scopes,
    build_setup_plan,
    resource_names,
    tags,
)


class AzureTeardownRefused(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TeardownResource:
    path: str
    api_version: str
    kind: str
    expected: dict[str, Any]
    covered_by: str | None = None


def inventory(
    inputs: PlanInputs, *, pod_principal: str, hub_principal: str, pod_incarnation: str | None
) -> tuple[TeardownResource, ...]:
    if not pod_principal or not hub_principal:
        raise AzureTeardownRefused("AZURE_CLEANUP_IDENTITY_UNAVAILABLE")
    plan = build_setup_plan(
        inputs, source_registry="unused.invalid", source_repository="unused", app_body={}
    )
    scopes = Scopes(inputs, resource_names(inputs))
    parents = (
        scopes.app,
        scopes.environment,
        scopes.openai,
        scopes.registry,
        scopes.storage,
        scopes.vault,
        scopes.identity,
        scopes.group,
    )
    values = {POD_PRINCIPAL[2:-1]: pod_principal, HUSSH_PRINCIPAL[2:-1]: hub_principal}
    resources = []
    seen: set[str] = set()
    for step in reversed(plan.steps):
        if step.kind == "action" or step.path.lower() in seen:
            continue
        seen.add(step.path.lower())
        parent = next((p for p in parents[:-1] if step.path.startswith(p + "/")), None)
        # Nested resource management deletes are not universally supported. Their
        # owning parent's qualified active absence covers them; RBAC has its own DELETE.
        covered = parent if step.kind == "resource" and parent else None
        expected = resolve(step.body, values) if step.kind != "resource" else tags(inputs)
        if step.path == scopes.app and pod_incarnation is not None:
            expected[INCARNATION_TAG] = pod_incarnation
        resources.append(
            TeardownResource(step.path, API_VERSIONS[step.api], step.kind, expected, covered)
        )
    return tuple(resources)


def qualified_identity(resource: TeardownResource, body: dict, inputs: PlanInputs) -> dict:
    if resource.kind != "resource":
        return _role_identity(resource, body)
    observed_id = body.get("id")
    if not isinstance(observed_id, str) or observed_id.lower() != resource.path.lower():
        raise AzureTeardownRefused("AZURE_RESOURCE_ID_CHANGED")
    properties = body.get("properties") or {}
    if not isinstance(properties, dict):
        raise AzureTeardownRefused("AZURE_RESOURCE_IDENTITY_UNAVAILABLE")
    if resource.kind == "resource":
        actual_tags = body.get("tags")
        if not isinstance(actual_tags, dict) or not binding_is_valid(actual_tags, inputs.hushh_id):
            raise AzureTeardownRefused("AZURE_RESOURCE_OWNER_UNVERIFIED")
        if any(actual_tags.get(key) != value for key, value in resource.expected.items()):
            raise AzureTeardownRefused("AZURE_RESOURCE_OWNER_CHANGED")
        identity = {
            "id": observed_id,
            "binding": actual_tags[BINDING_TAG],
            "nonce": actual_tags[NONCE_TAG],
        }
        if actual_tags.get(INCARNATION_TAG):
            identity["incarnation"] = actual_tags[INCARNATION_TAG]
        system = body.get("systemData") or {}
        if not isinstance(system, dict):
            raise AzureTeardownRefused("AZURE_RESOURCE_IDENTITY_UNAVAILABLE")
        created = system.get("createdAt") or properties.get("creationTime")
        if created is not None:
            identity["createdAt"] = str(created)
        # User-assigned identities have an immutable provider-issued principal.
        if properties.get("principalId"):
            identity["principalId"] = properties["principalId"]
        return identity
    raise AzureTeardownRefused("AZURE_RESOURCE_KIND_UNSUPPORTED")


def _role_identity(resource: TeardownResource, body: dict) -> dict:
    # Reuse the owning role/scope authority validator. Only the setup's exact
    # removal-role condition is additionally permitted here.
    from hushh_mcp.services.pod_files.azure_checkpoint import qualify_readback

    expected, observed = deepcopy(resource.expected), deepcopy(body)
    if resource.kind == "role_assignment":
        for key in ("condition", "conditionVersion"):
            wanted = expected["properties"].pop(key, None)
            actual = (observed.get("properties") or {}).pop(key, None)
            if (actual or None) != (wanted or None):
                raise AzureTeardownRefused("AZURE_RESOURCE_POLICY_CHANGED")
    try:
        return qualify_readback(
            {"path": resource.path, "kind": resource.kind, "body": expected}, observed
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise AzureTeardownRefused("AZURE_RESOURCE_POLICY_CHANGED") from exc
