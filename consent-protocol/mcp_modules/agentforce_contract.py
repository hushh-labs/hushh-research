"""Agentforce lint and trusted-connector handoff for Hussh Consent MCP.

Agentforce receives the same five generated tools and schemas as every other
host. This module verifies the Salesforce-safe subset and publishes a
non-secret Salesforce trusted-connector handoff; it does not define a second
endpoint or catalog.

The direct Agentforce profile is catalog-only. The selected enterprise target
uses a partner-authorized MuleSoft runtime with its own operations-provisioned
``execute`` principal. An AgentExchange package may expose a Salesforce action
or user experience, but it is not the selected decryption boundary. Hussh keeps
person-specific authority in explicit consent, scoped grants, and encrypted
delivery. No client credential becomes a synthetic user identity.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from mcp_modules.canonical_contract import canonical_tool_name, get_published_tool_names
from mcp_modules.public_contract import get_public_contract

AGENTFORCE_PROFILE = "agentforce"
AGENTFORCE_MAX_TOOLS = 20
AGENTFORCE_MAX_PROPERTY_CHARS = 255
AGENTFORCE_MAX_REQUEST_SECONDS = 55.0
SALESFORCE_AGENTEXCHANGE_INTEGRATION_TARGET = "salesforce-agentexchange"
MULESOFT_AGENTFORCE_INTEGRATION_TARGET = "mulesoft-agentforce"

# Salesforce's current external-MCP documentation permits letters, numbers,
# dots, slashes, and hyphens. The canonical v0.4 names are hyphenated.
_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9./-]{1,128}$")
_CANONICAL_TOOL_NAMES = {
    published: canonical_tool_name(published) for published in get_published_tool_names()
}


def get_agentforce_tool_names() -> tuple[str, ...]:
    """Return the Agentforce-visible aliases in lifecycle order."""

    return get_published_tool_names()


def canonical_agentforce_tool_name(name: str) -> str | None:
    """Resolve one Agentforce alias to its canonical Hussh handler name."""

    return canonical_tool_name(name)


def get_salesforce_agentexchange_handoff() -> dict[str, Any]:
    """Return the non-secret optional Salesforce action-facade contract.

    This remains available for compatibility and target-org experiments. It is
    not the selected decryptor: Agentforce reads the authorized CRM record or a
    metadata-only result produced by the trusted MuleSoft connector.
    """

    tool_allowlist = list(get_agentforce_tool_names())
    connector_delivery_tool = "get-encrypted-scoped-export"
    return {
        "integrationTarget": SALESFORCE_AGENTEXCHANGE_INTEGRATION_TARGET,
        "supportStatus": "agentforce-catalog-compatible",
        "selectionStatus": "optional-action-facade",
        "upstream": {
            "transport": "streamable-http",
            "path": "/mcp/",
            "authentication": "bearer-or-oauth2-client-credentials",
            "requestTimeoutSeconds": AGENTFORCE_MAX_REQUEST_SECONDS,
        },
        "agentforce": {
            "catalog": "salesforce-api-catalog",
            "transport": "streamable-http",
            "authentication": "oauth2-client-credentials",
            "toolsOnly": True,
            "toolAllowlist": tool_allowlist,
            "agentActionPolicy": {
                "catalogOnly": True,
                "directPersonalizedToolCalls": "blocked",
                "directToolCallResult": "REQUIRES_SECURE_CONSENT_FLOW",
                "agentforceActionDefault": "no-personalized-consent-actions",
                "plannerExposure": "no-personalized-hussh-tools",
                "trustedConnectorTools": tool_allowlist,
                "connectorOnlyTool": connector_delivery_tool,
                "connectorOnlyReason": (
                    "The encrypted export is delivered to the registered connector and "
                    "must be decrypted outside the Agentforce LLM."
                ),
            },
        },
        "connectorRequirements": {
            "preserveToolNames": True,
            "preserveInputOutputSchemas": True,
            "allowResources": False,
            "allowPrompts": False,
            "expandNestedFields": False,
            "keyCustody": "per-org-connector-runtime",
            "privateKeyInAgentforceModel": False,
        },
        "executionBoundary": {
            "directAgentforceExecution": "catalog-only",
            "trustedConnectorExecution": "operations-provisioned-execute-principal",
            "agentforcePersonalizedExecution": "requires-salesforce-supported-host-boundary",
            "applicationAuthentication": "oauth2-client-credentials-per-hop",
            "userAuthority": "explicit-consent-and-scoped-grant",
            "informationDelivery": "encrypted-export-after-approval",
        },
    }


def get_mulesoft_agentforce_handoff() -> dict[str, Any]:
    """Return the selected, UAT-gated MuleSoft trusted-connector handoff.

    The five public tools and schemas remain identical. This metadata declares
    where connector validation, Java/JCA decryption, destination write/readback,
    and metadata-only Agentforce settlement occur.
    """

    handoff = get_salesforce_agentexchange_handoff()
    handoff["integrationTarget"] = MULESOFT_AGENTFORCE_INTEGRATION_TARGET
    handoff["implementation"] = "mulesoft-secure-relay"
    handoff["selectionStatus"] = "selected-target-uat-gated"
    handoff["connectorRequirements"]["keyCustody"] = "partner-controlled-mulesoft-runtime"
    handoff["executionBoundary"]["agentforceInformationSource"] = (
        "authorized-salesforce-record-or-metadata-status"
    )
    return handoff


def get_agentforce_contract() -> dict[str, Any]:
    """Return the exact canonical lifecycle after Agentforce subset linting."""

    return {
        "profile": AGENTFORCE_PROFILE,
        "tools": deepcopy(get_public_contract()["tools"]),
    }


def agentforce_contract_errors(contract: dict[str, Any] | None = None) -> list[str]:
    """Return deterministic violations of the documented Agentforce subset."""

    active_contract = contract or get_agentforce_contract()
    tools = active_contract.get("tools")
    if not isinstance(tools, list):
        return ["tools must be an array"]
    errors: list[str] = []
    if not 1 <= len(tools) <= AGENTFORCE_MAX_TOOLS:
        errors.append(f"tool count must be between 1 and {AGENTFORCE_MAX_TOOLS}")

    names: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict):
            errors.append("tool must be an object")
            continue
        name = str(tool.get("name") or "")
        if not _TOOL_NAME_PATTERN.fullmatch(name):
            errors.append(f"tool name is not Agentforce-compatible: {name!r}")
        if name in names:
            errors.append(f"duplicate tool name: {name}")
        names.add(name)
        for key in ("title", "description"):
            if not str(tool.get(key) or "").strip():
                errors.append(f"{name}: {key} is required")
        for schema_key in ("inputSchema", "outputSchema"):
            _schema_errors(name, schema_key, tool.get(schema_key), errors)
    return errors


def _schema_errors(
    tool_name: str,
    schema_name: str,
    schema: object,
    errors: list[str],
) -> None:
    if not isinstance(schema, dict) or schema.get("type") != "object":
        errors.append(f"{tool_name}: {schema_name} must be an object schema")
        return
    if schema.get("additionalProperties") is not False:
        errors.append(f"{tool_name}: {schema_name} must reject undeclared fields")
    properties = schema.get("properties")
    required = schema.get("required")
    if not isinstance(properties, dict) or not isinstance(required, list):
        errors.append(f"{tool_name}: {schema_name} needs properties and required")
        return
    for field_name in required:
        if field_name not in properties:
            errors.append(f"{tool_name}: {schema_name} requires an undeclared field")
    for field_name, field in properties.items():
        if not isinstance(field_name, str) or len(field_name) > AGENTFORCE_MAX_PROPERTY_CHARS:
            errors.append(f"{tool_name}: {schema_name} has an oversized field name")
        if not isinstance(field, dict):
            errors.append(f"{tool_name}: {schema_name}.{field_name} must be an object")
            continue
        for metadata_key in ("title", "description"):
            value = str(field.get(metadata_key) or "")
            if not value.strip() or len(value) > AGENTFORCE_MAX_PROPERTY_CHARS:
                errors.append(
                    f"{tool_name}: {schema_name}.{field_name} needs a bounded {metadata_key}"
                )
        field_type = field.get("type")
        if field_type in {"string", "number", "integer", "boolean"}:
            continue
        if field_type == "array":
            items = field.get("items")
            if not isinstance(items, dict) or items.get("type") != "string":
                errors.append(
                    f"{tool_name}: {schema_name}.{field_name} must be an array of strings"
                )
            continue
        errors.append(f"{tool_name}: {schema_name}.{field_name} is not a supported primitive")
