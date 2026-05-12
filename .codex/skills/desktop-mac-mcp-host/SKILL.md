---
name: desktop-mac-mcp-host
description: Use when implementing or reviewing the local MCP HTTP/SSE host on the Mac, the OpenClaw DataSourceBinding interface, CRT/DAT minting, or the OpenClaw conformance test harness inside the desktop-mac owner family.
---

# Hussh Desktop Mac MCP Host Skill

## Purpose and Trigger

- Primary scope: `desktop-mac-mcp-host`
- Trigger on local MCP server work, OpenClaw DataSourceBinding protocol design, CRT and DAT minting on the Mac, OpenClaw conformance test harness, and BYOA agent bearer-token workflow.
- Avoid overlap with `mcp-developer-surface` and `hushh-consent-mcp`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `desktop-mac`

Owned repo surfaces:

1. `apps/one-mac/Sources/OneMCPServer`

Non-owned surfaces:

1. `desktop-mac`
2. `mcp-developer-surface`
3. `hushh-consent-mcp`

## Do Use

1. Designing or evolving the OpenClaw `DataSourceBinding` Swift protocol.
2. Local CRT minting, hourly rotation, and revocation propagation.
3. OpenClaw conformance test harness under `apps/one-mac/Tests`.
4. BYOA pane MCP-config snippet generation for Claude Desktop, Cursor, ChatGPT MCP, and Codex.

## Do Not Use

1. Knowledge-source ingestion work — use `desktop-mac-connectors`.
2. Hosted Consent MCP at `https://api.uat.hushh.ai/mcp/` — use `hushh-consent-mcp`.
3. Broad Mac-app intake where the MCP boundary is unclear.

## Read First

1. `docs/future/one-mac-knowledge-base-app.md`
2. `consent-protocol/hushh_mcp/consent/token.py`
3. `consent-protocol/api/routes/pkm_routes_shared.py`

## Workflow

1. Mirror the Python `hushh_mcp/consent/token.py` payload format byte-for-byte; the Swift port must round-trip with the Python source.
2. Keep `apps/one-mac/Sources/OneMCPServer/` open-sourceable in isolation: Apache-2.0, no Hussh-only dependencies.
3. Match One-mac MCP tool shapes to the existing hosted Consent MCP tools (`discover_user_domains`, `request_consent`, `check_consent_status`, `get_encrypted_scoped_export`, `validate_token`, `list_scopes`) so iOS consumers need zero changes.
4. Every MCP call must run validate CRT, then check DAT scope, then check Domain registry, then execute, then append a local consent log row plus a cloud transparency POST.
5. Treat the OpenClaw conformance test harness as the canonical contract; do not let the binding diverge from the harness without a documented migration.

## Handoff Rules

1. If the request is broad Mac-app intake, route it back to `desktop-mac`.
2. If the work touches knowledge-source ingestion or connector adapters, use `desktop-mac-connectors`.
3. If the work touches the hosted Consent MCP or its tool catalog, use `hushh-consent-mcp`.
4. If the work touches generic MCP developer-surface contracts shared across non-Mac surfaces, use `mcp-developer-surface`.

## Required Checks

```bash
./bin/hushh native mac build
./bin/hushh native mac test
```
