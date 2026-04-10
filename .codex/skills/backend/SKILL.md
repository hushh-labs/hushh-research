---
name: backend
description: Use when the request is broadly about backend runtime, API routes, services, agents, or protocol package behavior and the correct backend specialist skill is not yet clear.
---

# Hushh Backend Skill

## Purpose and Trigger

- Primary scope: `backend-intake`
- Trigger on broad backend requests across runtime routes, services, agents, protocol docs, tests, and package surfaces.
- Avoid overlap with `security-audit`, `repo-operations`, and `repo-context`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `backend`

Owned repo surfaces:

1. `consent-protocol/api`
2. `consent-protocol/hushh_mcp`
3. `consent-protocol/tests`
4. `consent-protocol/docs`
5. `consent-protocol/scripts`
6. `packages/hushh-mcp`

Non-owned surfaces:

1. `docs-governance`
2. `security-audit`
3. `repo-operations`

## Do Use

1. Broad backend intake before the correct backend spoke is clear.
2. Requests spanning API routes, service boundaries, backend tests, agents, and backend package surfaces.
3. Choosing whether the work belongs to runtime governance, API contracts, agents/operons, or the MCP developer surface.

## Do Not Use

1. Trust, IAM, vault, or audit work where security is the primary domain.
2. CI/deploy/env parity work that belongs to `repo-operations`.
3. Broad repo mapping before the domain itself is known.

## Read First

1. `consent-protocol/README.md`
2. `consent-protocol/docs/README.md`
3. `docs/reference/architecture/architecture.md`
4. `docs/project_context_map.md`

## Workflow

1. Decide whether the task belongs to runtime governance, API contracts, agents/operons, or the MCP developer surface.
2. Keep backend docs, tests, and boundary contracts aligned when the underlying rule changes.
3. Route IAM, consent, vault, PKM, and audit-heavy issues into `security-audit` when those are the real ownership surface.

## Handoff Rules

1. Route route and service-boundary work to `backend-runtime-governance`.
2. Route proxy/backend contract work to `backend-api-contracts`.
3. Route agents, operons, and ADK surfaces to `backend-agents-operons`.
4. Route `@hushh/mcp` and developer API/package work to `mcp-developer-surface`.
5. If the task begins as a cross-domain scan, start with `repo-context`.

## Required Checks

```bash
./bin/hushh protocol --help
cd consent-protocol && python3 -m pytest tests -q
```
