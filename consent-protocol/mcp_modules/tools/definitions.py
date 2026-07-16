"""Canonical Hussh Consent MCP v0.3 public tool contract."""

from __future__ import annotations

from mcp.types import Tool

from mcp_modules.public_contract import get_public_contract


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
        Tool(name="kai_open_optimize", description="Open Kai optimize.", inputSchema=empty),
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


def get_tool_definitions(allowed_tool_names: set[str] | None = None) -> list[Tool]:
    """Return the default public contract or an explicitly entitled subset."""

    tools: list[Tool] = []
    for definition in get_public_contract()["tools"]:
        name = str(definition["name"])
        if allowed_tool_names is not None and name not in allowed_tool_names:
            continue
        tools.append(Tool.model_validate(definition))
    if allowed_tool_names is None:
        return tools
    tools.extend(tool for tool in _private_tool_definitions() if tool.name in allowed_tool_names)
    return tools
