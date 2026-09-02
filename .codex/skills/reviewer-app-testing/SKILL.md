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
2. `.codex/skills/reviewer-app-testing/references/reviewer-rehearsal-preflight.md`
3. `hushh-webapp/scripts/testing/reviewer-test-identity.mjs`
4. `hushh-webapp/lib/testing/native-test.ts`
5. `hushh-webapp/components/app-ui/native-test-bootstrap.tsx`
6. `hushh-webapp/components/app-ui/native-test-router.tsx`
7. `hushh-webapp/lib/utils/browser-navigation.ts`

## Workflow

1. Classify the run as read-only or explicitly mutation-authorized; ordinary review is read-only.
2. Run the executable preflight before Chromium; it resolves the canonical reviewer without printing secrets and proves review mode is enabled.
3. For local runs, use `scripts/env/reviewer_mode.sh`; restart the backend after enabling and disabling it.
4. Let the default network guard block unapproved state-changing requests. A block is a failure, never a reason to weaken the guard.
5. Prove a cold authenticated entry visibly hard-gates on the vault before supplying any passphrase.
6. Unlock, verify `vaultKeyHash`, then use Next client navigation and assert `vault_unlocked` after every protected transition.
7. Fail on critical API 5xx, a blocked mutation, identity mismatch, or any loss of vault continuity.
8. Close the context, then prove cold-session authentication and re-unlock separately.
9. For Agent Chat changes, run `verify-reviewer-agent-chat.mjs` with explicit
   `REVIEWER_ALLOW_SHARED_MUTATIONS=true`; it must complete a real prompt turn and prove
   consumer-safe errors, self-avatar rendering, idle-status removal, and overflow safety.
10. Trusted Devices: `verify-reviewer-trusted-devices.mjs` (read-only). Always compose `createReviewerSessionHarness`; never hand-roll one (see the preflight reference).
11. Payment Cards: `verify-reviewer-payment-cards.mjs` (mutation-authorized); the guard
    exempts Firebase auth hosts. Both are detailed in the preflight reference.
Local enablement and identity reconciliation follow
`.codex/skills/reviewer-app-testing/references/reviewer-rehearsal-preflight.md`.

## Handoff Rules
1. Vault and encrypted-storage implementation work routes to `vault-pkm-governance`.
2. PKM upgrade and exact payload rehearsal routes to `pkm-upgrade-rehearsal`.
3. Cache behavior proof routes to `frontend-cache-coherence`; broad security work returns to `security-audit`.

## Required Checks

```bash
./scripts/ci/reviewer-app-testing-check.sh
./bin/hushh codex route-task reviewer-app-rehearsal --text
node .codex/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs --help
consent-protocol/.venv/bin/python .codex/skills/reviewer-app-testing/scripts/reconcile-reviewer-identity.py --help
```
