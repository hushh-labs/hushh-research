"""Who may do what in the person's subscription, as data (byoc-azure.md trust matrix).

The agent's identity gets five built-in, least-privilege roles at the narrowest scope
each needs. Hussh's app gets two CUSTOM roles and nothing else:

* "Hussh Pod Observer": read the agent and its environment, read revisions, restart;
* "Hussh Access Removal": ``roleAssignments/delete`` only, assigned under an ABAC
  condition that matches just Hussh's own principal and the agent's, so Hussh can
  remove the agent's access and then its own, last, and nobody else's.

Every role and assignment name is a deterministic GUID, so a re-run is idempotent and
erasure can address each grant without holding list authority.
"""

from __future__ import annotations

import uuid
from typing import Any, Iterable, Protocol

#: Built-in role definition ids (stable across every Azure tenant).
ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER = "e147488a-f6f5-4113-8e2d-b22465e65bf6"
ROLE_KEY_VAULT_SECRETS_USER = "4633458b-17de-408a-b874-0445c86b69e6"
ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"
ROLE_ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
ROLE_COGNITIVE_SERVICES_OPENAI_USER = "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd"

OBSERVER_ACTIONS: tuple[str, ...] = (
    "Microsoft.App/containerApps/read",
    "Microsoft.App/containerApps/revisions/read",
    "Microsoft.App/containerApps/revisions/restart/action",
    "Microsoft.App/managedEnvironments/read",
)
REMOVAL_ACTIONS: tuple[str, ...] = ("Microsoft.Authorization/roleAssignments/delete",)

#: Principals only known at apply time; the applier substitutes them.
POD_PRINCIPAL = "${podPrincipalId}"
HUSSH_PRINCIPAL = "${husshPrincipalId}"

_NAMESPACE = uuid.UUID("6f0f3b7e-4d55-4b9f-9a35-0c3a9e1a7c21")


class _Placement(Protocol):
    @property
    def subscription_id(self) -> str: ...

    @property
    def resource_group(self) -> str: ...


def deterministic_guid(*parts: str) -> str:
    return str(uuid.uuid5(_NAMESPACE, "|".join(parts)))


def observer_role_id(placement: _Placement) -> str:
    return deterministic_guid("observer", placement.subscription_id, placement.resource_group)


def removal_role_id(placement: _Placement) -> str:
    return deterministic_guid("removal", placement.subscription_id, placement.resource_group)


def removal_condition() -> str:
    """ABAC: the delete may only remove assignments held by Hussh or by the agent."""
    return (
        "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR "
        "(@Resource[Microsoft.Authorization/roleAssignments:PrincipalId] "
        f"ForAnyOfAnyValues:GuidEquals {{{HUSSH_PRINCIPAL}, {POD_PRINCIPAL}}}))"
    )


def role_assignment_path(scope: str, role_id: str, principal: str) -> str:
    """Deterministic assignment name, so erasure can address it without listing."""
    name = deterministic_guid("assignment", scope, role_id, principal)
    return f"{scope}/providers/Microsoft.Authorization/roleAssignments/{name}"


def role_assignment_body(role_definition_id: str, principal: str, *, condition: str = "") -> dict:
    properties: dict[str, Any] = {
        "roleDefinitionId": role_definition_id,
        "principalId": principal,
        "principalType": "ServicePrincipal",
    }
    if condition:
        properties.update({"condition": condition, "conditionVersion": "2.0"})
    return {"properties": properties}


def role_definition_body(
    label: str, resource_group: str, group_scope: str, actions: Iterable[str]
) -> dict:
    """A custom role assignable only inside the person's agent resource group."""
    return {
        "properties": {
            "roleName": f"{label} ({resource_group})",
            "description": f"{label}: granted by the person during Connect Azure.",
            "type": "CustomRole",
            "permissions": [{"actions": list(actions), "notActions": []}],
            "assignableScopes": [group_scope],
        }
    }


__all__ = [
    "HUSSH_PRINCIPAL",
    "OBSERVER_ACTIONS",
    "POD_PRINCIPAL",
    "REMOVAL_ACTIONS",
    "ROLE_ACR_PULL",
    "ROLE_COGNITIVE_SERVICES_OPENAI_USER",
    "ROLE_KEY_VAULT_CRYPTO_SERVICE_ENCRYPTION_USER",
    "ROLE_KEY_VAULT_SECRETS_USER",
    "ROLE_STORAGE_BLOB_DATA_CONTRIBUTOR",
    "deterministic_guid",
    "observer_role_id",
    "removal_condition",
    "removal_role_id",
    "role_assignment_body",
    "role_assignment_path",
    "role_definition_body",
]
