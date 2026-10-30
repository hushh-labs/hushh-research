# Repository routing

Reads `.agents/` at invocation time and composes a briefing the way `./bin/hushh codex route-task` does: workflow → owner_skill + default_spoke → union of `required_reads`, `required_commands`, `handoff_chain`, `verification_bundle`, `risk_tags`.

## Response rules

The repository routing contracts are the source of truth. The enforceable rules live in `.agents/skills/comms-community/references/reply-rules.md` and are injected into the routed briefing when the turn is a **community reply** — the route lands on `comms-community` / `community-response`, or the prompt names the channel outright (see `scripts/route.py`). They are deliberately *not* injected into engineering questions: they are a 180-line Discord tone contract, and a question mark in a bug report is not a request for Discord voice. Follow that file literally when it does load. If it conflicts with anything written here, it wins.

Invocation guidance:

1. When you cannot reach `.agents/` to fetch the routing contracts, report that routing is unavailable and inherit the communication rules in root `AGENTS.md`. Do not substitute a channel-specific style or fabricate a routed lane.
2. Pull the signature values (`<skill-id>`, `<workflow-id>`) from the routed briefing header (`# Routed workflow: ...` / `# Routed skill: ...`).
3. If the briefing header shows a disambiguation table or a catalog, do not fabricate a signature, invoke the router again with the chosen name first.

Anything stylistic beyond this belongs in `reply-rules.md`, not here. Edit the owning canonical file and the router will pick it up on the next invocation.

## Routed briefing

```sh
python3 .agents/routing/scripts/route.py <workflow-or-task>
```

## How to execute what's above

### A single skill or workflow briefing

Treat it as the instruction set:

1. **Scope check.** Honor the skill's "Do Use" / "Do Not Use", `primary_scope`, `owned_paths`. If the task falls outside, invoke `python3 .agents/routing/scripts/route.py <handoff-target>` instead of improvising.
2. **Read first.** Open every `.md` under "Read First (composed)" before touching code. The composed list already includes the workflow's, the owner's, and the spoke's required_reads.
3. **Follow the Workflow / Playbook section verbatim.** That's the repository's authored procedure.
4. **Run the composed Required Checks** before declaring done. Host permissions remain separate from the repository routing contract.
5. **Hand off on drift.** If work expands, stop and `python3 .agents/routing/scripts/route.py <next>` — usually the next entry in `handoff_chain`.

### A compact pointer (`Routed lane (compact)`)

The match was plausible but not confident, so the router sent the pointer instead
of the full playbook: lane name, owner/spoke, read-first paths, required checks,
and the runner-up candidates. Treat it as a suggestion. If it is the right lane,
run `python3 .agents/routing/scripts/route.py <name>` to load the full briefing; if it is not, ignore it and
proceed with the user's request as stated.

### An ambiguity / disambiguation table

Multiple skills scored close. Prefer the spoke over the owner when both match; prefer a workflow over a bare skill when a workflow is listed (workflows compose across owner + spoke).

### A catalog

No strong match. Pick by description, re-invoke `python3 .agents/routing/scripts/route.py <name>`.

### An agent briefing

The matched entry is a repo-scoped custom agent (under `.agents/subagents/`), not a skill or workflow. Treat it as a delegation lane, not instructions to execute directly:

1. Decide whether the current turn actually benefits from delegation. Most single-lane requests do not.
2. Follow the standing read-only delegation authorization and parent-only authority boundaries in `AGENTS.md` and `.agents/skills/agent-orchestration-governance/references/delegation-contract.md`. Do not ask again for authority the user or repository already provides. Use the host-supported agent invocation for the selected lane.
3. When the briefing appears as a `Suggested delegation lanes` footer on a skill or workflow briefing, treat it as context only. Execute the primary briefing normally.

### A `--check` report

Surface findings to the user. Don't auto-fix — `--check` is a health report, not a migration.

## Invocation patterns

```
python3 .agents/routing/scripts/route.py                                 # catalog of owners, spokes, workflows, agents
python3 .agents/routing/scripts/route.py backend-api-contracts           # compose skill briefing
python3 .agents/routing/scripts/route.py security-consent-audit          # compose workflow briefing (owner+spoke unioned)
python3 .agents/routing/scripts/route.py governor                        # compose agent briefing (delegation lane)
python3 .agents/routing/scripts/route.py "how does Kai maintain session continuity"  # free-text → token scoring
python3 .agents/routing/scripts/route.py --check                         # structural lint of .agents tree
```

## Design

- **Source of truth:** `.agents/skills/*`, `.agents/workflows/*`, and `.agents/subagents/*`. Edit there; the router re-reads every invocation.
- **One composition contract.** Routing emits the same union of fields that `repo_scan.py::build_route_task` produces, regardless of the calling host.
- **Agents are advisory lanes, not winners.** Exact agent name routes to an agent briefing. Free-text never elevates an agent above a matching skill or workflow. On explicit skill or workflow invocations, matching agents appear as a compact `Suggested delegation lanes` footer (suppressed on Q&A turns and on close-scoring ties).
- **Progressive disclosure.** Only the routed briefing enters context, not the full corpus. The `--automatic` path adds a second axis: silence below the gate, a compact pointer at medium confidence or when a rival lane scores within 2 points, and the full composed briefing only when the match is both strong and unambiguous.
- **Rarity-weighted matching.** Token overlap is weighted by how rare the token is in the corpus, so shared words (`audit`, `review`, `contract`) stop deciding the route and a path the user actually typed outranks any amount of prose overlap. Fixtures in [fixtures/routing_cases.json](fixtures/routing_cases.json) pin the expected lane for representative prompts and cap total injected size; `scripts/test_route_requests.py` enforces both in CI.
- **Explicit invocation.** Call `--automatic` with a JSON `{"prompt": "…"}` object on stdin for confidence-tiered routing. No startup hook or vendor integration is installed.
