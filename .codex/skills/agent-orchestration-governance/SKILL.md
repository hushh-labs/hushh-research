---
name: agent-orchestration-governance
description: Use when changing repo-scoped Codex custom agents, subagent concurrency or depth, delegation policy, or handoff verification rules in hushh-research.
---

# Hussh Agent Orchestration Governance Skill

## Purpose and Trigger

- Primary scope: `agent-orchestration-governance-intake`
- Trigger on repo-scoped custom agents, `.codex/config.toml` limits, delegation policy, child handoff contracts, or workflow orchestration changes.
- Avoid overlap with `codex-skill-authoring` for generic skill taxonomy and `repo-context` for broad repository intake.

## Coverage and Ownership

- Role: `owner`
- Owner family: `agent-orchestration-governance`

Owned repo surfaces:

1. `.codex/agents`
2. `.codex/config.toml`
3. `.codex/skills/agent-orchestration-governance`
4. `.codex/workflows/agent-orchestration-governance`
5. `AGENTS.md`
6. `docs/reference/operations/README.md`
7. `docs/reference/operations/coding-agent-mcp.md`

Non-owned surfaces:

1. `repo-context`
2. `codex-skill-authoring`
3. `repo-operations`
4. `future-planner`

## Do Use

1. Adding or tightening repo-scoped custom agents.
2. Changing subagent concurrency/depth limits or delegation policy.
3. Defining authority boundaries, parent-only actions, or child handoff shape.
4. Keeping agents thin and routed through existing master/spoke skills.

## Do Not Use

1. Broad repo scans that should start with `repo-context`.
2. Generic skill creation or taxonomy work that belongs to `codex-skill-authoring`.
3. Domain implementation after the correct owner lane is clear.
4. Recursive multi-agent expansion beyond bounded defaults without evidence.

## Read First

1. `AGENTS.md`
2. `.codex/skills/agent-orchestration-governance/references/delegation-contract.md`
3. `.codex/skills/codex-skill-authoring/references/skill-contract.md`
4. `.codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md`
5. `docs/reference/operations/coding-agent-mcp.md`

## Workflow

1. Verify that a custom agent is justified; prefer skills/workflows when role specialization is not needed.
2. Keep the fleet at the curated sweet spot: broad read-only evidence lanes, not one agent per skill.
3. Preserve the repo-wide delegation checkpoint and truth-first handoff shape in `AGENTS.md` and `delegation-contract.md`.
4. Keep custom-agent TOML files thin: role, sandbox, nicknames, concise instructions, and skill routing.
5. Keep wave-1 agents read-only and leave branch switching, writes, approval, merge, deploy, secrets, and final decisions to the parent/governor.
6. Keep global limits bounded at `max_threads = 6` and `max_depth = 1` unless a later review proves otherwise.
7. Route product-direction, founder-language, One/Kai/Nav, PKM, voice/action, and PR north-star lanes through the Founder Wiki North-Star Probe when material; repo/wiki divergence is `current_state_vs_north_star_drift`.
8. Run agent validation, fleet audit, router smoke, skill lint, and repo/docs governance checks after orchestration changes.

## Handoff Rules

1. Broad repo intake routes to `repo-context`.
2. Generic skill-system authoring routes to `codex-skill-authoring`.
3. CI, deploy, or runtime-governance follow-up routes to `repo-operations`.
4. Future-state agent-lattice planning routes to `future-planner`.
5. Domain implementation routes to the relevant owner skill.

## Required Checks

```bash
python3 .codex/skills/codex-skill-authoring/scripts/truth_first_smoke.py
python3 .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py .codex/skills/agent-orchestration-governance/scripts/delegation_router.py .codex/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py .codex/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
python3 .codex/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py --text
python3 .codex/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
./scripts/ci/repo-governance-check.sh
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh codex audit
```
