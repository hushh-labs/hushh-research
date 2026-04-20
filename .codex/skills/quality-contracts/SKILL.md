---
name: quality-contracts
description: Use when changing cross-surface verification policy, contract-test placement, test selection, or quality gates across frontend and backend.
---

# Hushh Quality Contracts Skill

## Purpose and Trigger

- Primary scope: `quality-contracts`
- Trigger on contract-test placement, test selection, route/browser verification, and cross-surface quality rules.
- Avoid overlap with `streaming-contracts` and `repo-operations`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `docs/reference/quality`
2. `hushh-webapp/__tests__`
3. `consent-protocol/tests`

Non-owned surfaces:

1. `security-audit`
2. `frontend`
3. `backend`

## Do Use

1. Test selection and contract-test placement decisions.
2. Cross-surface verification policy and quality-gate ownership.
3. Reviewing whether a code change is missing authoritative checks.

## Do Not Use

1. Broad security intake where the correct spoke is still unclear.
2. Repo-wide CI/deploy operations work.
3. Narrow streaming-protocol work when the issue is clearly about streaming only.

## Read First

1. `docs/reference/quality/README.md`
2. `docs/reference/quality/pr-impact-checklist.md`
3. `docs/reference/kai/kai-runtime-smoke-checklist.md`

## Workflow

1. Start from the contract or user-facing behavior that needs proof, then select the smallest authoritative checks.
2. Keep frontend and backend contract tests aligned with the same user-visible or policy-visible rule.
3. Do not default to Playwright when a cheaper proof is authoritative:
   - use unit/integration tests for data and component logic
   - use Next devtools `get_errors` / runtime diagnostics for render and build faults
   - use targeted service or route contract tests for API/state rules
4. Use Playwright only when the behavior depends on a real browser:
   - auth/bootstrap and reviewer-mode flows
   - vault unlock and protected-route gating
   - Next client navigation behavior
   - responsive layout, animation, interaction, or browser-only runtime issues
5. For vault-protected signed-in routes, split browser verification into two separate contracts when relevant:
   - same-session client navigation after unlock
   - cold-entry or direct deep-link behavior that re-auths or re-unlocks
6. Do not let a single Playwright script conflate these two contracts when the vault is memory-only.
7. When Playwright is required for a signed-in protected route, the default browser contract is:
   - reviewer-mode login
   - vault unlock using the configured Kai/reviewer passphrase from env
   - Next client navigation for same-session proof
8. Treat raw `page.goto(...)` to a protected route as cold-entry proof only, not same-session proof.
9. For PKM work, verify the same user across all truth surfaces that matter:
   - manifest-backed backend metadata
   - helper/service metadata path
   - MCP discovery payload
   - user-visible profile PKM rendering
10. Treat a locked summary that renders as empty PKM as a regression unless the stored PKM is actually empty.
11. Treat CI pipeline ownership as `repo-operations` work unless the task is primarily about what should be verified.
12. Keep required verification lean:
   - prefer changed-surface checks over broad suites
   - protect contributor setup, route/API contracts, and release-critical behavior first
13. When changing a required test set or gate policy, rerun the selected authoritative checks once after the edit and once again from the canonical repo entrypoint before closing the work.
14. Treat helper-only skill/docs drift as advisory by default. It becomes blocking only when it hides or weakens a core runtime/deploy/test authority surface that the RCA loop depends on.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `security-audit`.
2. If the task becomes CI or deploy pipeline ownership, use `repo-operations`.
3. If the task becomes streaming-specific contract work, use `streaming-contracts`.
4. If the task becomes pure frontend or backend implementation, route to `frontend` or `backend`.

## Required Checks

```bash
cd hushh-webapp && npm run test:ci
cd consent-protocol && python3 -m pytest tests/quality -q
```

When route/browser verification changes, require the test output to state which contract was proven: in-app navigation, cold deep link, or both.
