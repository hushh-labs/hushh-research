"""Read-only qualification before the owner chooses exact cloud deletion terms."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.azure_agent_setup import binding_is_valid
from hushh_mcp.services.azure_arm_client import API_VERSIONS, ArmClient
from hushh_mcp.services.azure_resource_teardown import _exclusive_group, _model_deployments
from hushh_mcp.services.azure_setup_plan import NONCE_TAG, PlanInputs, Scopes, resource_names
from hushh_mcp.services.azure_teardown_inventory import (
    AzureTeardownRefused,
    TeardownResource,
    inventory,
    qualified_identity,
)

_MISSING_PRINCIPAL = "00000000-0000-0000-0000-000000000000"


def _inputs(context: dict, metadata: dict, arm: ArmClient) -> PlanInputs:
    nonce = context.get("setupNonce") or metadata.get("setupNonce")
    group = f"/subscriptions/{context['subscriptionId']}/resourceGroups/{context['resourceGroup']}"
    observed = arm.get_or_none(group, api_version=API_VERSIONS["resources"], op="cleanup_preview")
    if observed is not None:
        if not binding_is_valid(observed.get("tags"), context["hushhId"]):
            raise AzureTeardownRefused("AZURE_RESOURCE_OWNER_UNVERIFIED")
        actual = observed["tags"][NONCE_TAG]
        if nonce is not None and nonce != actual:
            raise AzureTeardownRefused("AZURE_RESOURCE_OWNER_CHANGED")
        nonce = actual
    if (
        not isinstance(nonce, str)
        or len(nonce) != 16
        or any(c not in "0123456789abcdef" for c in nonce)
    ):
        raise AzureTeardownRefused("AZURE_CLEANUP_BINDING_UNAVAILABLE")
    return PlanInputs(
        context["hushhId"],
        context["tenantId"],
        context["subscriptionId"],
        context["location"],
        context["resourceGroup"],
        nonce,
        files_enabled=True,
    )


def _principal(arm: ArmClient, inputs: PlanInputs, metadata: dict, hub: str) -> str:
    scopes = Scopes(inputs, resource_names(inputs))
    identity = arm.get_or_none(
        scopes.identity, api_version=API_VERSIONS["managed_identity"], op="cleanup_preview"
    )
    recorded = metadata.get("runtime_principal_id")
    if identity is not None:
        qualified_identity(
            TeardownResource(
                scopes.identity,
                API_VERSIONS["managed_identity"],
                "resource",
                {NONCE_TAG: inputs.nonce},
            ),
            identity,
            inputs,
        )
        actual = (identity.get("properties") or {}).get("principalId")
        if not isinstance(actual, str) or not actual or (recorded and recorded != actual):
            raise AzureTeardownRefused("AZURE_RESOURCE_OWNER_CHANGED")
        return actual
    if recorded:
        return str(recorded)
    # Setup may have lost its identity before it could finish recording. Assignment
    # names are canonical even before principal substitution; read only those IDs.
    probe = inventory(
        inputs, pod_principal=_MISSING_PRINCIPAL, hub_principal=hub, pod_incarnation=None
    )
    for resource in probe:
        expected = resource.expected.get("properties", {})
        if resource.kind != "role_assignment" or expected.get("principalId") != _MISSING_PRINCIPAL:
            continue
        body = arm.get_or_none(
            resource.path, api_version=resource.api_version, op="cleanup_preview"
        )
        if body is not None:
            actual = (body.get("properties") or {}).get("principalId")
            if not isinstance(actual, str) or not actual:
                raise AzureTeardownRefused("AZURE_RESOURCE_IDENTITY_UNAVAILABLE")
            return actual
    return _MISSING_PRINCIPAL  # accepted only while every such assignment is absent


def inspect_plan(arm: ArmClient, *, context: dict, reservation: dict, hub_principal: str) -> dict:
    """No writes. Unknown resources and changed owner/incarnation refuse the preview."""
    snapshot = reservation.get("registrySnapshot") or {}
    if context.get("ownerId") != reservation.get("ownerId") or context.get(
        "attemptId"
    ) != reservation.get("attemptId"):
        raise AzureTeardownRefused("AZURE_CLEANUP_RESERVATION_CHANGED")
    metadata = snapshot.get("backend_metadata") or {}
    inputs = _inputs(context, metadata, arm)
    _require_undeployed_app_absent(arm, context, inputs)
    resources = inventory(
        inputs,
        pod_principal=_principal(arm, inputs, metadata, hub_principal),
        hub_principal=hub_principal,
        pod_incarnation=metadata.get("serviceUid"),
    )
    _exclusive_group(arm, inputs, resources)
    _model_deployments(arm, inputs)
    values: dict[str, Any] = {}
    for resource in resources:
        body = (
            None
            if resource.covered_by
            else arm.get_or_none(
                resource.path, api_version=resource.api_version, op="cleanup_preview"
            )
        )
        values[resource.path] = {
            "apiVersion": resource.api_version,
            "kind": resource.kind,
            "expected": resource.expected,
            "coveredBy": resource.covered_by,
            "identity": None if body is None else qualified_identity(resource, body, inputs),
            "deletionScope": (
                "whole_group"
                if resource.path == Scopes(inputs, resource_names(inputs)).group
                else "all_contents"
                if resource.kind == "resource"
                else "resource_only"
            ),
        }
    return {
        "version": 1,
        "context": context,
        "resources": values,
        "termsVersion": "azure-exact-parent-retention-v2",
    }


def execution_inventory(
    plan: dict, *, pod_principal: str, hub_principal: str, pod_incarnation: str | None
) -> tuple[PlanInputs, tuple[TeardownResource, ...], dict]:
    """Rehydrate only a SQL-qualified retained plan, never browser-submitted resource IDs."""
    context, values = plan["context"], plan["resources"]
    nonce = next(
        (
            value["identity"].get("nonce")
            for value in values.values()
            if isinstance(value.get("identity"), dict) and value["identity"].get("nonce")
        ),
        context.get("setupNonce"),
    )
    if not isinstance(nonce, str) or len(nonce) != 16:
        raise AzureTeardownRefused("AZURE_CLEANUP_BINDING_UNAVAILABLE")
    inputs = PlanInputs(
        context["hushhId"],
        context["tenantId"],
        context["subscriptionId"],
        context["location"],
        context["resourceGroup"],
        nonce,
        files_enabled=True,
    )
    canonical = inventory(
        inputs,
        pod_principal=pod_principal,
        hub_principal=hub_principal,
        pod_incarnation=pod_incarnation,
    )
    if {resource.path for resource in canonical} != set(values):
        raise AzureTeardownRefused("AZURE_CLEANUP_INVENTORY_CHANGED")
    for resource in canonical:
        selected = values[resource.path]
        expected_scope = (
            "whole_group"
            if resource.path == Scopes(inputs, resource_names(inputs)).group
            else "all_contents"
            if resource.kind == "resource"
            else "resource_only"
        )
        if (
            selected.get("apiVersion") != resource.api_version
            or selected.get("kind") != resource.kind
            or selected.get("expected") != resource.expected
            or selected.get("coveredBy") != resource.covered_by
            or selected.get("deletionScope") != expected_scope
        ):
            raise AzureTeardownRefused("AZURE_CLEANUP_INVENTORY_CHANGED")
    frozen = {path: value["identity"] for path, value in values.items() if not value["coveredBy"]}
    return inputs, canonical, frozen


def bound_execution_inventory(
    arm: ArmClient, *, plan: dict, reservation: dict, hub_principal: str
) -> tuple[PlanInputs, tuple[TeardownResource, ...], dict]:
    """Resolve principals from verified provider identity and the immutable owner snapshot."""
    context = plan["context"]
    if context.get("ownerId") != reservation.get("ownerId") or context.get(
        "attemptId"
    ) != reservation.get("attemptId"):
        raise AzureTeardownRefused("AZURE_CLEANUP_RESERVATION_CHANGED")
    metadata = (reservation.get("registrySnapshot") or {}).get("backend_metadata") or {}
    inputs = _inputs(context, metadata, arm)
    _require_undeployed_app_absent(arm, context, inputs)
    return execution_inventory(
        plan,
        pod_principal=_principal(arm, inputs, metadata, hub_principal),
        hub_principal=hub_principal,
        pod_incarnation=metadata.get("serviceUid"),
    )


def _require_undeployed_app_absent(arm: ArmClient, context: dict, inputs: PlanInputs) -> None:
    if (
        context.get("neverDeployed") is True
        and arm.get_or_none(
            Scopes(inputs, resource_names(inputs)).app,
            api_version=API_VERSIONS["container_apps"],
            op="cleanup_preview",
        )
        is not None
    ):
        raise AzureTeardownRefused("AZURE_CLEANUP_UNRECORDED_AGENT")
