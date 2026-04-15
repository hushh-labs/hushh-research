---
name: hushh-consent-mcp
description: Use when operating the Hushh Consent MCP connector directly for domain discovery, consent request/status checks, token validation, or scoped export verification.
---

# Hushh Consent MCP Skill

## Purpose and Trigger

- Primary scope: `hushh-consent-mcp-ops`
- Trigger on direct connector tasks against the Hushh Consent MCP surface:
  - `discover_user_domains`
  - `request_consent`
  - `check_consent_status`
  - `validate_token`
  - `get_encrypted_scoped_export`
- Use this when the question is about what the connector returns right now, not when changing backend consent logic.
- Avoid overlap with `backend`, `mcp-developer-surface`, and `security-audit`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `packages/hushh-mcp`
2. `consent-protocol/docs/mcp-setup.md`
3. `.codex/skills/hushh-consent-mcp`

Non-owned surfaces:

1. `backend`
2. `security-audit`
3. `docs-governance`

## Do Use

1. Verifying whether a specific user resolves to any discoverable domains/scopes.
2. Comparing prod vs UAT connector behavior for the same identifier.
3. Debugging connector startup/config mismatches across Codex, Claude Desktop, or other MCP hosts.
4. Verifying whether a missing result is a connector/config issue versus an actual empty discovery response.

## Do Not Use

1. Changing consent scope semantics or IAM policy.
2. Broad backend runtime work outside the MCP connector.
3. UI-only consent surface work.

## Read First

1. `packages/hushh-mcp/README.md`
2. `consent-protocol/docs/mcp-setup.md`
3. `docs/reference/operations/coding-agent-mcp.md`

## Workflow

1. Verify the local host config first if the issue smells like a connector startup failure.
2. When discovery returns no domains, check at least two environments when available before concluding it is a user-data issue.
3. Distinguish clearly between:
   - connector failed to start
   - connector connected but returned an empty discovery result
   - environment mismatch between local, UAT, and production
4. Report the raw connector result concisely before inferring causes.
5. If the connector returns empty in multiple environments, treat that as a valid empty response until proven otherwise.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the task becomes package/docs evolution, hand off to `mcp-developer-surface`.
3. If the task becomes consent-policy or trust-boundary analysis, hand off to `security-audit`.
4. If the task becomes backend API contract work, hand off to `backend-api-contracts`.

## Required Checks

```bash
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh codex audit
cd packages/hushh-mcp && npm run print-config
```
