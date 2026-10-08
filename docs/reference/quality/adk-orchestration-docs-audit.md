# Private-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-08

**The dev application and isolated Files journeys work on both clouds. Release
acceptance is held on cold latency and normal-owner journeys.** Warm chat improved;
GCP's latest genuine cold first response took 129.8 seconds against the 30-second
target. The corrected candidate now serves dev. Exact-predecessor recovery passed
on both clouds; its cold-wake qualification is running on isolated resources.

Qualification uses **1 vCPU, 2 GiB RAM, minimum zero, maximum one and one worker**.
Google caps concurrent container requests at eight. Azure's Files-enabled HTTP
scaler uses eight as a scaling threshold, not a request cap; both runtimes guard
eight active chat threads. Total HTTP concurrency is not matched across clouds.
Existing owners retain selected configurations. Background
status does not wake pods; direct relay idle grace remains ten minutes. Computer
Use stays disabled. No application merge, UAT/production release, stable offer or
automatic owner upgrade is authorized by these results.

## Exact release evidence

| Surface | Verified evidence | Boundary |
| --- | --- | --- |
| Source | `caaa5a82fd9c6e1a620b037fb83e158470c1216e`; [hosted CI 37817492719](https://github.com/hushh-labs/hushh-research/actions/runs/37817492719) passed | Frozen ADK `31932bb01ae9`; later unrelated ADK changes belong to the next cycle. |
| Dev application | [Deployment 37821311755](https://github.com/hushh-labs/hushh-research/actions/runs/37821311755) succeeded; backend `00150-slh`, frontend `00128-8m7`, exact source/run and 100% traffic independently read back | Rollback targets: backend `00149-z9b`, frontend `00127-rn9`. |
| Schema | Version 284; all 55 dev-manifest rows match; no required schema gaps | Isolated schema restoration and owner-image recovery are separate receipts. |
| Pod release | `2026.10-dev.11+caaa5a82fd9c.e213acf2`; digest `sha256:e213acf2468179177371709fb2651eb622439ec8c2a2df3d11394d23867ffa1e` | Immutable dev-only offer currently lists no predecessor digests. Exact `ace34069` recovery has now passed on both clouds; descriptor publication remains a separate governed step. Publication does not approve an owner installation. |
| Isolated pods | Google revision `00010-r7q`; Azure `--q30f41b62764c`; both run `e213acf2` and passed encrypted Files/key recovery | Synthetic owners; not evidence of a normal Settings approval or fresh Azure environment. |

Application digests: backend `sha256:c26db844ba84e0607bcfd40c5953bb7ec211a659c34ecbb20a403ad77f52cd1b`;
frontend `sha256:c81cef6c080cabf8799a95b2a9e0df89ea9dfdaebfd736c47bbc0db1e1ab6f3d`.
GitHub Actions governed deployment; Cloud Build built immutable images.
The archived release descriptor and independent serving readback match the run. No owner resources were replaced by that workflow.

## Files-led acceptance matrix

| Journey | Source complete / isolated live result | Remaining acceptance |
| --- | --- | --- |
| Files | Dedicated `agent_files` and `/one/files` explorer. Both clouds: resumable 4 MiB + 1 KiB transfer, duplicate chunks, byte-exact download, folder move/rename/undo, trash/restore. | Normal owner browser, exact Files configuration offer and installation. |
| Organization | Google authenticated Cloud Tasks and Azure managed-identity Storage Queue consumer both complete opted-in synthetic organization. Exclusions refuse dispatch; cancellation preserves originals. Analysis switched off afterward. | Normal owner experience and production IAM/queue qualification. |
| Recovery / updates | Exact `ace34069` → `e213acf2` transition passed on both clouds: identity, keys, selected configuration and encrypted history retained. Google file bytes matched; separate current-image fixtures on both clouds also retain Files. | Normal Settings approval during active work, refresh/reconnect and one durable operation. Qualification is at 1 vCPU / 2 GiB, not capacity proof for every existing owner configuration. |
| Chat / runtime | Previous image `596aa92e`: 20 chats and one/two/four overlapping chat/Files/status pass; ten-minute soak settles 20 operations per cloud. New-image warm results are below. | Cold target; 20 genuine cold samples per cloud; real Puppy overlap; measured peak resources and final-image idle return. |
| Puppy | Existing Hermes identity and signed direct stream retained; prior grant/withdrawal, response and cancellation receipts. | Fresh response/reconnect on qualified image and independent active internet. Heartbeat alone is not inference. |
| Setup / billing | Durable retry, explicit Shared/`unplaced`, pending/assigned preservation, owner identity/IAM/CORS/admission gates. | New and existing owner setup, billing/policy return without duplicate resources. Azure trial refuses a second environment and new OpenAI S0 resource. |
| Connectors / commands | Sealed native Google authorization, scoped pod tools, exact approval/resume, refresh/restart fencing, notification coalescing and bounded durable jobs. | Real provider sign-in, native iOS/Android, scope upgrades, recorded commands, notification delivery and verified legacy hub cleanup. |
| Computer Use | Task/preview/takeover ports, consented PKM exports and encrypted opt-in site sessions are source-backed. | Separately gated on both clouds; no owner information admitted to an unqualified executor. |

## Performance and model decision

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Google new-image warm chat | 20/20; first-text p50 **6.611 s**, p95 **7.700 s** | `e213acf2`; approved dev bridge. First post-install turn was 24.821 s, separate from this warm series. Cold wake requires independent platform-zero evidence. |
| Google previous-image cold | Admission **50.958 s**, first text **129.795 s**, complete **134.314 s** | Target failed. Stopped after one sample to fix the measured replay cost; original failure retained. |
| Azure new-image warm chat | 20/20; first-text p50 **10.703 s**, p95 **13.389 s** | Previous image p95 was 29.018 s on the same fixture. First post-install turn was 25.643 s. Existing environment and cross-region custody remain qualification limits. |
| Azure previous-image cold | Fresh platform zero followed by a **90 s** admission timeout | Original failure retained. New-image cold sampling requires fresh scale-to-zero after its completed checkpoint turn. |
| Azure transport probe | Six bounded reads/path: median **289 ms → 70 ms** with existing pooled transport | Same-resource microbenchmark; no response cache. A same-resource microbenchmark does not establish end-to-end improvement. |
| Gemini 3.8 | Native exchange 2/3; third response 504, including the one allowed transient retry | Not qualified as default. Corrected mailbox trace follows authored acknowledgement then Email delegation; strict first-tool score alone was misleading. |
| Azure GPT-6 Luna | 3/3 native tool round trips and 6/6 representative first-tool cases; 3.0–6.6 s/native exchange | Actual pod identity, temporary scoped Responses-only deployment. No 429 at configured capacity; earlier capacity-one 429 and its retry remain failures. Small sample is not quota capacity. |

Initial model qualification totals **$1.66458985 against the $2 ceiling**; runtime
journeys are separately bounded. Governed Google defaults remain unchanged. The
Azure personal owner's original model/resource was not modified by qualification.

The reviewed `2026.10-dev.12` descriptor adds only predecessor `ace34069` after
the direct Google/Azure recovery receipts. Its reuse pin retains the already
published executable digest and original source/run; publication and owner approval
are still separate. Remove the pin before any subsequent application image build.

### Reviewed integration debt

The [architecture baseline](./architecture-fitness-baseline.json) retains measured
legacy debt and unchanged 500/250/80 budgets. Small extensions to existing recovery,
object-store and nearest regression owners require explicit source review; new
checkpoint logic stays in its own bounded leaf. No mass split or gate removal.

The released source persists bounded encrypted derived checkpoints of existing
log reducers and completed conversation state. The log remains authoritative:
current custody, cursor ancestry, erasure fences and incarnation checks still run.
Erasure leaves public closed projection slots, refusing delayed stale/create-only
writes. Streamed reads retain exact object versions and bound bytes before loading.
Azure reuses the existing cookie-refusing transport pool with per-request identity.
The application serves this source; owner installation and final cold-wake results remain separate evidence.

## Owners and next gate

| Owner | Required receipt |
| --- | --- |
| Runtime / release | Core mirror, exact-SHA hosted CI and governed dev deployment passed. Exact-predecessor recovery passed on both clouds. Finish current-image measurements, publish only qualified compatibility metadata and complete normal-owner approval. |
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
