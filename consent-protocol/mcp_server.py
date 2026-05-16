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

