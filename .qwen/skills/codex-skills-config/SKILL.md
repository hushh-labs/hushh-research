---
name: codex-bridge
description: |
  Auto-triggers on any repo-scoped task. Routes user prompts to the correct
  skill, workflow, or specialist agent by token-scoring against .codex/ manifests.
  Composes a briefing (union of workflow + owner_skill + default_spoke fields),
  runs the delegation checkpoint, and executes the Playbook.
  Covers: consent-protocol, Operons, HCT, Kai, MCP, IAM, PKM, vault, backend,
  frontend, mobile, security, docs, comms, ops, skill authoring, and any new
  specialist added under .codex/ later.
argument-hint: "[skill-or-workflow-name | --list | --check | --coverage | free-text]"
paths:
  - .codex/**
  - consent-protocol/**
  - hushh-webapp/**
  - docs/**
  - AGENTS.md
  - CODEX_SKILLS_CONFIG.md
  - .claude/skills/codex-bridge/**
---

# Qwen Codex Bridge

## Auto-trigger

This skill activates automatically when the user's prompt or changed paths touch any of the `paths` above. Treat every activation as a signal to route, not to improvise.

## Quick mental model

```
User Prompt
    ↓
Token-score against .codex/skills/* + .codex/workflows/* + .codex/agents/*
    ↓
Exact match wins → score wins → catalog
    ↓
Compose briefing: workflow.owned_skill + workflow.default_spoke → union(required_reads, required_commands, handoff_chain, verification_bundle)
    ↓
Run delegation checkpoint (AGENTS.md threshold)
    ↓
Execute Playbook verbatim → run verification_bundle → handoff on drift
```

## Response rules (Qwen defaults)

When `.codex/` is unreachable (tests, isolated invocations):

1. **3-4 line prose**, Discord-casual tone, no em-dashes.
2. Full GitHub URLs on `main` for doc links.
3. Signature line: `_Routed to: <skill-id> | <workflow-id>_` (pull from briefing; never fabricate).
4. If a disambiguation table or catalog appears, do NOT fabricate a signature — invoke the bridge again with the chosen name first.

## Invocation patterns

```
/codex-bridge                                # Catalog of owners, spokes, workflows, agents
/codex-bridge backend-api-contracts          # Compose skill briefing
/codex-bridge security-consent-audit         # Compose workflow briefing (owner+spoke unioned)
/codex-bridge governor                       # Compose agent briefing (delegation lane)
/codex-bridge "how does Kai maintain session continuity"  # Free-text → token scoring
/codex-bridge --check                        # Structural lint of .codex tree
/codex-bridge --coverage                     # Skill/workflow coverage report
/codex-bridge --list                         # Alias for --list (catalog)
```

## Routing logic (execute this every activation)

### Step 1 — Check for exact match

```bash
# Walk .codex/skills/*/SKILL.md frontmatter (name field)
# Walk .codex/workflows/*/workflow.json (id field)
# Walk .codex/agents/*.toml (name field)
# Case-insensitive exact match against user prompt (trimmed)
# If prefix match yields exactly one → use it
```

### Step 2 — Token scoring (if no exact match)

Score each skill:
```
score = 6*(query_tokens ∩ name_tokens)
      + 4*(query_tokens ∩ description_tokens)
      + 5*(query_tokens ∩ task_types_tokens)
      + 4*(query_tokens ∩ primary_scope_tokens)
      + 2*(query_tokens ∩ owner_family_tokens)
      + 1*(query_tokens ∩ adjacent_skills_tokens)
      + 2*for_each(owned_path contains any query_token)
```

Score each workflow:
```
score = 6*(query_tokens ∩ name_tokens)
      + 4*(query_tokens ∩ description_tokens)
      + 5*(query_tokens ∩ task_type_tokens)
      + 3*(query_tokens ∩ goal_tokens)
      + 3*(query_tokens ∩ title_tokens)
      + 2*(query_tokens ∩ deliverables_tokens)
      + 1*for_each(affected_surface contains any query_token)
```

Score each agent:
```
score = 6*(query_tokens ∩ name_tokens)
      + 4*(query_tokens ∩ nickname_candidates_tokens)
      + 4*(query_tokens ∩ description_tokens)
      + 2*(query_tokens ∩ developer_instructions skill_refs_tokens)
      + 1*(query_tokens ∩ priority_headings_tokens)
```

**Rules:**
- Highest score wins. If a workflow and skill tie, prefer the workflow.
- If top score < 10 → catalog (no strong match).
- If two entries within 20% of top → disambiguation table.

### Step 3 — Path-aware boost

If changed paths are visible, add +3 for each `.codex/` skill whose `owned_paths` contains a matching path prefix.

### Step 4 — Compose briefing

For a workflow match, union fields from:
- `workflow.json` (required_reads, required_commands, handoff_chain, verification_bundle, common_failures)
- `owner_skill`'s skill.json/SKILL.md (same fields)
- `default_spoke`'s skill.json/SKILL.md (same fields, if present)

For a skill match, surface its required_reads, required_commands, handoff_chain, verification_bundle, risk_tags.

For an agent match, surface its developer_instructions, nickname_candidates, default_reasoning_effort, sandbox_mode.

## Delegation checkpoint (AGENTS.md policy)

**Run at start of every non-trivial task.** Before choosing a local-only path:

### Spawn a read-only subagent when ALL are true:

1. User has allowed delegation OR the active workflow has an approved delegation step.
2. Task can split into independent evidence lanes (backend contracts, frontend callers, CI/deploy, security/consent, tests, docs, RCA).
3. Next parent action is NOT blocked on the delegated result.
4. Parent session can keep working on non-overlapping work while subagents inspect evidence.
5. Final authority stays with parent session or repo `governor`; subagents return evidence, not final decisions.

### Keep work local when ANY are true:

1. Task is small, single-surface, or faster to verify directly.
2. Next action depends immediately on the result.
3. Task involves: branch switching, approval, merge, deploy, credential handling, secrets.
4. Parallel agents would duplicate effort or create inconsistent assumptions.
5. User has not allowed delegation.

### High-stakes triggers (lean toward delegation):

PR governance, RCA, release readiness, security/consent review, cross-surface runtime work, schema/migration review, docs/founder-language work, voice/action-runtime work, analytics/observability work, mobile/native work, frontend/backend contract work.

### Re-checkpoint mid-execution when:

New evidence surfaces: trust boundary, schema migration, generated contract, deploy surface, duplicate runtime, active requested-changes review, cross-surface caller mismatch.

### Parent-only actions (NEVER delegate):

`approve`, `approval`, `merge`, `queue`, `deploy`, `git push`, `push branch`, `push to`, `force-push`, `credential`, `secret`, `branch switch`, `checkout`

### Delegation command:

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py \
  --workflow <workflow-id> --phase start|mid \
  --prompt "<user request>" --paths "<comma-separated paths>" --text
```

### Agent reasoning levels:

| Agent | Reasoning | Domain |
|-------|-----------|--------|
| `governor` | xhigh | Top-level orchestration, evidence synthesis |
| `reviewer` | xhigh | Correctness, regressions, security-adjacent issues |
| `backend_architect` | high | Route placement, service boundaries, API correctness |
| `frontend_architect` | high | Route placement, shell integrity, design-system |
| `security_consent_auditor` | xhigh | IAM, consent, vault, PKM, trust-boundary |
| `mobile_native_architect` | high | iOS/Android/Capacitor parity |
| `rca_investigator` | xhigh | Root cause analysis, incident investigation |
| `analytics_observability_architect` | high | Analytics, telemetry, GA4, Firebase, BigQuery |
| `data_model_architect` | high | Schema, migration, data-plane contracts |
| `voice_systems_architect` | xhigh | Kai voice/action runtime |
| `product_docs_architect` | high | Documentation architecture, founder language |
| `repo_operator` | high | CI/CD, deploy, branch governance, release ops |

## How to execute what's routed

### A single skill or workflow briefing

Treat it as the instruction set:

1. **Scope check.** Honor the skill's "Do Use" / "Do Not Use", `primary_scope`, `owned_paths`. If the task falls outside, invoke `/codex-bridge <handoff-target>` instead of improvising.
2. **Read first.** Open every `.md` under "Read First (composed)" before touching code.
3. **Follow the Playbook verbatim.** That's what the routing has already decided works.
4. **Run the composed Required Checks** before declaring done.
5. **Hand off on drift.** If work expands, stop and `/codex-bridge <next>` — usually the next entry in `handoff_chain`.

### An ambiguity / disambiguation table

Multiple skills scored close. Prefer the spoke over the owner when both match. Prefer a workflow over a bare skill when a workflow is listed.

### A catalog

No strong match (top score < 10). Surface the catalog. Pick by description, re-invoke `/codex-bridge <name>`.

### An agent briefing (NOT instructions to execute)

The matched entry is a repo-scoped custom agent (under `.codex/agents/`). Treat it as a **delegation lane**, not instructions to execute directly:

1. Run the project delegation checkpoint from `AGENTS.md` before deciding.
2. If a repo workflow or global policy authorizes read-only evidence lanes and the checkpoint passes, invoke the relevant agent lane without a separate user confirmation.
3. Ask the user first only for write-capable workers, branch operations, merge, deploy, secrets, or final approval authority.
4. When the briefing appears as `Suggested delegation lanes` on a skill/workflow briefing, treat it as evidence-lane context and execute the primary briefing normally.

### A `--check` report

Surface findings to the user. Don't auto-fix — `--check` is a health report, not a migration.

## Qwen-specific optimizations

### Tool usage patterns

```
# For routing (read-only):
Read   → .codex/skills/*/SKILL.md, .codex/workflows/*/workflow.json, .codex/agents/*.toml
Grep   → Search for skill names, workflow IDs, agent names in prompts
Glob   → Discover .codex/ tree structure

# For execution (after routing):
Bash   → python3 .codex/scripts/route.py <args>
Bash   → python3 .codex/skills/*/scripts/*.py (skill-specific checks)
Bash   → python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py
```

### Vision capabilities

Use vision to:
- Inspect UI layouts in `hushh-webapp/` components for frontend parity checks.
- Review screenshots in mobile parity audits.
- Verify design system compliance against tailwind/Tailwind config.

### Context window management

- Only load the **routed briefing** into context, not the full `.codex/` corpus.
- Progressive disclosure: read required_reads first, then the Playbook, then verification_bundle.
- When running `--check` or `--coverage`, process output in batches.

### Delegation decision shortcut

For this repo, the delegation threshold is intentionally **low**. If the router finds a concrete specialist lane, lean toward spawning it unless the task is small or immediately blocked. Record the decision: `Subagent checkpoint: <delegated|not-delegated> because <reason>.`

## Authority boundary

Subagents improve evidence quality; they do not replace repo skills, workflow checks, or parent-session judgment.

1. Use repo skills first to choose the owner lane.
2. Delegate only concrete, bounded sidecar tasks.
3. Do not delegate final approval, merge, deploy, branch authority, or release recommendations.
4. Require delegated handoffs to include scope, inspected files/surfaces, findings, assumptions, validations, and unresolved risks.

### What the Parent Session Retains
- Final approval, merge, deploy, branch authority
- Release recommendations
- Credential and secret handling
- Branch switching and creation

### What Subagents Return
- Evidence: scope, files inspected, findings, assumptions, validations, unresolved risks
- Judgments: architectural correctness, trust-boundary safety, contract alignment
- Recommendations: with explicit tradeoffs, not final decisions

### Extra-High Reasoning Required For
- Governor synthesis
- Reviewer regression review
- Security/consent/vault audits
- Voice/action-runtime audits

## Mid-Execution Recheck Triggers

Re-run the delegation checkpoint when:
- Discovering a trust boundary
- Schema migration discovered
- Generated contract found
- Deploy surface identified
- Duplicate runtime detected
- Active requested-changes review present
- Cross-surface caller mismatch found

## Documentation Architecture

### Strict Documentation-Home Model
```
docs/                          → Cross-cutting repo contracts
├── reference/                 → Execution-owned contracts
│   ├── architecture/          → 7-layer stack, API contracts, data model
│   ├── iam/                   → IAM, consent, marketplace
│   ├── kai/                   → Kai architecture, voice, runtime
│   ├── mobile/                → Capacitor parity
│   ├── operations/            → Governance, CI, brand, docs
│   ├── quality/               → Design system, PR impact, analytics
│   └── streaming/             → Streaming contracts
├── vision/                    → Product thesis, agent ontology
├── future/                    → Planning-only (not shipped)
└── guides/                    → Bootstrap, runtime, onboarding

consent-protocol/docs/         → Backend/protocol package docs
hushh-webapp/docs/             → Frontend/native package docs
```

### Founder Language Matrix
Dual-label terminology contract — lead with founder terms for architecture meaning, follow with implementation labels for engineering precision. Never present future-state as shipped without checked-in runtime proof.

## Verification Commands

### Skill Health
```bash
./bin/hushh codex audit
./bin/hushh codex scan summary
./bin/hushh codex list-workflows
```

### Agent Fleet
```bash
python3 .codex/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py --text
python3 .codex/skills/agent-orchestration-governance/scripts/agent_router_smoke.py
```

### Documentation
```bash
./bin/hushh docs verify
```

### CI
```bash
./bin/hushh ci
./bin/hushh test
```

## Key Files Reference

| File | Purpose |
|------|---------|
| `AGENTS.md` | Project-wide delegation checkpoint + authority boundary |
| `.claude/skills/codex-bridge/SKILL.md` | Codex Bridge skill (routing entry point) |
| `.codex/config.toml` | Global agent limits |
| `.codex/agents/governor.toml` | Top-level orchestration agent |
| `.codex/agents/reviewer.toml` | Correctness/risk reviewer |
| `.codex/agents/security_consent_auditor.toml` | Trust-boundary auditor |
| `.codex/skills/agent-orchestration-governance/SKILL.md` | Agent orchestration governance |
| `.codex/skills/agent-orchestration-governance/scripts/delegation_router.py` | Delegation decision engine |
| `.codex/skills/repo-context/SKILL.md` | Repo orientation + routing |
| `.codex/skills/codex-skill-authoring/SKILL.md` | Skill creation/retrofitting |
| `.codex/skills/codex-skill-authoring/references/skill-contract.md` | Skill contract specification |
| `.codex/skills/agent-orchestration-governance/references/delegation-contract.md` | Delegation policy |
| `.codex/skills/repo-context/references/ownership-map.md` | Owner/spoke routing map |
| `.codex/skills/repo-context/references/index-contract.md` | Repo context index contract |
| `docs/reference/architecture/architecture.md` | Seven-layer platform architecture |
| `docs/reference/architecture/founder-language-matrix.md` | Terminology contract |
| `docs/reference/operations/branch-governance.md` | Branch + deploy governance |
| `docs/reference/operations/documentation-architecture-map.md` | Docs home map |
| `docs/reference/operations/brand-and-compatibility-contract.md` | Brand naming rules |
| `docs/reference/operations/coding-agent-mcp.md` | MCP server operations |
| `docs/reference/iam/consent-scope-catalog.md` | Consent scope templates |
| `docs/project_context_map.md` | Contributor/agent orientation |

## Reuse Guide

### For Other Projects

To adapt this system to another repo:

1. **Copy the structure:** `.codex/skills/`, `.codex/workflows/`, `.codex/agents/`, `.codex/config.toml`
2. **Define your owner skills:** One per major domain in your project
3. **Define your spoke skills:** Narrow paths within each owner
4. **Define your workflows:** Recurring execution shapes as `workflow.json` + `PLAYBOOK.md`
5. **Define your agents:** Read-only specialists for high-risk evidence lanes
6. **Write the delegation router:** Term + path-prefix matching for your domain
7. **Write the Codex Bridge:** Token-scoring + briefing composition for your taxonomy
8. **Set authority boundaries:** What the parent retains vs. what can be delegated
9. **Set global limits:** `max_threads` and `max_depth` appropriate for your project size

### Minimal Viable Setup

```
.codex/
├── config.toml              # [agents] max_threads = 4, max_depth = 1
├── agents/
│   └── reviewer.toml        # At minimum: one correctness reviewer
├── skills/
│   ├── repo-context/        # Broad repo orientation
│   └── <domain>/            # One per major domain
│       ├── SKILL.md
│       └── skill.json
└── workflows/
    └── <workflow-id>/
        ├── workflow.json
        └── PLAYBOOK.md
```
