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
5. `AGENTS.md`
6. `docs/reference/operations/README.md`
7. `docs/reference/operations/coding-agent-mcp.md`

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

1. `AGENTS.md`
2. `.codex/skills/agent-orchestration-governance/references/delegation-contract.md`
3. `.codex/skills/codex-skill-authoring/references/skill-contract.md`
4. `docs/reference/operations/coding-agent-mcp.md`

## Workflow

1. Verify that a repo-scoped custom agent is actually justified before adding one; prefer skills and workflows when role specialization is not needed.
2. Keep the agent fleet at the curated sweet spot: broad evidence lanes, not one agent per skill. Add a new agent only when a recurring high-risk evidence family crosses multiple skills and existing agents have repeatedly missed it.
3. Preserve the project-wide delegation checkpoint in `AGENTS.md` before narrowing behavior in any skill or workflow:
   - use subagents only when the user explicitly allows delegation or a repo workflow/global repo policy has an approved delegation step
   - treat every non-trivial repo workflow as eligible for read-only evidence lanes when the checkpoint passes
   - treat high-stakes PR governance, RCA, release readiness, security/consent review, schema/migration review, docs/founder-language work, analytics/observability work, mobile/native work, frontend/backend contract review, and voice/action-runtime review as especially strong delegation candidates
   - use `.codex/skills/agent-orchestration-governance/scripts/delegation_router.py` at prompt intake or mid-execution when prompt/path intent is ambiguous
   - require independent evidence lanes and a concrete handoff shape
   - keep final authority with the parent session or `governor`
   - record why delegation was skipped when a high-stakes workflow stays local
4. Keep custom-agent TOML files thin:
   - define role, sandbox, nicknames, and concise behavioral instructions
   - route domain knowledge back to existing repo skills instead of copying it into agent files
   - set `default_reasoning_effort` to `high` or `xhigh`; governor, reviewer, security/consent, and voice/action agents should default to `xhigh`
5. Keep wave-1 repo custom agents read-only by default and leave edits to the parent session or the built-in `worker`.
6. Keep branch authority with the parent session and `repo-operations`:
   - delegated agents must not create, switch, delete, or push branches unless the parent explicitly scopes that as their task
   - handoffs must report if they observed branch drift, detached HEAD state, or temporary-branch risk
   - workers that edit files inherit the parent branch and must not use branch isolation as a default safety mechanism
7. Keep global limits bounded in `.codex/config.toml`:
   - `max_threads = 6`
   - `max_depth = 1`
8. Encode the authority boundary directly:
   - only `governor` produces final merge, deploy, or plan recommendations inside delegated workflows
   - child agents return evidence and judgments, not final authority
9. Require every delegated handoff to include:
   - scope covered
   - files or surfaces inspected
   - findings or conclusion
   - assumptions
   - validations run
   - unresolved risks
10. When changing this surface, keep docs and workflow routing aligned with the actual agent/config files.
11. Add a mid-execution delegation recheck to workflows that can discover new authority lanes after initial intake, especially PR governance, RCA, release readiness, and security/consent review.
12. Treat self-maintenance as drift detection plus CI enforcement, not autonomous self-rewrite or bot mutation.
13. Run the dedicated agent-orchestration validation and fleet audit first, then the router smoke tests, repo governance check, skill lint, and audit.

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
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/delegation_router.py
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py
python3 -m py_compile .codex/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
python3 .codex/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py --text
python3 .codex/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "review a PR touching voice, vault, and CI" --paths "hushh-webapp/lib/voice/foo.ts,hushh-webapp/lib/vault/foo.ts,.github/workflows/ci.yml" --text
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow new-feature-tri-flow --phase start --prompt "implement a profile route change touching vault cache and frontend loading states" --paths "hushh-webapp/app/profile/page.tsx,hushh-webapp/lib/vault/cache.ts" --text
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase start --prompt "review migration and UAT schema parity for PKM projection" --paths "consent-protocol/db/migrations/example.sql,docs/reference/architecture/data-model-governance.md" --text
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow analytics-observability-review --phase start --prompt "verify GA4 event taxonomy and BigQuery dashboard contract" --paths "hushh-webapp/lib/observability/events.ts,docs/reference/operations/observability-event-matrix.md" --text
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow mobile-parity-check --phase start --prompt "audit iOS Android Capacitor native parity for vault unlock" --paths "hushh-webapp/ios/App/App/AppDelegate.swift,hushh-webapp/android/app/build.gradle" --text
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow pr-governance-review --phase mid --prompt "review founder docs and One Kai Nav ontology drift" --paths "docs/vision/agent-ontology.md,docs/future/one-nav-runtime-plan.md" --text
./scripts/ci/repo-governance-check.sh
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh codex list-workflows
./bin/hushh codex audit
./bin/hushh docs verify
```
