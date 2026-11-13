# Private-agent architecture references

[Private-agent roadmap](README.md)

## Status

Navigation only, updated 2026-09-25. The former provider-specific design snapshot
is removed. Its reusable design lessons and dated bootstrap findings are retained
in the [documentation audit](../../operations/acceptance/private-agents.md#what-the-retained-evidence-establishes).
Historical source remains in Git; it is not an implementation procedure.

## Visual Context

Canonical visual owner: [Personal Agent index](README.md).
Requirements: [private-agent north star](../../product/principles/private-agent-requirements.md).

## Current contracts

- [Private-agent requirements and qualified evidence](../../product/principles/private-agent-requirements.md)
- [GCP deployment and substrate boundary](../../architecture/deployment-standard.md)
- [Encrypted backup and recovery](../../operations/hosting/pod-backup-and-recovery.md)
- [Owner-pod direct runtime handoff](owner-pod-direct-runtime-handoff-2026-09-10.md)
- [Dated execution evidence](execution-log.md)

GCP and owner-cloud Azure are the implemented cloud deployment providers
(`docs/architecture/byoc-azure.md`). Managed Shared runtime, owner-project
BYOC, owner-cloud Azure and disabled Hussh Pods remain distinct hosting states. AWS
implementation is outside the current scope. The Salesforce/Agentforce CRM
connector remains independent of pod hosting.
