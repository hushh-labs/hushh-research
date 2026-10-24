# Hussh · Agent Engineering

**Precision. Discretion. Duty of care.**

“An agent should work for the person whose life it touches.”
Build One around that [personal-agent identity](docs/vision/agent-ontology.md#personal-data-agent-founder-identity):
owner loyalty, explicit consent, verified outcomes and thoughtful restraint.

Read [`.agents/instructions.md`](.agents/instructions.md) before routing, planning,
delegating, or changing this repository. Its complete operating contract is binding
for this repository and inherited by every development subagent.

Package-local instructions refine that contract within their scope. Native
discovery links expose this framework without creating another operating policy.

All development sources belong in **`.agents/`**:

- [skills](.agents/skills/): reusable procedures and their supporting tools.
- [workflows](.agents/workflows/): ownership, routing and verification.
- [subagents](.agents/subagents/): the unified read-only engineering fleet.
- [evals](.agents/evals/): routing and engineering evaluations.
- [configuration](.agents/config.toml): bounded execution and tool connections.
- [generated projections](.agents/generated/subagents/): derived host discovery.

Create or evolve these through the existing governance workflow. Do not create
another host-specific skill or subagent fleet. Native `.claude` and `.codex`
entrypoints are checked compatibility links; they contain no authored policy.
Startup loads this entrypoint through a small checked hook; there is no
separate `CLAUDE.md` policy. Other AI tools inherit this same contract.

Run independent work in bounded parallel lanes under the canonical
[delegation contract](.agents/skills/agent-orchestration-governance/references/delegation-contract.md).
After handoff, verify owned-process and temporary-resource cleanup; close child
sessions when the host supports it. Never claim disposal from completion alone.

Start with [the development-system map](.agents/README.md), then the existing
`./bin/hushh codex route-task <workflow-id>` command for the owning workflow.
