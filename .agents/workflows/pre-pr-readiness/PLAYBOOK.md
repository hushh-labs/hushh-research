# Pre-PR Readiness

Use this workflow pack before opening or updating a pull request.

## Goal

Run the same local blocking CI surface that GitHub expects for `PR Validation` and `CI Status Gate`, so failures are found locally first.

## Steps

1. Start with `repo-operations`.
2. Run the repo-operations Branch Preservation Gate before creating a task worktree or updating a PR. Keep the root checkout clean on the active base (`dev`, or `uat` when working UAT) and execute edits in an ephemeral registered task worktree from fresh `origin/<active-base>` (or continue on the named developer PR branch when active).
3. Run `./bin/hushh agents pre-pr`; it must run `bash scripts/ci/check-dco-signoff.sh` before the broader CI mirror.
4. Before every push that updates a pull request, ensure every local commit in `origin/main..HEAD` has a DCO trailer. Prefer `git commit -s`; if unsigned commits already exist, repair them with `git rebase --signoff <base>` or a clean signed squash onto `origin/main` when merge/sync commits made the history noisy.
5. After subtree sync, branch merge, rebase, queue repair, or any other history-changing operation, rerun `bash scripts/ci/check-dco-signoff.sh origin/main HEAD` immediately before pushing.
6. If the change touches `.agents/`, `docs/`, `config/`, or `scripts/`, rerun `bash scripts/ci/orchestrate.sh governance` after the last local edit.
7. Use `./bin/hushh agents pre-pr --include-advisory` only when you intentionally want the wider local release/readiness lane.
8. If the local mirror fails, fix the failing surface before opening or updating the pull request.
9. After the pull request opens, switch to `./bin/hushh agents ci-status --watch` and monitor GitHub to terminal state.
10. After an agent triggers merge, auto-merge, or merge-queue entry, keep monitoring until the authoritative chain reaches terminal state.
11. For merge-queue repos, do not stop at `queued to merge`; the minimum completion bar is:
   - queue entry confirmed
   - `Queue Validation` terminal
   - if the change lands on `main`, `Main Post-Merge Smoke` terminal
12. After the PR lands, run required downstream source syncs (`main` -> `uat`/`dev`, `uat` -> `dev`), permanently remove the temporary task worktree and branch refs once verified integrated, and leave the root checkout fast-forwarded on the active base (`dev` or `uat`).
13. Only stop at the queue stage when the user asked to queue the PR, not to see it fully land.

## Common Drift Risks

1. opening a pull request without running the local mirror
2. pushing unsigned commits and letting DCO fail on GitHub, especially after subtree sync or merge repair commits
3. changing `.agents/`, `docs/`, `config/`, or `scripts/` without rerunning the governance lane
4. adding GitHub-required checks without keeping the local mirror aligned
5. using advisory checks as the default pre-PR blocker
6. treating `merge triggered` or `queued to merge` as task completion
7. spawning redundant "phase N" branches alongside an open task worktree/branch instead of continuing cleanly
8. leaving uncleaned task worktrees or temporary branches behind, or leaving the root checkout off the active base (`dev` or `uat`)

## UI contract preflight

Before route or UI edits, follow the [Back/Search contributor scaffold](../../../docs/development/contracts/ui-contract-contributor-guide.md) and run `cd hushh-webapp && npm run ui:doctor`. Review authored cases/actions before `npm run build:ui-contracts`; finish with `npm run verify:ui-contracts` and the owning behavioral tests.
