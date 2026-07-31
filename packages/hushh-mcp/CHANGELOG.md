# Changelog

## Unreleased

## 0.4.1 - 2026-07-30

- Added an explicit npm bridge configuration for operations-provisioned OAuth
  client credentials. The bridge obtains and renews its short-lived Bearer
  token in memory; client credentials never appear in MCP results or generated
  remote configuration.
- Made the header-only POST MCP migration explicit for users upgrading from
  the published 0.1.3 package.

## 0.4.0 - 2026-07-20

- Published one generated five-tool v0.4 catalog for bearer, PKCE, client
  credentials, Codex, Claude, MuleSoft, and Agentforce.
- Promoted `prepare-campaign-context` to a first-class external tool and added
  shallow safe offer/lifecycle fields for frontend rendering.
- Added a hyphenated-name migration: v0.3 underscore calls remain accepted
  until 2026-10-20 but are not listed from `tools/list`.
- Added direct-Agentforce safe Consent Center handoff behavior without calling
  a personalized consent or export handler.

## 0.3.0 - 2026-07-15

Breaking MCP catalog hardening release.

- Replaced the prior consent catalog with four core lifecycle tools plus a hardened `prepare_campaign_context` compatibility tool for the Hussh ADK campaign agent.
- Removed public MCP access to `discover_user_domains`, `list_scopes`, and `validate_token`; token validation remains internal.
- Added strict input and output schemas, structured results, stable redacted errors, app-bound lifecycle references, and cursor pagination.
- Preserved the raw `/api/v1` HTTP compatibility contract and envelope-v2/X25519 encryption model.
- Added a portable Streamable HTTP gateway manifest through `hushh-mcp --print-gateway-manifest`; bearer-header authentication is configured in the host, never inside the transport descriptor.
- Added Codex, Claude Desktop, Cursor, VS Code, hosted, and generic bridge setup guidance.
- Added an explicit migration path from npm `0.1.3` and the UAT MCP server `0.2.0` catalog; query-token configurations must move to bearer headers.
