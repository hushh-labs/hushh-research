# Consumer MCP implementation record

Status: **In progress; not available for consumer acceptance.**

## Baseline and boundaries

- Worktree: sibling `hushh-consumer-mcp`; branch `feat/consumer-mcp`.
- Committed private baseline: `883327eaf57c3e78d62197d899811f5360262481` (11 September 2026).
- Original workspace and ADK worktree are independently active and remain untouched.
- No deployment, main promotion, production activation or marketplace submission has occurred in this workstream.
- Working source is implementation evidence, not installed-runtime or host acceptance evidence.

## Approved product contract

External assistants authenticate as owner-bound clients. Registered Puppy devices retain their distinct native authority. One owner approval permits reads, routine additions and corrections of current and future personal memory until the client is disconnected. Credentials remain short-lived. Deletion, permission changes and consequential external actions require fresh confirmation. Secrets are never personal memory.

Provisioning, recoverable owner-pod vault custody and client access are separate approvals in one setup journey. The universal MCP gateway may handle approved results in transit but cannot persist payloads or hold vault keys. Optional direct transport uses the same capabilities. Canonical encrypted PKM commits own successful saves; pod replicas are derived.

## Checkpoints

| Checkpoint | Status | Next evidence |
|---|---|---|
| Isolation and committed baseline | Done | Baseline above; clean source when created |
| Consumer capability coverage | Inventory complete; implementation pending | Baseline table below; no executable coverage claimed |
| OAuth owner/client/resource binding | Local checks pass | 55 focused checks; live host acceptance pending |
| Standing grants and resumable onboarding | Pending | Separate approvals, revocation and no duplicate infrastructure |
| Pod custody and canonical memory | Pending | Authenticated enrollment, encrypted commit, CAS and replacement recovery |
| Consumer tools and Puppy adapters | Pending | Typed operation execution, receipts and common records |
| Direct/universal transport parity | Pending | Isolation, revocation races and non-persistence |
| Host acceptance and submission packages | Pending | Real Claude and ChatGPT journeys, operational receipts |

## Verification and rollback

Run focused checks for each changed contract. Run the combined release gate on the final candidate. Keep legacy developer consent/export semantics unchanged. Do not claim an operation works because a UI action or catalog entry exists.

No deployed rollback is needed yet. Future rollback must retain canonical revisions, tombstones and revoked grants; never restore a runtime that ignores revoked authority.

## Source-derived consumer inventory

The baseline action gateway has 214 authored actions (186 wired, 28 unwired). Of these, 78 refer to routes, 96 to local handlers, five to Kai commands, five to voice tools and two to controls. These are interaction counts, **not executable MCP coverage**.

| Family | Existing owner | Consumer MCP disposition at baseline |
|---|---|---|
| Account and vault setup | `account.py`, trusted-device and vault services | Secure owner handoff required |
| Deployment | `personal_agent.py`, `byoc_setup_job_service.py` | Adapt existing resumable job; retain cost approval and disabled-hosted refusal |
| PKM | `pkm.py`, canonical mutation/write engine | Semantic reads/writes require approved pod custody and canonical encrypted commits |
| Agent memory | `pod_memory.py`, memory store and resolver | Adapt inspection, recall, correction, export and erasure; retain tombstones |
| Files / Source Library | Existing provider file service and Source Library contracts | Upload and organization require explicit service adapters; share confirmation remains separate |
| Connections | `ConnectionsService`, `one/connections.py` | Service-backed directory and proposal operations; device contact permission remains a handoff |
| Calendar | `GoogleCalendarService`, `one/calendar.py` | Read/availability/proposal services exist; OAuth and action confirmation remain secure handoffs |
| Email / identity | `one/email.py`, Gmail routes, `OneEmailKYCService` | Adapt tracked read/draft workflows; approval is distinct from successful external delivery |
| Location | Location services and `PodLocationReadPort` | Adapt supported reads/proposals; device acquisition/background permission remains native |
| Finance | Kai portfolio/analysis services | Existing MCP UI intents do not execute analysis; real job/results adapter required |
| Consent / sharing | Consent ledger, exports, information-request services | Preserve current five-tool developer flow; add owner review and revocation without vault-key disclosure |
| Delegated private-agent work | `pod_turn.py`, shared fleet and specialist runtime | Add bounded task tracking and cancellation; no shared runtime fallback |
| Puppy and recovery | Trusted-device services and Hermes local PKM bridge | Retain device proof and local custody; common canonical records must be proven |
| Wallet / profile / support | Existing wallet-card, profile and support services | Separate public operations from protected reveals; native wallet installation is a handoff |
| Marketplace / RIA | Existing marketplace and RIA services | Consumer ownership must not grant advisor/business-operator roles |

The topology generator remains the existing coverage join: `scripts/ops/generate_runtime_topology_index.py`. A future MCP mapping must classify every authored consumer capability without making this projection a router.

## Current correction and receipts

- OAuth now retains verified owner, registered client, authorization identity, scopes and optional MCP resource. These fields do not themselves grant memory access.
- Resource-aware code exchange and refresh require the original configured audience. Access rejects mismatched deployments, revoked clients and orphaned/denied authorizations.
- New protected-resource discovery and 401 challenges use `CONSENT_API_PUBLIC_ORIGIN`; missing configuration refuses resource discovery rather than advertising an unusable audience.
- Existing unbound developer connections retain their five-tool consent/export behavior. Client-credentials and registry credentials never receive an owner identity.
- Parked dev migration `937_consumer_mcp_oauth_resource.sql` adds the nullable resource column; old offline SQLite schemas also upgrade additively. No live migration applied.
- Verification: 55 tests passed across `test_mcp_oauth_owner_binding.py`, `test_developer_oauth.py`, `test_mcp_remote_endpoint.py`, `test_mcp_public_contract_v030.py`, and `test_mcp_encrypted_scoped_export_tool.py`; Ruff and whitespace checks passed. Tests use synthetic local SQL, not live hosts.
- Next: connect standing-consent admission to the existing consent ledger, then resumable setup and pod custody. OAuth identity is not an implementation of these pending authorities.
