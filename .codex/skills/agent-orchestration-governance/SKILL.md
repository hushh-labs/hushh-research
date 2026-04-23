---
name: agent-orchestration-governance
description: Use when changing repo-scoped Codex custom agents, subagent concurrency or depth, delegation policy, or handoff verification rules in hushh-research.
---

# Hussh Agent Orchestration Governance Skill

## Purpose and Trigger

- Primary scope: `agent-orchestration-governance-intake`
- Trigger on repo-scoped Codex custom-agent authoring, `.codex/config.toml` subagent limits, delegation policy, child handoff contracts, or workflow changes that govern how Codex orchestrates bounded parallel work in this repo.
- Avoid overlap with `codex-skill-authoring` for generic skill taxonomy changes and `repo-context` for broad repository intake.

## Coverage and Ownership

- Role: `owner`
- Owner family: `agent-orchestration-governance`

Owned repo surfaces:

1. `.codex/agents`
2. `.codex/config.toml`
3. `.codex/skills/agent-orchestration-governance`
4. `.codex/workflows/agent-orchestration-governance`
5. `docs/reference/operations/README.md`
6. `docs/reference/operations/coding-agent-mcp.md`

Non-owned surfaces:

1. `repo-context`
2. `codex-skill-authoring`
3. `repo-operations`
4. `future-planner`

## Do Use

1. Adding or tightening project-scoped custom agents under `.codex/agents/`.
2. Changing repo-level concurrency or depth limits under `.codex/config.toml`.
3. Defining or tightening delegation boundaries, authority rules, or child handoff structure.
4. Keeping repo-scoped agent behavior thin and routed through existing skills instead of duplicating domain guidance.
5. Validating that repo custom agents stay read-first unless a narrower exception is deliberate and documented.

## Do Not Use

1. Broad repo scans that should start with `repo-context`.
2. Generic skill creation or taxonomy work that belongs to `codex-skill-authoring`.
3. Domain implementation work in frontend, backend, security, or repo operations after the correct owner lane is already clear.
4. Recursive multi-agent expansion beyond the bounded defaults unless a later review explicitly proves the need.

## Read First

1. `.codex/skills/agent-orchestration-governance/references/delegation-contract.md`
2. `.codex/skills/codex-skill-authoring/references/skill-contract.md`
3. `docs/reference/operations/coding-agent-mcp.md`

## Workflow

1. Verify that a repo-scoped custom agent is actually justified before adding one; prefer skills and workflows when role specialization is not needed.
2. Keep custom-agent TOML files thin:
   - define role, sandbox, nicknames, and concise behavioral instructions
   - route domain knowledge back to existing repo skills instead of copying it into agent files
   - let model and reasoning inherit from the parent Codex session by default
3. Keep wave-1 repo custom agents read-only by default and leave edits to the parent session or the built-in `worker`.
4. Keep global limits bounded in `.codex/config.toml`:
   - `max_threads = 6`
   - `max_depth = 1`
5. Encode the authority boundary directly:
   - only `governor` produces final merge, deploy, or plan recommendations inside delegated workflows
   - child agents return evidence and judgments, not final authority
6. Require every delegated handoff to include:
   - scope covered
   - files or surfaces inspected
   - findings or conclusion
   - assumptions
   - validations run
   - unresolved risks
7. When changing this surface, keep docs and workflow routing aligned with the actual agent/config files.
8. Treat self-maintenance as drift detection plus CI enforcement, not autonomous self-rewrite or bot mutation.
9. Run the dedicated agent-orchestration validation first, then the repo governance check, skill lint, and audit.

## Handoff Rules

1. Route broad repo intake to `repo-context`.
2. Route generic skill-system authoring or taxonomy maintenance to `codex-skill-authoring`.
3. Route CI, deploy, or runtime-governance follow-up to `repo-operations`.
4. Route future-state agent-lattice planning or expansion reviews to `future-planner`.
5. Route domain-specific implementation work back to the relevant owner skill once orchestration policy is settled.

## Required Checks

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py
./scripts/ci/repo-governance-check.sh
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh codex list-workflows
./bin/hushh codex audit
./bin/hushh docs verify
```
