# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). The
Files-led matrix below carries this revision-bound decision.

**Decision at 2026-09-30:** Hold existing-owner Files activation and any main,
UAT, production, or stable-channel promotion. The dev application and a prior
owner-approved image update have evidence; the installed personal pod still has
Files disabled, and its read-only setup plan refused release compatibility.
No Files resources or owner-pod update were started by that refusal.

This is a dated decision record, not a live fleet register. It compresses the
2026-09-24 through 2026-09-30 integration audit at source revision `17a79fa`.
The implementation paths named below were inspected in the 2026-09-30 checkout;
CI and serving claims come from the dated audit receipts, not a fresh deployment
query for this documentation edit. The [One hierarchy](../one/one-agent-hierarchy.md),
[private Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md), and
[deployment standard](../architecture/deployment-standard.md) own reusable
architecture and operator instructions.

## Decision evidence

The frozen ADK integration and infrastructure source at `1d90942a7` passed the
local core mirror and [hosted validation 36755011818](https://github.com/hushh-labs/hushh-research/actions/runs/36755011818).
The [main-owned dev workflow 36757584302](https://github.com/hushh-labs/hushh-research/actions/runs/36757584302)
then served frontend `hushh-webapp-00099-wxx` and backend
`consent-protocol-00120-6gz` at 100% traffic with that exact SHA and workflow
labels. A later Files refusal presentation change at `01429e94d` passed
[hosted validation 36775950543](https://github.com/hushh-labs/hushh-research/actions/runs/36775950543)
and [frontend-only dev workflow 36778215277](https://github.com/hushh-labs/hushh-research/actions/runs/36778215277).
The dated readback found frontend `hushh-webapp-00100-xnh` at 100% with that
source; backend stayed on `1d90942a7`. These are dev results. The release
artifact also reported degraded `ria_stage1_query_only` dependency health.

The normal owner Settings journey previously installed dev `.8` from verified
`.6` after active-work drain and duplicate approval coalescing. It read back
the installed immutable digest on the same service with the owner's selected
compute and custody settings intact. On 2026-09-30 that service still lacked
`POD_FILES_ENABLED`; direct Files list returned 503. The read-only Files setup
plan returned 409, `compatibility for this software update is not verified`.
The [release compatibility check](../../../consent-protocol/api/routes/one/personal_agent.py)
and [digest allowlist](../../../consent-protocol/hushh_mcp/services/pod_release.py)
confirm that this is a deliberate image gate. The
[Files UI](../../../hushh-webapp/components/files/files-workspace.tsx)
reported the inactive capability accurately. This establishes truthful refusal,
not a successful Files activation.

## Files-led acceptance matrix

| Area | Dated evidence and classification | Blocking proof / accountable owner |
| --- | --- | --- |
| **Existing-owner Files setup** | **Partially exists.** 2026-09-30 normal owner browser unlocked and admitted to the existing pod; Files list was 503 and the read-only setup plan was 409. No capability, queue, worker, or image was changed. | **Blocked:** backend Files and pod-release owners need a recovery-proven immutable dev release compatible with the exact installed predecessor, then an owner-reviewed configuration plan and installed-configuration readback. An image-only approval cannot activate Files. [Files runbook](../operations/private-files-library.md). |
| **Files transfer and cold opening** | **Partially exists.** 2026-09-30 reviewer on a separate, already enabled `.5` pod passed folder creation, interrupted 5 MiB upload/resume, byte-exact download, rename/undo, Trash/restore, and same-session vault continuity. Cold interrupted list attempts were intermittent; warm retries passed. | **Blocked:** Files browser/pod owners need a repeatable cold normal-owner admission, list and settings read within an accepted time bound. Review-minted sessions intentionally receive `TRUSTED_DEVICE_REVIEW_SESSION_REFUSED` for self-enrolment; do not weaken that authority check to make the harness pass. |
| **Files analysis, billing and recovery** | **Source-backed, live acceptance missing.** Opt-in, exclusions, bounded jobs and distinct configuration approval are documented in the [Files contract](../operations/private-files-library.md). Transfer proof above does not prove automatic organization, missing-billing return, erasure, or interrupted activation recovery. | **Blocked:** Files backend, browser and deployment owners must run the normal owner journey, reconcile uncertain cloud steps, verify retained encrypted information and teardown boundaries, and record target-bound receipts. Those future runs are **unverified**. |
| **One/ADK delegation and MCP** | **Source-backed dev integration.** The frozen local ADK tree at `de7a91daf` plus one affected editor correction was integrated into the 2026-09-30 branch candidate; generated registries were rebuilt from authored owners. Local core and exact-SHA CI passed. Owner-private calls use current owner authority without ordinary exact-call review; review-required calls retain the one-use ledger. | **Open:** agent owners must prove each admitted specialist's usable route and consent boundary and run a review-required connector fixture in dev (**unverified**). The 2026-09-24 A2A result was preview containment, not official remote A2A v1 acceptance. Use the [hierarchy](../one/one-agent-hierarchy.md); do not infer one universal dispatch path. |
| **Owner update and private chat** | **Partially accepted in dev.** 2026-09-30 `.6` to `.8` Settings approval, active-work drain, same-service replacement and installed-digest readback passed. A warm postinstall chat and encrypted-session continuity passed. One historical cold browser rehearsal ended its 120-second wait before the pod completed at about 131 seconds; the current rehearsal source waits 180 seconds, which is a harness bound, not a runtime limit or fresh live pass. | **Open:** pod runtime and release owners need fresh live cold-turn timing against an agreed objective, plus controlled update-failure/recovery proof before broader rollout. Publication alone does not install an owner image. [Update runbook](../operations/dev-pod-first-light-runbook.md). |
| **Puppy direct relay and hub capacity** | **Partially accepted in dev.** 2026-09-30 the existing trusted device produced a direct local-model reply with only `puppy.inference`; owner withdrawal revoked the pod subject and ended the relay, then re-enabling and restarting that relay restored a reply. The five-instance dev hub revision showed no platform 429s in one bounded postdeploy window. | **Open:** device and repo-operations owners need independent active network paths, device/model cancellation observation, cold timing, staged concurrent load and a soak. An idle pod link is not a device cancellation receipt; a zero-429 window is not a capacity envelope. |
| **Production authority and promotion** | **Blocked.** A 2026-09-30 live production provenance check found `deploy_authority_drift` between reviewed IAM setup and live bindings. No application main merge, UAT/production deployment, stable offer or Files activation is evidenced here. | **Blocked:** production governance must reconcile setup and live least-privilege IAM and rerun its live checker. Release owners then need migration graduation, billing/recovery evidence and UAT repetition of Files, update and Puppy journeys. The degraded RIA dependency needs its own owner disposition. |

The 2026-09-24 Plaid passthrough and Mail/Drive findings were source audits,
not rollout receipts. Keep their separate gates with the
[Plaid vault contract](../kai/plaid-vault-passthrough.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md).
The inspected [Plaid client](../../../consent-protocol/hushh_mcp/integrations/plaid/client.py)
still has a generic network retry around POST, and the
generic Kai proxy (`hushh-webapp/app/api/kai/[...path]/route.ts`)
still rebuilds JSON without forwarding the backend vault route's `no-store`
header. Their owners must verify single-use exchange recovery and browser-facing
cache policy before making those claims; this pod decision does not close them.

## Accountable next gate

1. **Files and pod-release owners:** freeze one exact branch candidate; prove the
   installed predecessor, recovery ancestry, migration and immutable release
   descriptor. A future compatible release remains **unverified**. Source,
   local core and exact-SHA hosted checks must pass before a governed dev offer.
2. **Normal owner approval:** obtain the read-only Files configuration plan,
   verify its owner, pod incarnation, resources and immutable image, then use
   the existing owner approval and durable update operation. Confirm the same
   service and selected compute, encrypted storage, keys, recovery prefixes,
   installed digest and `POD_FILES_ENABLED` on readback. No reviewer-session
   self-enrolment or implicit Shared fallback is an acceptable shortcut.
3. **Files/browser acceptance:** repeat cold admission and initial read on the
   newly enabled pod, then transfer, analysis opt-in/exclusion, missing-billing
   resume, cancellation and uncertain-step recovery. Preserve private receipts
   in their restricted owner workflow; publish only sanitized outcomes.
4. **Release gate:** complete independent-network Puppy and device cancellation,
   hub load/soak, production IAM provenance, migration/recovery and UAT. Only
   then reconsider main or broader rollout. Each future row remains
   **unverified** until its target-bound result is recorded.

## GCP-only pod deployment correction — 2026-09-25

This heading preserves the historical link. The 2026-09-25 source correction
removed Anypoint as a pod deployment target. Managed `gcp` and owner-project
`user_gcp` are the supported deployment modes; `null` is inert. Unsupported
persisted targets fail closed. The separate CRM connector remains in scope;
no AWS or Azure pod adapter or cloud-resource change followed from that docs
correction. The [deployment standard](../architecture/deployment-standard.md)
owns the current decision. The 2026-08-11 first-light observations on
asynchronous API readiness, exact GCP IAM and rendered-service checks now live
in the [dev runbook](../operations/dev-pod-first-light-runbook.md#owner-project-first-light-checks-2026-08-11-rehearsal).
The [recovery guide](../operations/pod-backup-and-recovery.md) retains the
conditional first-boot key and custody lesson. Neither dated rehearsal proves
fleet-wide recovery or Files readiness.

## Files continuation evidence — 2026-09-25

This heading preserves the historical link. At the 2026-09-25 Research source
checkpoint, focused tests exercised signed browser admission/renewal,
encrypted Files storage and bounded folder-index rebuilding, isolated-schema
migration restoration, queue/worker erasure and consent regressions. They
established source contracts, not deployed schema, live erasure or owner Files
activation. The [Files runbook](../operations/private-files-library.md) owns
the subsequent provisioning and recovery contract. The 2026-09-30 matrix
above supersedes that checkpoint for the dev decision; the older tests do not
resolve the installed-image compatibility refusal.
