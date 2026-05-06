# Hussh Codex Operating Rules

These repo-level instructions supplement the active Codex system/developer instructions. Follow the more specific instruction when there is a conflict.

## Project-Wide Premise Verification Gate

Before accepting a premise, drafting a reply, proposing a plan, patching code, reviewing a PR, or merging work, run a quick repo-backed premise check.

This applies to every non-trivial Codex task in this repo. The goal is to prevent drift where Codex agrees with a user or contributor claim that the repo already contradicts.

The canonical shared contract lives at `.codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md`. Use that file as the source of truth for claim labels, evidence order, domain probes, and agent handoff shape.

Use this sequence:

1. Extract the concrete claims from the prompt, especially statements like `missing`, `not implemented`, `new`, `dynamic`, `static`, `always`, `never`, `broken`, `safe`, `duplicate`, or `ready`.
2. Check the current source of truth before responding:
   - code paths
   - generated contracts
   - docs and future-state caveats
   - schemas and migrations
   - tests
   - runtime logs or CI when relevant
3. Classify each important claim as:
   - `already_exists`
   - `partially_exists`
   - `missing`
   - `future_state_only`
   - `wrong_direction`
   - `needs_verification`
4. Respond or act from that classification, not from conversational agreement.
5. If the premise is wrong, say so directly and replace it with the correct boundary.
6. If the capability already exists, do not propose a parallel path. Extend or harden the existing contract.
7. If the capability exists only transiently, name the real gap: persistence, visibility, tests, UX, docs, schema, consent, cache, or observability.
8. For high-risk surfaces such as auth, consent, vault, PKM, finance recommendations, generated action contracts, migrations, deploys, and external integrations, verify twice from independent evidence when feasible.

Default response shape for repo-backed Q&A:

1. `Correction / current truth`
2. `Useful contribution boundary`
3. `Where it should live`
4. `What not to build`
5. `Smallest acceptable next PR`

Do not write as if the project is blank. Hussh already has many shipped contracts. Codex must actively find and reuse them.

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
4. Require delegated handoffs to include claim inspected, classification, evidence checked, current repo truth, real gap, suggested boundary, blind-acceptance risk, scope, inspected surfaces, assumptions, validations, and unresolved risks.
