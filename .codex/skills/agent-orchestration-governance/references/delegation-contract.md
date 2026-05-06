# Delegation Contract

Use this reference when changing repo-scoped custom agents or the orchestration rules that govern them.

The shared truth-first reasoning contract lives at `.codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md`. Delegation uses that kernel for claim labels, evidence order, domain probes, and child handoff shape.

## Baseline policy

1. Skills remain the primary knowledge and process system.
2. Workflow packs remain the primary deterministic routing and delivery system.
3. Repo-scoped custom agents are a thin execution layer for bounded role specialization and explicit parallelism.
4. Subagent use is explicit at the repo-policy level. Do not add unbounded fan-out, but repo workflows inherit a global read-only evidence-lane policy so the parent does not need to ask again for obvious specialist review.
5. The sweet spot is a small fleet of broad evidence lanes. Do not create one agent per skill; add an agent only when a recurring high-risk family crosses multiple skills and cannot be reliably covered by the current baseline.
6. Premise verification happens before delegation and before synthesis. Agents exist to gather evidence against concrete claims, not to reinforce the prompt's assumption.

## Premise Verification Before Delegation

Before routing to an agent lane, the parent must extract the important claims in the prompt and classify them against repo evidence when feasible:

1. `already_exists`
2. `partially_exists`
3. `missing`
4. `future_state_only`
5. `wrong_direction`
6. `needs_verification`

Use specialist agents to inspect claims when the surface is high-risk or cross-domain, but keep the final classification with the parent or `governor`.

Delegated prompts should ask for evidence in this shape:

1. `claim_inspected`
2. `classification`
3. `evidence_checked`
4. `current_repo_truth`
5. `real_gap`
6. `suggested_boundary`
7. `risk_if_prompt_is_accepted_blindly`
8. `scope_covered`
9. `inspected_surfaces`
10. `assumptions`
11. `validations_run`
12. `unresolved_risks`

Do not ask a child agent only "is this okay?" or "summarize this." That creates agreeable but weak evidence.

## Subagent suitability checkpoint

Before using subagents, make the decision explicit. The checkpoint is required for large PR batches, cross-domain RCA, release/deploy validation, security-sensitive reviews, or any task where independent evidence lanes can materially improve accuracy.

When the lane is not obvious, run:

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow <workflow-id> --phase start --prompt "<user request>" --paths "<comma-separated paths>" --text
```

The threshold is intentionally low once the parent has classified the work as non-trivial. A concrete prompt or path match to any specialist lane is enough to recommend a read-only evidence lane, even when the workflow id is not known. Keep trivial one-command tasks local by not invoking the router unless the task meaningfully benefits from independent evidence.

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

## Mid-Execution Recheck

Run a second delegation checkpoint during execution when new evidence reveals a different authority lane than the prompt implied. Examples:

1. A frontend-looking PR touches vault, consent, auth, or PKM trust boundaries.
2. A backend-looking PR includes DB migrations, generated contracts, or deploy/runtime config.
3. A green PR is found to duplicate an existing runtime surface.
4. A route or UI change is not reachable from the current app shell.
5. A voice, typed-search, or action change bypasses generated gateway contracts.
6. A review, merge queue, DCO, or environment signal changes after the initial plan.

Use `--phase mid` with the router and record whether the parent spawned a new read-only evidence lane or kept the work local.

## Bounded defaults

1. Keep `agents.max_threads = 6` unless a later review proves a different cap is necessary.
2. Keep `agents.max_depth = 1` unless a later review proves recursive delegation is worth the cost and predictability risk.
3. Keep wave-1 repo-scoped custom agents read-only by default.
4. Use high reasoning as the minimum for repo-scoped specialist agents. Use extra-high reasoning for governor synthesis, reviewer regression review, security/consent/vault audits, and voice/action-runtime audits.
5. Leave edits to the parent session or the built-in `worker`.

## Pre-Authorized Evidence Lanes

All repo workflows are approved to spawn read-only evidence agents automatically when the suitability checkpoint passes. Workflow-specific `delegation_policy` entries may tighten lane names or opt a workflow into more explicit reporting, but absence of that field means the workflow inherits the repo-global router policy.

Common high-signal lanes:

1. `pr-governance-review`: reviewer plus the relevant specialist lanes for the changed runtime family.
2. `autonomous-rca-governance`: RCA investigator plus repo operator, with backend/frontend/security lanes added only when the failure boundary requires them.
3. `release-readiness` and `ci-watch-and-heal`: repo operator first, then RCA investigator on failures.
4. `security-consent-audit`: security consent auditor first, with backend/frontend lanes when caller or route contracts are implicated.
5. `kai-voice-governance`: voice systems architect plus reviewer when generated contracts, planner/executor flow, or UI action parity changes.
6. `pr-governance-review`: data model architect when migrations, schema contracts, UAT parity, cache coherence, or local-first/cloud projection authority is implicated.
7. Product/docs/founder-language tasks: product docs architect when founder language, roadmap claims, One/Kai/Nav role clarity, durable docs placement, or community copy is implicated.
8. Analytics/observability tasks: analytics observability architect when GA4, Firebase Analytics, BigQuery, event taxonomy, route ids, or dashboard contracts are implicated.
9. Mobile/native tasks: mobile native architect when iOS, Android, Capacitor, native bridge, plugin registration, or device parity is implicated.

Automatic here means the parent may spawn the lane without asking the user again. It does not mean child agents can approve, merge, deploy, push, or mutate branches.

The router is advisory, not authority. If it recommends a lane that the runtime does not expose in the current session, record that runtime availability gap and continue locally or with the closest available read-only agent.

## Authority rules

1. Only `governor` produces final merge, deploy, or plan recommendations inside delegated workflows.
2. Child agents produce evidence and judgments, not final authority.
3. Child agents must not self-authorize integration, release, or governance changes.
4. Do not use repo-scoped custom agents as a second skill system; route domain behavior back to existing repo skills.

## Self-maintenance model

1. Self-maintaining means policy drift is detected automatically through local validation and the existing `Governance` CI lane.
2. Self-maintaining does not mean autonomous rewrite, bot PRs, or scheduled mutation in wave 1.
3. Any expansion of the curated wave-1 baseline should require an intentional validator update.
4. Run the fleet audit after agent, skill, or workflow changes:

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py --text
```

`update_required` means the fleet violates a hard governance rule. `review_recommended` means a human should consider whether an uncovered skill family or recurring miss deserves a new agent, a skill update, or no change.

## Required child handoff shape

Every delegated result should include:

1. `claim_inspected`
2. `classification`
3. `evidence_checked`
4. `current_repo_truth`
5. `real_gap`
6. `suggested_boundary`
7. `risk_if_prompt_is_accepted_blindly`
8. `scope_covered`
9. `inspected_surfaces`
10. `assumptions`
11. `validations_run`
12. `unresolved_risks`

## Current repo-scoped custom-agent baseline

1. `governor`: final synthesis and delegation authority.
2. `reviewer`: correctness, regression, and test-risk review.
3. `repo_operator`: CI/CD, deployment, and environment interpretation.
4. `rca_investigator`: failure classification and blast-radius analysis.
5. `frontend_architect`: frontend structure and design-system judgment.
6. `backend_architect`: backend contract and runtime-boundary judgment.
7. `data_model_architect`: data model, migration, schema contract, UAT parity, and local-first/cloud projection authority review.
8. `product_docs_architect`: durable docs, founder language, One/Kai/Nav ontology, and current-vs-future wording review.
9. `analytics_observability_architect`: analytics event contracts, telemetry topology, dashboard proof, and governed smoke review.
10. `mobile_native_architect`: iOS/Android parity, Capacitor bridge safety, and native release-readiness review.
11. `security_consent_auditor`: IAM, consent, vault, and PKM trust-boundary review.
12. `voice_systems_architect`: Kai voice runtime and contract review.

Treat this as a curated baseline, not a signal to create a large specialist lattice. Keep the default range at 8-12 repo-scoped agents unless the fleet audit and a concrete postmortem justify changing it.
