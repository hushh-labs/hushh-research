# Operations

[Documentation](../README.md)

Operate the admitted deployment you actually have. Verify serving state and
recorded operations before retrying updates, cleanup or provider mutations.

## Visual Map

```mermaid
flowchart LR
  source["Reviewed source"]
  validate["Exact-source validation"]
  release["Explicit authorized release"]
  observe["Serving and health readback"]
  recover["Recovery or reconciled cleanup"]
  source --> validate
  validate --> release
  release --> observe
  observe --> recover
```

| Task | Guide |
| --- | --- |
| Understand branches, teams and deployment | [CI and releases](releases/ci.md), [branch governance](releases/branch-governance.md) |
| Select a local or cloud environment | [Environments](environments.md), [configuration and secrets](configuration/env-and-secrets.md) |
| Install or update a private agent | [Private deployment runbook](hosting/dev-pod-first-light-runbook.md) |
| Verify capability acceptance | [Private-agent acceptance](acceptance/private-agents.md) |
| Manage encrypted Files | [Files operations](hosting/private-files-library.md) |
| Remove cloud resources or delete an account | [Cleanup and deletion](identity/account-deletion-rollout.md) |
| Recover from failure | [Pod recovery](hosting/pod-backup-and-recovery.md), [database recovery](production-db-backup-and-recovery.md), [source rollback](releases/source-snapshot-rollback.md) |
| Diagnose incidents or capacity | [Observability](observability/observability-architecture-map.md), [runtime capacity](hosting/runtime-capacity.md) |
| Release native apps | [TestFlight](mobile/ship-ios-testflight.md), [App Store](mobile/release-ios-appstore.md), [Google Play](mobile/ship-android-playstore.md) |

Trusted workflows execute from Main; application sources remain isolated.
Merging code never deploys. Current live teams, exact-source checks, compatibility
and rollback admission remain authoritative. Follow the existing
[Admin release SOP](../../.agents/skills/repo-operations/references/admin-release-sop.md)
for the action you are authorized to perform.

## Specialized operating guides

- [Releases](releases/README.md): Validate, admit and explicitly release a selected application revision.
- [Hosting](hosting/README.md): Install, observe and recover owner-controlled deployments.
- [Configuration](configuration/README.md): Choose runtime profiles and maintain configuration and credential boundaries.
- [Observability](observability/README.md): Understand health, telemetry and operational incidents.
- [Identity](identity/README.md): Operate account, authentication and cleanup lifecycle changes.
- [Integrations](integrations/README.md): Operate provider-specific connections and background workflows.
- [Mobile](mobile/README.md): Build and distribute explicitly authorized native releases.
- [Advanced Ops](advanced.md)
- [Hussh Brand And Compatibility Contract](brand-and-compatibility-contract.md)
- [MCP Host Operations](coding-agent-mcp.md)
- [Hussh Rebrand Classification](hussh-rebrand-classification.md)
- [Historical operational lessons](safe-changes-history.md)
- [Subtree Maintainers](subtree-maintainers.md)
