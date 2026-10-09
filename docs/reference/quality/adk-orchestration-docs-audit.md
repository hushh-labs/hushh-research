# Private-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-08

Measurement snapshot: **2026-10-09 05:15 UTC** (October 8 locally). Cold cohorts are unchanged. Owner activation, sealed Puppy admission, idle socket release, zero replicas and on-demand reconnection were verified; normal browser inference and Settings approval remain separate.

**Production rollout is withheld. Dev application and isolated Files journeys
work on both clouds; release acceptance still needs cold latency and normal-owner
journeys.** The corrected image
serves dev and passes exact-predecessor recovery on both clouds. Current cold
responses remain above the 30-second target. Complete 20-sample cold cohorts
have p95 **71.304 seconds Azure / 71.721 seconds Google**. These are
operator-bootstrap measurements, not browser timing. Slow samples and original failures
remain recorded. Current-image warm and bounded concurrent journeys pass.

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
| Local continuation | `0eeb3cc1dc`: reuse fresh, identity-bound direct admission instead of a redundant browser wake probe; preserve the existing endpoint facade | 61 focused checks, typecheck, lint and architecture ratchet pass. Not deployed. Hermes `dc0f776fb3` records verified sealed admission without private payloads. |
| Verified candidate | `f026ba9eaf54782fcf3d09fd9578a68af1c4ad3f`; local core and [hosted CI 37846374234](https://github.com/hushh-labs/hushh-research/actions/runs/37846374234) passed | Not deployed. Frozen ADK `31932bb01ae9`; later unrelated ADK changes belong to the next cycle. |
| Serving source | `e30732de37f21759e86b95027252163319de3d60`; [hosted CI 37828524953](https://github.com/hushh-labs/hushh-research/actions/runs/37828524953) passed | Source and serving evidence remain separate. |
| Dev application | [Deployment 37832290957](https://github.com/hushh-labs/hushh-research/actions/runs/37832290957) succeeded; backend `00151-9x6`, frontend `00129-bn5`, exact source/run and 100% traffic independently read back | Rollback targets: backend `00150-slh`, frontend `00128-8m7`. |
| Serving schema | Version 284; all 55 entries in the serving dev manifest match | Source-only 287 adds explicit Shared choice fields; parked 958 captures legacy continuity. These changes were not applied by this task; final integration must reconcile release contracts before rollout. |
| Pod release | `2026.10-dev.12+caaa5a82fd9c.e213acf2`; digest `sha256:e213acf2468179177371709fb2651eb622439ec8c2a2df3d11394d23867ffa1e` | Published dev-only offer admits only exact predecessor `ace34069` after recovery passed on both clouds. Reused image retains source `caaa5a82` and its original provenance. Publication does not approve an owner installation. |
| Isolated pods | Google `00010-r7q`; Azure warm/soak `--q30f41b62764c`, registry-locality comparison `--ql04f3fe9a92`; all run `e213acf2` with verified Files/key recovery | Synthetic owners; not evidence of a normal Settings approval or fresh Azure environment. |

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
| Chat / runtime | Current `e213acf2`: 20 warm and 20 genuine-cold chats per cloud complete; one/two/four overlapping chat/Files/status pass; ten-minute soak settles 20 operations per cloud. | Cold target fails; normal-browser cold timing, real Puppy overlap and full-workload resource peaks remain unverified. Genuine scale-to-zero observed on the current image. |
| Headless reviewer / owner APIs | Deployed dev: canonical reviewer authentication, visible locked-vault challenge, unlock, Hosting/Updates and same-session continuity pass. Existing owner-approved Hermes session returns active Azure BYOC, an installable `.12` update and HTTP 200 Files plan, with unchanged owner/device claims; content analysis remains off. | Bounded browser rehearsal still fails on unsolicited enrollment; local guard and negative control pass. No browser import of the device session, new enrollment, Files approval, update approval or installation occurred. |
| Puppy | Existing grant enabled; signed Azure endpoint and inference-only binding v9 verified. Sealed WSS admission reports epoch 32 and 600-second grace. Its direct socket closed by 05:06:53 UTC; Azure reported zero replicas at 05:13:30. Owner activation reconnected the same identity at epoch 33 by 05:15:15. | Browser inference, cancellation, withdrawal/re-enable and independent active internet. Cold relay rehearsal took about 52 seconds with one transient reconnect; not a first-token result. |
| Setup / billing | Durable retry and pending/assigned preservation. New authorization refuses an unrecorded setup; malformed detach history cannot revive Shared. One-time legacy continuity is locally qualified. | New and existing owner setup, billing/policy return without duplicate resources. Azure trial refuses a second environment and new OpenAI S0 resource. |
| Connectors / commands | Sealed native Google authorization, scoped pod tools, exact approval/resume, refresh/restart fencing, notification coalescing and bounded durable jobs. | Real provider sign-in, native iOS/Android, scope upgrades, recorded commands, notification delivery and verified legacy hub cleanup. |
| Computer Use | Task/preview/takeover ports, consented PKM exports and encrypted opt-in site sessions are source-backed. | Separately gated on both clouds; no owner information admitted to an unqualified executor. |

## Performance and model decision

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Google new-image warm chat | 20/20; first-text p50 **6.611 s**, p95 **7.700 s** | `e213acf2`; approved dev bridge. First post-install turn was 24.821 s, separate from this warm series. Cold wake requires independent platform-zero evidence. |
| Google previous-image cold | Admission **50.958 s**, first text **129.795 s**, complete **134.314 s** | Target failed. Stopped after one sample to fix the measured replay cost; original failure retained. |
| Azure new-image warm chat | 20/20; first-text p50 **10.703 s**, p95 **13.389 s** | Previous image p95 was 29.018 s on the same fixture. First post-install turn was 25.643 s. Existing environment and cross-region custody remain qualification limits. |
| Current-image cold | Google **20/20**, p50 **31.117 s**, p95 **71.721 s**, range **29.455–74.320 s**; Azure **20/20**, p50 **60.035 s**, p95 **71.304 s** | Fresh platform zero before each sample; nearest-rank percentiles. Operator-bootstrap admission is included; this is not normal-browser timing. Both targets failed. Original Google 129.795 s and Azure 90 s admission timeout retained. |
| Azure cold phases | Image pull **26.048 s**; startup recovery **3.251 s** | Same-image EastUS2 registry comparison preserves identity, ingress, keys and file bytes; 20-sample cohort complete. Original registry and custody are WestUS2 while compute is EastUS2. |
| Azure transport probe | Six bounded reads/path: median **289 ms → 70 ms** with existing pooled transport | Same-resource microbenchmark; no response cache. A same-resource microbenchmark does not establish end-to-end improvement. |
| Gemini 3.8 | Native exchange 2/3; third response 504, including the one allowed transient retry | Not qualified as default. Corrected mailbox trace follows authored acknowledgement then Email delegation; strict first-tool score alone was misleading. |
| Gemini 3.5 Flash | LOW: native tools 3/3; strict first-tool selection 5/6 | The mailbox case acknowledges then delegates to Email in a bounded two-step trace, matching authored behavior. Initial 429 retained and one permitted retry used. No connector executed or default promotion. |
| Gemini 3.5 Flash-Lite | Native tools 3/3; current explicit LOW first-tool run 5/6, probe p95 **2.497 s**, no 429; Drive returned no tool | Prior baseline and MEDIUM runs each scored 4/6; baseline thinking was unspecified and its mailbox fixture differed. Retain those receipts without claiming a paired improvement. LOW's Drive refusal and owner journeys keep default promotion unqualified. |
| Azure GPT-6 Luna | 3/3 native tool round trips and 6/6 representative first-tool cases; 3.0–6.6 s/native exchange | Actual pod identity, temporary scoped Responses-only deployment. No 429 at configured capacity; earlier capacity-one 429 and its retry remain failures. Small sample is not quota capacity. |

One's authored chat policy defaults to LOW; the Azure Responses adapter carries
that level as `reasoning.effort`. The selectable Google fleet remains 3.7/3.6.
Current official global input/output rates per million tokens are $1.50/$9 for
plain 3.5 Flash, $0.30/$2.50 for Flash-Lite, and introductory $0.75/$3.75 for
3.8 Flash through December 31 ([provider rates](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)). LOW changes observed reasoning usage, not token
prices; output includes reasoning ([thinking contract](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking)). The conservative qualification accounting is
$1.96791915 of the $2 ceiling, including a reserved failed request; it is not an invoice.

During bounded overlap/soak, Azure sampled maximum working set was **0.500 GiB**
and CPU **0.092 cores**. Google maximum one-minute p95 memory was **20.95%** of
2 GiB and CPU **31.95%**. Different provider aggregations are not comparable peaks
or full-workload capacity proof. Both observations retained at most one instance.

Runtime journeys are separately bounded. Governed Google defaults remain unchanged. The
Azure personal owner's original model/resource was not modified by qualification.

The published `2026.10-dev.12` descriptor adds only predecessor `ace34069` after
the direct Google/Azure recovery receipts. Its reuse pin retains the already
published executable digest and original source/run. Publication passed; normal
owner approval remains separate. The local `2026.10-dev.13` draft removes that reuse pin and lists no predecessors; it has not been built, published or installed. The serving offer remains `.12`.

A subsequent local correction removes one redundant pre-snapshot log read while
retaining fresh owner/lease admission, projection ancestry/erasure checks and final
read admission. The nearest 16 tests pass; removing the final fence in an isolated
negative control correctly fails the concurrent-erasure case. This correction is
not in the serving image; its latency benefit remains unmeasured. A further
source correction loads the hub router only when requested, retaining the public
`api.routes.one.router` entrypoint. The local import probe fell from 2.797 to
1.515 seconds; all 104 pod routes and 345 hub routes retained their contracts.
Local import timing does not establish a cloud cold-start improvement.

The headless run identified unsolicited browser enrollment during bounded reviewer
reads. The local client now refuses fresh enrollment before key creation or network
mutation, while reusing existing subjects. The server's review-mint refusal remains
unchanged. The nearest 63 checks pass; removing the guard fails the regression.
This correction has not been deployed and cannot authorize a personal pod update.

### Reviewed integration debt

The [architecture baseline](./architecture-fitness-baseline.json) retains measured
legacy debt and unchanged 500/250/80 budgets. Small extensions to existing recovery,
object-store and nearest regression owners require explicit source review; new
checkpoint logic stays in its own bounded leaf. No mass split or gate removal.
The bounded enrollment correction received independent review: only its service
module span (709 to 715) and nearest regression module (495 to 516) were accepted.
Scanner rules, exclusions and future regression enforcement remain unchanged.

The released source persists bounded encrypted derived checkpoints of existing
log reducers and completed conversation state. The log remains authoritative:
current custody, cursor ancestry, erasure fences and incarnation checks still run.
Erasure leaves public closed projection slots, refusing delayed stale/create-only
writes. Streamed reads retain exact object versions and bound bytes before loading.
Azure reuses the existing cookie-refusing transport pool with per-request identity.
The application serves this source; owner installation and final cold-wake results remain separate evidence. Registry comparison uses only disposable resources and preserves recovery and custody.

## Owners and next gate

| Owner | Required receipt |
| --- | --- |
| Runtime / release | Core mirror, exact-SHA hosted CI and governed dev deployment passed. Exact-predecessor recovery and current-image cold/warm cohorts completed on both clouds. Compatibility metadata is published. Resolve measured cold latency and complete normal-owner approval. |
| Owner / device | A supported owner Firebase SDK session and vault unlock for Settings; existing Hermes awake plus another independent internet path. Chromium sign-in was refused October 7; Firebase rejects both CLI clients with `INVALID_OAUTH_CLIENT_ID`. Existing Hermes authentication passes owner API readback, without minting or removing claims, but has no supported browser import. No installation approved. UID/passphrase alone do not establish sign-in. |
| Azure subscription | Eligibility for fresh environment/model resources. Existing-environment fixture is explicitly narrower; no personal service settings changed. |
| Documentation / Wiki | Current report calculations and visual review pass. The prior full docs command flags retained scratch/source-copy links under the concurrent classification change; preserve evidence while its owner resolves provenance. Private pod-page corrections now passed readback, including current release, legacy Shared continuity, migration limits, relay wait and Flash-Lite measurements. |
| Production | Graduate parked migrations/release channels; qualify actual legacy Shared cohort, IAM, erasure, recovery, hub capacity and UAT journeys independently. |

Read-only checks of the actual UAT/production databases found the branch-only
`cloud` marker absent from completed legacy accounts; 955 alone would not preserve
their Shared access. New parked 958 captures eligible completed accounts once,
excluding assignments, pending setup, detached/malformed authority and prior
choices. Real PostgreSQL tests prove replay cannot admit new/later-completed
accounts. The production reader foundations and additive backfill must graduate
before application traffic; no production schema was changed. Missing placement
alone is not Shared. Existing-account release notes follow
unlock and resolved setup; new accounts skip historical catch-up. Pod notes require
the exact successful operation and verified digest. Neither notice grants access.

Whole monthly planning budgets at 30 billable hours, 50 GiB and 1,500 modeled calls
are **$38.69 Google/Flash and $18.74 Azure/Luna**, including a $5 reserve. Models are
not equivalent quality. At the same resources and token assumptions, Google with
**3.5 Flash-Lite is $23.32**; this price scenario does not qualify a model switch.
[Package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget)
include disk/IP, hypothetical external VM wake, custody, model calls and exclusions.
Paid scale-down tails need measurement; warnings never stop service.

Cross-cloud migration remains disabled: record-head equality is insufficient for
nested encrypted memory, Files objects or remembered sessions. Record-only transfer
now refuses source-custody memory on send and receive. Authenticated drain requires
an exact operation/incarnation, zero active work and committed-state receipt.
Incomplete recovery or cleanup retains its ticket; active/unreconciled moves cannot
be overwritten. Full key/object transfer, destination readability and cloud-specific
resource reconstruction are not implemented by that sequencer. See the
[migration contract](../architecture/pod-migration.md).

Local continuation checks: **102 hosting**, **56 migration/job/backfill** and
**37 Hermes relay** checks pass. The PostgreSQL retry-race negative control fails
when the timestamp fence is removed. Ruff, migration-manifest alignment and skill
lint pass. All **182 Mermaid figures** render; the revised cloud-move figure also
passes visual review. Maintained-document checks pass, but the overall docs command
still reports **71 scratch/source-copy link findings** under the concurrent
classification change. No gate was weakened; all eight unrelated edit hashes remain
unchanged. These source checks do not establish cloud-move or complete Puppy acceptance.
The browser correction adds **61 focused checks**, typecheck, changed-file lint and
an unchanged architecture ratchet. Its delayed-persistence negative control fails
when the observation timestamp is moved after storage. Reachability evidence is
memory-only and cannot authorize a turn; ambiguous chat submissions remain single-send.

The personal Azure pod still runs installed digest `ace34069` on the same revision,
with its selected **0.5 vCPU / 1 GiB, minimum zero and maximum one**. No image or
configuration changed. Activation-to-binding readback took **11.137 seconds** on an
already warm pod; this is neither a cold-turn nor first-token measurement. Sealed
relay admission and idle socket release passed. Azure then reported zero replicas
at 05:13:30; the scale-down tail is bracketed separately from socket closure. A new
owner activation reconnected the same identity at epoch 33. Rehearsal start to sealed
admission took **52.139 seconds**, including preflight and one transient reconnect
whose cause is not established. No model request was sent; browser inference remains
separate.

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
