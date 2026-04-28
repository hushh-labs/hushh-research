# Delegation Contract

Use this reference when changing repo-scoped custom agents or the orchestration rules that govern them.

## Baseline policy

1. Skills remain the primary knowledge and process system.
2. Workflow packs remain the primary deterministic routing and delivery system.
3. Repo-scoped custom agents are a thin execution layer for bounded role specialization and explicit parallelism.
4. Subagent use is explicit only. Do not add instructions that auto-fan-out by default.

## Subagent suitability checkpoint

Before using subagents, make the decision explicit. The checkpoint is required for large PR batches, cross-domain RCA, release/deploy validation, security-sensitive reviews, or any task where independent evidence lanes can materially improve accuracy.

Use subagents when all of these are true:

1. The user has explicitly allowed delegation or the active workflow has an approved delegation step.
2. The work can be split into independent lanes that do not need the next parent action immediately.
3. Each lane has a concrete evidence target, such as backend contract, frontend caller, CI/deploy, security/consent, tests, or docs.
4. The parent session can continue useful non-overlapping work while children inspect evidence.
5. Final authority stays with the parent session or `governor`; child agents only return evidence and judgments.

Keep the work local when any of these are true:

1. The task is a small single-surface change or review.
2. The next parent action is blocked on the result, making delegation slower than direct inspection.
3. The task requires branch switching, merging, approval, deployment, or credential handling.
4. The work is tightly coupled enough that parallel agents would duplicate effort or create inconsistent assumptions.
5. The user asked for information only and did not authorize delegation.

When the checkpoint chooses not to delegate, record the reason briefly in the parent response or working report for high-stakes workflows.

## Bounded defaults

1. Keep `agents.max_threads = 6` unless a later review proves a different cap is necessary.
2. Keep `agents.max_depth = 1` unless a later review proves recursive delegation is worth the cost and predictability risk.
3. Keep wave-1 repo-scoped custom agents read-only by default.
4. Let model and reasoning inherit from the parent Codex session by default; pinning is an exception for future specialized lanes.
5. Leave edits to the parent session or the built-in `worker`.

## Authority rules

1. Only `governor` produces final merge, deploy, or plan recommendations inside delegated workflows.
2. Child agents produce evidence and judgments, not final authority.
3. Child agents must not self-authorize integration, release, or governance changes.
4. Do not use repo-scoped custom agents as a second skill system; route domain behavior back to existing repo skills.

## Self-maintenance model

1. Self-maintaining means policy drift is detected automatically through local validation and the existing `Governance` CI lane.
2. Self-maintaining does not mean autonomous rewrite, bot PRs, or scheduled mutation in wave 1.
3. Any expansion of the curated wave-1 baseline should require an intentional validator update.

## Required child handoff shape

Every delegated result should include:

1. `scope covered`
2. `files or surfaces inspected`
3. `findings or conclusion`
4. `assumptions`
5. `validations run`
6. `unresolved risks`

## Current repo-scoped custom-agent baseline

1. `governor`: final synthesis and delegation authority.
2. `reviewer`: correctness, regression, and test-risk review.
3. `repo_operator`: CI/CD, deployment, and environment interpretation.
4. `rca_investigator`: failure classification and blast-radius analysis.
5. `frontend_architect`: frontend structure and design-system judgment.
6. `backend_architect`: backend contract and runtime-boundary judgment.
7. `security_consent_auditor`: IAM, consent, vault, and PKM trust-boundary review.
8. `voice_systems_architect`: Kai voice runtime and contract review.

Treat this as a curated baseline, not a signal to create a large specialist lattice.
