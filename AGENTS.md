# Hussh · Agent Engineering

**Precision. Discretion. Duty of care.**

“An agent should work for the person whose life it touches.”
Build One around that [personal-agent identity](docs/vision/agent-ontology.md#personal-data-agent-founder-identity):
owner loyalty, explicit consent, verified outcomes and thoughtful restraint.

Read [`.agents/instructions.md`](.agents/instructions.md) before routing, planning,
delegating, or changing this repository. Its complete operating contract is binding
for this repository and inherited by every development subagent.

Package-local instructions refine that contract within their scope. Every coding
agent uses this same entrypoint and reads the canonical sources directly.

All development sources belong in **`.agents/`**:

- [skills](.agents/skills/): reusable procedures and their supporting tools.
- [workflows](.agents/workflows/): ownership, routing and verification.
- [subagents](.agents/subagents/): the unified read-only engineering fleet.
- [evals](.agents/evals/): routing and engineering evaluations.
- [configuration](.agents/config.toml): bounded execution and tool connections.

Create or evolve these through the existing governance workflow. Do not create
`.claude`, `.codex`, `.qwen` or another vendor-specific instruction, skill or agent
tree. Do not generate per-host adapters or copies of the development fleet.
Root `AGENTS.md` and `.agents` are the portable operating contract. Tool access and
automatic discovery still depend on the active host; never claim that reading this
file registers MCP servers or subagents automatically.

Run independent work in bounded parallel lanes under the canonical
[delegation contract](.agents/skills/agent-orchestration-governance/references/delegation-contract.md).
After handoff, verify owned-process and temporary-resource cleanup; close child
sessions when the host supports it. Never claim disposal from completion alone.

Start with [the development-system map](.agents/README.md), then the existing
`./bin/hushh codex route-task <workflow-id>` command for the owning workflow.
Route CI work through the existing `ci-watch-and-heal` or `release-readiness`
workflow and the `repo-operations` skill; keep required checks and release
authority intact.

Before changing a readiness check, probe, grader or instruction text that a live check grades, follow the [readiness guardrails](.agents/skills/repo-operations/references/managed-provider-readiness.md#readiness-and-live-check-guardrails).
