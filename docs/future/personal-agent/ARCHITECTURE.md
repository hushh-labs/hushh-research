# Private-agent architecture references

## Status

Navigation only, updated 2026-09-25. The former provider-specific design snapshot
is removed. Its reusable design lessons and dated bootstrap findings are retained
in the [documentation audit](../../reference/quality/adk-orchestration-docs-audit.md#gcp-only-pod-deployment-correction--2026-09-25).
Historical source remains in Git; it is not an implementation procedure.

## Visual Context

Canonical visual owner: [Personal Agent index](./README.md).
Requirements: [private-agent north star](../../reference/architecture/private-agent-north-star.md).

## Current contracts

- [Private-agent requirements and qualified evidence](../../reference/architecture/private-agent-north-star.md)
- [GCP deployment and substrate boundary](../../reference/architecture/deployment-standard.md)
- [Encrypted backup and recovery](../../reference/operations/pod-backup-and-recovery.md)
- [Owner-pod direct runtime handoff](./OWNER-POD-DIRECT-RUNTIME-HANDOFF-2026-09-10.md)
- [Dated execution evidence](./EXECUTION-LOG.md)

GCP is the only implemented cloud deployment provider. Managed Shared runtime,
owner-project BYOC and disabled Hussh Pods remain distinct hosting states. AWS and
Azure implementation is outside the current scope. The Salesforce/Agentforce CRM
connector remains independent of pod hosting.
