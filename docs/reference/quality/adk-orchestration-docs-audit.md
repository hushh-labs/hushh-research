# Private-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-08

**The dev application and isolated Files journeys work on both clouds. Release
acceptance is held on cold latency and normal-owner journeys.** Warm chat improved;
GCP's latest genuine cold first response took 129.8 seconds against the 30-second
target. The next candidate addresses measured replay and transport costs.

Qualification uses **1 vCPU, 2 GiB RAM, minimum zero, maximum one, one worker and
concurrency eight**. Existing owners retain selected configurations. Background
status does not wake pods; direct relay idle grace remains ten minutes. Computer
Use stays disabled. No application merge, UAT/production release, stable offer or
automatic owner upgrade is authorized by these results.

## Exact release evidence

| Surface | Verified evidence | Boundary |
| --- | --- | --- |
| Source | `9ab8233a44c652881aa4555b1cb91e7fe7bc8c6a`; [hosted CI 37773844930](https://github.com/hushh-labs/hushh-research/actions/runs/37773844930) passed | Frozen ADK `31932bb01ae9`; later unrelated ADK changes belong to the next cycle. |
| Dev application | [Deployment 37787105038](https://github.com/hushh-labs/hushh-research/actions/runs/37787105038) succeeded; backend `00149-z9b`, frontend `00127-rn9`, exact source/run and 100% traffic independently read back | Rollback targets: backend `00148-9kb`, frontend `00126-67p`. |
| Schema | Version 284; all 55 dev-manifest rows match; no required schema gaps | Isolated schema restoration and owner-image recovery are separate receipts. |
| Pod release | `2026.10-dev.11+9ab8233a44c6.596aa92e`; digest `sha256:596aa92e79d1100c863d335e629a363540d03509318e192007a448d1fdef3f7f` | Immutable dev-only offer lists no qualified predecessor digests. Publication does not approve an owner installation. |
| Isolated pods | Google revision `00009-xwj`; Azure `--qb7407ec57e1f`; both run the exact target digest | Synthetic owners; not evidence of a normal Settings approval or fresh Azure environment. |

Application digests: backend `sha256:784b64b4850388d5b2de172651bec0b012e8cbe8ef7e6391f518ae4940598239`;
frontend `sha256:dad3db3a4bf32f150c29d5cc0d6d9ba1ade4a05bd926c48d98c20653c5b51a4e`.
GitHub Actions governed deployment; Cloud Build built backend in 377 seconds and
frontend in 114 seconds. No owner resources were replaced by that workflow.

## Files-led acceptance matrix

| Journey | Source complete / isolated live result | Remaining acceptance |
| --- | --- | --- |
| Files | Dedicated `agent_files` and `/one/files` explorer. Both clouds: resumable 4 MiB + 1 KiB transfer, duplicate chunks, byte-exact download, folder move/rename/undo, trash/restore. | Normal owner browser, exact Files configuration offer and installation. |
| Organization | Google authenticated Cloud Tasks and Azure managed-identity Storage Queue consumer both complete opted-in synthetic organization. Exclusions refuse dispatch; cancellation preserves originals. Analysis switched off afterward. | Normal owner experience and production IAM/queue qualification. |
| Recovery / updates | Both isolated pods preserve identity, keys, selected configuration and exact file bytes across the current image transition. Google also retains a synthetic encrypted conversation marker. | Actual predecessor compatibility, Settings approval while work is active, one durable operation through refresh, restart and verified completion. |
| Chat / runtime | Both clouds complete 20 chat turns. One/two/four overlapping chat, Files and status operations pass; ten-minute soak settles 20 operations per cloud. | Cold target; 20 genuine cold samples per cloud; real Puppy overlap; measured peak resources and final-image idle return. |
| Puppy | Existing Hermes identity and signed direct stream retained; prior grant/withdrawal, response and cancellation receipts. | Fresh response/reconnect on qualified image and independent active internet. Heartbeat alone is not inference. |
| Setup / billing | Durable retry, explicit Shared/`unplaced`, pending/assigned preservation, owner identity/IAM/CORS/admission gates. | New and existing owner setup, billing/policy return without duplicate resources. Azure trial refuses a second environment and new OpenAI S0 resource. |
| Connectors / commands | Sealed native Google authorization, scoped pod tools, exact approval/resume, refresh/restart fencing, notification coalescing and bounded durable jobs. | Real provider sign-in, native iOS/Android, scope upgrades, recorded commands, notification delivery and verified legacy hub cleanup. |
| Computer Use | Task/preview/takeover ports, consented PKM exports and encrypted opt-in site sessions are source-backed. | Separately gated on both clouds; no owner information admitted to an unqualified executor. |

## Performance and model decision

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Google current-image chat | 20/20; first-text p50 **6.765 s**, p95 **7.637 s** | Observed series includes a 48.987 s first post-boot turn. This is not a genuine-cold distribution; approved dev Gemini bridge. |
| Google genuine cold | Admission **50.958 s**, first text **129.795 s**, complete **134.314 s** | Target failed. Stopped after one sample to fix the measured replay cost; original failure retained. |
| Azure current-image chat | 20/20; first-text p50 **25.743 s**, p95 **29.018 s** | Disposable app, existing unchanged environment; custody resources in another region. No performance equivalence inferred from matching allocation. |
| Azure transport probe | Six bounded reads/path: median **289 ms → 70 ms** with existing pooled transport | Same-resource microbenchmark; no response cache. End-to-end improvement requires the corrected image. |
| Gemini 3.8 | Native exchange 2/3; third response 504, including the one allowed transient retry | Not qualified as default. Corrected mailbox trace follows authored acknowledgement then Email delegation; strict first-tool score alone was misleading. |
| Azure GPT-6 Luna | 3/3 native tool round trips and 6/6 representative first-tool cases; 3.0–6.6 s/native exchange | Actual pod identity, temporary scoped Responses-only deployment. No 429 at configured capacity; earlier capacity-one 429 and its retry remain failures. Small sample is not quota capacity. |

Initial model qualification totals **$1.66458985 against the $2 ceiling**; runtime
journeys are separately bounded. Governed Google defaults remain unchanged. The
Azure personal owner's original model/resource was not modified by qualification.

### Reviewed integration debt

The [architecture baseline](./architecture-fitness-baseline.json) retains measured
legacy debt and unchanged 500/250/80 budgets. Small extensions to existing recovery,
object-store and nearest regression owners require explicit source review; new
checkpoint logic stays in its own bounded leaf. No mass split or gate removal.

The next source change persists bounded encrypted derived checkpoints of existing
log reducers and completed conversation state. The log remains authoritative:
current custody, cursor ancestry, erasure fences and incarnation checks still run.
Erasure leaves public closed projection slots, refusing delayed stale/create-only
writes. Streamed reads retain exact object versions and bound bytes before loading.
Azure reuses the existing cookie-refusing transport pool with per-request identity.
These are local corrections, not claims about the serving image above.

## Owners and next gate

| Owner | Required receipt |
| --- | --- |
| Runtime / release | Finish corrected candidate, core mirror once, exact-SHA hosted CI, governed dev deployment and both-cloud cold/warm/idle measurement. |
| Owner / device | Normal Google-authenticated unlocked browser for native provider and Settings journeys; existing Hermes awake plus another independent internet path. Automated Chromium sign-in was refused October 7 and stopped. CLI access and review-minted sessions do not substitute. |
| Azure subscription | Eligibility for fresh environment/model resources. Existing-environment fixture is explicitly narrower; no personal service settings changed. |
| Production | Graduate parked migrations/release channels; qualify actual legacy Shared cohort, IAM, erasure, recovery, hub capacity and UAT journeys independently. |

Migration 955 preserves only the evidenced legacy Shared cohort with its recorded
`cloud` marker and no conflicting choice, assignment, detach history or setup job.
Missing placement alone is not Shared. Existing-account release notes follow
unlock and resolved setup; new accounts skip historical catch-up. Pod notes require
the exact successful operation and verified digest. Neither notice grants access.

Whole monthly planning budgets at 30 billable hours, 50 GiB and 1,500 modeled calls
are **$38.69 Google/Flash and $18.74 Azure/Luna**, including a $5 reserve. Models are
not equivalent quality. [Package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget)
include disk/IP, hypothetical external VM wake, custody, model calls and exclusions.
Paid scale-down tails need measurement; warnings never stop service.

Operational owners: [Files](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md),
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md).

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; CRM remains. Current
Google/Azure choices and cloud-specific gates belong to the deployment standard.

## Files continuation evidence — 2026-09-25

Historical pointer: early source checks were not owner-cloud activation receipts.
Dev history cleanup 944 completed September 28 under
[run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630).
Migration 249 is the public-profile bridge; no repeated deletion or no-op rollback
claim. Current acceptance belongs to the matrix above; Git retains chronology.
