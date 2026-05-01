# GitHub Contribution Governance

Use this workflow pack when the task matches `github-contribution-governance`.

## Goal

Ensure GitHub work is attributable to the intended account, visible through a PR/check path, and eligible for contribution graph credit once merged.

## Steps

1. Start with `repo-operations` and use `github-contribution-governance` as the narrow path.
2. Read the GitHub contribution docs listed in `workflow.json` when the question is about green dots or missing activity.
3. Confirm `gh auth status`, active login, local `user.email`, and the exact author identity on any relevant commit SHA.
4. If the next commit would use a generic or unverified email, set repo-local Git config before committing.
5. Confirm whether the branch has an open PR against `main`, `develop`, or the repository default branch.
6. If no PR exists and the user requested publication, hand off to `github:yeet` for PR creation.
7. Watch PR checks through `repo-operations`; hand off to `github:gh-fix-ci` for failures.
8. Merge only when the user requested merge and repo policy permits it.
9. Verify the landed commit on the eligible branch and report whether GitHub may still take up to 24 hours to refresh the contribution graph.

## Common Drift Risks

1. Branch commits are attributed to the right account but never land on the default branch.
2. Older `.local` commits cannot be linked without history rewrite or replacement commits.
3. A PR contribution appears, but commit green squares do not because the commits have not merged.
4. A self-authored PR is blocked by review, branch protection, or merge queue policy.
