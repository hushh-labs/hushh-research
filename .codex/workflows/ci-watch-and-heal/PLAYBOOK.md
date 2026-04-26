# CI Watch And Heal

Use this workflow pack when the task matches `ci-watch-and-heal`.

## Goal

Monitor PR checks live, classify failures into the correct owner skill, and keep the fix-and-rerun loop tight until CI reaches a terminal state or a real blocker is identified.

## Steps

1. Start with `repo-operations` and use `owner skill only` as the default narrow path.
2. Run the repo-operations Branch Preservation Gate: identify the active developer branch, keep fixes on it when safe, and record it as the return target before any merge, checkout, or hotfix branch.
3. Run `./bin/hushh codex ci-status --watch` on the active PR or current branch.
4. Distinguish the failing stage before editing code:
   `PR Validation` is developer feedback, `Queue Validation` is the authoritative pre-merge blocker, and `Main Post-Merge Smoke` is the merge-to-main completion gate on the real `main` SHA.
5. If the change lands on `main`, continue the monitoring chain through `Main Post-Merge Smoke`. Continue into `Deploy to UAT` only when the user explicitly asked for a UAT deployment or that dispatch has already started.
6. If the fix landed on `main` or an isolated hotfix branch, back-sync the landed `origin/main` commits into the preserved developer branch before handoff.
7. Route each failed check through the owner skill suggested by the monitor before editing code.
8. Pull the failing job logs, apply the smallest fix that addresses the actual check failure, and rerun the local parity bundle.
9. Capture every field listed in `impact_fields` before calling the work complete.

## Common Drift Risks

1. treating CI monitoring as manual follow-up instead of active ownership
2. fixing the wrong subsystem because the failing job was not classified first
3. treating queue failures and post-merge smoke failures as the same class of problem
4. rerunning once and walking away before terminal green
5. treating every merge as an implicit UAT deploy instead of a separate explicit cadence
6. creating or staying on a temporary branch when the existing developer branch should carry the follow-up
7. landing a hotfix on `main` without back-syncing it into the preserved developer branch
