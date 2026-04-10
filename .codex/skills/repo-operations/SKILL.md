---
name: repo-operations
description: Use when working on Hushh CI/CD, branch protection, merge queue, GitHub Actions, deploys, env or secret parity, Cloud Run or Cloud Build operations, UAT or production rollout, incident triage, or operational verification.
---

# Hushh Repo Operations Skill

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

## Do Use

1. Failing CI or GitHub Actions investigation.
2. Branch protection, merge queue, freshness policy, and approval-state questions.
3. UAT or production deployment work, Cloud Run or Cloud Build issues, and environment parity checks.

## Do Not Use

1. Product implementation or broad repo mapping work.
2. GitHub board/project-management workflows.
3. Documentation-home governance or frontend design-system work.

## Read First

1. `docs/reference/operations/README.md`
2. `docs/reference/operations/ci.md`
3. `docs/reference/operations/branch-governance.md`
4. `docs/reference/operations/cli.md`
5. `.codex/skills/repo-operations/references/agent-trigger-policy.md`

## Workflow

1. Prefer live verification over assumptions for GitHub, CI, deploy, and ruleset state.
2. Use `./bin/hushh` as the canonical repo command surface and `gh` for live repository state.
3. Move from diagnosis into fix-and-rerun for failures inside the repo-operations surface.
4. Monitor the resulting workflow chain until terminal success or a concrete blocker.

## Handoff Rules

1. If the task is broad repo orientation, start with `repo-context`.
2. If the task is board/project work, use `planning-board`.
3. If the task is docs-home governance, use `docs-governance`.
4. If the task is domain-specific backend or security implementation beyond repo operations, use `backend` or `security-audit`.

## Required Checks

```bash
./bin/hushh docs verify
./bin/hushh ci
./scripts/ci/verify-main-branch-protection.sh
./scripts/ci/verify-production-environment-governance.sh
```
