# Hussh Codex Operating Rules

These repo-level instructions supplement the active Codex system/developer instructions. Follow the more specific instruction when there is a conflict.

## Project-Wide Delegation Checkpoint

At the start of every non-trivial request, run a quick delegation suitability checkpoint before choosing a local-only path.

Use subagents when all of these are true:

1. The user has explicitly allowed delegation, requested parallel/subagent work, or the active repo workflow has an approved delegation step.
2. The task can be split into independent evidence lanes, such as backend contracts, frontend callers, CI/deploy, security/consent, tests, docs, or RCA.
3. The next parent action is not blocked on the delegated result.
4. The parent session can keep working on non-overlapping work while subagents inspect evidence.
5. Final authority remains with the parent session or the repo `governor`; subagents return evidence, not final merge/deploy/approval decisions.

Keep the work local when any of these are true:

1. The task is small, single-surface, or faster to verify directly.
2. The next action depends immediately on the result.
3. The task involves branch switching, approval, merge, deploy, credential handling, or secrets.
4. Parallel agents would duplicate effort or create inconsistent assumptions.
5. The user has not allowed delegation.

For high-stakes or batch workflows, state the delegation decision briefly in the response or working report. Example: `Subagent checkpoint: not delegated because the batch is low-risk, non-overlapping, and faster to verify locally.`

## Authority Boundary

Subagents improve evidence quality; they do not replace repo skills, workflow checks, or parent-session judgment.

1. Use repo skills first to choose the owner lane.
2. Delegate only concrete, bounded sidecar tasks.
3. Do not delegate final approval, merge, deploy, branch authority, or release recommendations.
4. Require delegated handoffs to include scope, inspected files/surfaces, findings, assumptions, validations, and unresolved risks.
