# Delegation Contract

Use this reference when changing repo-scoped custom agents or the orchestration rules that govern them.

## Baseline policy

1. Skills remain the primary knowledge and process system.
2. Workflow packs remain the primary deterministic routing and delivery system.
3. Repo-scoped custom agents are a thin execution layer for bounded role specialization and explicit parallelism.
4. Subagent use is explicit only. Do not add instructions that auto-fan-out by default.

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
