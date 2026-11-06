---
name: quality-contracts
description: Use when changing cross-surface verification policy, contract-test placement, test selection, or quality gates across frontend and backend.
---

# Hussh Quality Contracts Skill

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
3. Reviewing whether a change is missing authoritative checks.

## Do Not Use

1. Broad security intake where the correct spoke is unclear.
2. Repo-wide CI/deploy operations work.
3. Narrow streaming-protocol work when the issue is clearly streaming only.

## Read First

1. `docs/reference/quality/README.md`
2. `docs/reference/quality/pr-impact-checklist.md`
3. `docs/reference/kai/kai-runtime-smoke-checklist.md`
4. `.agents/skills/quality-contracts/references/browser-verification-contract.md`
5. `docs/reference/quality/definition-of-done.md`

## Workflow

1. Start from the contract or user-visible behavior that needs proof.
2. Select the smallest authoritative checks across frontend, backend, route, data, and browser surfaces.
3. Keep frontend and backend contract tests aligned with the same user-visible or policy-visible rule.
4. Do not add one-time, manual, skipped-by-default, or source-string tests to routine suites when a reusable runtime helper, component test, service test, or script-first smoke proves the behavior.
5. Source-reading contract tests are allowed only for explicit architecture boundaries with no cheaper runtime surface; delete them when behavior-level coverage becomes available.
6. Legacy, migration, and compatibility tests stay only while they protect a live compatibility/removal boundary; otherwise delete or move the durable fact into the canonical contract.
7. Use Playwright only when a real browser is required; follow `browser-verification-contract.md` for protected routes.
8. For signed-in, vault, PKM, Email Helper, consent, or app-review proof, resolve the reviewer from runtime env (`REVIEWER_UID`; deprecated aliases only as migration fallbacks) and assert the browser session, vault owner, workflow owner, and PKM data owner are the same user. Do not validate against copied recipients, counterparty labels, admin fixtures, or a hardcoded UID/email.
9. Treat CI pipeline ownership as `repo-operations` unless the primary question is what should be verified.
10. For new tables or data-contract changes, include the repo data-model audit.
11. When changing required test sets or gate policy, rerun selected checks once after the edit and once from the canonical repo entrypoint.
12. Treat helper-only drift as advisory unless it weakens runtime, deploy, or test authority.

## Handoff Rules

1. Broad or ambiguous security work routes back to `security-audit`.
2. CI or deploy pipeline ownership routes to `repo-operations`.
3. Streaming-specific contract work routes to `streaming-contracts`.
4. Pure frontend or backend implementation routes to `frontend` or `backend`.

## Required Checks

Select the nearest owner check for the changed contract and include adjacent
callers when the change crosses a boundary. The full frontend and protocol
suites remain available for release qualification, dependency-wide changes and
diagnosis; they are not the default for every incremental PR.

CI validation profiles preserve the security and source-authority baseline:

- `focused`: always-run authority checks plus regression owners selected from
  the exact changed-file list;
- `release`: core release-authority owners plus affected regression owners;
- `diagnostic`: the historical full check set, including optional hygiene.

Treat missing or unknown changed-file metadata conservatively. App-browser checks
run only as explicit diagnostics; One Browser authority
contracts remain required when affected. Use engine-specific diagnostics locally
when that contract changes. Run native checks only
when native source or its contract changes. Never turn an unrun check into a
pass or remove a live security, consent, data-model or deployment gate to make
the selection smaller.


For quality-policy changes, supply the verified changed-file inventory to the
existing focused owner. Feature work also runs its affected runtime checks through
pre-PR readiness; the commands are selected by the change, not a full-suite default.

```bash
CI_VALIDATION_LEVEL=focused CI_CHANGED_FILES_FILE=/path/to/changed-files.txt scripts/ci/repo-governance-check.sh
```
