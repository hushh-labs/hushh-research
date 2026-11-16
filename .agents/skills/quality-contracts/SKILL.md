---
name: quality-contracts
description: Use when changing cross-surface verification policy, contract-test placement, test selection, Tier-1.5 Floci multi-cloud wire conformance, or quality gates across frontend and backend.
---

# Hussh Quality Contracts Skill

## Purpose and Trigger

- Primary scope: `quality-contracts`
- Trigger on contract-test placement, test selection, Tier-1.5 Floci multi-cloud SDK/HTTP wire conformance, route/browser verification, and cross-surface quality rules.
- Avoid overlap with `streaming-contracts` and `repo-operations`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `docs/development/quality`
2. `hushh-webapp/__tests__`
3. `consent-protocol/tests`

Non-owned surfaces:

1. `security-audit`
2. `frontend`
3. `backend`

## Do Use

1. Test selection, Tier-1.5 Floci multi-cloud wire-test placement, and contract-test placement decisions.
2. Cross-surface verification policy and quality-gate ownership.
3. Reviewing whether a change is missing authoritative runtime, wire, or browser checks.

## Do Not Use

1. Broad security intake where the correct spoke is unclear.
2. Repo-wide CI/deploy operations work.
3. Narrow streaming-protocol work when the issue is clearly streaming only.

## Read First

1. `docs/development/quality/README.md`
2. `docs/development/quality/pr-impact-checklist.md`
3. `docs/architecture/finance/kai-runtime-smoke-checklist.md`
4. `.agents/skills/quality-contracts/references/browser-verification-contract.md`
5. `.agents/skills/quality-contracts/references/floci-wire-verification.md`
6. `docs/development/quality/floci-multicloud-wire-verification.md`
7. `docs/development/quality/definition-of-done.md`

## Workflow

1. Start from the contract or user-visible behavior that needs proof and select the smallest authoritative checks across frontend, backend, wire, data, and browser surfaces.
2. Keep frontend and backend contract tests aligned with the same user-visible or policy-visible rule; include the repo data-model audit for new tables or data-contract changes.
3. Prefer reusable runtime helpers, component/service tests, or script-first smokes over manual, skipped-by-default, or source-string checks; retain source-reading or compatibility tests only while no runtime surface exists or a live removal boundary stays active.
4. For multi-cloud storage, KMS/Key Vault AAD, capability-prefix gateways, or BYOC adapters (`GCS`, `Azure Blob`, `AWS S3/ECS/KMS`, `PrefixTokenObjectStore`), require Tier-1.5 loopback HTTP/SDK checks via `consent-protocol/tests/floci_wire_harness.py` (`floci-wire-verification.md`) instead of `MagicMock` wire stubs; keep overrides loopback-only outside `uat`/`staging`/`production`, and never treat Tier-1.5 passes as `execution_qualified` live-cloud proof.
5. Use Playwright only when a real browser is required (`browser-verification-contract.md`); for signed-in, vault, PKM, Email Helper, consent, or app-review proof, resolve `REVIEWER_UID` from runtime env and assert identical user ownership across browser session, vault, workflow, and PKM rather than counterparty fixtures or hardcoded UIDs/emails.
6. Treat CI pipeline ownership as `repo-operations` unless the primary question is what should be verified; prove gate-policy changes once through the canonical entrypoint (`floci-wire-verification.md`) without turning unrun checks into passes or removing live security, consent, data-model, or deployment gates.
7. Treat helper-only drift as advisory unless it weakens runtime, deploy, or test authority.

## Handoff Rules

1. Broad or ambiguous security work routes back to `security-audit`.
2. CI or deploy pipeline ownership routes to `repo-operations`.
3. Streaming-specific contract work routes to `streaming-contracts`.
4. Pure frontend or backend implementation routes to `frontend` or `backend`.

## Required Checks

Follow `floci-wire-verification.md` and [CI readiness policy](../../../docs/operations/releases/ci.md#managed-provider-readiness-policy) for `focused`, `release`, and `diagnostic` profile selection, One Browser vs app-browser boundaries, and Tier-1.5 multi-cloud wire suites.

```bash
CI_VALIDATION_LEVEL=focused CI_CHANGED_FILES_FILE=/path/to/changed-files.txt scripts/ci/repo-governance-check.sh
```
