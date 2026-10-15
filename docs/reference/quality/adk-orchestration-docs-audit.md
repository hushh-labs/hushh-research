# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-15 UTC

**Hold the application merge and production BYOC rollout.** The hub and frontend
currently serve verified `5c2d1483aa`; the personal Azure pod completed its Dev 19
Settings-approved installation. Recovery,
installed digest, unchanged hosting, post-update Puppy streaming/Stop and
byte-exact interrupted Files transfer passed. Dev 19's active-at-handoff overlap
did not occur; retain that attempt separately from Dev 17's verified active drain.
Native connectors, cold-start latency and production controls remain unqualified. Peer WorkOS SSO remains off: deprovisioning must fence existing consent tokens even when Firebase quarantine fails.
The next candidate adds restart-safe private command/MCP recovery; local evidence
is not deployed acceptance. Computer Use and cross-cloud moves remain disabled.
Existing owners retain their resources and selected configuration.

## Current implementation slice — Azure AI and Shared Files

**Serving:** dev remains at `5c2d1483aa`, backend `00172-7q4` and frontend
`00146-l8q`, both 100% traffic. The [15 October deployment](https://github.com/hushh-labs/hushh-research/actions/runs/38709401259)
passed schema 355 but refused misplaced optional Cloud Build defaults; governed
rollback retained the prior application. Files 959 is applied; history cleanup
249 stays deferred. No owner image changed.

**Candidate:** the configuration repair composes main `6baa14e0c1` and concurrent
branch `d46a9327e6`, preserving placement, owner/vault fences and native navigation.
The prior [exact `15d83d5bab` passed all 25 hosted checks](https://github.com/hushh-labs/hushh-research/actions/runs/38705983993).
The replacement passes governance, all 461 Back cases, affected authority/UI
checks and the production web build. Drive authority regressions fail their
broken-code controls and pass after repair. A Mac restart interrupted the final
backend run at 42% without a terminal result; that run is not a pass. Remaining
canonical stages and new exact-head hosted validation are required. Earlier
failed attempts remain recorded; unrelated root/ADK/PDF work is preserved.

**Pod offer:** Dev 19's qualified executable lacks the new Azure custom-key
adapter. Dev 20 therefore builds a new immutable dev image with **no supported
upgrade predecessors**. Isolated exact-image recovery must pass before adding a
predecessor; publishing never installs it. The documented verified-image reuse
path can later publish qualified metadata without rebuilding that executable.
Shared Files owner acceptance remains unperformed.

**Lifecycle correction — local, not deployed:** **326 affected Azure lifecycle
checks pass**, including real PostgreSQL. Setup, updates and rebuilds share the
existing job journal; dispatch binds the owner, original pod identity, approved
image and exact permitted resources. Files writes require their current approved
checkpoint. Stale authority and self-granted custody writes are refused; the
paired broken-code controls fail. Exact revision recovery settles the original
cloud request; unknown outcomes remain unresolved. Optional image pruning stays
off on this path until its receipts are qualified. Cancellation joins the real
update thread and fences new writes. Full cleanup preserves encrypted
credentials until provider revocation succeeds; version-4 tombstones cover
cleared/superseded grants. Legacy repair requires the original key, exact fenced
inventory and conditional metadata replacement. Broken-code controls fail.

Deletion recovery additionally passes **126 affected checks**: a new real SQL
worker polls the original typed provider operation without another DELETE.
Changed subscriptions, path escapes and unknown legacy operation kinds refuse;
absence cannot replace settlement. These checks do not prove live full cleanup.

Dev-only 960/961 and the new 962 authority are not live acceptance. Complete Azure
JIT deletion/finalization and operator-project mail-topic
cleanup before release freeze. Account deletion stays refused while obligations
are unresolved; provider retention is not immediate physical erasure. Existing
GCP receipts keep historical obligations without inventing uncreated resources.

**Browser correction — local, disabled:** 22 UI cases and headless checks of the
actual component with optimized CSS at 390/820/1440 px pass, including mouse/touch;
owner-only viewport changes fence old coordinates and wait for a fresh painted
frame. GCP's native worker identity and Azure's execution/private bridge remain
unqualified. No new cloud readiness or owner installation is claimed.

| Journey | Source / local evidence | Dev / release status |
| --- | --- | --- |
| Provider-aware AI | Placement-aware Shared Gemini, owner GCP Vertex and Azure identity defaults; sealed private Azure keys use strict hosts, public DNS pinning and no proxies/redirects. Working connections survive failed validation; returning to a default requires a verified receipt. One AI step follows Hosting | Source checks pass; live custom-key/default responses require the new release |
| Shared Files | Browser encryption, bounded ciphertext transfers, immutable revisions, owner/vault fencing and reversible explorer operations. SQL records the bucket incarnation before its first write and rejects legacy adoption, replacement and uncertain cleanup | Dev migration 959; activation remains off. Isolated GCS proves bytes, conditional writes, resumable terminal states and bounded cleanup. Workload identity access is verified on the isolated pilot bucket; live owner API acceptance remains required |
| Selected analysis | Existing authored Files specialist receives a selected bounded projection only; sibling folder labels are excluded in both browser payload and server schema; browser checks consent, exclusions, revision and job state before applying reversible proposals under a lease | Local authority cases pass; live foreground provider acceptance is unverified. No background decryption grant |
| Managed Hussh Pods | Project shards selected; capacity/cost worksheet and per-pod custody requirements recorded. Verified dev quota reads show service-account admission is tighter than service/queue slots; reservations must not double-count observed resources. Consumption, KMS isolation, transactional admission and cleanup remain unqualified. Backend creation refuses even if deployment flags are present | No provisioning offer or qualified shard yet |
| Transfers / continuation | Shared library enrollment and placement writes share transactional admission; active/unresolved libraries refuse unqualified cloud cutover even with Files disabled. Existing browser and Files-only scheduling commits remain preserved; private execution gates remain closed | Shared-to-pod, reverse and cross-cloud Files transfer remain unavailable pending destination/readability and cleanup evidence |

Cloud-default verification uses the same authorized model modes as chat; fleet configuration alone cannot discard an owner key.

Legacy unknown one-shot writes remain fenced. New source uses encrypted resumable
session receipts and conditional recovery; elapsed lease time alone never clears a
provider write. The live GCS race exposed cancellation after exact bytes landed;
recovery now checks that terminal outcome explicitly. Local fixtures and admin
probes do not establish owner-cloud acceptance.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Frozen implementation | Dev 19 metadata `49074b1f72a1` serves the exact qualified `e04b76c61433` executable image. Frozen integration `22c7d3cac422` includes main `1d691714135e` and local ADK `63b4b60aac89`. Local browser/scheduling implementation `5a02603976ff`, integration repairs `ce4bdfb7ef` and final fixture/UI repair `cf3a2e9737` are committed; command/MCP restart recovery has local evidence | Concurrent root/ADK/PDF edits are preserved. Candidate changes are not installed on owner pods. |
| Current hub/frontend — Oct 14 | Verified ADC readback: `5c2d1483aa`, backend `00172-7q4`, frontend `00146-l8q`, 100% traffic; governed [run 38563449251](https://github.com/hushh-labs/hushh-research/actions/runs/38563449251) healthy | Shared Files is not enabled yet; new local upload/label corrections are unserved. Owner Dev 19 evidence remains separate. |
| Exact-SHA CI | [Run 38324970426](https://github.com/hushh-labs/hushh-research/actions/runs/38324970426) passed for exact Dev 19 `49074b1f72a1`; [runtime run 38319211087](https://github.com/hushh-labs/hushh-research/actions/runs/38319211087) passed for `e04b76c61433` | Failed receipts remain. The next executable candidate requires its own core mirror and exact-SHA hosted CI. |
| Local verification | Exact `e04b76c61433` canonical core passed in 687.9 s, including 18,113 backend and 860 isolated PostgreSQL cases, web-core, MCP, integration and PKM | Local and disposable-fixture evidence is not personal-owner acceptance. |
| Browser/scheduling local verification — Oct 13 | Frozen `ce4bdfb7ef` passed 18,614 non-DB backend cases. Its retained core failure exposed one Shared fixture dependency and three lint issues, repaired in `cf3a2e9737`: 179 affected PostgreSQL/authority cases, 73 UI cases, regenerated UI contracts, web-core production build, MCP verification, integration (388 PKM cases) and unchanged architecture ratchet pass | Stage-specific recovery evidence, not an exact-SHA green canonical core or hosted run. Root integration is concurrently in progress; reconcile before the final release freeze. No new browser/scheduling source serves. |
| Reconnect correction | Serving chat separates detachment from Stop, retains the original key lifetime/update permit and reconciles sealed history. The local candidate adds encrypted command journals and native MCP recovery through the existing approval ledger | Native ADK/PostgreSQL lost-acknowledgement and second-restart rehearsal passes with exactly one dispatch. No universal background completion or automatic effect replay is claimed. |
| Governed dev deployment | [Run 38326276722](https://github.com/hushh-labs/hushh-research/actions/runs/38326276722) passed in 14 minutes, including schema, health, provenance and selected acceptance gates | GitHub Actions governs; Cloud Build builds. Application remains unmerged. |
| Actual serving state — Oct 13, 00:33 UTC | Backend `00169-92j`, digest `223018d7cf26`, labels `49074b1f72a1`; frontend `00144-hvt`, digest `012ccf8f6641`, labels `e04b76c61433`. Both 100% traffic | Independent ADC readback confirms immutable images. Backend rollback `00168-nlx`; frontend remains `00144-hvt`. |
| Dev access repair | Request-slot exhaustion was measured independently of CPU, RAM and database load. Messages cancels open and late stream bodies; both old-code negative controls fail. Serving concurrency is now 40, with the same maximum three instances, worker and pools. The normal owner session is reachable and unlocked | This is a bounded mitigation, not a sustainable capacity or production-load claim. Owner-pod resources are unchanged. |
| Schema | Governed pre/post schema guards pass without missing required tables, columns or functions; selected canonical head 320 | Destructive history cleanup 249 remains deferred. No production schema acceptance or SQL rollback recovery claim. |
| Exact target recovery | Dev 18 image `fa018342ab72`, source `e04b76c61433`, passed exact `47bb9a718063` → target recovery on disposable GCP and Azure pods. Keys, encrypted history, byte-exact Files, metadata, preferences and configuration are preserved. Azure retained the personal-size 0.5 vCPU/1 GiB configuration | The first GCP transition hit a platform-capacity 429. Its failed receipt remains; the repeat proved reverse and forward continuity with retained snapshots and capacity-only admission retry. No personal maintenance, configuration change or production rollback acceptance is implied. |
| Qualified offer | Published Dev 19 pins exact `fa018342ab72` bytes and only the isolated-qualified `47bb9a718063` predecessor. Normal owner Settings installation completed and installed digest was read back | No automatic install, stable publication or wildcard compatibility. A future target requires its own exact-predecessor recovery proof. |
| Personal pod | Dev 19 installed and verified Oct 13, 00:34 UTC, Azure revision `u633683c19958`, digest `fa018342ab72`. Identity/configuration hashes match. Min 0/max 1, one worker, 0.5 vCPU/1 GiB, HTTP threshold eight, queue scaler and 600-second relay grace retained | Active chat existed at approval but settled before handoff. Dev 17 independently proved accepting → draining active work → durable idle → replacement. Do not merge those receipts into a Dev 19 drain pass. |

The original failed deployment and CI receipts remain available in GitHub and
private operational evidence. Private owner identifiers, cloud receipts and
credentials remain outside this memo.

## Acceptance matrix

| Journey | Demonstrated | Required before production |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer. Normal owner on Azure Dev 17: interrupted/resumed upload and download with one stable identity, byte-exact integrity, folders, inline rename/undo, move/undo, trash/restore and cold passphrase unlock. The first premature-resume harness attempt is retained; the corrected run proves one identity | Repeat new/existing setup and owner-cloud storage/IAM acceptance in UAT. Local UI checks do not prove cloud custody. |
| Files organization | Normal owner Azure Dev 17 synthetic text reached the authenticated queue and terminal organized outcome; post-organization download preserved the original bytes. Earlier semantic move/undo remains dated Dev 15 evidence. On the exact Dev 16 target, GCP Cloud Tasks and Azure managed-identity Storage Queue completed automatic synthetic organization in 45.198 s and 51.24 s; originals remained byte-exact and analysis/automatic settings were restored | These disposable fixtures do not establish fresh owner provisioning or UAT acceptance. Trash does not claim physical deletion; unchanged results do not prove a semantic move. |
| Updates | Exact Dev 15 → Dev 16 recovery passed on both clouds. Earlier normal Dev 12/15 owner-approved installations pass; Dev 17 pins the qualified executable and predecessor without rebuilding it | Active-work Settings approval, authenticated durable handoff, restart, recovery and digest readback passed on the personal pod. The persisted approval and acknowledgement name the same exact operation across the sign-in retries; supported navigation refresh unblocked hidden callback hydration. Automatic recovery is not yet serving. Feed consistency, broader interruption cases and production rollback remain separate checks. |
| Private chat | Exact Dev 18 disposable image: GCP and Azure readers disconnected after admitted run start; both observed pending work followed by the complete encrypted assistant outcome, with exactly one turn POST. Completion took 33.804 s and 39.537 s | Synthetic same-process detach evidence, not cold p95, uninterrupted background CPU or crash recovery. Recorded voice, complete connector approval/resume and the failed cold-start target remain separate. |
| Restart continuation | Files jobs and update operations have persisted reconciliation owners. Chat recovers saved history; detached live work retains its original authorization deadline | Universal restart-safe continuation is not established. Serving Dev 19 retains process-local command checkpoints and connector pending arguments; the unserved candidate adds sealed recovery through their existing owners. Recovered or changed terms require current admission and exact review; uncertain effects must not be blindly replayed. |
| Puppy / phone | Physical S24 Ultra has dated signed-admission, direct stream and same-turn Stop receipts. After the Mac reboot, the existing Hermes identity reconnected: first browser turn failed at 93.1 s; warm retry streamed first text at 17.667 s and completed at 18.345 s. Existing grant withdrawal, reconnect and idle/wake receipts remain. | The failed first attempt is retained. Dev 19 post-update owner response, actual Gemma model and server-side Stop passed; warm first text 16.136 s/total 16.328 s. Earlier failed and cold samples remain retained. Independent internet paths remain unverified. Restored wireless pairing does not prove the currently intermittent phone browser-debug transport. |
| Setup / billing | Durable retry, recovery links, explicit Shared/unplaced authority and assignment preservation exist | Fresh setup and missing-billing/policy return on both clouds without duplicate resources. |
| Google connectors | Sealed native authorization, refresh/restart fences, exact reviews and direct notification coalescing exist | Native iOS/Android authorization, scope upgrades, direct delivery and approved legacy hub credential removal. |
| Existing users | Explicit Shared choice and strictly evidenced legacy cohort; assigned/pending/unresolved pods cannot silently become Shared. Existing-user changelog admission exists; new users are excluded | Graduate schema/backfill and configure reviewed environment-specific changelog content before rollout. Actual UAT/production cohort adoption needs readback. |
| Resource lifecycle | Oct 12 Azure inventory classified active, shared recovery, pending setup and obsolete synthetic resources. Two obsolete test apps, one temporary registry and its exact pull grant were deleted and absence verified. Personal pod configuration is unchanged; shared storage, keys, identities and environment were retained | GCP retained object versions still require custody/retention reconciliation; Azure fixture prefix access is refused. No complete physical erasure claim. |
| Native security | Exact Capacitor 8.4.3 pins and reserved-proxy chat refusal; old-code negative control fails | Rebuilt native binaries and their independent distribution/acceptance. Web deployment is not a native release. |
| Computer Use | Local task rediscovery, explicit takeover/handback, current-owner Stop and metadata-only recovery have focused source evidence. Controlled Chromium login/redirect fixtures pass | GCP worker identity/private bridge and Azure supported identity/execution/private bridge remain unqualified. Feature disabled on both clouds; no live owner browser claim. |
| Scheduled tasks | Local Files-only template, exact revision/grant checks, durable outbox, duplicate/uncertain fencing and pending cancellation covered by nearest core suites | GCP due-time delivery needs live wake/idle acceptance. Azure due-time delivery, general goals and scheduled browser work are unavailable. No new source is serving yet. |

Puppy requires a registry-confirmed owner-cloud assignment, active device and
owner grant bound to the current pod incarnation. Shared and Hussh-hosted pod
modes refuse inference. Phone browser HTTP/SSE and Mac sealed WSS are separate
transports; a successful health check proves neither a device response nor
independent-network access.

## Performance and economics

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Matched GCP first text | 20 cold: p95 71.721 s; 20 warm: p95 7.700 s | Cold target ≤30 s fails. Operator admission is included. |
| Matched Azure first text | 20 cold: p95 71.304 s; 20 warm: p95 13.389 s | Cold target fails; image pull 26.048 s and recovery 3.251 s were separately observed. |
| Current smaller Azure wake | Genuine zero → first visible cloud text 76.706 s; completion 84.985 s. Image pull 25.370 s, admission path 46.346 s | One sample; ≤30 s target fails. Matched-image recovery and useful work pass at 0.5 vCPU/1 GiB. |
| Dev 15 Puppy wake | Confirmed post-zero first token 65.836 s; completion 66.150 s | One cold sample, not p95. Idle closure and zero replicas were observed separately. |
| Physical S24 Puppy | First text 30.658 s; completion 30.974 s; activation 14.343 s and device dispatch-to-text 15.866 s | One foreground Wi-Fi sample, not cold p95. The original missing-footer harness timeout and independent terminal readback are retained; no resend hid the failure. |
| Bounded runtime | Ten-minute soak settled 20 synthetic operations/cloud | Different CPU/memory aggregations cannot establish comparable peak capacity or real Puppy overlap. |
| Model qualification | Gemini 3.8 tools 2/3; 3.5 Flash LOW and Flash-Lite LOW 3/3 tools + 5/6 first-tool; Azure Luna 3/3 + 6/6 | Small bounded sample; defaults unchanged. Observed provider failures/429s remain recorded. Estimated qualification charge $1.96791915 of the $2 ceiling. |
| Monthly package | 30 billable hours, 50 GiB, 1,500 modeled calls + $5 reserve: Google/3.8 $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32 | Dated planning estimates, not equivalent quality, invoices or quotas. |

Qualification uses **1 vCPU, 2 GiB RAM, min 0/max 1 and one worker**. Existing
owners retain their selected configuration. GCP concurrency is eight; Azure's
HTTP threshold eight is not a request cap. Status polling must not wake compute;
direct relay grace remains ten minutes. Open sockets and scale-down tails extend
paid time. Spending thresholds warn without stopping service.

See [whole-package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget).
Matched comparisons include disk, secure ingress, wake control, storage, custody,
maintenance and model calls; equal vCPU labels do not prove equal performance.

## Owners and next gate

| Owner | Required decision or receipt |
| --- | --- |
| Engineering / release | Freeze and release verified private command/MCP recovery; complete native connector and Feed acceptance; improve measured cold latency; retain exact image compatibility. |
| Production / operations | Migration/release graduation, legacy cohort continuity, IAM, billing, erasure/retention, recovery, hub capacity and independent UAT acceptance. |
| Owner / device | Independent internet Puppy check; preserve the existing identity, assignment and grant. No re-registration or reset. |
| Documentation / Wiki | Keyless Drive renewal repaired in the Wiki repository: [PR 6](https://github.com/kushaltrivedi5/Hussh/pull/6), 73 MCP cases, old-code negative control and independent review. `hussh-mcp-00329-xub` serves exact source `602b6e31dc83`, digest `b12b4fd8d9f0`, with unchanged configuration. Private affected article patch passed immediate and delayed readback. No universal Wiki freshness claim. |

[Application PR 7555](https://github.com/hushh-labs/hushh-research/pull/7555)
remains draft. No application merge, UAT/production deployment, stable-channel
publication or automatic owner upgrade is authorized by this readiness result.

Operational owners: [Files](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md),
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md),
[cloud-move contract](../architecture/pod-migration.md).

## Reviewed integration debt

The [architecture baseline](./architecture-fitness-baseline.json) retains exact
reviewed spans, source hashes, parent revisions and rationale. Budgets
500/250/80, scanner and exclusions remain unchanged. Reviewed inherited debt is
not deployment acceptance; chronology remains in Git history.

The Oct 12 scope-commerce reconciliation reviews exactly 45 finding slots:
14 unchanged incoming-main spans, 27 compatibility compositions, three private
`one_memory` guards and the nearest provider-intent regression test extension.
Independent review found and repaired a lost main session-persistence timing
wrapper before accepting its revised module/class spans. The real repository
test fails on frozen `02989d1c2fc4` and passes after repair, including failure
timing, owner binding and ciphertext assertions. Exact hashes, both parents,
before/after values and qualifications are retained in the baseline's
`scope_main_and_hosted_return_20261012` entry. Every other finding slot and all
future-growth enforcement remain unchanged; full core and hosted CI are still
release gates.

The subsequent fake-provider recovery test isolates configuration explicitly,
adding two lines to its existing module span (530 to 532). Independent backend
review qualifies only that finding; the baseline records its source hash and
focused verification under `scope_commerce_recovery_test_isolation_20261012`.
Invalid ambient provider configuration cannot affect this fake-adapter test.
Production configuration validation, immutable provider requests and all other
finding slots remain unchanged.

The latest main sync at `9c4e1cb045` adds nine notification size findings:
eight spans are byte-identical incoming source, and the Capacitor index retains
root registration/listener contracts while adding three emergency-cue lines.
Backend and frontend review qualify only those spans, with hashes and provenance
in `scope_commerce_latest_main_notifications_20261012`. Finite-lived SMS delivery
does not change scope-commerce authority or strict hosted-return admission.
This is source qualification; audible cues and physical delivery remain separate
acceptance work. Every other finding and future-growth enforcement is preserved.

The main `1056ed5652` union qualifies exactly 41 additional size slots through
independent backend, frontend and operations review. It preserves lazy pod
imports, recipient/owner admission and extracted deployment packaging. Review
found a shared specialist still selecting the legacy client; default turns now
use per-turn ADK project routing while injected owner models and explicit legacy
callbacks retain their contracts. Actual `handle_turn` tests cover both caller
orders and the callback negative control. The Information class remains 337;
its ceiling is unchanged. Exact hashes and parent revisions are retained in
`scope_commerce_main_project_and_location_20261012`. Budgets, scanner, exclusions
and every unrelated finding remain unchanged. Source qualification does not
establish deployed behavior or successful provider-job cleanup.

The continuation at `b12cd078` qualifies one existing capability-graph generator
module slot, 947 to 960 lines, after independent `ci_registry_review` inspection.
Bounded committed ancestry now retains both branches' workflow histories when
they independently integrate the same base, including later and second-parent
verification merges. The existing 18 graph-gate cases pass; the actual committed
predecessor function fails the strengthened real-Git regression. Semantic,
deprecation and revision-policy admission, the eight authored-ref cap and every
other fitness finding remain unchanged. Exact evidence is recorded in
`scope_commerce_parallel_history_20261012`; this is source qualification.

The main `ee67770aeb` union qualifies exactly three frontend module slots through
independent `client_context` review: Consent Center routing, its existing
cold-link suite and Feed presentation. Recognized answer rows preserve their
lane even with a missing prefix; answer pricing describes one written answer,
while Drive retains its Viewer term. The corrected union passes 109 focused UI
cases. Backend review found raw owner/exception logging; class-only diagnostics
now retain strict failure admission and resilient fallback. All 30 nearest
source-completeness cases pass, and actual incoming methods fail the protected
diagnostic negative control. This correction reduces the backend below existing
ceilings. `scope_commerce_request_lane_main_20261012` records the three exact
hashes; no other allowance, budget, scanner or payment authority changes.

The subsequent main `f7b76b5d4f` union qualifies two existing backend slots:
the wallet access class, 395 to 431 lines, and the encrypted-session test module,
804 to 808. Independent `backend_context` review verifies owner/exact-card cursor
binding and current-call-bound presentation completion; the nearest combined
backend suite passes 68 cases. `client_context` review catches lost inspection
of historical sent copies: their encrypted receipts remain in a conditional,
collapsed section, fenced to the current owner, card and vault session. These
copies never establish revocable access. Independent `merge_security_review`
finds same-line checksum/signature/error denial missing from the imported
SwiftPM helper; denial now applies independently of collision recognition.
The actual predecessor fails all three strengthened denial cases. Exactly two
reviewed backend values change in `scope_commerce_wallet_history_main_20261012`;
all other findings, scanner rules and 500/250/80 budgets remain unchanged.
Actual PostgreSQL pagination and hosted native resolution remain separate
runtime evidence, not claims established by this source review.

The main `4277558db7` union qualifies 98 size slots over 96 keys through
independent `ci_registry_review`: 94 matching main spans and four composed
modules retain exact existing-parent blocks. The payment suite preserves five
constraint-assertion lines (3350 to 3355); sharing routes retain six placement
fixture lines (1013 to 1019); wallet tests retain twelve connector-erasure race
lines (1361 to 1373); Feed retains the existing profile/recipient/private-agent
cases (1685 to 1826). No added block is novel relative to kept parent
`79856d1f1b`. Exactly 63 existing slots grow and 35 main-owned size slots are
added; all 2,424 previous slots/maxima survive, yielding 2,459 retained slots.
Exact hashes and per-slot evidence live in
`scope_commerce_main_document_payout_union_20261012`. No dependency-direction,
initialization or parse finding is accepted, and budgets/scanner rules remain
unchanged. Backend review separately verifies pinned migration replay and the
byte-preserved 322–327 registration repair; accepted environment rows and
financial obligations remain untouched. This is source lineage qualification,
not deployed payment or payout acceptance.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and cloud-specific gates belong to the deployment standard.
