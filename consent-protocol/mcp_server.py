#!/usr/bin/env python3
"""
Hussh MCP Server - Production Grade
====================================

Consent-first personal data access for AI agents.

This MCP Server exposes the Hussh consent protocol to any MCP Host,
enabling AI agents to access user data ONLY with explicit, cryptographic consent.

Compliant with:
- MCP Specification (JSON-RPC 2.0, stdio transport)
- HushhMCP Protocol (consent tokens, TrustLinks, scoped access)

Run with: python mcp_server.py
Public install/setup: See https://www.npmjs.com/package/@hushh/mcp
Technical companion: See docs/mcp-setup.md

Modular architecture:
- mcp/config.py: Server configuration
- mcp/tools/: Tool handlers
- mcp/resources.py: MCP resources
"""

import asyncio
import json
import logging
import time
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Resource, TextContent, Tool

from mcp_modules import resources as mcp_resources

# Import modular components
from mcp_modules.config import SERVER_INFO
from mcp_modules.developer_context import (
    get_current_visible_tool_names,
    is_tool_allowed,
)
from mcp_modules.log_redaction import install_sensitive_log_filter, redact_mcp_arguments
from mcp_modules.tools import (
    get_tool_definitions,
    handle_check_consent_status,
    handle_delegate,
    handle_discover_user_domains,
    handle_get_encrypted_scoped_export,
    handle_get_ria_client_access_summary,
    handle_get_ria_profile,
    handle_get_ria_verification_status,
    handle_get_shopping_memory,
    handle_kai_analyze_stock,
    handle_kai_cancel_active_analysis,
    handle_kai_navigate_back,
    handle_kai_open_consent,
    handle_kai_open_dashboard,
    handle_kai_open_history,
    handle_kai_open_home,
    handle_kai_open_import,
    handle_kai_open_optimize,
    handle_kai_open_profile,
    handle_kai_resume_active_analysis,
    handle_list_marketplace_investors,
    handle_list_ria_profiles,
    handle_list_scopes,
    handle_prepare_campaign_context,
    handle_request_consent,
    handle_validate_token,
)
from mcp_modules.tools.schemas import (
    CheckConsentStatusSchema,
    DelegateToAgentSchema,
    DiscoverUserDomainsSchema,
    EmptyArgsSchema,
    GetEncryptedScopedExportSchema,
    GetRiaClientAccessSummarySchema,
    GetRiaProfileSchema,
    GetRiaVerificationStatusSchema,
    KaiAnalyzeStockSchema,
    KaiOpenHistorySchema,
    ListMarketplaceInvestorsSchema,
    ListRiaProfilesSchema,
    PrepareCampaignContextSchema,
    RequestConsentSchema,
    ValidateTokenSchema,
)

# ============================================================================
# LOGGING CONFIGURATION
# IMPORTANT: Only use stderr - stdout is reserved for JSON-RPC messages
# ============================================================================
from services.logging_config import configure_logging

configure_logging(level="INFO", stream="ext://sys.stderr")
install_sensitive_log_filter()
logger = logging.getLogger("hushh-mcp-server")


# ============================================================================
# SERVER INITIALIZATION
# ============================================================================

server = Server("hushh-consent")

HANDLERS = {
    # ── Consent / Privacy tools ───────────────────────────────────────────────
    "prepare_campaign_context": handle_prepare_campaign_context,
    "request_consent": handle_request_consent,
    "validate_token": handle_validate_token,
    "get_encrypted_scoped_export": handle_get_encrypted_scoped_export,
    "get_shopping_memory": handle_get_shopping_memory,
    "delegate_to_agent": handle_delegate,
    "list_scopes": handle_list_scopes,
    "discover_user_domains": handle_discover_user_domains,
    "check_consent_status": handle_check_consent_status,
    # ── RIA / Marketplace tools ───────────────────────────────────────────────
    "list_ria_profiles": handle_list_ria_profiles,
    "get_ria_profile": handle_get_ria_profile,
    "list_marketplace_investors": handle_list_marketplace_investors,
    "get_ria_verification_status": handle_get_ria_verification_status,
    "get_ria_client_access_summary": handle_get_ria_client_access_summary,
    # ── Kai voice action tools ────────────────────────────────────────────────
    "kai_analyze_stock": handle_kai_analyze_stock,
    "kai_open_dashboard": handle_kai_open_dashboard,
    "kai_open_import": handle_kai_open_import,
    "kai_open_history": handle_kai_open_history,
    "kai_open_consent": handle_kai_open_consent,
    "kai_open_profile": handle_kai_open_profile,
    "kai_open_optimize": handle_kai_open_optimize,
    "kai_open_home": handle_kai_open_home,
    "kai_navigate_back": handle_kai_navigate_back,
    "kai_resume_active_analysis": handle_kai_resume_active_analysis,
    "kai_cancel_active_analysis": handle_kai_cancel_active_analysis,
}

SCHEMA_MAP = {
    "prepare_campaign_context": PrepareCampaignContextSchema,
    "request_consent": RequestConsentSchema,
    "validate_token": ValidateTokenSchema,
    "get_encrypted_scoped_export": GetEncryptedScopedExportSchema,
    "delegate_to_agent": DelegateToAgentSchema,
    "list_scopes": EmptyArgsSchema,
    "discover_user_domains": DiscoverUserDomainsSchema,
    "check_consent_status": CheckConsentStatusSchema,
    "list_ria_profiles": ListRiaProfilesSchema,
    "get_ria_profile": GetRiaProfileSchema,
    "list_marketplace_investors": ListMarketplaceInvestorsSchema,
    "get_ria_verification_status": GetRiaVerificationStatusSchema,
    "get_ria_client_access_summary": GetRiaClientAccessSummarySchema,
    "kai_analyze_stock": KaiAnalyzeStockSchema,
    "kai_open_dashboard": EmptyArgsSchema,
    "kai_open_import": EmptyArgsSchema,
    "kai_open_history": KaiOpenHistorySchema,
    "kai_open_consent": EmptyArgsSchema,
    "kai_open_profile": EmptyArgsSchema,
    "kai_open_optimize": EmptyArgsSchema,
    "kai_open_home": EmptyArgsSchema,
    "kai_navigate_back": EmptyArgsSchema,
    "kai_resume_active_analysis": EmptyArgsSchema,
    "kai_cancel_active_analysis": EmptyArgsSchema,
}


# ============================================================================
# TOOL DEFINITIONS
# ============================================================================


@server.list_tools()
async def list_tools() -> list[Tool]:
    """Expose Hussh consent tools to MCP hosts."""
    allowed_tool_names = set(get_current_visible_tool_names())
    return get_tool_definitions(allowed_tool_names=allowed_tool_names)


# ============================================================================
# TOOL CALL ROUTER
# ============================================================================


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """
    Route tool calls to appropriate handlers.

    Compliance: MCP tools/call specification
    Logging: All calls logged for audit trail
    """
    start_time = time.perf_counter()
    logger.info(f"🔧 Tool called: {name}")
    logger.info("   Arguments: %s", json.dumps(redact_mcp_arguments(arguments), default=str))

    schema_cls = SCHEMA_MAP.get(name)
    if schema_cls:
        try:
            validated_args = schema_cls.model_validate(arguments or {})
            arguments = {k: v for k, v in validated_args.model_dump().items() if v is not None}
        except Exception as ve:
            logger.warning(f"❌ Argument validation failed for tool {name}: {ve}")
            return [
                TextContent(
                    type="text",
                    text=json.dumps(
                        {
                            "status": "error",
                            "error": f"Invalid arguments: {str(ve)}",
                            "tool": name,
                        }
                    ),
                )
            ]

    handler = HANDLERS.get(name)
    if not handler:
        logger.warning(f"❌ Unknown tool requested: {name}")
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {"error": f"Unknown tool: {name}", "available_tools": list(HANDLERS.keys())}
                ),
            )
        ]

    if not is_tool_allowed(name):
        logger.warning("❌ Tool not entitled for current app: %s", name)
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "error": "Tool not available for this developer app",
                        "tool": name,
                        "available_tools": list(get_current_visible_tool_names()),
                    }
                ),
            )
        ]

    try:
        result = await handler(arguments)
        end_time = time.perf_counter()
        elapsed_ms = (end_time - start_time) * 1000
        logger.info(f"✅ Tool {name} completed successfully")
        logger.info(f"⏱️ Performance: Tool {name} execution took {elapsed_ms:.2f}ms")
        return result
    except Exception as e:
        end_time = time.perf_counter()
        elapsed_ms = (end_time - start_time) * 1000
        logger.error(f"❌ Tool {name} failed: {str(e)}")
        logger.info(f"⏱️ Performance: Tool {name} failed after {elapsed_ms:.2f}ms")
        return [
            TextContent(
                type="text", text=json.dumps({"error": str(e), "tool": name, "status": "failed"})
            )
        ]


# ============================================================================
# MCP RESOURCES
# ============================================================================


@server.list_resources()
async def list_resources() -> list[Resource]:
    """List available MCP resources."""
    return await mcp_resources.list_resources()


@server.read_resource()
async def read_resource(uri: str) -> str | bytes:
    """Read MCP resource content by URI."""
    return await mcp_resources.read_resource(uri)


# ============================================================================
# MAIN ENTRY POINT
# ============================================================================


async def main() -> None:
    """
    Run the Hussh MCP Server.

    Transport: stdio (for Claude Desktop, Cursor, and other MCP hosts)
    Protocol: JSON-RPC 2.0
    Compliance: HushhMCP (consent-first personal data access)
    """
    logger.info("=" * 60)
    logger.info("🚀 HUSHH MCP SERVER STARTING")
    logger.info("=" * 60)
    logger.info(f"   Name: {SERVER_INFO['name']}")
    logger.info(f"   Version: {SERVER_INFO['version']}")
    logger.info(f"   Protocol: {SERVER_INFO['protocol']}")
    logger.info(f"   Transport: {SERVER_INFO['transport']}")
    logger.info(f"   Tools: {SERVER_INFO['tools_count']} consent tools exposed")
    logger.info("")
    logger.info("   Compliance:")
    for item in SERVER_INFO["compliance"]:
        logger.info(f"     ✅ {item}")
    logger.info("")
    logger.info("   Ready to receive connections from MCP hosts...")
    logger.info("=" * 60)

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
