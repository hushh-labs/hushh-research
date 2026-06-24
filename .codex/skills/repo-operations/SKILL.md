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
4. `.codex/skills/repo-operations/references/branch-runtime-ops.md`
5. `.codex/skills/repo-operations/references/agent-trigger-policy.md`

## Workflow

1. Record current branch/worktree state and preserve the user's development branch before branch, CI, deploy, PR, hotfix, or validation work.
2. Prefer live verification over assumptions for GitHub, CI, deploy, ruleset, and runtime state.
3. Use `./bin/hushh` as the canonical repo command surface and `gh` for live repository state.
4. For PR work, verify pre-PR, DCO, current head SHA, required gates, queue state, and post-merge smoke.
5. For core workflow chains, monitor until terminal success or a concrete blocker; queued or in-progress authority runs mean the task is not done.
6. For merge/deploy requests, keep merge-to-main and deploy-to-UAT as separate operator cadences.
7. For DB migration/contract changes, run the DB release gate before calling UAT ready.
8. For local runtime/server work, follow `branch-runtime-ops.md` for visible terminal defaults, inline override, restart, and health-probe rules.
9. For UAT runtime failures, start with the repo RCA command before editing or redeploying.

## Maintainer Allowlist & Merge-to-Main (standardized — do this once)

`config/ci-governance.json` is the SINGLE SOURCE OF TRUTH for who can approve/merge
to `main` and who can deploy. Editing that file is the ONLY thing a maintainer
authors; one apply command pushes the intent to GitHub. Never click GitHub
settings by hand — that is exactly what drifts.

The four allowlists in `config/ci-governance.json`:

1. `main.review_bypass_users` — can satisfy the required review on `main`
   (a single-maintainer PR can self-clear the approval gate).
2. `main.merge_queue_bypass_users` — backed by the org team
   `allowed-maintainers-to-approve`; team membership IS this list.
3. `uat.manual_dispatch_users` — can run the UAT deploy workflow.
4. `production.manual_dispatch_users` — can run the production deploy (kept tiny).

### To add (or remove) a maintainer — end to end

```bash
# 1. Edit the JSON. Add the GitHub login to the relevant list(s). For a full
#    maintainer add the login to: main.review_bypass_users,
#    main.merge_queue_bypass_users, and uat.manual_dispatch_users.
#    (production stays restricted — add only on explicit owner instruction.)

# 2. Push the intent to GitHub (idempotent; dry-run first).
python3 scripts/ci/apply-governance.py            # dry-run: shows the plan
python3 scripts/ci/apply-governance.py --apply    # writes branch protection + team

# 3. Confirm zero drift.
./scripts/ci/verify-main-branch-protection.sh     # must print ✅, no ERROR lines

# 4. Land the JSON change through the train (it is a protected_pipeline_path).
```

Why both an apply AND a verify script: `apply-governance.py` is the write side
(JSON -> GitHub); `verify-main-branch-protection.sh` is the read side (drift
detection, runs in CI). They are mirror images. If verify ever reports drift,
run apply.

### "How do I merge my own PR to main?" (maintainer FAQ)

Direct topic-branch PRs into `main` are blocked by `PR Base Policy`. Two
sanctioned paths:

- DEFAULT: target `integration/pr-train`. The train promotes to `main`.
- PROMOTION (maintainer fast-path): branch named `maintainer/promote-*`, add
  that exact branch name to `branch_flow.main_allowed_head_branches` (same JSON),
  open the PR to `main`. Because you are in `main.review_bypass_users` and
  `merge_queue_bypass_users` (after step 2 above), you can approve + enqueue your
  own promotion PR. `gh pr merge <n> --squash --admin` works for the cohort.

UAT deploy needs NO GitHub sync — `scripts/ci/assert-governed-actor.py` reads
`uat.manual_dispatch_users` from the JSON at workflow runtime. Being in the list
is sufficient.

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
./scripts/ci/apply-governance.py            # write side: sync ci-governance.json -> GitHub (use --apply)
./scripts/ci/verify-production-environment-governance.sh
```
