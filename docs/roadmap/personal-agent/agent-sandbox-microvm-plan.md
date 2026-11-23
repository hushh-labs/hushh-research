# Agent Sandbox microVM pool and standalone Terminal

[Private-agent remaining work](README.md) · [Roadmap](../README.md) · [Current hosting architecture](../../architecture/modules/hosting.md)

This active plan tracks **Hussh Confidential Sandbox** under [#9744 Stand up FedRAMP-ready Agent Sandbox microVM pool, Terminal capability, and Shared Runtime retirement](https://github.com/hushh-labs/hushh-research/issues/9744) ([Wave 1 PR #9755](https://github.com/hushh-labs/hushh-research/pull/9755), [Wave 2 PR #9762](https://github.com/hushh-labs/hushh-research/pull/9762)) and works alongside [#9511 Complete One's standalone Browser capability and reusable workspace split-pane UI](https://github.com/hushh-labs/hushh-research/issues/9511). Live Dev cluster routing, Edge Gateway wake/reap continuity, and UAT/Shared Runtime retirement remain tracked across the phase exits below.

## Visual Map

```mermaid
flowchart LR
  Client["Clients (Web, iOS, Android, Companion)"] -->|"Auth + Consent"| Hub["Stateless Hub Router"]
  Hub -->|"Exempt Placement"| BYOC["Owner Cloud or Local Puppy"]
  Hub -->|"Warm Claim"| Pool["Pre-Warmed Virgin Sandbox Pool"]
  Pool -->|"Ephemeral Scratch"| Scratch["In-Memory Keyed Scratch (Wiped on Exit)"]
  Pool <-->|"4 MiB Encrypted Chunks"| Obj["Per-User Encrypted Object Store"]
  Pool -->|"Default-Deny Direct Egress"| Proxy["Outside Sentinel Proxy + Audit Chain"]
  Proxy -->|"Allowed HTTPS Only"| Ext["Permitted Destinations"]
```

## For humans

**Owner:** [Kushal Trivedi](https://github.com/kushaltrivedi5)  
**Environment:** Dev  

### How hosted pods changed and why this aligns with Google ACE and Muse

1. **Before (Per-User Cloud Service Model):** Each new signup required provisioning a persistent cloud service and monolithic workspace archive, hitting per-project service limits around a few thousand accounts, charging standing disk/idle costs for dormant users, splitting development across Shared vs Private Pod runtimes, and leaving outbound networking inside the same container as terminal workloads.
2. **Now (Disposable Sandbox Pool + Permanent Owner Identity):** Every hosted person keeps one permanent private HTTPS agent path behind a stateless cluster TLS Edge Gateway and one durable cryptographic identity key unwrapped only into RAM at wake (then immediately wiped from tmpfs before requests arrive). Underneath, execution runs on virgin, single-use pooled sandboxes (`gVisor` today, `Kata` / `kata-clh` microVMs for dedicated isolation) that auto-destroy after `10 minutes` (`600s`) of inactivity while persisting workspace files incrementally in `4 MiB` encrypted object chunks.
3. **Open Adoption and Clear Unit Economics:** There is no invite wall or hard weekly turn cap blocking adoption. Instead, concurrency stays naturally bounded at **1 active sandbox per owner** (`USD 0.109/active-hr` or ~`USD 0.018` per 10-minute session), dormant accounts cost roughly **USD 0.003/user-month** in object storage with **USD 0 idle sandbox compute**, and Dev stands at `0` idle sandboxes plus `1` standing Sentinel proxy (`~USD 10/mo`).
4. **Google ACE and Muse Resonance:** Built on upstream `kubernetes-sigs/agent-sandbox` primitives (`SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim`) so Hussh aligns directly with Google Agent Compute Engine (ACE) (with upstream Kubernetes cluster portability across GCP, AWS GovCloud, and Azure Gov, while user-facing **Hussh Confidential Sandbox** runs exclusively on Google Cloud today). Delivers the Muse-grade persistent personal computer UX (zero idle polling, composable Browser + Terminal split pane, `$0` sleep) while adding Hussh sovereign advantages: zero plaintext through the central Hub, direct end-to-end sealed **Puppy** WebSocket continuity across disposable sandboxes, zero-DNS-exfiltration `hostAliases`, and out-of-sandbox Sentinel credential swapping plus tamper-evident audit logs.

### Why we are moving hosted agents to pooled single-use sandboxes

Running two agent runtimes side by side (a shared server for everyday users and dedicated per-person cloud services for private pods) splits features cleanly in code yet creates operational divergence and cloud per-project service limits at scale. Monolithic workspace tarballs also block serious terminal and multi-file toolchains.

Moving hosted accounts onto a pre-warmed pool of isolated single-use Kubernetes sandboxes aligns compute cost with concurrent active sessions rather than total signups:

1. **Zero idle compute burn for dormant users:** Inactive accounts exist purely as encrypted cloud objects while active turns claim an untouched sandbox immediately.
2. **Single-use sanitization and one signed base image:** Each claimed sandbox encrypts local scratch with an ephemeral in-memory key, destroys itself permanently when a session ends, and pulls CVE updates from one signed base image on next wake.
3. **Incremental encrypted sync:** Only changed file blocks upload to per-user encrypted object storage, removing monolithic archive ceilings and standing block-disk bills.
4. **Outside network gatekeeper and tamper-evident history:** Sandbox containers cannot reach cloud metadata endpoints or direct internet sockets; an outside gatekeeper validates destinations, injects short-lived credentials at the edge, and records audit history outside sandbox write authority.
5. **Open adoption with single-active-lease concurrency and BYOC/Puppy exemption:** Hosted sandboxes default to open, unrestricted adoption (`require_invite=False`, unbounded weekly turns), coalescing concurrent activity onto **1 active sandbox per owner** with a `10-minute` idle auto-destroy reaper (`WeeklySandboxQuotaLedger` also retains explicit invite and rolling weekly quota gates when configured), while owner-hosted cloud placements (BYOC) and local Puppy remain exempt and unthrottled.

### Phased rollout

- [x] **Phase 0: Architecture alignment and clean split.** Locked unified microVM runtime and narrowed #9511 to standalone Browser and reusable workspace split-pane UI.
- [x] **Phase 1: Warm-pool sandbox baseline, incremental sync, outside gatekeeper, and standalone Terminal.** Landed Wave 1 contracts ([Wave 1 PR #9755](https://github.com/hushh-labs/hushh-research/pull/9755)), completed live Dev GKE sandbox claim and single-use teardown validation, and greened all CI checks on `dev`.
- [x] **Phase 2: Live Dev routing, outside proxy runtime, and Browser + Terminal composition.** Landed Wave 2 ([PR #9762](https://github.com/hushh-labs/hushh-research/pull/9762)): out-of-sandbox `SentinelProxyRuntime` (`:3128` + `:8081` + durable JSONL HMAC audit sink), live Kubernetes `SandboxClaim` allocation, `hostAliases` zero-DNS-exfiltration resolution, Hub `/api/one/sandbox/claims` endpoints, and Browser-to-Terminal stdin handoff, verified end-to-end on live Dev GKE Autopilot (`hussh-one-sandbox-dev` in `hushh-pda-dev`) and scaled back to `0` idle pods.
- [x] **Phase 3: Direct TLS Edge Gateway, instant local read replica, fast recovery, and Dev Shared Runtime consolidation.** Stateless Edge Gateway (`/u/{hushh_id}/...` + direct `WS /api/one/puppy/relay`), single-use `virgin_standby` lease activation + tmpfs key unlink (`HUSSH_UNLINK_POD_PRIVATE_KEY_AFTER_LOAD`), `<2s` Kubernetes pod-termination inspection (`inspect_pod_termination`) + automatic dead-standby replacement, compacted `OwnerRecoveryProjection` shutdown checkpoint flush, 12-hour `pst1.` placement-bound session reuse across wakes, self-healing Dev Hub custody bootstrap (`consent-protocol/hushh_mcp/services/dev_sandbox_custody_bootstrap.py`), owner-scoped AES-256-GCM IndexedDB read-through cache (`0ms - 150ms` passive UI reads, `<100ms` target on Chats, Files, and Personal Wiki), `pod_mode()` offline Goals ([#9517](https://github.com/hushh-labs/hushh-research/issues/9517)) custody parity, Google Cloud single-pool branding truth, and `Hussh Shared` retirement on Dev cutover lanes.
- [ ] **Phase 4: UAT qualification, #9511 split-pane completion, and UAT/Production Shared Agent Runtime retirement.**

### Connected plans and sibling tracks

- **[#9511 Standalone Browser & Split-Pane UI](https://github.com/hushh-labs/hushh-research/issues/9511) ([Browser completion plan](browser-completion-plan.md)):** Delivers the desktop split-pane shell (`Browser` + `Activity` + pluggable `Terminal` slot) right behind Phase 1/2 runtime stabilization.
- **[#9736 Unify Information Exchange across Shared and Private Pods](https://github.com/hushh-labs/hushh-research/issues/9736):** Converges Drive/Gmail sharing onto unified Shared and Private Pod executors and retires standalone Drive workers alongside unified sandbox parity.
- **[#9517 Goals and Tasks](https://github.com/hushh-labs/hushh-research/issues/9517):** Schedules recurring tasks across Pod and local Puppy devices using qualified Browser/Terminal boundaries.
- **[#9370 Personal Wiki Memory](https://github.com/hushh-labs/hushh-research/issues/9370) and [#9429 External AI Archive Imports](https://github.com/hushh-labs/hushh-research/issues/9429) ([Personal Wiki Memory plan](../personal-wiki-memory-plan.md)):** Consumer memory compilation, archive imports, and scoped recall running inside the unified personal runtime.
- **[#5507 Owner-Controlled Private Pods](https://github.com/hushh-labs/hushh-research/issues/5507) ([Private-agent infra roadmap](../hussh-one-infra/README.md)):** Owner-hosted BYOC runtime readiness sharing the unified custody and broker boundary.

## For coding agents

- **Portable custom resources (`extensions.agents.x-k8s.io/v1beta1`):** Rendered by `consent-protocol/hushh_mcp/operons/agent_sandbox/k8s_manifests.py` and reference YAML in `deploy/agent-sandbox/`. Enforces `envVarsInjectionPolicy: Disallowed`, `volumeClaimTemplatesPolicy: Disallowed`, `automountServiceAccountToken: false`, `readOnlyRootFilesystem: true`, non-root UID `10001`, dropped Linux capabilities (`ALL`), immutable `@sha256:` digests, `SandboxClaim` single-use `shutdownPolicy: DeleteForeground` (`ttlSecondsAfterFinished: 0`), and `NetworkPolicy` ingress/egress fencing (`hussh-consent-hub` on TCP `8080`, `sentinel-egress-proxy` on TCP `3128`).
- **Cluster portability:** Uses `gvisor` (verified live on Dev GKE Autopilot cluster `hussh-one-sandbox-dev` in `hushh-pda-dev` with immediate warm-pool `SandboxAdopted` binding, automatic virgin replenishment, and `DeleteForeground` cleanup to `0` pods) alongside `microvm` (`kata-clh` hardware microVMs) and `kata` for dedicated Kata node pools, AWS GovCloud EKS, and Azure Gov AKS, reconciled via `deploy/agent-sandbox/reconcile_dev_gke_sandbox.sh` without Terraform per [the deployment standard](../../architecture/deployment-standard.md) and `AceComputeBackend.render_k8s_agent_sandbox_bundle`.
- **Single-use lease and quota gate:** `consent-protocol/hushh_mcp/services/agent_sandbox/lease_manager.py` enforces `WeeklySandboxQuotaLedger` (exempting `puppy` and `is_owner_cloud_target`) and `VirginSandboxLeaseManager` (`SC4_SINGLE_USE_VIOLATION` on reuse attempt, in-place zeroization of `bytearray` scratch keys).
- **Incremental CAS workspace sync:** `consent-protocol/hushh_mcp/services/pod_workspace/cas_sync_store.py` reuses `WorkspaceCheckpointLibrary` HKDF-SHA256 / AES-256-GCM framing over `ObjectStore` with deduplicated `<= 4 MiB` chunks, excluding `.env*`, private keys, `node_modules`, `.venv`, and symlinks, with `WORKSPACE_REVISION_CONFLICT` fencing and `SP 800-88` key-epoch crypto-erase (`forget_workspace`).
- **Outside egress mediation and tamper-evident audit:** `consent-protocol/hushh_mcp/operons/agent_sandbox/egress_policy.py` (blocking cleartext HTTP, metadata CIDRs, RFC1918/CGNAT DNS rebinding, reverse-tunnel suffixes, and 8 default-off raw TCP ports) pairs with `consent-protocol/hushh_mcp/services/agent_sandbox/sentinel_egress_proxy.py` (`hsur_*` surrogate swap + immediate origin-mismatch revocation) and `consent-protocol/hushh_mcp/operons/agent_sandbox/tamper_evident_audit.py` (HMAC-SHA256 chained log, failing closed with `AUDIT_UNAVAILABLE` if audit writes fail).
- **Standalone ADK Terminal tools:** `consent-protocol/hushh_mcp/one_adk/terminal_tools.py` exposes `terminal_start`, `terminal_poll`, `terminal_write`, and `terminal_stop` via `ContextVar` `terminal_session_invocation`, attached in `agent_tree._one_roster_tools` strictly inside `pod_mode()` without inflating `_COMPOSED_INSTRUCTION_CHAR_BUDGET`, backed by `SandboxProcessSessionManager` (`TERMINAL_OWNER_TAKEOVER_ACTIVE`, `SANDBOX_RAW_CREDENTIAL_FORBIDDEN`).
- **Live Hub routing and out-of-sandbox Sentinel runtime:** `consent-protocol/hushh_mcp/services/agent_sandbox/k8s_claim_allocator.py`, `hub_sandbox_router.py`, and `sentinel_proxy_server.py` connect `AceComputeBackend.build_hub_sandbox_router`, Hub-only `[OPS]` endpoints under `/api/one/sandbox/claims`, durable JSONL HMAC audit logging (`AUDIT_UNAVAILABLE` fail-closed), `sentinel_service_ip` `hostAliases` mapping (keeping UDP/TCP 53 DNS egress closed), on-demand `0 -> 1 -> 0` warm-pool scaling, and Browser-takeover stdin handoff (`BROWSER_TAKEOVER_REQUIRED`, `HANDOFF_CODE_INVALID`). Deploy baseline assets in `deploy/agent-sandbox/sentinel-egress-proxy.yaml` default to `replicas: 0` with `readOnlyRootFilesystem: true` and UID `10001`.
- **Stateless TLS Edge Gateway, fast crash recovery, and durable identity continuity:** `consent-protocol/hushh_mcp/services/agent_sandbox/edge_gateway_app.py`, `consent-protocol/hushh_mcp/services/agent_sandbox/k8s_claim_allocator.py`, `consent-protocol/hushh_mcp/services/agent_sandbox/virgin_standby.py`, `consent-protocol/hushh_mcp/services/dev_sandbox_custody_bootstrap.py`, `consent-protocol/hushh_mcp/services/pod_session_authority.py`, and `consent-protocol/pod_server.py` provide `/u/{hushh_id}/...` HTTP and `/u/{hushh_id}/api/one/puppy/relay` WebSocket passthrough straight to claimed GKE sandbox IPs without Hub visibility, deriving permanent per-owner X25519 keys via HKDF-SHA256, binding `/internal/v1/activate-lease` single-use (`409` on replay), wiping and unlinking `.pod_key_once` immediately (`HUSSH_UNLINK_POD_PRIVATE_KEY_AFTER_LOAD`), inspecting Kubernetes pod termination in `<2s` (`SANDBOX_HYDRATION_FAILED`) while auto-replacing dead pre-activation standbys, flushing compacted `OwnerRecoveryProjection` checkpoints on clean shutdown, reusing 12-hour `pst1.` placement-bound sessions across wakes, self-hydrating Dev Hub custody secrets at startup, and pairing with `hushh-webapp/lib/storage/encrypted-owner-ui-cache.ts`, `hushh-webapp/lib/files/files-cache.ts`, and `hushh-webapp/lib/agent/agent-chat-history-cache.ts` so Chats, Files, and Personal Wiki render in `0ms - 150ms` (`<100ms` target) across reloads.

## Operational references

- [Deployment standard](../../architecture/deployment-standard.md)
- [Dev pod first-light runbook](../../operations/hosting/dev-pod-first-light-runbook.md)
- [Browser completion plan](browser-completion-plan.md)
- [Portable Kubernetes manifests](../../../deploy/agent-sandbox/README.md)
