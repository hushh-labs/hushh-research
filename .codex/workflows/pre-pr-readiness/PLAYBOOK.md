# Pre-PR Readiness

Use this workflow pack before opening or updating a pull request.

## Goal

Run the same local blocking CI surface that GitHub expects for `PR Validation` and `CI Status Gate`, so failures are found locally first.

## Steps

1. Start with `repo-operations`.
2. Run `./bin/hushh codex pre-pr`.
3. Before the first push, ensure every local commit destined for the pull request has a DCO trailer. Prefer `git commit -s`; if unsigned commits already exist, repair them with `git rebase --signoff <base>`.
4. If the change touches `.codex/`, `docs/`, `config/`, or `scripts/`, rerun `bash scripts/ci/orchestrate.sh governance` after the last local edit.
5. Use `./bin/hushh codex pre-pr --include-advisory` only when you intentionally want the wider local release/readiness lane.
6. If the local mirror fails, fix the failing surface before opening or updating the pull request.
7. After the pull request opens, switch to `./bin/hushh codex ci-status --watch` and monitor GitHub to terminal state.
8. After Codex triggers merge, auto-merge, or merge-queue entry, keep monitoring until the authoritative chain reaches terminal state.
9. For merge-queue repos, do not stop at `queued to merge`; the minimum completion bar is:
   - queue entry confirmed
   - `Queue Validation` terminal
   - if the change lands on `main`, `Main Post-Merge Smoke` terminal
10. Only stop at the queue stage when the user asked to queue the PR, not to see it fully land.

## Common Drift Risks

1. opening a pull request without running the local mirror
2. pushing unsigned commits and letting DCO fail on GitHub
3. changing `.codex/`, `docs/`, `config/`, or `scripts/` without rerunning the governance lane
4. adding GitHub-required checks without keeping the local mirror aligned
5. using advisory checks as the default pre-PR blocker
6. treating `merge triggered` or `queued to merge` as task completion
