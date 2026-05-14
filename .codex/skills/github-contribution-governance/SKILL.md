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

1. Confirm the active GitHub account before committing, pushing, opening PRs, or merging.
2. Verify local Git author identity before creating new commits.
3. Diagnose why a commit, branch, or PR is not showing on the GitHub contribution graph.
4. Keep daily contribution work on a PR path into `main`, `develop`, or the repository default branch.
5. Check that GitHub attributes pushed commits to the intended account via the GitHub API.

## Do Not Use

1. Do not rewrite already-pushed history without an explicit user request for the exact branch.
2. Do not merge a PR before required checks and repository policy are understood.
3. Do not expose private verified emails from `gh api user/emails`; summarize whether a verified address exists.
4. Do not treat a pushed feature branch as green-dot complete until GitHub shows an eligible PR or default-branch path.
5. Do not handle failing CI root cause here; route that to `github:gh-fix-ci` or `repo-operations`.

## Read First

1. `docs/reference/operations/ci.md`
2. `docs/reference/operations/branch-governance.md`
3. `https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference`
4. `https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions`
5. `https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address`

## Workflow

1. Establish identity:
   - run `gh auth status`
   - run `gh api user --jq '.login'`
   - run `git config --get user.name` and `git config --get user.email`
2. If the local commit email is blank, generic, or not the GitHub no-reply/verified email for the active account, set repo-local Git config before committing.
3. Before committing, confirm the worktree scope and stage only files that belong to the contribution task.
4. After committing and pushing, verify attribution with:
   - `gh api repos/<owner>/<repo>/commits/<sha> --jq '{authorLogin:.author.login,email:.commit.author.email,date:.commit.author.date}'`
5. If there is no PR for the branch, create one against the requested base or the repository default branch.
6. For green-dot commit credit, do not stop at branch push. GitHub counts commits when the author email is associated with the account and the commits land on the default branch or `gh-pages`; PRs and issues can also count as contribution events when opened in a standalone repository.
7. Monitor PR checks through `./bin/hushh codex ci-status` or `gh run list` before merge. If checks fail, hand off to `github:gh-fix-ci`.
8. Merge only when repository policy allows it and the user has requested merge. After merge, verify the landed commit on `main` or the canonical base.
9. For older `.local` commits from the last working window, explain the two safe recovery paths:
   - amend/rebase those commits with the verified email and force-push the feature branch before merge
   - create a new correctly-authored follow-up commit and merge it
   Do not rewrite shared history without explicit branch-level approval.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `repo-operations`.
2. If the task is full branch publish or PR creation, use `github:yeet` after this skill verifies author identity.
3. If the PR checks fail, use `github:gh-fix-ci`.
4. If branch protection, merge queue, or deployment gates block merge, use `repo-operations`.

## Required Checks

```bash
gh auth status
gh api user --jq '.login'
git config --get user.email
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```
