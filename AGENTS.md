# Hussh Codex Operating Rules

These repo-level instructions supplement the active Codex system/developer instructions. Follow the more specific instruction when there is a conflict.

## Project-Wide Delegation Checkpoint

At the start of every non-trivial request, run a quick delegation suitability checkpoint before choosing a local-only path.

This applies to every non-trivial Codex task in this repo, not only PR governance. Repo workflows inherit a global read-only evidence-lane policy unless a workflow explicitly opts out. For high-stakes PR governance, RCA, release readiness, security/consent review, cross-surface runtime work, schema/migration review, docs/founder-language work, voice/action-runtime work, analytics/observability work, mobile/native work, or frontend/backend contract work, use read-only evidence subagents when the suitability checkpoint passes. This is not optional ceremony: if a specialist agent can materially reduce drift or hallucination without blocking the parent, spawn it and record the lane.

Use the repo delegation router when the intent or changed paths are not obvious:

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow <workflow-id> --phase start --prompt "<user request>" --paths "<comma-separated paths>" --text
```

Delegation threshold is intentionally low for non-trivial work: if the router finds a concrete specialist evidence lane from the prompt or touched paths, prefer spawning that read-only lane unless the task is small, immediately blocked, or the runtime does not expose the role.

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

When spawning repo-scoped specialist agents, use at least high reasoning. Use extra-high reasoning for governor synthesis, reviewer regression review, security/consent/vault audits, and voice/action-runtime audits. Keep agents read-only unless the user explicitly requests worker-style code changes with a disjoint write set.

Re-run the checkpoint mid-execution when new evidence changes the shape of the task, such as discovering a trust boundary, schema migration, generated contract, deploy surface, duplicate runtime, active requested-changes review, or cross-surface caller mismatch.

Keep the repo-scoped fleet curated. The target is a small set of broad evidence lanes, not one agent per skill. Add a new agent only when repeated misses show a high-risk evidence family needs its own specialist authority, and validate that change with the agent fleet audit.

## Authority Boundary

Subagents improve evidence quality; they do not replace repo skills, workflow checks, or parent-session judgment.

1. Use repo skills first to choose the owner lane.
2. Delegate only concrete, bounded sidecar tasks.
3. Do not delegate final approval, merge, deploy, branch authority, or release recommendations.
4. Require delegated handoffs to include scope, inspected files/surfaces, findings, assumptions, validations, and unresolved risks.
