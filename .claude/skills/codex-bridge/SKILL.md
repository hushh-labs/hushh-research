---
name: codex-bridge
description: Answers questions about and routes tasks for the hushh-research codebase. Use whenever the user asks about or wants to change anything this repo owns, including consent-protocol, Operons, HCT, Kai, MCP, IAM, PKM, vault, backend, frontend, mobile, security, docs, comms, ops, skill authoring, and any new specialist added under .codex/ later. Reads .codex/skills/, .codex/workflows/, and agents/ at invocation time, composes a briefing the way codex route-task does (workflow plus owner_skill plus default_spoke unioned), surfaces agents/* as advisory delegation lanes, and auto-discovers anything added to the tree without a bridge edit.
argument-hint: "[skill-or-workflow-name | --list | --check | --coverage | free-text]"
allowed-tools: Read Grep Glob Bash(python3 *)
---

# Codex Bridge

Reads `.codex/` at invocation time and composes a briefing the way `./bin/hushh codex route-task` does: workflow → owner_skill + default_spoke → union of `required_reads`, `required_commands`, `handoff_chain`, `verification_bundle`, `risk_tags`.

## Response rules

The repository routing contracts are the source of truth. The enforceable rules live in `.codex/skills/comms-community/references/reply-rules.md` and are injected into the routed briefing when the turn is a **community reply** — the route lands on `comms-community` / `community-response`, or the prompt names the channel outright (see `scripts/route.py`). They are deliberately *not* injected into engineering questions: they are a 180-line Discord tone contract, and a question mark in a bug report is not a request for Discord voice. Follow that file literally when it does load. If it conflicts with anything written here, it wins.

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

### A compact pointer (`Routed lane (compact)`)

The match was plausible but not confident, so the bridge sent the pointer instead
of the full playbook: lane name, owner/spoke, read-first paths, required checks,
and the runner-up candidates. Treat it as a suggestion. If it is the right lane,
run `/codex-bridge <name>` to load the full briefing; if it is not, ignore it and
proceed with the user's request as stated.

### An ambiguity / disambiguation table

Multiple skills scored close. Prefer the spoke over the owner when both match; prefer a workflow over a bare skill when a workflow is listed (workflows compose across owner + spoke).

### A catalog

No strong match. Pick by description, re-invoke `/codex-bridge <name>`.

### An agent briefing

The matched entry is a repo-scoped custom agent (under `agents/`), not a skill or workflow. Treat it as a delegation lane, not instructions to execute directly:

1. Decide whether the current turn actually benefits from delegation. Most single-lane requests do not.
2. Follow the standing read-only delegation authorization and parent-only authority boundaries in `AGENTS.md` and `.codex/skills/agent-orchestration-governance/references/delegation-contract.md`. Do not ask again for authority the user or repository already provides. Use the host-supported agent invocation for the selected lane.
3. When the briefing appears as a `Suggested delegation lanes` footer on a skill or workflow briefing, treat it as context only. Execute the primary briefing normally.

### A `--check` report

Surface findings to the user. Don't auto-fix — `--check` is a health report, not a migration.

## Invocation patterns

```
/codex-bridge                                 # catalog of owners, spokes, workflows, agents
/codex-bridge backend-api-contracts           # compose skill briefing
/codex-bridge security-consent-audit          # compose workflow briefing (owner+spoke unioned)
/codex-bridge governor                        # compose agent briefing (delegation lane)
/codex-bridge "how does Kai maintain session continuity"  # free-text → token scoring
/codex-bridge --check                         # structural lint of .codex tree
```

## Design

- **Source of truth:** `.codex/skills/*`, `.codex/workflows/*`, and `agents/*`. Edit there; the bridge re-reads every invocation.
- **Composition mirrors codex.** Routing emits the same union of fields that `repo_scan.py::build_route_task` produces, so Claude makes the same scope decisions codex would.
- **Agents are advisory lanes, not winners.** Exact agent name routes to an agent briefing. Free-text never elevates an agent above a matching skill or workflow. On explicit skill or workflow invocations, matching agents appear as a compact `Suggested delegation lanes` footer (suppressed on Q&A turns and on close-scoring ties).
- **Progressive disclosure.** Only the routed briefing enters context, not the full corpus. The `--hook` path adds a second axis: silence below the gate, a compact pointer at medium confidence or when a rival lane scores within 2 points, and the full composed briefing only when the match is both strong and unambiguous.
- **Rarity-weighted matching.** Token overlap is weighted by how rare the token is in the corpus, so shared words (`audit`, `review`, `contract`) stop deciding the route and a path the user actually typed outranks any amount of prose overlap. Fixtures in [fixtures/routing_cases.json](fixtures/routing_cases.json) pin the expected lane for representative prompts and cap total injected size; `scripts/test_route_hook.py` enforces both in CI.
- **Path-aware auto-trigger.** `paths: .codex/**, consent-protocol/**, hushh-webapp/**, docs/**` covers the repo surfaces where a specialist applies.
