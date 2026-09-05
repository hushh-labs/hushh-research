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
4. `.codex/skills/repo-operations/references/admin-release-sop.md`
5. `.codex/skills/repo-operations/references/branch-runtime-ops.md`
6. `.codex/skills/repo-operations/references/maintainer-branch-freshness.md`
7. `.codex/skills/repo-operations/references/agent-trigger-policy.md`
8. `.codex/skills/repo-operations/references/anti-rationalization.md`

## Workflow

1. Record current branch/worktree state and preserve the user's development branch before branch, CI, deploy, PR, hotfix, or validation work.
2. Prefer live verification over assumptions for GitHub, CI, deploy, ruleset, and runtime state.
3. Use `./bin/hushh` as the canonical repo command surface and `gh` for live repository state.
4. For merge or deploy work, follow `admin-release-sop.md` as the single state machine; verify pre-PR, DCO, current head SHA, required gates, queue state, landed SHA, post-merge smoke, and requested environment separately.
5. For core workflow chains, monitor until terminal success or a concrete blocker; queued or in-progress authority runs mean the task is not done.
6. For merge/deploy requests, keep merge-to-main and deploy-to-UAT as separate operator cadences.
7. For DB migration/contract changes, run the DB release gate before calling UAT ready.
8. For local runtime/server work, follow `branch-runtime-ops.md` for visible terminal defaults, inline override, restart, and health-probe rules.
9. For UAT runtime failures, start with the repo RCA command before editing or redeploying.
10. For an explicit admin/direct push to `main`, run the Direct Main Admin Push Preflight in `branch-runtime-ops.md` before pushing. This proves maintainer identity, branch-protection parity, latest `origin/main`, DCO, secret hygiene, requested verification, and a clean tree; maintainer bypass is never permission to skip validation.
11. When branch freshness drift is detected, update the existing working branch using `maintainer-branch-freshness.md`, rerun DCO and changed-surface checks, then push the same branch with `--force-with-lease` only when this session owns the rewritten commits.
12. To add/remove a maintainer, repair the repository auto-merge setting, or change deploy/merge authority, edit `config/ci-governance.json` (single source of truth) then run `python3 scripts/ci/apply-governance.py --apply` to sync GitHub; MERGE AND DEPLOY ARE SEPARATE LISTS and neither implies the other, so a refused deploy is almost never the GitHub role it claims to be ("maintainer but not admin") — read the `assert-governed-actor.py` refusal line in the workflow log, which names the surface and actor, and check `<lane>.manual_dispatch_users` before touching org settings; the GitHub teams are a DERIVED MIRROR of that file and are never read by any gate, so never grant access by editing a team; the JSON edit must LAND ON MAIN for runtime UAT/merge gates to see it. Full runbook in `docs/reference/operations/branch-governance.md` ("Adding or removing a maintainer"). MERGE-TO-MAIN lane is decided by AUTHOR: governed maintainers (in `main.review_bypass_users` / `main.merge_queue_bypass_users`) shipping their own code branch from `origin/main` and open a PR DIRECTLY into `main` (the `PR Base Policy` gate passes by actor identity — no train, no cherry-pick, no promote-branch whitelist); the CI status gate, merge queue, and post-merge smoke gate still apply. Non-maintainer PRs route through `integration/pr-train`. Never cherry-pick a train-built branch onto `main` (dependency trap); branch from `origin/main` at the start instead.
13. Resolve expensive PKM and reviewer-browser verification through `scripts/ci/resolve-uat-verification-plan.py`; it is the only changed-SHA selector for PR, queue, post-merge, and UAT. Preserve non-skippable authority, migration, provenance, health, and changed-surface gates. Do not add a second path classifier or run the PKM upgrade rehearsal for ordinary UI, consent, or MCP changes.
14. When production GitHub WIF configuration is absent or drifted, use `deploy/iam/setup_production_github_wif.sh`; do not create a parallel provider, reuse UAT authority, or restore a JSON service-account key. Detect the drift with `python3 scripts/ci/verify-deploy-identity-provenance.py`, which compares that script's own literals — attribute mapping, attribute condition, deploy-account project roles — against live GCP. Its `--record-only` half needs no cloud and runs in `repo-governance-check.sh`; a refused live read reports `deploy_identity_unverifiable` and never a pass. Never restate the condition anywhere else: the setup script is the record, and a second copy is a second thing to drift.

## Handoff Rules

1. Broad repo orientation starts with `repo-context`.
2. Board/project work routes to `planning-board`.
3. Docs-home governance routes to `docs-governance`.
4. GA4/Firebase/BigQuery observability routes to `analytics-observability-governance`.
5. Licensing, onboarding, subtree, and domain implementation route to their owner skills.

## Required Checks

```bash
./bin/hushh codex ci-status
./bin/hushh codex pre-pr
./bin/hushh codex rca --surface uat --text
./bin/hushh docs verify
./bin/hushh ci
./scripts/ci/verify-main-branch-protection.sh
./scripts/ci/apply-governance.py
./scripts/ci/verify-production-environment-governance.sh
```
