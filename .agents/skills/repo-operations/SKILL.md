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

1. `docs/reference/operations/README.md`
2. `docs/reference/operations/ci.md`
3. `docs/reference/operations/branch-governance.md`
4. `.agents/skills/repo-operations/references/admin-release-sop.md`
5. `.agents/skills/repo-operations/references/branch-runtime-ops.md`
6. `.agents/skills/repo-operations/references/maintainer-branch-freshness.md`
7. `.agents/skills/repo-operations/references/agent-trigger-policy.md`
8. `.agents/skills/repo-operations/references/anti-rationalization.md`

## Workflow

For private pod hosting, owner updates and legacy bootstrap, follow the
[Dev pod runbook](../../../docs/reference/operations/dev-pod-first-light-runbook.md).
It owns durable admission, spend, owner custody, release provenance and cleanup.

1. Record current branch/worktree state and preserve the user's development branch before branch, CI, deploy, PR, hotfix, or validation work.
2. Prefer live verification over assumptions for GitHub, CI, deploy, ruleset, and runtime state.
3. Use `./bin/hushh` as the canonical repo command surface and `gh` for live repository state. Local admin work as `kushal@hushh.ai` uses verified ADC under `admin-release-sop.md`; a stale or differently selected CLI account is not an ADC failure.
4. For merge or deploy work, follow `admin-release-sop.md` as the single state machine; verify pre-PR, DCO, current head SHA, required gates, queue state, landed SHA, post-merge smoke, and requested environment separately.
5. For core workflow chains, monitor until terminal success or a concrete blocker; queued or in-progress authority runs mean the task is not done. For iOS uploads or tester-visibility reports, apply `.agents/skills/release-ios-appstore/references/release-proof.md`, including live marketing-version and concurrent-release admission before treating a higher build number as the latest update.
6. For merge/deploy requests, keep merge-to-main and deploy-to-UAT as separate operator cadences.
7. For DB migration/contract changes, run the DB release gate before calling UAT ready. Where canonical replay coexists with pending-only overlays, verify affected installed constraints through a complete replay; matching ledger checksums alone do not prove semantic parity. Follow `docs/reference/operations/migration-governance.md` for the owning repair and rollback boundaries.
8. For local runtime/server work, follow `branch-runtime-ops.md` for visible terminal defaults, inline override, restart, health-probe rules, and the native auth-health fallback retirement gate.
9. For UAT runtime failures, start with the repo RCA command before editing or redeploying.
10. Use a pull request and the authorized Admin SOP for a reviewed, exact-head merge when appropriate. Verify the current destination, required CI and applicable approvals; admin authority never grants permission to skip validation or deploy.
11. Follow `maintainer-branch-freshness.md`: inspect the actual destination and reconcile relevant stable fixes during development. Branch age alone does not block a merge; queue validation proves the combined result. Preserve shared history and run affected checks after conflict resolution. A source sync never deploys.
12. GitHub teams own access membership. Only authorized leadership accounts may manage membership; ordinary team members must not have team-maintainer or equivalent organization authority. Never run an old roster reconciler or restore revoked access from `config/ci-governance.json` username arrays. The current `apply-governance.py` manages safeguards and never writes team membership. During the live-team migration, distinguish the Main-owned authority observer, native protected review and verified runtime enforcement; inspect the actual active admission before claiming every consumer uses current teams. Capability, permission and release-policy changes remain protected PRs. Follow `branch-governance.md` and the canonical Admin SOP; no merge or membership update deploys an application. Dev intake and direct exact-commit UAT qualification retain their independent boundaries. Governed maintainers may propose operations PRs directly into `main` by actor identity; CI, current reviews, combined-result evidence and landed smoke still apply.
13. Resolve expensive PKM and reviewer-browser verification through `scripts/ci/resolve-uat-verification-plan.py`; it is the only changed-SHA selector for deterministic preservation checks in PR, queue, post-merge, and UAT. App-browser reviewer diagnostics require the explicit UAT input and do not run automatically. Preserve non-skippable authority, migration, provenance, health, and changed-surface gates. Do not add a second path classifier or run the PKM upgrade rehearsal for ordinary UI, consent, or MCP changes.
14. When production GitHub WIF configuration is absent or drifted, use `deploy/iam/setup_production_github_wif.sh`; do not create a parallel provider, reuse UAT authority, or restore a JSON service-account key. Detect the drift with `python3 scripts/ci/verify-deploy-identity-provenance.py`, which compares that script's own literals — attribute mapping, attribute condition, deploy-account project roles — against live GCP. Its `--record-only` half needs no cloud and runs in `repo-governance-check.sh`; a refused live read reports `deploy_identity_unverifiable` and never a pass. Never restate the condition anywhere else: the setup script is the record, and a second copy is a second thing to drift.
15. Batch CI pushes and reuse unchanged evidence; never restart a run merely to monitor it. Distinguish security workflow entries from actual alerts, and preserve credential isolation and exact-attempt authority when consolidating them. See `docs/reference/operations/ci.md`.
16. Use `./bin/hushh agents ci-rerun --run-id <id> --expected-attempt <n> --sha <sha>` for one exact-source validation retry. The authenticated user needs live repository write access, not pipeline-editor approval. The helper observes attempt `n+1` and never dispatches another workflow. Retry authority grants no merge, protected-edit or deployment permission. PRs use Gitleaks with read-only credentials; repository-wide unresolved-secret clearance runs in the separate protected Deployment Security job of an explicit release. Missing credentials, incomplete inventories and stale attempts refuse release. Never restore a repository-wide token or expose the protected credential to candidate code.

The five governed destinations are `main`, `dev`, `uat`, `uat-isolated` and
`integration/pr-train`. Ordinary maintainers use the merge queue: its trusted
destination-owned authority validates the actual combined result, not branch age.
Native protected-path review remains independent on every destination; changing
CI, release policy or fundamental guidance requires the configured pipeline editors' authority.
Dev/UAT's review reduction is a staged governance operation: verify the additive
native review rules, install/read back each owner strict-status/PR guard, narrow
queue exceptions to the configured protected owners, then reduce classic blanket review.
Do not claim this source policy is live until the read-only verifier passes.
Before reducing Dev/UAT reviews, source-sync the exact Main queue/guard/classifier
blobs and policy into each destination; activation refuses stale destination code.
Installed native path partitions keep their assignments; new CI controllers use
supplemental partitions of at most 15 patterns, never an in-place coverage shift.
The trusted protected-edit classifier distinguishes CI-reachable npm script
changes (including lifecycle/transitive hooks) from dependency or local-only
script edits. Backend test additions/comments stay ordinary; removing existing
CI identities needs owner authority, and malformed/option-like entries refuse.
These controls protect authored pipeline authority, not arbitrary hostile product
or test code executing inside a test process.
`uat-isolated` retains strict classic CI and blanket review, with the
pipeline-editor Team’s qualified Admin exception through the SOP. The legacy train retains its existing safeguards.

When the authenticated user is a current pipeline editor and authored a Main, Dev, UAT or isolated UAT PR, use the
existing `queue_combined_result.py owner-merge` Admin SOP. GitHub's native queue
still refuses the author-only bypass despite a separate path-review exception;
do not remove the exact-head owner route or weaken required CI to evade it.
The direct exception requires explicit authenticated owner approval, exact head,
the current destination as an ancestor, uncontested reviews, live strict
GitHub-Actions status/PR protection and identical successful combined-tree input
evidence, checked again before submission. Other maintainers do not inherit that
queue exception. Generic organization-admin status is not merge authority.

No merge on any destination deploys an application. Dev/UAT/production deployment
remains a separate explicit, governed operation with its own source, attempt,
environment, compatibility and rollback admission.

For matching-branch Dev/UAT deployments, follow the CI runbook's
**Matching-branch release control** section. Keep the protected security token on
Main; Dev/UAT requester jobs carry only their ordinary Actions token. The existing
nonproduction WIF updater owns its observed provider condition. Verify both caller
and reusable-workflow permissions, source/attempt receipts and live admission;
source extraction alone does not activate branch routing. No merge implies deployment.

## Handoff Rules

1. Broad repo orientation starts with `repo-context`.
2. Board/project work routes to `planning-board`.
3. Docs-home governance routes to `docs-governance`.
4. GA4/Firebase/BigQuery observability routes to `analytics-observability-governance`.
5. Licensing, onboarding, subtree, and domain implementation route to their owner skills.

## Required Checks

Use focused or release governance with the exact changed files. The diagnostic
profile runs the historical full set. Missing inputs stay conservative. Run the
core mirror for cross-stage changes and `codex pre-pr` for PR impact and affected
owners. App-browser proof requires explicit diagnostics; hosted compilation and
functional contracts do not certify live browser behavior. Use an exact-source, next-attempt retry after a
diagnosed failure, and keep live authority and security gates blocking.

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
