# Development system

Start with root [AGENTS.md](../AGENTS.md), which explicitly loads the binding
[operating contract](instructions.md). Package-local rules still apply.

| Home | Responsibility |
| --- | --- |
| [skills](skills/README.md) | Authored practices and governed owner/spoke procedures |
| [subagents](subagents/) | Read-only engineering evidence lanes |
| [workflows](workflows/) | Existing recurring workflow contracts and playbooks |
| [adapters](adapters/README.md) | Authored host invocation sources and generated discovery |

Use `./bin/hushh codex route-task <workflow-id>` for a recurring task, or
`./bin/hushh codex scan summary` for orientation. Routing IDs and verification
requirements are unchanged by consolidation.

Runtime product agents remain in
[`consent-protocol/hushh_mcp/agents`](../consent-protocol/hushh_mcp/agents/).
They are separate from development subagents.
