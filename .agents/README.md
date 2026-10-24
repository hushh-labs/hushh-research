# Agent engineering framework

**Precision. Discretion. Duty of care.**

Build One for the person it serves. The approved [personal-agent identity](../docs/vision/agent-ontology.md#personal-data-agent-founder-identity)
governs the product; this framework governs how we engineer and verify it.

Start with root [AGENTS.md](../AGENTS.md), which explicitly loads the binding
[operating contract](instructions.md). Package-local rules still apply.

| Home | Responsibility |
| --- | --- |
| [skills](skills/README.md) | Authored practices and governed owner/spoke procedures |
| [subagents](subagents/) | Read-only engineering evidence lanes |
| [workflows](workflows/) | Existing recurring workflow contracts and playbooks |
| [configuration](config.toml) | Bounded execution and declared tool connections |
| [startup](startup.json) | Load the root contract through the checked [startup hook](scripts/startup.py) |
| [routing](routing/) | Invocation of existing workflow and skill owners |
| [generated/subagents](generated/subagents/) | Derived discovery; never an authored second fleet |
| [evals](evals/cases/) | Deterministic skill-routing cases shared by every host |
| [imports](imports/) | Pinned third-party resources with retained licenses and explicit review status |

`.agents` is the only authored development tree. Codex reads its skills directly;
the few native `.codex` and `.claude` entrypoints are relative compatibility links
checked by the adapter validator. Do not create another skill or subagent copy.
Tracked native entrypoints are checked links. Do not author vendor
folders inside this framework. Stock tools require their native entrypoints;
deleting those links breaks ordinary GUI/direct-launch discovery. Ignored local
permissions and the active ADK worktree under `.claude/worktrees` remain local
state; preserve them until their owner completes integration and cleanup.

## One delivery loop

1. **Orient:** read the root contract, verify the current source and running artifact.
2. **Route:** select the existing workflow and its owning skill.
3. **Delegate:** use bounded read-only subagents for independent evidence; the parent owns patches and release decisions.
4. **Patch:** fix the owning source and extend its nearest meaningful regression check. Do not create a separate patch tree.
5. **Evaluate:** use routing evaluations and the changed contract's authoritative checks; run the core mirror once on the completed candidate.
6. **Release:** require exact-revision CI and governed environment receipts. Record actual outcomes and clean task-owned resources.

Skills supply reusable methods; workflows compose them; subagents inspect evidence;
evaluations detect drift. They share the same instructions, authority and persona.

## Release a development lane

1. Route the change through `agent-orchestration-governance`; edit the existing
   skill, workflow or `.agents/subagents/*.toml` source.
2. Regenerate Claude projections and check native links. Run the owning routing,
   authority and governance checks; model selection inherits the parent session.
3. Collect the subagent's evidence and unresolved risks. The parent decides what
   to accept and verifies the changed contract before committing.
4. Release finished child sessions through the host's supported control and
   verify their terminal state and task-owned resource cleanup. If the host has
   no close control, report that limitation; do not claim a thread was released.

These are engineering lanes. Product specialists such as Files and Browser are
authored in the runtime, not in this development fleet.

Use `./bin/hushh codex route-task <workflow-id>` for a recurring task, or
`./bin/hushh codex scan summary` for orientation. Routing IDs and verification
requirements are unchanged by consolidation.

Runtime product agents remain in
[`consent-protocol/hushh_mcp/agents`](../consent-protocol/hushh_mcp/agents/).
They are separate from development subagents.

## Imports and compatibility

Pinned imports retain their original bytes, licenses and review classification.
Relocation never enables imported hooks or writers. `skills-lock.json` records
upstream paths and hashes, not installed local paths. The existing
[platform-source inventory](skills/agent-orchestration-governance/references/platform-source-inventory.json)
records local custody and approved native invocation. Existing command identifiers
remain compatible; they do not create another routing authority.
