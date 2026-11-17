---
name: repo-operations
description: Use when working on Hussh CI/CD, branch protection, merge queue, GitHub Actions, deploys, env or secret parity, Cloud Run or Cloud Build operations, UAT or production rollout, incident triage, or operational verification.
---

# Hussh Repo Operations Skill

## Purpose and Trigger

- Primary scope: `repo-operations-intake`
- Trigger on CI/CD, branch protection, merge queue, deploys, env parity, runtime rollout, and operational verification.
- Avoid overlap with `repo-context`, `planning-board`, and `docs-governance`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `bin`
2. `scripts`
3. `config`
4. `deploy`

Non-owned surfaces:

1. `docs-governance`
2. `planning-board`
3. `frontend`
4. `backend`
5. `analytics-observability-governance`

## Do Use

1. CI, GitHub Actions, branch protection, merge queue, and live check monitoring.
2. UAT/production rollout, Cloud Run/Cloud Build, env parity, and release-authority checks.
3. Operational RCA, fix-and-rerun loops, DCO/push safety, and branch preservation.

## Do Not Use

1. Product implementation or broad repo mapping.
2. GitHub board/project-management workflows.
3. Documentation-home governance or frontend design-system work.

## Read First

1. `docs/operations/README.md`
2. `docs/operations/releases/ci.md`
3. `docs/operations/releases/branch-governance.md`
4. `.agents/skills/repo-operations/references/admin-release-sop.md`
5. `.agents/skills/repo-operations/references/branch-runtime-ops.md`
6. `.agents/skills/repo-operations/references/maintainer-branch-freshness.md`
7. `.agents/skills/repo-operations/references/agent-trigger-policy.md`
8. `.agents/skills/repo-operations/references/anti-rationalization.md`

## Workflow

Follow [Main-owned release control](../../../docs/operations/releases/ci.md#main-owned-release-control), [the Dev pod runbook](../../../docs/operations/hosting/dev-pod-first-light-runbook.md), and [release and pod authority](references/release-and-pod-authority.md) for live-team review, CI timing, WIF provenance, queue owner-merge, and private pod hosting.

1. Keep the root checkout on the active base branch (`dev`, or `uat` when working UAT) so local servers run cleanly against fresh base state; execute agent edits in an ephemeral registered task worktree branched from fresh `origin/<base>` (or on the named developer branch when explicitly active) and remove it cleanly after integration per `branch-runtime-ops.md`.
2. Prefer live verification over assumptions for GitHub, CI, ruleset, and runtime state; verify acting CLI/connector identity, permissions, and selected `kushal@hushh.ai` ADC (distinct from stale account selection) via `./bin/hushh`, `gh`, and `.agents/skills/repo-operations/references/admin-release-sop.md`.
3. Follow `admin-release-sop.md` as the single state machine for merge/deploy cadences (verify pre-PR, DCO, exact head SHA, gates, queue state, landed SHA, smoke, and requested environment separately; `merge to main` never deploys) and monitor core runs until terminal completion.
4. For DB migration/contract changes, run the DB release gate and `docs/operations/releases/migration-governance.md` complete replay checks before calling UAT ready; verify iOS release proof via `.agents/skills/release-ios-appstore/references/release-proof.md`, live Firebase Auth checks, and native auth-health fallback retirement independently.
5. Run local servers via in-session three-terminal commands in `branch-runtime-ops.md`, diagnose UAT failures with `./bin/hushh agents rca --surface uat --text`, route ready PRs with `./bin/hushh agents review-route --pr <number> --apply`, and select PKM/browser checks solely via `scripts/ci/resolve-uat-verification-plan.py`.
6. Follow `maintainer-branch-freshness.md` across Main, UAT, and Dev: sync landed deltas downstream promptly without conflating source syncs with deployment, batch pushes cleanly, and retry unchanged failed runs via `./bin/hushh agents ci-rerun`.
7. Enforce the five governed destinations (`main`, `dev`, `uat`, `uat-isolated`, `integration/pr-train`): **Dev intake** owns feature integration, governed operations PRs may target directly into `main` by actor identity, and changes to CI, release policy, or `.agents/skills/` require `@hushh-labs/pipeline-editors` authority.

## Handoff Rules

1. Broad repo orientation starts with `repo-context`.
2. Board/project work routes to `planning-board`.
3. Docs-home governance routes to `docs-governance`.
4. GA4/Firebase/BigQuery observability routes to `analytics-observability-governance`.
5. Licensing, onboarding, subtree, and domain implementation route to their owner skills.

## Required Checks

Use focused or release governance with the exact changed files. The diagnostic
profile runs the historical full set. Missing inputs stay conservative. Run the
core mirror for cross-stage changes and `./bin/hushh agents pre-pr` for PR impact and affected
owners. App-browser proof requires explicit diagnostics; hosted compilation and
functional contracts do not certify live browser behavior. Use an exact-source, next-attempt retry after a
diagnosed failure, and keep live authority and security gates blocking. Ordinary
UAT uses core provider readiness; secondary features retain separate diagnostic
outcomes. Follow the [CI policy](../../../docs/operations/releases/ci.md#managed-provider-readiness-policy)
and qualify a policy-changing combined candidate once before release.

```bash
./bin/hushh agents ci-status
CI_VALIDATION_LEVEL=focused CI_CHANGED_FILES_FILE=/path/to/changed-files.txt scripts/ci/repo-governance-check.sh
CI_VALIDATION_LEVEL=diagnostic scripts/ci/repo-governance-check.sh
./bin/hushh agents rca --surface uat --text
./bin/hushh docs verify
./scripts/ci/verify-main-branch-protection.sh
./scripts/ci/apply-governance.py
./scripts/ci/verify-production-environment-governance.sh
```
