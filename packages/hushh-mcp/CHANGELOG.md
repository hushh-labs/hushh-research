# Changelog

## 0.3.0 - 2026-07-15

Breaking MCP catalog hardening release.

- Replaced the prior consent catalog with four core lifecycle tools plus a hardened `prepare_campaign_context` compatibility tool for the Hussh ADK campaign agent.
- Removed public MCP access to `discover_user_domains`, `list_scopes`, and `validate_token`; token validation remains internal.
- Added strict input and output schemas, structured results, stable redacted errors, app-bound lifecycle references, and cursor pagination.
- Preserved the raw `/api/v1` HTTP compatibility contract and envelope-v2/X25519 encryption model.
- Added a portable Streamable HTTP gateway manifest through `hushh-mcp --print-gateway-manifest`; bearer-header authentication is configured in the host, never inside the transport descriptor.
- Added Codex, Claude Desktop, Cursor, VS Code, hosted, and generic bridge setup guidance.
- Added an explicit migration path from npm `0.1.3` and the UAT MCP server `0.2.0` catalog; query-token configurations must move to bearer headers.
