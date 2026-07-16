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
import logging
import sys
import time

import jsonschema
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult

from mcp_modules import resources as mcp_resources
from mcp_modules.config import SERVER_INFO
from mcp_modules.developer_context import (
    get_current_visible_tool_names,
    is_tool_allowed,
)
from mcp_modules.log_redaction import install_sensitive_log_filter
from mcp_modules.public_contract import (
    get_public_tool_names,
    get_server_instructions,
    validate_public_tool_input,
    validate_public_tool_output,
)
from mcp_modules.tools.campaign_context_tools import handle_prepare_campaign_context
from mcp_modules.tools.definitions import get_tool_definitions
from mcp_modules.tools.kai_tools import (
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
)
from mcp_modules.tools.public_tools_v3 import (
    _error as build_safe_error,
)
from mcp_modules.tools.public_tools_v3 import (
    handle_check_consent_status,
    handle_get_encrypted_scoped_export,
    handle_request_consent,
    handle_search_user_scopes,
)
from mcp_modules.tools.ria_read_tools import (
    handle_get_ria_client_access_summary,
    handle_get_ria_profile,
    handle_get_ria_verification_status,
    handle_list_marketplace_investors,
    handle_list_ria_profiles,
)
from mcp_modules.transport_context import mark_local_stdio_transport

# ============================================================================
# LOGGING CONFIGURATION
# IMPORTANT: Only use stderr - stdout is reserved for JSON-RPC messages
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="[HUSHH-MCP] %(levelname)s: %(message)s",
    stream=sys.stderr,  # CRITICAL: Don't pollute stdout
)
install_sensitive_log_filter()
logger = logging.getLogger("hushh-mcp-server")


# ============================================================================
# SERVER INITIALIZATION
# ============================================================================

_CONNECTOR_INITIALIZATION_INSTRUCTIONS = get_server_instructions()
server = Server(
    "hushh-consent",
    version=SERVER_INFO["version"],
    instructions=_CONNECTOR_INITIALIZATION_INSTRUCTIONS,
)

HANDLERS = {
    "search_user_scopes": handle_search_user_scopes,
    "prepare_campaign_context": handle_prepare_campaign_context,
    "request_consent": handle_request_consent,
    "check_consent_status": handle_check_consent_status,
    "get_encrypted_scoped_export": handle_get_encrypted_scoped_export,
    # Existing non-public groups remain available only to explicitly entitled
    # partner/internal apps. They are excluded from the v0.3 public contract.
    "list_ria_profiles": handle_list_ria_profiles,
    "get_ria_profile": handle_get_ria_profile,
    "list_marketplace_investors": handle_list_marketplace_investors,
    "get_ria_verification_status": handle_get_ria_verification_status,
    "get_ria_client_access_summary": handle_get_ria_client_access_summary,
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
_PUBLIC_TOOL_NAMES = frozenset(get_public_tool_names())
_PRIVATE_INPUT_SCHEMAS = {
    tool.name: tool.inputSchema
    for tool in get_tool_definitions(allowed_tool_names=set(HANDLERS) - _PUBLIC_TOOL_NAMES)
}


def _mcp_error(result: tuple[list, dict]) -> CallToolResult:
    content, structured = result
    return CallToolResult(content=content, structuredContent=structured, isError=True)


# ============================================================================
# TOOL DEFINITIONS
# ============================================================================


@server.list_tools()
async def list_tools():
    """Expose Hussh consent tools to MCP hosts."""
    allowed_tool_names = set(get_current_visible_tool_names())
    return get_tool_definitions(allowed_tool_names=allowed_tool_names)


# ============================================================================
# TOOL CALL ROUTER
# ============================================================================


@server.call_tool(validate_input=False)
async def call_tool(name: str, arguments: dict):
    """
    Route tool calls to appropriate handlers.

    Compliance: MCP tools/call specification
    Logging: All calls logged for audit trail
    """
    start_time = time.perf_counter()
    logger.info("Tool called: %s", name)

    handler = HANDLERS.get(name)
    if not handler:
        logger.warning(f"❌ Unknown tool requested: {name}")
        return _mcp_error(
            build_safe_error(
                "UNKNOWN_TOOL",
                "The requested tool is not part of the Hussh Consent MCP contract.",
                recoverable=True,
                next_action="Call tools/list and use one of the published tools.",
            )
        )

    if not is_tool_allowed(name):
        logger.warning("❌ Tool not entitled for current app: %s", name)
        return _mcp_error(
            build_safe_error(
                "TOOL_NOT_ENTITLED",
                "This developer app is not entitled to the requested tool.",
                recoverable=False,
                next_action="Use tools/list for the app's current entitlement surface.",
            )
        )

    if name in _PUBLIC_TOOL_NAMES and not validate_public_tool_input(name, arguments):
        return _mcp_error(
            build_safe_error(
                "INVALID_ARGUMENTS",
                "The tool arguments do not match the published contract.",
                recoverable=True,
                next_action="Call tools/list and retry with only the declared fields.",
            )
        )
    if name not in _PUBLIC_TOOL_NAMES:
        try:
            jsonschema.validate(arguments, _PRIVATE_INPUT_SCHEMAS[name])
        except (KeyError, jsonschema.ValidationError, jsonschema.SchemaError):
            return _mcp_error(
                build_safe_error(
                    "INVALID_ARGUMENTS",
                    "The tool arguments do not match the entitled tool contract.",
                    recoverable=True,
                    next_action="Call tools/list and retry with only the declared fields.",
                )
            )

    try:
        result = await handler(arguments)
        if name not in _PUBLIC_TOOL_NAMES:
            return result
        if not validate_public_tool_output(name, result[1]):
            logger.error("Tool %s returned a contract-invalid result", name)
            return _mcp_error(
                build_safe_error(
                    "INVALID_TOOL_RESULT",
                    "Hussh could not produce a contract-valid tool result.",
                    recoverable=True,
                    next_action="Retry once; if it repeats, report the correlation reference.",
                )
            )
        end_time = time.perf_counter()
        elapsed_ms = (end_time - start_time) * 1000
        logger.info(f"✅ Tool {name} completed successfully")
        logger.info(f"⏱️ Performance: Tool {name} execution took {elapsed_ms:.2f}ms")
        if "error_code" in result[1]:
            return _mcp_error(result)
        return result
    except Exception as exc:
        end_time = time.perf_counter()
        elapsed_ms = (end_time - start_time) * 1000
        logger.error("Tool %s failed error_type=%s", name, type(exc).__name__)
        logger.info(f"⏱️ Performance: Tool {name} failed after {elapsed_ms:.2f}ms")
        return _mcp_error(
            build_safe_error(
                "INTERNAL_ERROR",
                "Hussh could not complete the tool call.",
                recoverable=True,
                next_action="Retry once; if it repeats, report the correlation reference.",
            )
        )


# ============================================================================
# MCP RESOURCES
# ============================================================================


@server.list_resources()
async def list_resources():
    """List available MCP resources."""
    return await mcp_resources.list_resources()


@server.read_resource()
async def read_resource(uri: str):
    """Read MCP resource content by URI."""
    return await mcp_resources.read_resource(uri)


# ============================================================================
# MAIN ENTRY POINT
# ============================================================================


async def main():
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
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(
                experimental_capabilities={"hushh.connector": SERVER_INFO["connector_capabilities"]}
            ),
        )


if __name__ == "__main__":
    # This process is the local stdio subprocess (spawned by `npx @hushh/mcp`
    # or a direct `python mcp_server.py` invocation) running on the
    # developer's own machine with loopback access. mcp_remote.py imports
    # `server` as a module without ever executing this block, so the remote
    # transport never observes this flag as True.
    mark_local_stdio_transport()
    asyncio.run(main())
