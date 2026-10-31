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
| [routing](routing/) | Invocation of existing workflow and skill owners |
| [evals](evals/cases/) | Deterministic skill-routing cases shared by every host |
| [imports](imports/) | Pinned third-party resources with retained licenses and explicit review status |

`.agents` is the only development tree. Root `AGENTS.md` guides every coding
agent to the same instructions, skills, workflows, subagents and evaluations.
Do not create vendor folders, native startup hooks, adapters or discovery mirrors.
A host that does not load `AGENTS.md` automatically must be directed to read it;
this repository does not install a second bootstrap policy. Tool connections and
subagent execution remain capabilities of the active host, not claims made by a
Markdown file.

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
2. Validate canonical sources and absence of vendor roots. Run the owning routing,
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

## Machine-local settings

Portable instructions, skills and subagents remain authored in this tree. Personal
host overrides belong in ignored `.agents/.local/`, outside the shared framework.
Preserve their bytes and live connections during migration. These retained settings
are not another operating policy and are not automatically installed by this repo.
Do not commit private settings or recreate host-specific discovery.

## Imports and compatibility

Pinned imports retain their original bytes, licenses and review classification.
Relocation never enables imported hooks or writers. `skills-lock.json` records
upstream paths and hashes, not installed local paths. The existing
[platform-source inventory](skills/agent-orchestration-governance/references/platform-source-inventory.json)
records local custody and reviewed portable sources. Existing command identifiers
remain compatible; they do not create another routing authority.
