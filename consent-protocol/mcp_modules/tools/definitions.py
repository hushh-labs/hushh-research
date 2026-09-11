"""Canonical Hussh Consent MCP v0.3 public tool contract."""

from __future__ import annotations

from mcp.types import Tool

from mcp_modules.canonical_contract import canonical_tool_name
from mcp_modules.public_contract import get_public_contract
from mcp_modules.tools.consumer_tools import (
    ConsumerCapabilitiesResult,
    ConsumerConnectionResult,
    ConsumerDisconnectResult,
    ConsumerMemoryResult,
    ConsumerReceiptsResult,
    ConsumerSetupStatusResult,
)


def _private_tool_definitions() -> list[Tool]:
    """Return existing entitlement-gated tools that are not in the public contract.

    These definitions preserve partner RIA and Kai voice entitlements. They are
    never returned for the default public developer group and are deliberately
    excluded from the authored Hussh Consent lifecycle contract.
    """

    def schema(properties: dict, required: list[str] | None = None) -> dict:
        return {
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": required or [],
        }

    empty = schema({})
    return [
        Tool(
            name="get_hussh_connection",
            description="Check your Hussh private-agent setup and get a secure memory-approval link. Requires owner OAuth. Does not read memory, approve permission or provision paid infrastructure.",
            inputSchema=empty,
            outputSchema=ConsumerConnectionResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="get_hussh_setup_status",
            description="Read the current resumable private-agent setup job. This is read-only and never provisions infrastructure.",
            inputSchema=empty,
            outputSchema=ConsumerSetupStatusResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_capabilities",
            description="List the authored Hussh consumer capabilities and their execution boundary. This is read-only and does not claim pod readiness.",
            inputSchema=empty,
            outputSchema=ConsumerCapabilitiesResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_hussh_receipts",
            description="List bounded owner-scoped consent receipts without exposing bearer tokens or private information.",
            inputSchema=empty,
            outputSchema=ConsumerReceiptsResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="disconnect_hussh_connection",
            description="Disconnect this assistant after explicit confirmation. This revokes its standing Hussh memory access while keeping your private agent and information intact.",
            inputSchema=schema(
                {
                    "confirm": {"type": "boolean", "const": True},
                    "generation": {"type": "integer", "minimum": 1},
                },
                ["confirm", "generation"],
            ),
            outputSchema=ConsumerDisconnectResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": True,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="read_hussh_memory",
            description="Read information from your owner pod after your standing Hussh memory approval. The pod is the execution target; unavailable pods fail closed.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "query": {"type": "string", "minLength": 1, "maxLength": 512},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                ["domain", "query"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="save_hussh_memory",
            description="Save an owner-approved personal memory through your owner pod. The canonical encrypted PKM commit must succeed; no plaintext fallback is used.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "content": {"type": "string", "minLength": 1, "maxLength": 4000},
                    "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 128},
                    "expected_revision": {"type": "integer", "minimum": 0},
                },
                ["domain", "content", "idempotency_key"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="correct_hussh_memory",
            description="Correct an existing owner-pod memory with compare-and-swap protection. Deletion and sharing changes require separate confirmation.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "memory_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "content": {"type": "string", "minLength": 1, "maxLength": 4000},
                    "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 128},
                    "expected_revision": {"type": "integer", "minimum": 0},
                },
                ["domain", "memory_id", "content", "idempotency_key"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="export_hussh_memory",
            description="Request an owner-pod export of personal memory metadata. Credentials, keys and recovery secrets are excluded.",
            inputSchema=schema(
                {
                    "domain": {"type": "string", "minLength": 1, "maxLength": 64},
                    "format": {"type": "string", "maxLength": 32},
                },
                ["domain"],
            ),
            outputSchema=ConsumerMemoryResult.model_json_schema(),
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        ),
        Tool(
            name="list_ria_profiles",
            description="List entitlement-gated RIA marketplace profiles.",
            inputSchema=schema(
                {
                    "query": {"type": "string", "maxLength": 200},
                    "firm": {"type": "string", "maxLength": 200},
                    "verification_status": {"type": "string", "maxLength": 64},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                }
            ),
        ),
        Tool(
            name="get_ria_profile",
            description="Get one entitlement-gated RIA marketplace profile.",
            inputSchema=schema(
                {"ria_id": {"type": "string", "minLength": 1, "maxLength": 128}},
                ["ria_id"],
            ),
        ),
        Tool(
            name="list_marketplace_investors",
            description="List entitlement-gated marketplace investor profiles.",
            inputSchema=schema(
                {
                    "query": {"type": "string", "maxLength": 200},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                }
            ),
        ),
        Tool(
            name="get_ria_verification_status",
            description="Read RIA verification status with VAULT_OWNER authority.",
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                },
                ["user_id", "consent_token"],
            ),
        ),
        Tool(
            name="get_ria_client_access_summary",
            description="Read an entitlement-gated RIA client access summary.",
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                },
                ["user_id", "consent_token"],
            ),
        ),
        Tool(
            name="kai_analyze_stock",
            description="Start an entitlement-gated Kai stock analysis action.",
            inputSchema=schema(
                {
                    "symbol": {"type": "string", "minLength": 1, "maxLength": 120},
                    "analysis_type": {
                        "type": "string",
                        "enum": ["fundamental", "sentiment", "valuation", "full"],
                    },
                },
                ["symbol"],
            ),
        ),
        Tool(name="kai_open_dashboard", description="Open Kai dashboard.", inputSchema=empty),
        Tool(name="kai_open_import", description="Open Kai import.", inputSchema=empty),
        Tool(
            name="kai_open_history",
            description="Open Kai analysis history.",
            inputSchema=schema(
                {
                    "tab": {
                        "type": "string",
                        "enum": ["history", "debate", "summary", "transcript"],
                    }
                }
            ),
        ),
        Tool(name="kai_open_consent", description="Open Kai consent.", inputSchema=empty),
        Tool(name="kai_open_profile", description="Open Kai profile.", inputSchema=empty),
        Tool(name="kai_open_home", description="Open Kai home.", inputSchema=empty),
        Tool(name="kai_navigate_back", description="Navigate back in Kai.", inputSchema=empty),
        Tool(
            name="kai_resume_active_analysis",
            description="Resume the active Kai analysis.",
            inputSchema=empty,
        ),
        Tool(
            name="kai_cancel_active_analysis",
            description="Cancel the active Kai analysis.",
            inputSchema=empty,
        ),
    ]


def get_tool_definitions(
    allowed_tool_names: set[str] | None = None,
    *,
    schema_profile: str = "standard",
) -> list[Tool]:
    """Return the default public contract or an explicitly entitled subset."""

    # Catalog presentation is no longer app-profile-dependent.  Entitlements
    # remain internal underscore identifiers while tools/list publishes the
    # one v0.4 hyphenated contract to every external host.
    tools: list[Tool] = []
    for definition in get_public_contract()["tools"]:
        internal_name = canonical_tool_name(str(definition["name"]))
        if allowed_tool_names is not None and internal_name not in allowed_tool_names:
            continue
        tools.append(Tool.model_validate(definition))
    if allowed_tool_names is None:
        return tools
    tools.extend(tool for tool in _private_tool_definitions() if tool.name in allowed_tool_names)
    return tools
