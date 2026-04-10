---
name: mcp-developer-surface
description: Use when changing the Hushh MCP developer surface, @hushh/mcp package behavior, developer API docs, or MCP setup guidance.
---

# Hushh MCP Developer Surface Skill

## Purpose and Trigger

- Primary scope: `mcp-developer-surface`
- Trigger on Hushh MCP package behavior, developer API docs, MCP setup guidance, or external developer-surface changes.
- Avoid overlap with `backend-api-contracts` and `security-audit`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `packages/hushh-mcp`
2. `consent-protocol/docs/mcp-setup.md`
3. `consent-protocol/docs/reference/developer-api.md`

Non-owned surfaces:

1. `backend`
2. `security-audit`
3. `docs-governance`

## Do Use

1. `@hushh/mcp` package changes.
2. Developer API docs and MCP setup contract updates.
3. External developer-surface routing between package, docs, and backend behavior.

## Do Not Use

1. Broad backend intake where the correct spoke is still unclear.
2. Generic backend runtime or route-placement work.
3. Internal-only trust policy changes without a developer-surface impact.

## Read First

1. `packages/hushh-mcp/README.md`
2. `consent-protocol/docs/mcp-setup.md`
3. `consent-protocol/docs/reference/developer-api.md`

## Workflow

1. Treat package behavior, developer docs, and setup guidance as one integrated developer surface.
2. Keep package scripts and printed config surfaces aligned with the documented contract.
3. Route consent-scope and trust-enforcement questions to `security-audit` when those become the core concern.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the task becomes general API wire-contract work, use `backend-api-contracts`.
3. If the task becomes security or consent enforcement work, use `security-audit`.

## Required Checks

```bash
cd packages/hushh-mcp && npm run docs:check
cd packages/hushh-mcp && npm run print-config
```
