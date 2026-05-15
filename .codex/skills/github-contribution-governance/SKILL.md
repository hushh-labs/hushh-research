---
name: github-contribution-governance
description: Use when verifying GitHub contribution attribution, green-dot eligibility, commit author email, PR targeting, and merge readiness for Hussh work so daily contributions land on the intended GitHub profile.
---

# GitHub Contribution Governance

## Purpose and Trigger

- Primary scope: `github-contribution-governance`
- Trigger on GitHub contribution graph, green-dot, commit attribution, author-email, PR target, or merge-readiness questions for Hussh work.
- Avoid overlap with `repo-context`, `github:yeet`, and `github:gh-fix-ci`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `.codex/skills/github-contribution-governance`
2. `.codex/workflows/github-contribution-governance`

Non-owned surfaces:

1. `repo-operations`
2. `.github/workflows`
3. `docs`

## Do Use

1. Confirm active GitHub account and local Git author identity before commits.
2. Diagnose missing contribution graph, green-dot, PR target, or attribution behavior.
3. Build maintainer-harvest attribution plans that separate GitHub commit credit, public acknowledgement, and internal impact credit.

## Do Not Use

1. Do not rewrite pushed history without explicit branch-level user approval.
2. Do not merge before required checks and repo policy are understood.
3. Do not expose private verified emails.
4. Do not handle failing CI root cause; route to `github:gh-fix-ci` or `repo-operations`.

## Read First

1. `docs/reference/operations/ci.md`
2. `docs/reference/operations/branch-governance.md`
3. `.codex/skills/github-contribution-governance/references/contribution-attribution.md`

## Workflow

1. Establish active GitHub login and repo-local Git author identity.
2. If local commit email is blank, generic, or not associated with the account, set repo-local Git config before committing.
3. Before committing, confirm worktree scope and stage only files that belong to the contribution task.
4. After committing and pushing, verify attribution on the pushed commit through GitHub.
5. If there is no PR, create one against the requested base or repository default branch.
6. Do not stop at branch push for green-dot credit; use the contribution rules in `contribution-attribution.md`.
7. Monitor PR checks before merge and hand off failing CI to the CI owner.
8. For maintainer harvests, decide co-author trailers versus acknowledgement before the commit lands.

## Handoff Rules

1. Broad or ambiguous repo workflow routes back to `repo-operations`.
2. Full branch publish or PR creation can use `github:yeet` after identity is verified.
3. Failing PR checks route to `github:gh-fix-ci`.
4. Branch protection, merge queue, or deploy gates route to `repo-operations`.

## Required Checks

```bash
gh auth status
gh api user --jq '.login'
git config --get user.email
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```
