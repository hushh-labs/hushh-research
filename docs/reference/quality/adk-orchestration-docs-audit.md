# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-12 UTC

**Hold the application merge and production BYOC rollout.** Source, deployment,
owner installation and production acceptance have separate evidence. The existing
personal Azure pod now runs the owner-approved Dev 17 offer: active chat drain,
durable idle receipt, restart, recovery and exact installed-digest verification
passed. Current-image Files transfer/reversal and Puppy response/reconnection
passed; broader acceptance remains bounded below. Native connectors, cold-start latency and production controls
remain unqualified. The background Azure sign-in hydration repair is source-verified
and awaits deployed acceptance. Computer Use and cross-cloud moves stay
disabled. Existing owners retain their resources and selected configuration.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Frozen implementation | `535e3351b95a` contains the reviewed main/ADK union, setup simplification, Files/Puppy corrections and retained-stream fix | Concurrent root/ADK/PDF edits remain preserved outside this frozen release. |
| Exact-SHA CI | [Run 38252668481](https://github.com/hushh-labs/hushh-research/actions/runs/38252668481) passed the complete hosted pipeline, including native compilation, browser coverage, full web and protocol lanes | Prior failed runs remain retained. The bounded Swift package retry does not bypass checksum, compilation or test checks; this run succeeded on its first resolution attempt. |
| Local verification | Composite core retains the full backend pass, focused repairs, PostgreSQL cases and remaining canonical stages; byte-identical runtime proof was reused. Release metadata receives its nearest contract checks | No repeated full local suite or fixture evidence is presented as owner acceptance. |
| Unserved reconnect correction | Private chat separates disconnect from explicit Stop, retains its original key deadline and update permit, and reconciles encrypted history without resubmission. Owner-bound preparation stays pending through storage admission, including before the first session exists. Files activity uses bounded visible-only reads; sanitized errors retain preceding stream stages | Source and nearest regression evidence only; exact final CI and pod installation are required. Process-local continuation cannot guarantee background CPU or survival across runtime loss. Dev 18 builds a new image with no admitted predecessor until exact-target recovery qualifies it. |
| Governed dev deployment | [Run 38286242704](https://github.com/hushh-labs/hushh-research/actions/runs/38286242704) passed schema, preservation, candidate health, provenance, parity, semantic checks and reviewer navigation/cold unlock | GitHub Actions governs; Cloud Build builds. The application remains unmerged. |
| Actual serving state — Oct 12, 18:05 UTC | Backend `00167-tz5`, digest `c7749c998f59`; frontend `00143-5ph`, digest `3366ba1ea033`. Both label `0d00ceaf1e1b` at 100% traffic; executable bytes retain the fully validated `535e3351b95a` source | Independent ADC readback confirms revisions, immutable images and deployment labels. Rollback targets remain `00166-gk9` and `00142-jtt`. |
| Dev access repair | Request-slot exhaustion was measured independently of CPU, RAM and database load. Messages cancels open and late stream bodies; both old-code negative controls fail. Serving concurrency is now 40, with the same maximum three instances, worker and pools. The normal owner session is reachable and unlocked | This is a bounded mitigation, not a sustainable capacity or production-load claim. Owner-pod resources are unchanged. |
| Schema | Governed pre/post schema guards pass without missing required tables, columns or functions; selected canonical head 320 | Destructive history cleanup 249 remains deferred. No production schema acceptance or SQL rollback recovery claim. |
| Exact target recovery | Dev 16 image `47bb9a718063`, source `535e3351b95a`, passed actual Dev 15 → target recovery on disposable GCP and Azure pods. Keys, encrypted history, byte-exact Files, metadata, preferences and configuration are preserved. The same target also recovered at the personal Azure size, 0.5 vCPU/1 GiB; chat and authenticated organization completed with originals intact | The smaller-size test changes only a disposable service. The smaller fixture proved genuine zero and subsequent wake; exact personal Settings approval also passed. Neither establishes production capacity. |
| Qualified offer | Dev 17 metadata pins the same Dev 16 executable bytes and only the exact qualified Dev 15 predecessor | Exact metadata CI [38284850377](https://github.com/hushh-labs/hushh-research/actions/runs/38284850377) and governed publication passed. No additional pod image was built; installation followed normal owner approval. |
| Personal pod | Normal Settings Dev 17 update verified Oct 12, 20:12 UTC. Active work transitioned accepting → draining → durable idle; restart restored encrypted state and verified digest `47bb9a718063`. ARM readback confirms ready revision `ue6f29555d96a` at 100% | Resource, identity, environment, secret, scale and ingress hashes match the predecessor. Min 0/max 1, one worker, 0.5 vCPU/1 GiB, HTTP threshold eight, queue scaler and 600-second relay grace are preserved. |

The original failed deployment and CI receipts remain available in GitHub and
private operational evidence. Private owner identifiers, cloud receipts and
credentials remain outside this memo.

## Acceptance matrix

| Journey | Demonstrated | Required before production |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer. Normal owner on Azure Dev 17: interrupted/resumed upload and download with one stable identity, byte-exact integrity, folders, inline rename/undo, move/undo, trash/restore and cold passphrase unlock. The first premature-resume harness attempt is retained; the corrected run proves one identity | Repeat new/existing setup and owner-cloud storage/IAM acceptance in UAT. Local UI checks do not prove cloud custody. |
| Files organization | Normal owner Azure Dev 17 synthetic text reached the authenticated queue and terminal organized outcome; post-organization download preserved the original bytes. Earlier semantic move/undo remains dated Dev 15 evidence. On the exact Dev 16 target, GCP Cloud Tasks and Azure managed-identity Storage Queue completed automatic synthetic organization in 45.198 s and 51.24 s; originals remained byte-exact and analysis/automatic settings were restored | These disposable fixtures do not establish fresh owner provisioning or UAT acceptance. Trash does not claim physical deletion; unchanged results do not prove a semantic move. |
| Updates | Exact Dev 15 → Dev 16 recovery passed on both clouds. Earlier normal Dev 12/15 owner-approved installations pass; Dev 17 pins the qualified executable and predecessor without rebuilding it | Active-work Settings approval, authenticated durable handoff, restart, recovery and digest readback passed on the personal pod. The persisted approval and acknowledgement name the same exact operation across the sign-in retries; supported navigation refresh unblocked hidden callback hydration. Automatic recovery is not yet serving. Feed consistency, broader interruption cases and production rollback remain separate checks. |
| Private chat | Earlier 20 cold and 20 warm synthetic turns per cloud and bounded soak pass. Exact Dev 16 target chat completed: GCP first text 16.351 s/total 21.664 s; Azure 21.82 s/29.47 s | These individual target samples are not cold p95. Recorded voice, complete connector approval/resume and the failed cold-start target remain separate. |
| Restart continuation | Files jobs and update operations have persisted reconciliation owners. Chat recovers saved history; detached live work retains its original authorization deadline | Universal restart-safe continuation is not established: private command checkpoints and connector pending arguments remain process-local. Recovered or changed terms require current admission and exact review; uncertain effects must not be blindly replayed. |
| Puppy / phone | Physical S24 Ultra has dated signed-admission, direct stream and same-turn Stop receipts. After the Mac reboot, the existing Hermes identity reconnected: first browser turn failed at 93.1 s; warm retry streamed first text at 17.667 s and completed at 18.345 s. Existing grant withdrawal, reconnect and idle/wake receipts remain. | The failed first attempt is retained. Current Dev 17 owner browser response, Gemma model footer and server-side Stop passed after restart; warm first text 7.904 s/total 8.117 s, first restart sample 92.465 s/92.724 s. Independent internet paths remain unverified. Restored wireless pairing does not prove the currently intermittent phone browser-debug transport. |
| Setup / billing | Durable retry, recovery links, explicit Shared/unplaced authority and assignment preservation exist | Fresh setup and missing-billing/policy return on both clouds without duplicate resources. |
| Google connectors | Sealed native authorization, refresh/restart fences, exact reviews and direct notification coalescing exist | Native iOS/Android authorization, scope upgrades, direct delivery and approved legacy hub credential removal. |
| Existing users | Explicit Shared choice and strictly evidenced legacy cohort; assigned/pending/unresolved pods cannot silently become Shared. Existing-user changelog admission exists; new users are excluded | Graduate schema/backfill and configure reviewed environment-specific changelog content before rollout. Actual UAT/production cohort adoption needs readback. |
| Resource lifecycle | Oct 12 Azure inventory classified active, shared recovery, pending setup and obsolete synthetic resources. Two obsolete test apps, one temporary registry and its exact pull grant were deleted and absence verified. Personal pod configuration is unchanged; shared storage, keys, identities and environment were retained | GCP retained object versions still require custody/retention reconciliation; Azure fixture prefix access is refused. No complete physical erasure claim. |
| Native security | Exact Capacitor 8.4.3 pins and reserved-proxy chat refusal; old-code negative control fails | Rebuilt native binaries and their independent distribution/acceptance. Web deployment is not a native release. |
| Cloud moves / Computer Use | Source foundations refuse unqualified custody and execution | Neither capability is offered until its transfer/recovery or per-cloud sandbox/privacy gates pass. |

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
| Engineering / release | Deploy and verify bounded hidden-callback recovery; finish Feed and native connector checks; improve measured cold-start latency; retain exact image compatibility. |
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
