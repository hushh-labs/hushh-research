# Agent Orchestration Governance

Use this workflow pack when the task matches `agent-orchestration-governance`.

## Goal

Define or tighten repo-scoped Codex custom agents, bounded subagent limits, and delegation authority without creating a second skill system or introducing uncontrolled fan-out.

## Steps

1. Start with `agent-orchestration-governance`.
2. Open only the required reads listed in `workflow.json` plus the touched agent or skill manifests.
3. Verify first that a repo-scoped custom agent is justified; prefer existing skills and workflows when a new role boundary is unnecessary.
4. Keep repo custom agents thin, narrow, read-first, and inheritance-first by default.
5. Let model and reasoning inherit from the parent Codex session unless a future specialized lane has a documented reason to pin them.
6. Keep global limits bounded:
   - `max_threads = 6`
   - `max_depth = 1`
7. Encode authority boundaries explicitly:
   - `governor` synthesizes and recommends final outcomes
   - child agents return evidence, not final authority
8. Require every delegated child result to include:
   - scope covered
   - files or surfaces inspected
   - findings or conclusion
   - assumptions
   - validations run
   - unresolved risks
9. Treat self-maintenance as local validation plus the existing `Governance` CI lane; do not add autonomous rewrite behavior in wave 1.
10. Run the dedicated agent-orchestration validation first, then the governance check, skill lint, workflow listing, repo audit, and docs verification.
11. Hand off to `codex-skill-authoring`, `repo-context`, `repo-operations`, or `future-planner` when the task leaves orchestration governance.

## Common Drift Risks

1. using custom agents to replace skills instead of specializing execution lanes
2. allowing recursive fan-out beyond the bounded defaults
3. pinning models by default and overriding the user-selected runtime model without a documented reason
4. giving read-first agents write capability without an explicit reason
5. forgetting the workflow-pack, CI, and docs updates when adding a new owner skill
6. letting child-agent conclusions be mistaken for final merge, deploy, or governance authority
