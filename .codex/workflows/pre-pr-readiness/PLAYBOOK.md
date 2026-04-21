# Pre-PR Readiness

Use this workflow pack before opening or updating a pull request.

## Goal

Run the same local blocking CI surface that GitHub expects for `PR Validation` and `CI Status Gate`, so failures are found locally first.

## Steps

1. Start with `repo-operations`.
2. Run `./bin/hushh codex pre-pr`.
3. Use `./bin/hushh codex pre-pr --include-advisory` only when you intentionally want the wider local release/readiness lane.
4. If the local mirror fails, fix the failing surface before opening or updating the pull request.
5. After the pull request opens, switch to `./bin/hushh codex ci-status --watch` and monitor GitHub to terminal state.
6. After Codex triggers merge, auto-merge, or merge-queue entry, keep monitoring until the authoritative chain reaches terminal state.
7. For merge-queue repos, do not stop at `queued to merge`; the minimum completion bar is:
   - queue entry confirmed
   - `Queue Validation` terminal
   - if the change lands on `main`, `Main Post-Merge Smoke` terminal
8. Only stop at the queue stage when the user asked to queue the PR, not to see it fully land.

## Common Drift Risks

1. opening a pull request without running the local mirror
2. adding GitHub-required checks without keeping the local mirror aligned
3. using advisory checks as the default pre-PR blocker
4. treating `merge triggered` or `queued to merge` as task completion
