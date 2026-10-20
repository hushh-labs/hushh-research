# Host adapters

The [shared operating contract](../instructions.md) owns repository behavior.
[Claude invocation context](claude/instructions.md) and classified templates live
here once. The existing platform-source inventory records their authority and
pending import review; moving a source does not approve its execution.

Native settings live here in [codex/config.toml](codex/config.toml) and
[claude/settings.json](claude/settings.json). Host-required `.codex/config.toml`
and `.claude/settings.json` are relative symlinks to those sources. Existing MCP
definitions and local authorization remain unchanged; relocation does not restart
clients or transfer credentials.

Codex discovers `.agents/skills` directly and `.codex/agents` links to the unified
subagent fleet. Claude's skill directories link to the canonical skills or the
classified invocation adapters here. The links are generated and checked by
`../skills/agent-orchestration-governance/scripts/sync_host_adapters.py`.
The adjacent `sync_claude_agents.py` generator writes engineering projections
under `claude/agents`; `.claude/agents` links there.
Run either with `--write`, then `--check`; edit the canonical source first.

The pinned [Impeccable dependency](../imports/impeccable/) retains its original
bytes, licenses and pending-review classification. Its legacy Claude discovery
path is a link. Nested imported writers are not members of the approved fleet;
relocation does not enable their hooks or subprocesses. Review the pinned upstream
revision, dependencies and authority before any import update. Use the canonical
frontend owner for product design; the imported library does not override it.

## Imported provenance

`skills-lock.json` records paths in upstream source repositories, not installed
local paths. Keep those paths and pinned hashes intact when relocating authored
procedures. Local custody and review classifications belong to the existing
[platform-source inventory](../skills/agent-orchestration-governance/references/platform-source-inventory.json).
The [upstream lock contract](https://github.com/vercel-labs/skills/blob/main/src/skill-lock.ts)
defines this distinction. Import provenance does not authorize imported execution.
