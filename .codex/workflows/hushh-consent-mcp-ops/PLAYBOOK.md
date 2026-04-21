# Hushh Consent MCP Ops

Use this workflow pack when the task matches `hushh-consent-mcp-ops`.

## Goal

Operate and verify the Hushh Consent MCP connector directly without confusing connector startup, empty discovery, and environment mismatch.

## Steps

1. Start with `hushh-consent-mcp` and keep the task at the connector/config level first.
2. Verify host config and printed package config before inferring backend or user-data faults.
3. Distinguish clearly between startup failure, environment mismatch, and valid empty discovery.
4. Hand off to `mcp-developer-surface` only when the task becomes package/docs evolution instead of connector ops.
5. Hand off to `security-audit` only when the core issue is consent policy or trust-boundary behavior.

## Common Drift Risks

1. treating package docs and connector ops as unrelated surfaces
2. skipping config verification and blaming the backend first
3. using MCP ops work to smuggle in broad API or policy changes
