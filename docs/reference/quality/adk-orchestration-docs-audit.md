# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-16 UTC

**Hold the application merge and production BYOC rollout.** The hub and frontend now
serve `c13b3899ba`; the personal Azure pod retains its Dev 19
Settings-approved installation. Recovery,
installed digest, unchanged hosting, post-update Puppy streaming/Stop and
byte-exact interrupted Files transfer passed. Dev 19's active-at-handoff overlap
did not occur; retain that attempt separately from Dev 17's verified active drain.
Native connectors, cold-start latency and production controls remain unqualified. Peer WorkOS SSO remains off: deprovisioning must fence existing consent tokens even when Firebase quarantine fails.
The new source adds restart-safe private command/MCP recovery; owner-image
installation and live journey acceptance remain separate. Computer Use and cross-cloud moves remain disabled.
Existing owners retain their resources and selected configuration.

**16 October resource correction:** the personal Azure owner approved 1 vCPU /
2 GiB on the same Dev 19 image. Authenticated idle handoff, exact replacement
readback and durable-key recovery pass. Min 0/max 1, one worker, HTTP threshold
eight and the 600-second relay grace are preserved. The temporary OIDC-only admin
grant was removed and absence verified. Protected Files readback remains separate.
Normal-owner readback then passed a 32 KiB byte-exact upload/download. A fresh
sealed Puppy connection returned the synthetic marker from Gemma 4 12B in
73.363 s; local-model first content took 48.019 s. This is one warm observation,
not cold-start acceptance. Its synthetic Files fixture is retained for update continuity.
At 10:21 UTC, a turn sent immediately after a verified zero-replica observation
completed through the existing Hermes identity in **69.723 s**. This is one cold
Puppy sample, not a p95 or cloud-model result; latency remains unqualified.

## Current implementation slice — Azure AI and Shared Files

**Serving, 16 October 18:54 UTC:** [dev deployment 38947511945](https://github.com/hushh-labs/hushh-research/actions/runs/38947511945)
completed healthy. Verified ADC readback confirms **`c13b3899ba` on both services**:
backend `00174-f5s` and frontend `00147-h45`, each at 100% traffic. Their immutable
digests match workflow provenance. The minimum schema passes; parked 959–963 are
applied with no failed journal rows or checksum drift. History cleanup 249 stays
deferred. Rollback revisions are backend `00173-w2c` and frontend `00146-l8q`.
Selected PKM preservation and reviewer navigation/cold re-unlock passed. These
do not establish full owner-cloud Files, connector or software-update acceptance.

**Frozen application:** `c13b3899ba` includes the negotiated legacy-pod receipt
compatibility repair and reviewed main integration. The canonical local core is
complete; [exact-SHA branch validation](https://github.com/hushh-labs/hushh-research/actions/runs/38911092654)
passed on attempt 2 after one failed-job-only retry. Attempt 1 passed every lane except one
Wallet fixture that clicked before an async copy control re-enabled. The original
failure is retained; its permanent test-only correction passes all 32 nearest
cases. Production serialization and privacy checks are unchanged. No passing lane
was restarted and no gate, deadline or assertion was relaxed.

**Deployment authority:** workflow-only [PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121)
landed through the owner-authorized Admin queue bypass at `745911d536` after
[exact-head CI](https://github.com/hushh-labs/hushh-research/actions/runs/38942154162)
passed. The original cleanup-order and synthetic-watchdog failures remain
recorded; only failed jobs were retried, with no assertion or deadline relaxed.
`azfx` was removed from the seven governed access lists, its invitation was
cancelled, and live main/train branch-protection parity passed. The
[landed-SHA smoke check](https://github.com/hushh-labs/hushh-research/actions/runs/38946927965)
passed. The frozen branch candidate is deployed and serving readback passes.
The application remains unmerged; owner installation is separate.

**Compatibility:** [deployment 38894554442](https://github.com/hushh-labs/hushh-research/actions/runs/38894554442)
was cancelled before traffic changed when new receipt declarations proved
incompatible with installed pods. The candidate now negotiates authenticated
capabilities: ordinary legacy chat remains available; unsupported receipt
continuations refuse. Reviewed main `3ba21ab8c8` contributes migration 357 while
branch schema head 406 is preserved. After Circle message actions, application
rollback must retain their visibility rules; the SQL rollback refuses after
effects. No further broad main/ADK intake belongs to this frozen release.

**Cloud chat:** two normal-owner synthetic turns on the installed Azure Dev 19
image failed with provider HTTP 400, including a fresh conversation (45.242 s).
Both Azure deployments accept isolated static-tool controls. A separate memory-schema
400 becomes 200 after normalization, but that does not establish the terminal chat
failure's cause. Cloud chat remains a failed live acceptance row.

**New Azure signup:** the pod, storage and signed direct access completed in
20m51s; Azure environment creation accounted for 14m26s. Optional model quota was
refused, so cloud readiness does not imply working AI. The local setup UI now uses
three core phases and avoids a false model-ready tick; 73 focused checks, an
original-code negative control, generated UI contracts and typecheck pass. An
Azure upgrade retains remaining trial credit only until the original 30-day expiry;
model quota must still be verified. See [Microsoft's upgrade policy](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/upgrade-azure-subscription).

**Onboarding repair — local:** three-dot account deletion now opens the existing
Azure cleanup review instead of closing on refusal. The AI picker uses one
provider-aware section and retains cloud-provider quota errors. Before cloud
creation, the chosen model's real quota is checked; unknown evidence is never
converted to zero. Failed setup cleanup separates journal-qualified resources
from positively proved zero-effect attempts. An old group, missing original
absence observation, active worker, stale custody or unresolved request cannot
qualify automatic erasure. Focused PostgreSQL and UI checks are recorded with the
candidate. Bounded cleanup and presentation extractions pass the architecture
ratchet without a baseline waiver; 174 backend checks plus the corrected 42-case
boundary run, 115 frontend checks, typecheck and regenerated UI contracts pass.
Live disposable cleanup remains a release acceptance requirement.
**Pod offer:** Dev 19's qualified executable lacks the new Azure custom-key
adapter. Dev 20 is now published as immutable digest `72b049dfdbc2…842b001b`, with **no supported
upgrade predecessors**. Mounted hub metadata matches its generation-pinned archive. Isolated exact-image recovery must pass before adding a
predecessor; publishing never installs it. The documented verified-image reuse
path can later publish qualified metadata without rebuilding that executable.
Shared Files owner acceptance remains unperformed.
An isolated native Azure Job recovered 57 encrypted records from the exact Dev 19
fixture using its managed identity. Reads were bounded; no keys were exported or
storage contents changed. The Job was deleted and ARM absence verified. This is
predecessor recovery evidence, not target-image or owner-update acceptance.
Dev 20 subsequently passed a native GCP read of the original **4,195,328-byte**
synthetic Files fixture, byte-exact, with no key export or storage writes. Its
45-record recovery receipt was reconciled from structured Cloud Logging after a
logging-read 429; the Job was not rerun and deletion/absence was verified. This
does not establish direct admission, authenticated update continuity or Azure
target-image recovery; the predecessor list remains empty.

**Lifecycle correction — hub deployed; owner image not installed:** setup, updates and rebuilds
retain exact admitted requests and join actual workers before release. Connector
revocation requires validated historical coverage; legacy zero counters cannot
qualify cleanup. Unknown cloud responses remain unresolved and are never replayed. A signed,
non-destructive compatibility preflight refuses old pod images before key erasure;
owner approval and complete cleanup composition remain required.

| Cleanup boundary | Local evidence | Remaining release condition |
| --- | --- | --- |
| GCP operator-project Gmail | 476 affected checks pass, including real PostgreSQL full-topic admission/acknowledgement/deletion, retained creation/IAM history and attached-identity separation. Missing-proof and dropped-history negative controls fail | Dev-only963 schema and hub must serve before new notification plans; live disposable owner cleanup still required |
| Azure | Owner inspection, exact resource/retention approval, fresh JIT callback and journalled teardown compose locally. 358 backend and 92 UI cases pass; removing the completion gate fails its negative control. The explicit checkpoint backend preserves fresh delegated authority; default-observer substitution fails its regression control | Generated UI contracts and typecheck pass. Combined core/hosted validation and deployment pass; responsive owner review and disposable dev cleanup remain required; no personal account deletion was attempted |

Live dev's latest verified ledger (15 October,20:22 UTC) stops at959;960/961/963
are candidate migrations; 962 is now selected for governed dev rehearsal,
with full completion/archive guards. Provider retention is not
immediate physical erasure. Existing owners keep resources and hosting choices.
See the [deletion runbook](../operations/account-deletion-rollout.md).

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

| Surface | Current evidence | Limit |
| --- | --- | --- |
| Dev hub/frontend | ADC readback: both `c13b3899ba`; backend `00174-f5s` / digest `74748b1cc3ea`, frontend `00147-h45` / `2991a17d7bb8`, 100% each | Governed deployment and independent serving/schema readback pass; owner pods remain independently installed |
| Personal Azure pod | Dev 19 `fa018342ab72`, source `e04b76c61433`; revision `ca-hussh-one-pod--ra36f90e3d756` | Same-image resource maintenance, not a new software installation |
| Combined source | Frozen executable candidate `c13b3899ba`: receipt correction, reviewed main integration and event-separated dev validation. Local ADK intake remains frozen at `2462c0bc6f` | Exact-SHA CI, workflow landing and governed dev deployment pass. Subsequent test/memo corrections are not a new deployed executable |
| Verification | Application `c13b3899ba` passed exact-SHA hosted CI on attempt 2 after the single classified fixture retry. Workflow-only `9e634f1537` passed all hosted checks and landed through the authorized Admin SOP | Original failures are retained. Live owner journeys remain required; Admin authority and landed smoke are verified |
| Prior image recovery | Exact `47bb9a718063` → `fa018342ab72` passed on both disposable clouds; normal Dev 19 owner installation and continuity passed | No compatibility claim for the next image until its exact pair is qualified |
| Recovery fixtures | GCP synthetic owner recovered under its runtime identity. Azure native identity recovered 57 encrypted records and its original 4,195,328-byte Files fixture exactly; temporary Jobs were removed and absence verified | Original failed probes remain recorded. This qualifies predecessor recovery only; the next exact target image still needs continuity verification |

## Acceptance matrix

| Journey | Demonstrated | Required before production |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer. Normal owner on Azure Dev 17: interrupted/resumed upload and download with one stable identity, byte-exact integrity, folders, inline rename/undo, move/undo, trash/restore and cold passphrase unlock. The first premature-resume harness attempt is retained; the corrected run proves one identity | Repeat new/existing setup and owner-cloud storage/IAM acceptance in UAT. Local UI checks do not prove cloud custody. |
| Files organization | Normal owner Azure Dev 17 synthetic text reached the authenticated queue and terminal organized outcome; post-organization download preserved the original bytes. Earlier semantic move/undo remains dated Dev 15 evidence. On the exact Dev 16 target, GCP Cloud Tasks and Azure managed-identity Storage Queue completed automatic synthetic organization in 45.198 s and 51.24 s; originals remained byte-exact and analysis/automatic settings were restored | These disposable fixtures do not establish fresh owner provisioning or UAT acceptance. Trash does not claim physical deletion; unchanged results do not prove a semantic move. |
| Updates | Exact Dev 15 → Dev 16 recovery passed on both clouds. Earlier normal Dev 12/15 owner-approved installations pass; Dev 17 pins the qualified executable and predecessor without rebuilding it | Active-work Settings approval, authenticated durable handoff, restart, recovery and digest readback passed on the personal pod. The persisted approval and acknowledgement name the same exact operation across the sign-in retries; supported navigation refresh unblocked hidden callback hydration. Automatic recovery requires installation of the new qualified pod image. Feed consistency, broader interruption cases and production rollback remain separate checks. |
| Private chat | Exact Dev 18 disposable image: GCP and Azure readers disconnected after admitted run start; both observed pending work followed by the complete encrypted assistant outcome, with exactly one turn POST. Completion took 33.804 s and 39.537 s | Synthetic same-process detach evidence, not cold p95, uninterrupted background CPU or crash recovery. Recorded voice, complete connector approval/resume and the failed cold-start target remain separate. |
| Restart continuation | Files jobs and update operations have persisted reconciliation owners. Chat recovers saved history; detached live work retains its original authorization deadline | Universal restart-safe continuation is not established. Serving Dev 19 retains process-local command checkpoints and connector pending arguments; the published but uninstalled Dev 20 image adds sealed recovery through their existing owners. Recovered or changed terms require current admission and exact review; uncertain effects must not be blindly replayed. |
| Puppy / phone | Physical S24 Ultra has dated signed-admission, direct stream and same-turn Stop receipts. After the Mac reboot, the existing Hermes identity reconnected: first browser turn failed at 93.1 s; warm retry streamed first text at 17.667 s and completed at 18.345 s. Existing grant withdrawal, reconnect and idle/wake receipts remain. | The failed first attempt is retained. Dev 19 post-update owner response, actual Gemma model and server-side Stop passed; warm first text 16.136 s/total 16.328 s. Earlier failed and cold samples remain retained. Independent internet paths remain unverified. Restored wireless pairing does not prove the currently intermittent phone browser-debug transport. |
| Setup / billing | Durable retry, recovery links, explicit Shared/unplaced authority and assignment preservation exist | Fresh setup and missing-billing/policy return on both clouds without duplicate resources. |
| Google connectors | Sealed native authorization, refresh/restart fences, exact reviews and direct notification coalescing exist | Native iOS/Android authorization, scope upgrades, direct delivery and approved legacy hub credential removal. |
| Existing users | Explicit Shared choice and strictly evidenced legacy cohort; assigned/pending/unresolved pods cannot silently become Shared. Existing-user changelog admission exists; new users are excluded | Graduate schema/backfill and configure reviewed environment-specific changelog content before rollout. Actual UAT/production cohort adoption needs readback. |
| Resource lifecycle | Oct 12 Azure inventory classified active, shared recovery, pending setup and obsolete synthetic resources. Two obsolete test apps, one temporary registry and its exact pull grant were deleted and absence verified. Personal pod configuration is unchanged; shared storage, keys, identities and environment were retained | GCP retained object versions still require custody/retention reconciliation; Azure fixture prefix access is refused. No complete physical erasure claim. |
| Native security | Exact Capacitor 8.4.3 pins and reserved-proxy chat refusal; old-code negative control fails | Rebuilt native binaries and their independent distribution/acceptance. Web deployment is not a native release. |
| Computer Use | Local task rediscovery, explicit takeover/handback, current-owner Stop and metadata-only recovery have focused source evidence. Controlled Chromium login/redirect fixtures pass | GCP worker identity/private bridge and Azure supported identity/execution/private bridge remain unqualified. Feature disabled on both clouds; no live owner browser claim. |
| Scheduled tasks | Local Files-only template, exact revision/grant checks, durable outbox, duplicate/uncertain fencing and pending cancellation covered by nearest core suites | GCP due-time delivery needs live wake/idle acceptance. Azure due-time delivery, general goals and scheduled browser work are unavailable. The hub source is serving; owner-image and task delivery acceptance remain separate. |

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

The [architecture baseline](./architecture-fitness-baseline.json) owns exact
reviewed spans, source hashes, parents, rationale and negative-control evidence.
Global budgets 500/250/80, scanner rules and exclusions remain unchanged; CI still
rejects new or worsened findings. Historical integration chronology remains in Git.
Reviewed inherited debt is source qualification, not deployed acceptance.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and cloud-specific gates belong to the deployment standard.
