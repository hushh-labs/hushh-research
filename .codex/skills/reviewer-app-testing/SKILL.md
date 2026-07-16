---
name: reviewer-app-testing
description: Use when operating reviewer-account browser rehearsals that require BYOK unlock, memory-only decrypted information, and same-session client navigation.
---

# Hussh Reviewer App Testing Skill

## Purpose and Trigger

- Primary scope: `reviewer-app-testing`
- Trigger on reviewer Playwright flows, BYOK unlock continuity, protected route chains, or cold-session re-unlock proof.
- Avoid overlap with `vault-pkm-governance`, `pkm-upgrade-rehearsal`, and `frontend-cache-coherence`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `.codex/skills/reviewer-app-testing`
2. `hushh-webapp/scripts/testing/reviewer-test-identity.mjs`
3. `hushh-webapp/scripts/testing/verify-signed-in-routes.mjs`

Non-owned surfaces:

1. `consent-protocol/hushh_mcp/vault`
2. `hushh-webapp/lib/pkm`
3. `scripts/ci/pkm-upgrade-gate.sh`

## Do Use

1. Canonical reviewer identity, authentication, passphrase-wrapper unlock, and vault-key integrity proof.
2. Same-browser-context protected flows where decrypted information and keys must remain memory-only.
3. Separate cold-context reauthentication and re-unlock proof after the same-session route chain.
4. Shared Playwright helpers used by domain-specific reviewer rehearsals.

## Do Not Use

1. Vault cryptography or PKM storage implementation changes; use `vault-pkm-governance`.
2. PKM restructuring, preservation, scope, rollback, or payload acceptance; use `pkm-upgrade-rehearsal`.
3. Generic public-route browser checks that do not depend on an unlocked vault.
4. Shared reviewer mutation without explicit operator authority for the current task.

## Read First

1. `.codex/skills/reviewer-app-testing/references/byok-reviewer-browser-contract.md`
2. `hushh-webapp/scripts/testing/reviewer-test-identity.mjs`
3. `hushh-webapp/lib/testing/native-test.ts`
4. `hushh-webapp/components/app-ui/native-test-bootstrap.tsx`
5. `hushh-webapp/components/app-ui/native-test-router.tsx`
6. `hushh-webapp/lib/utils/browser-navigation.ts`

## Workflow

1. Resolve the canonical reviewer through the shared identity module; never print or persist its secrets.
2. Decide and record whether the run is read-only or explicitly mutation-authorized.
3. Authenticate, unlock, derive the wrapper key locally, and verify `vaultKeyHash`.
4. Keep passphrase, tokens, key, and decrypted information in memory throughout the same-session route chain.
5. Use Next client navigation and assert `vault_unlocked` after every protected route transition.
6. Fail the route chain on critical first-party vault, consent, connection, notification, or PKM API 5xx responses.
7. Close the context, then test cold-session authentication and re-unlock separately.
8. Hand domain assertions to the owning spoke while retaining this BYOK/session contract.

## Handoff Rules

1. Vault and encrypted-storage implementation work routes to `vault-pkm-governance`.
2. PKM upgrade and exact payload rehearsal routes to `pkm-upgrade-rehearsal`.
3. Cache behavior proof routes to `frontend-cache-coherence`; broad security work returns to `security-audit`.

## Required Checks

```bash
./scripts/ci/reviewer-app-testing-check.sh
./bin/hushh codex route-task reviewer-app-rehearsal --text
```
