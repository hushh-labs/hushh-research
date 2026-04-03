# Operations Index


## Visual Map

```mermaid
flowchart TD
  root["Operations Index"]
  n1["Branch Governance"]
  root --> n1
  n2["Ci"]
  root --> n2
  n3["Coding Agent Mcp"]
  root --> n3
  n4["Developer Access Matrix"]
  root --> n4
  n5["Docs Governance"]
  root --> n5
  n6["Env And Secrets"]
  root --> n6
  n7["Env Secrets Key Matrix"]
  root --> n7
  n8["Observability Google First"]
  root --> n8
  n9["Production Db Backup And Recovery"]
  root --> n9
```

Use this as the entrypoint for CI, docs governance, delivery, and environment operations.
One-time rollout notes belong in PRs, issues, or git history, not in the active operations surface.

## References

- [ci.md](./ci.md): local/remote CI parity and required lanes.
- [branch-governance.md](./branch-governance.md): branch rules, review gates, and bypass policy.
- [docs-governance.md](./docs-governance.md): documentation placement and quality gates.
- [env-and-secrets.md](./env-and-secrets.md): environment and secret contract.
- [env-secrets-key-matrix.md](./env-secrets-key-matrix.md): key-by-key environment matrix.
- [naming-policy.md](./naming-policy.md): Hushh public naming rules and compatibility boundaries.
- [developer-access-matrix.md](./developer-access-matrix.md): org-level developer IAM baseline, runtime identities, and DB access path.
- [observability-google-first.md](./observability-google-first.md): observability operating model.
- [production-db-backup-and-recovery.md](./production-db-backup-and-recovery.md): production DB recovery guide.
- [coding-agent-mcp.md](./coding-agent-mcp.md): coding-agent and MCP operating notes.
- [subtree-maintainers.md](./subtree-maintainers.md): maintainer-only subtree sync and upstream coordination.
- [`../../../consent-protocol/scripts/README.md`](../../../consent-protocol/scripts/README.md): maintainer-only backend script map and when to use it.
