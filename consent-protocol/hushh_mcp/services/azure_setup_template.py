"""The setup plan rendered as an ARM template, for the person (and a reviewer) to read.

Transparency, not a second applier: the template lists every resource, custom role
and role assignment the setup will create, and the actions it will run (provider
registration, the image import), with the values only known at apply time as
template parameters. ``test_azure_setup_plan`` holds it to the applier's plan: the
same resources, the same roles, nothing more and nothing less.

The signing secret's value is never in the template; it is created in memory once.
"""

from __future__ import annotations

import re
from typing import Any

from hushh_mcp.services.azure_setup_plan import ArmStep, SetupPlan

_PLACEHOLDER = re.compile(r"\$\{([A-Za-z]+)\}")
_PARAMETERS: dict[str, str] = {
    "podPrincipalId": "The agent identity's principal id, created by this deployment.",
    "podClientId": "The agent identity's client id, created by this deployment.",
    "husshPrincipalId": "The Hussh app's service principal in your directory.",
    "keyUriWithVersion": "The agent key's versioned URI, created by this deployment.",
    "signingSecretValue": "Generated in memory once; never stored or shown.",
    "imageDigest": "The approved agent image digest.",
    "incarnation": "A per-setup id the agent is tagged with.",
}


def _expression(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _expression(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_expression(item) for item in value]
    if not isinstance(value, str) or "${" not in value:
        return value
    whole = _PLACEHOLDER.fullmatch(value)
    if whole:
        return f"[parameters('{whole.group(1)}')]"
    pieces: list[str] = []
    for index, part in enumerate(_PLACEHOLDER.split(value)):
        if index % 2:
            pieces.append(f"parameters('{part}')")
        elif part:
            escaped = part.replace("'", "''")
            pieces.append(f"'{escaped}'")
    return f"[concat({', '.join(pieces)})]"


def resource_type(path: str) -> str:
    """``Microsoft.X/a/b`` for an ARM id: the provider namespace and type segments."""
    if "/providers/" not in path:
        return "Microsoft.Resources/resourceGroups"
    tail = path.rsplit("/providers/", 1)[1].split("/")
    return "/".join([tail[0], *tail[1::2]])


def _resource(step: ArmStep, plan: SetupPlan) -> dict[str, Any]:
    body = _expression(step.body)
    return {
        "type": resource_type(step.path),
        "apiVersion": plan.api_version(step),
        "id": step.path,
        "stage": step.stage,
        **({"createOnly": True} if step.create_only else {}),
        **({"optional": True} if step.optional else {}),
        **body,
    }


def render_arm_template(plan: SetupPlan) -> dict[str, Any]:
    """Deterministic: the same plan always renders the same template."""
    resources = [_resource(s, plan) for s in plan.steps if s.kind != "action"]
    actions = [
        {
            "stage": s.stage,
            "method": s.method,
            "id": s.path,
            "apiVersion": plan.api_version(s),
            "body": _expression(s.body),
        }
        for s in plan.steps
        if s.kind == "action"
    ]
    used = sorted({name for s in plan.steps for name in _PLACEHOLDER.findall(repr(s.body)) if name})
    return {
        "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        "contentVersion": "1.0.0.0",
        "metadata": {
            "purpose": "Hussh private agent in your own subscription (transparency copy)",
            "resourceGroup": plan.names.resource_group,
            "actions": actions,
        },
        "parameters": {
            name: {"type": "string", "metadata": {"description": _PARAMETERS.get(name, name)}}
            for name in used
        },
        "resources": resources,
    }


__all__ = ["render_arm_template", "resource_type"]
