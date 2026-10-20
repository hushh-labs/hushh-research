# Development system

Start with root [AGENTS.md](../AGENTS.md), which explicitly loads the binding
[operating contract](instructions.md). Package-local rules still apply.

| Home | Responsibility |
| --- | --- |
| [skills](skills/README.md) | Authored practices and governed owner/spoke procedures |
| [subagents](subagents/) | Read-only engineering evidence lanes |
| [workflows](workflows/) | Existing recurring workflow contracts and playbooks |
| [adapters](adapters/README.md) | Authored host invocation sources and generated discovery |
| [evals](evals/cases/) | Deterministic skill-routing cases shared by every host |
| [imports](imports/) | Pinned third-party resources with retained licenses and explicit review status |

`.agents` is the only authored development tree. Codex reads its skills directly;
the few native `.codex` and `.claude` entrypoints are relative compatibility links
checked by the adapter validator. Do not create another skill or subagent copy.
The active ADK worktree under `.claude/worktrees` is local work, not agent policy;
preserve it until its owner completes integration and cleanup.

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
