"""Canonical Hussh Consent MCP v0.3 public tool contract."""

from __future__ import annotations

from mcp.types import Tool

from mcp_modules.canonical_contract import canonical_tool_name
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
        # ── Location voice + narrow read tools ─────────────────────────
        Tool(name="location_open_now", description="Open the Location Now tab.", inputSchema=empty),
        Tool(
            name="location_open_people",
            description="Open the Location People tab.",
            inputSchema=empty,
        ),
        Tool(
            name="location_open_links",
            description="Open the Location Links tab.",
            inputSchema=empty,
        ),
        Tool(
            name="location_open_share",
            description="Open the Location share composer.",
            inputSchema=empty,
        ),
        Tool(
            name="location_open_ask",
            description="Open the Location request composer.",
            inputSchema=empty,
        ),
        Tool(
            name="location_open_map",
            description="Open the full-screen Location map.",
            inputSchema=empty,
        ),
        Tool(
            name="location_open_settings",
            description="Open Location privacy settings.",
            inputSchema=empty,
        ),
        Tool(
            name="location_open_sos",
            description="Open the emergency SOS screen.",
            inputSchema=empty,
        ),
        Tool(
            name="location_get_state",
            description=(
                "Read the caller's own aggregate Location sharing status: active/pending "
                "grant counts, circle count, verified-recipient count. Never returns "
                "coordinates, other-person contact details, or key material."
            ),
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                },
                ["user_id", "consent_token"],
            ),
        ),
        Tool(
            name="location_list_circles",
            description="List the caller's own named Location circles (name, kind, role, member count).",
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                },
                ["user_id", "consent_token"],
            ),
        ),
        # ── Gmail / Calendar read tools ─────────────────────────────────
        Tool(
            name="list_gmail_receipts",
            description=(
                "List the caller's own pre-synced Gmail purchase-receipt records. Reads a "
                "structured Postgres table; never fetches raw email bodies."
            ),
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                    "page": {"type": "integer", "minimum": 1, "maximum": 1000},
                    "per_page": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                ["user_id", "consent_token"],
            ),
        ),
        Tool(
            name="list_upcoming_calendar_events",
            description=(
                "List the caller's own upcoming Google Calendar events, redacted to "
                "title/start/end/status only (no description, location, or attendee emails)."
            ),
            inputSchema=schema(
                {
                    "user_id": {"type": "string", "minLength": 1, "maxLength": 128},
                    "consent_token": {"type": "string", "minLength": 16, "maxLength": 2048},
                    "start_at": {"type": "string", "minLength": 1, "maxLength": 64},
                    "end_at": {"type": "string", "minLength": 1, "maxLength": 64},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                ["user_id", "consent_token", "start_at", "end_at"],
            ),
        ),
        # ── PKM convenience ──────────────────────────────────────────────
        Tool(
            name="read_own_pkm_attribute",
            description=(
                "Convenience wrapper: request consent for one narrow attr.<domain>.<leaf>.* "
                "scope on the caller's own PKM data, wait briefly for approval, then return "
                "the result. Internally calls request_consent -> check_consent_status -> "
                "get_encrypted_scoped_export; never accepts a domain-wildcard or pkm.read scope."
            ),
            inputSchema=schema(
                {
                    "user_identifier": {"type": "string", "minLength": 1, "maxLength": 256},
                    "domain": {"type": "string", "maxLength": 64},
                    "leaf": {"type": "string", "maxLength": 64},
                    "purpose": {"type": "string", "maxLength": 300},
                    "max_wait_seconds": {"type": "integer", "minimum": 1, "maximum": 45},
                },
                ["user_identifier", "domain", "leaf"],
            ),
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
