# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-12 UTC

**Hold the application merge and production BYOC rollout.** Source, deployment,
owner installation and production acceptance have separate evidence. The existing
personal Azure pod runs the owner-approved Dev 15 image; its Files transfers,
private chat and Puppy response/cancellation pass. Active-work update draining,
native connector journeys, cold-start performance and environment-specific
production controls remain unqualified. Computer Use and cross-cloud moves stay
disabled. Existing owners retain their resources and selected configuration.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Frozen implementation | `535e3351b95a` contains the reviewed main/ADK union, setup simplification, Files/Puppy corrections and retained-stream fix | Concurrent root/ADK/PDF edits remain preserved outside this frozen release. |
| Exact-SHA CI | [Run 38252668481](https://github.com/hushh-labs/hushh-research/actions/runs/38252668481) passed the complete hosted pipeline, including native compilation, browser coverage, full web and protocol lanes | Prior failed runs remain retained. The bounded Swift package retry does not bypass checksum, compilation or test checks; this run succeeded on its first resolution attempt. |
| Local verification | Composite core retains the full backend pass, focused repairs, PostgreSQL cases and remaining canonical stages; byte-identical runtime proof was reused. Release metadata receives its nearest contract checks | No repeated full local suite or fixture evidence is presented as owner acceptance. |
| Governed dev deployment | [Run 38257902102](https://github.com/hushh-labs/hushh-research/actions/runs/38257902102) passed schema, preservation, candidate health, provenance, parity, semantic checks and reviewer navigation/cold unlock | GitHub Actions governs; Cloud Build builds. The application remains unmerged. |
| Actual serving state — Oct 12, 14:55 UTC | Backend `00166-gk9`, digest `c7749c998f59`; frontend `00142-jtt`, digest `3366ba1ea033`. Both serve `535e3351b95a` at 100% traffic | Independent ADC readback confirms revisions, immutable images and deployment labels. Rollback targets remain `00165-92f` and `00141-7h9`. |
| Dev access repair | Request-slot exhaustion was measured independently of CPU, RAM and database load. Messages cancels open and late stream bodies; both old-code negative controls fail. Serving concurrency is now 40, with the same maximum three instances, worker and pools. The normal owner session is reachable and unlocked | This is a bounded mitigation, not a sustainable capacity or production-load claim. Owner-pod resources are unchanged. |
| Schema | Governed pre/post schema guards pass without missing required tables, columns or functions; selected canonical head 320 | Destructive history cleanup 249 remains deferred. No production schema acceptance or SQL rollback recovery claim. |
| Exact target recovery | Dev 16 image `47bb9a718063`, source `535e3351b95a`, passed actual Dev 15 → target recovery on disposable GCP and Azure pods. Keys, encrypted history, byte-exact Files, metadata, preferences and configuration are preserved. The same target also recovered at the personal Azure size, 0.5 vCPU/1 GiB; chat and authenticated organization completed with originals intact | The smaller-size test changes only a disposable service. Genuine idle/wake and exact personal Settings approval remain separate acceptance. |
| Qualified offer | Dev 17 metadata pins the same Dev 16 executable bytes and only the exact qualified Dev 15 predecessor | The metadata offer requires its own governed publication. No additional pod image is built; publishing never installs. |
| Personal pod | The earlier normal Settings operation verified Dev 15 restart, recovery and installed digest | The selected min 0/max 1, single worker, 0.5 vCPU/1 GiB, HTTP threshold eight and queue scaler are preserved. The new active-work update has not yet occurred. |

The original failed deployment and CI receipts remain available in GitHub and
private operational evidence. Private owner identifiers, cloud receipts and
credentials remain outside this memo.

## Acceptance matrix

| Journey | Demonstrated | Required before production |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer. Normal owner on Azure Dev 15: interrupted/resumed upload and download, byte-exact integrity, folders, inline rename/undo, move/undo, trash/restore and same-session continuity | Repeat new/existing setup and owner-cloud storage/IAM acceptance in UAT. Local UI checks do not prove cloud custody. |
| Files organization | Normal owner Azure Dev 15 semantic move/undo passed. On the exact Dev 16 target, GCP Cloud Tasks and Azure managed-identity Storage Queue completed automatic synthetic organization in 45.198 s and 51.24 s; originals remained byte-exact and analysis/automatic settings were restored | These disposable fixtures do not establish fresh owner provisioning or UAT acceptance. Trash does not claim physical deletion; unchanged results do not prove a semantic move. |
| Updates | Exact Dev 15 → Dev 16 recovery passed on both clouds. Earlier normal Dev 12/15 owner-approved installations pass; Dev 17 pins the qualified executable and predecessor without rebuilding it | New exact Settings approval with active-work drain, interruption/reconnect consistency and personal-profile acceptance remain required. Production provenance and destructive rollback faults are separate gates. |
| Private chat | Earlier 20 cold and 20 warm synthetic turns per cloud and bounded soak pass. Exact Dev 16 target chat completed: GCP first text 16.351 s/total 21.664 s; Azure 21.82 s/29.47 s | These individual target samples are not cold p95. Recorded voice, complete connector approval/resume and the failed cold-start target remain separate. |
| Puppy / phone | Physical S24 Ultra has dated signed-admission, direct stream and same-turn Stop receipts. After the Mac reboot, the existing Hermes identity reconnected: first browser turn failed at 93.1 s; warm retry streamed first text at 17.667 s and completed at 18.345 s. Existing grant withdrawal, reconnect and idle/wake receipts remain. | The failed first attempt is retained. Independent internet paths and the repaired model footer need current-image acceptance. Restored wireless pairing does not prove the currently intermittent phone browser-debug transport. |
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
| Engineering / release | Personal-profile idle/wake, exact Settings-approved active-work update, native connectors and cold-start improvement; retain exact image compatibility. |
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
