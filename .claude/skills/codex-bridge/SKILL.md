---
name: codex-bridge
description: Answers questions about and routes tasks for the hushh-research codebase. Use whenever the user asks about or wants to change anything this repo owns, including consent-protocol, Operons, HCT, Kai, MCP, IAM, PKM, vault, backend, frontend, mobile, security, docs, comms, ops, skill authoring, and any new specialist added under .codex/ later. Reads .codex/skills/ and .codex/workflows/ at invocation time, composes a briefing the way codex route-task does (workflow plus owner_skill plus default_spoke unioned), and auto-discovers any skills added to the tree without a bridge edit.
argument-hint: "[skill-or-workflow-name | --list | --check | --coverage | free-text]"
allowed-tools: Read Grep Glob Bash(python3 *)
paths:
  - .codex/**
  - consent-protocol/**
  - hushh-webapp/**
  - docs/**
---

# Codex Bridge

Reads `.codex/` at invocation time and composes a briefing the way `./bin/hushh codex route-task` does: workflow → owner_skill + default_spoke → union of `required_reads`, `required_commands`, `handoff_chain`, `verification_bundle`, `risk_tags`.

## Response rules

Codex is the source of truth. The enforceable rules live in `.codex/skills/comms-community/references/reply-rules.md` and are injected into the routed briefing whenever the query looks like Q&A (see `scripts/route.py`). Follow that file literally. If it conflicts with anything written here, it wins.

Baseline that the bridge adds on top of codex's reply rules (because codex runs in a different harness):

1. When you cannot reach `.codex/` to fetch the rules (tests, isolated invocations), default to: 3 to 4 lines of prose, Discord-casual tone, no em-dashes, markdown doc links only (full GitHub URLs on `main`), signature line at the end.
2. Pull the signature values (`<skill-id>`, `<workflow-id>`) from the routed briefing header (`# Routed workflow: ...` / `# Routed skill: ...`).
3. If the briefing header shows a disambiguation table or a catalog, do not fabricate a signature, invoke the bridge again with the chosen name first.

Anything stylistic beyond this belongs in `reply-rules.md`, not here. Edit the codex file and the bridge will pick it up on the next invocation.

## Routed briefing

!`python3 ${CLAUDE_SKILL_DIR}/scripts/route.py $ARGUMENTS`

## How to execute what's above

### A single skill or workflow briefing

Treat it as the instruction set:

1. **Scope check.** Honor the skill's "Do Use" / "Do Not Use", `primary_scope`, `owned_paths`. If the task falls outside, invoke `/codex-bridge <handoff-target>` instead of improvising.
2. **Read first.** Open every `.md` under "Read First (composed)" before touching code. The composed list already includes the workflow's, the owner's, and the spoke's required_reads.
3. **Follow the Workflow / Playbook section verbatim.** That's what codex has already decided works.
4. **Run the composed Required Checks** before declaring done. The `Bash(python3 *)` grant covers Python-based checks; other bash tools will prompt once.
5. **Hand off on drift.** If work expands, stop and `/codex-bridge <next>` — usually the next entry in `handoff_chain`.

### An ambiguity / disambiguation table

Multiple skills scored close. Prefer the spoke over the owner when both match; prefer a workflow over a bare skill when a workflow is listed (workflows compose across owner + spoke).

### A catalog

No strong match. Pick by description, re-invoke `/codex-bridge <name>`.

### A `--check` report

Surface findings to the user. Don't auto-fix — `--check` is a health report, not a migration.

## Invocation patterns

```
/codex-bridge                                 # catalog of owners, spokes, workflows
/codex-bridge backend-api-contracts           # compose skill briefing
/codex-bridge security-consent-audit          # compose workflow briefing (owner+spoke unioned)
/codex-bridge "how does Kai maintain session continuity"  # free-text → token scoring
/codex-bridge --check                         # structural lint of .codex tree
```

## Design

- **Source of truth:** `.codex/skills/*` and `.codex/workflows/*`. Edit there; the bridge re-reads every invocation.
- **Composition mirrors codex.** Routing emits the same union of fields that `repo_scan.py::build_route_task` produces, so Claude makes the same scope decisions codex would.
- **Progressive disclosure.** Only the routed briefing enters context, not the full corpus.
- **Path-aware auto-trigger.** `paths: .codex/**, consent-protocol/**, hushh-webapp/**, docs/**` covers the repo surfaces where a specialist applies.
