# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Trust and execution boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-18 UTC

**Continue dev qualification; hold the application merge and production rollout.**
The exact CI-green application serves dev. The personal Azure owner installed Dev 25
through normal Settings approval: recovery, immutable digest, unchanged incarnation
and exactly one Feed completion are verified. The existing Hermes identity then
completed one streamed Gemma 12B response; the UI returned to idle with no overflow.
No other model was tested. An initial setup-progress lock refusal was retained;
one normal retry completed the same approved operation. Its owner-first journal
repair now serves dev after exact-source CI and governed deployment.
Shared Files transfer, consented analysis and reversible management pass. Personal
Files and fresh Shared Move/download/undo pass. Shared deletion remains fenced
on an uncertain upload; cold latency, connectors and full lifecycle acceptance
remain gates. Computer Use, managed Hussh provisioning
and cross-cloud Files moves stay disabled.

## Source and serving evidence

| Surface | Verified evidence | Boundary |
| --- | --- | --- |
| Application | `e9482e4319ad`; [exact-SHA hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/39104101777) and [governed dev deployment](https://github.com/hushh-labs/hushh-research/actions/runs/39105713670) pass | Resumed core evidence retains the original failure, 21,249 parallel passes, 1,470 serial passes, 27 owning checks and the unfenced-runtime negative. The browser-only follow-up adds 12 focused passes; unchanged protocol/MCP/integration inputs reuse their completed proof |
| Published repair target | Image `4a3b29a74641…a939ac9a`, source `991a06ccbc01` | Both native workers recovered 4,195,328 retained Files bytes exactly and were removed with absence readback. Azure authenticated replacement retained encrypted history, Files, settings and key identity; post-update chat completed. Dev 25 admits only the tested Dev 23 digest `250aea9e…fc69f1` |
| Dev hub/frontend | Approved-ADC readback: hub `00185-f9z` / `73c3632206cd`, source `e9482e4319ad`; frontend `00153-7ck` / `3796e3503566`, source `991a06ccbc01`; both 100% traffic | Backend-only workflow; the complete frontend delta is two browser-test paths, so its image was preserved. GitHub governs and Cloud Build builds. Dev 25 archive equality passes |
| Schema / rollback | Last independent ledger read: 65 rows, 964 applied, zero checksum/required-contract mismatches; this deployment passed pre/post schema gates. History cleanup 249 remains deferred. Application rollback: hub `00184-fkl`, source `39dd047b92a0`; frontend `00153-7ck`, source `991a06ccbc01` | No live rollback or destructive history cutover. Application rollback does not reverse schema or recover deleted information |
| Published pod release | `2026.10-dev.25+991a06ccbc01.4a3b29a7`, immutable `sha256:4a3b29a74641d7eac470da43d18f01c5039f4c0327ed84811ce2f0bfa939ac9a`; publisher `39091378215` | Serving/archive equality verified; exact predecessor only. Publishing did not install it |
| Personal Azure pod | Settings-approved operation `op_b9a279571aaf47bcaffdbc4689c80d6c`, verified 18 October 03:19:39 UTC; revision `ca-hussh-one-pod--u36234007817f`, digest `4a3b29a7…a939ac9a` | Same service, identity and incarnation; 1 vCPU, 2 GiB, min 0/max 1, one worker, HTTP threshold 8, relay grace 600 s. One matching Feed completion; no account/device reset |
| Prior Dev 21 qualification | Both disposable clouds recovered 4,195,328 Files bytes using native identities, then upgraded from exact predecessor. Azure also retained encrypted chat/settings and completed another real response. Temporary Jobs deleted and absence verified | GCP live chat continuity and live rollback remain unverified; isolated evidence is distinct from personal Settings approval |
| New Dev 22 native recovery | Exact `250aea9e…fc69f1` image recovers the retained 4,195,328-byte Files fixture on both clouds using native identities; keys remain inside the runtime. Both temporary Jobs were deleted and absence verified | GCP log-read 429 reconciled without rerunning its successful worker. Azure authenticated replacement retained Files, settings, key identity and the exact encrypted chat; the subsequent response reached `RUN_FINISHED` (13.089 s first content / 20.401 s completion). GCP chat returned `AGENT_ERROR` before replacement. A native-identity model probe independently returns Vertex `403 PERMISSION_DENIED` despite enabled billing/API and the existing Vertex AI User grant; a fixture-only Service Usage Consumer grant was tried, then removed by an etag-preserving exact diff with independent readback. A fresh synthetic turn still failed after seven minutes; this is not the established chat fix and no model fallback occurred. The published Dev 23 descriptor admits only exact Dev 21 digest `72b049df…842b001b` for the proven Azure owner transition. Normal Settings approval completed operation `op_80762d405b414642ad7db95eb4177cd4`; durable idle, installed digest and recovery verification are recorded. GCP chat acceptance remains unverified |

Native GCP diagnostics confirm the expected workload identity and requested
cloud-platform scope. REST `v1` and the pinned SDK’s `v1beta1` both return 403,
including the exact declared Vertex/Consumer role pair; the SDK sample took
0.128 s. Temporary Jobs and diagnostic grants were removed with readback.
Transport parity is established; the provider refusal remains unresolved.
Policy readback and the bounded 120-second waits do not exclude IAM propagation.
No model fallback, personal-resource change or further IAM widening is justified.
An authorized personal-account read at 22:47 UTC independently confirms the fixture
identity already has both declared roles on the approved dev bridge, whose billing
and Vertex API are enabled. Chat's `user_adc` binding resolves the owner project;
the separate Files bridge setting does not select chat's project. On 18 October,
one native-identity diagnostic against that bridge returned HTTP 200 and nonempty
text in 1.046 s: three input tokens and one output token, with no retry. The exact
current image and workload identity were verified; its temporary Job was deleted
and absence confirmed. No IAM or service configuration changed. This proves access
to that explicit bridge, not readiness of the owner's Vertex project. An authorized
native-ADC chat selection is still missing; Files approval and generic environment
overrides cannot supply it.

The workflow-only Admin repair and `azfx` removal landed separately through
[PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121), with live protection
parity and landed-SHA smoke verified. Neither grants application promotion.

## Acceptance matrix

| Journey | Demonstrated | Remaining condition / owner |
| --- | --- | --- |
| Normal private chat | Latest Dev 23 post-update normal owner UI: unchanged tool catalog, HTTP 200 and `RUN_FINISHED`; first content 4.410 s, completion 5.600 s from POST. Prior same-session synthetic history remains | One warm sample; cold p95 and recorded voice/connector journeys remain Engineering acceptance |
| Files workspace | Dedicated `agent_files` explorer. On deployed `f378a75b5588`, normal owner navigation, folder creation, 32 KiB upload, actual Move dialog, destination readback, byte-exact download and undo with stable identity pass. Only the new synthetic file/folder were trashed. Earlier interrupted transfers, rename/undo, trash/restore and cold unlock receipts remain | Fresh Shared Move is separately verified below. Fresh/existing setup and UAT storage/IAM acceptance remain; trash is not immediate physical erasure |
| Organization | Prior normal Azure owner queue/terminal result preserves original bytes. Exact earlier target completed automatic synthetic jobs on GCP Cloud Tasks and Azure Storage Queue; original content remained byte-exact and settings restored | Current-image live foreground analysis and fresh provisioning are not inferred from older receipts |
| Software update | Dev 25 normal approval and one retained operation finish with recovery/digest verification and exactly one Feed event. Prior Dev 23 separately proved active-chat drain, durable idle and refresh/re-unlock | The first Dev 25 job hit the unchanged owner-lock guard before any ARM mutation. One normal retry reused the same approved operation. Owner-first progress hardening now serves in `e9482e4319ad`; no additional owner installation or live rollback fault injection |
| Puppy | Dev 25: existing Hermes identity/grant, fresh signed binding, sealed WSS and nonempty streamed Gemma 12B response; UI idle and aligned. Request-to-first-text 35.257 s, completion 35.509 s; device first content 25.308 s. No cloud fallback or model sweep | One post-update sample, not cold or p95. Prior Stop, withdrawal, refusal and re-enable receipts remain; phone was waived. Independent-network and cold-model percentiles are unclaimed |
| Restart continuation | New installed image includes sealed private command/MCP recovery; Files jobs and updates retain their existing durable owners | Source/recovery tests do not prove every live connector/command continuation. Current admission and exact review remain necessary; uncertain effects cannot be blindly replayed |
| AI / setup | Provider-aware Shared/GCP/Azure defaults, encrypted Azure custom keys, public-destination validation, quota preflight, billing recovery and durable setup retry are implemented and serving | Live custom-key/default responses, missing-billing return and fresh native sign-in on both platforms remain acceptance rows. Cloud readiness cannot imply available model quota |
| Shared Files | Earlier 4,195,328-byte interrupted/resumed transfer, selected analysis and reversible management pass. On 18 October, a fresh disposable Shared owner cold-unlocked normally; 32 KiB upload, actual Move dialog closure, source/destination readback, stable identity, byte-exact download and Undo pass on frontend `991a06ccbc` / hub `e9482e4319` | Dev operator-issued authentication and the official configured-phone fixture do not qualify ordinary Google/CAPTCHA/SMS/legal onboarding. Background analysis stayed unavailable; no model call occurred. Normal deletion returned 500 twice, including one deliberate continuation after active-owner readback; the exact synthetic owner and encrypted retry custody remain preserved. Earlier failures and the separately erased 15 October fixture remain recorded |
| Account/cloud cleanup | Earlier disposable Shared product erasure verified active/versioned object and Firebase absence. The fresh 18 October UI rehearsal instead retains an erasing inventory, one uncertain protocol-2 create-only upload and its vault. Exact-session empty status returns 412; this is **not** terminal evidence | Local correction settles validated successful sends before the final access check; recovery may attempt cancellation after an uncertain status, but requires HTTP 499 plus existing object/bucket proof and exact CAS. A safe `409 FILES_ERASURE_WAITING_FOR_WRITES` preserves the confirmed-active session without automatic retry. 99 focused Python and 37 frontend cases pass; these corrections are not deployed. No fence or provider object was manually cleared |
| Existing users | Explicit Shared choice and evidenced legacy cohort; assigned/pending/unresolved pods cannot silently become Shared. Existing-user changelog excludes new users | Environment-specific cohort/schema graduation and reviewed changelog content require UAT/production readback |
| Computer Use / scheduling | Responsive local preview/takeover/handback, owner fencing and metadata-only recovery tested. Files-only scheduling/outbox preserved | Native GCP identity/bridge and Azure execution/privacy gates remain closed. Azure due-time delivery, general goals and scheduled browser work unavailable |
| Hussh-managed hosting / moves | Project-shard custody/capacity design; fail-closed provisioning and transfer admission | No qualified shard or migration offer. Shared-to-pod, reverse and cross-cloud moves require verified destination readability and source-cleanup receipts |
| Security | Capacitor 8.4.3 matches the critical upstream proxy fix; negative control fails on old code. Bounded triage found no confirmed attacker-reachable path for 15 remaining high advisories | Affected versions remain, including urllib3 streaming and Sharp/librsvg. This is not vulnerability clearance or native-binary acceptance |

**Earlier Puppy follow-up — 17 October:** two initial local-model attempts
failed; the E2B engine reported an aborted startup. After a bounded native CLI
load with a 180 s idle TTL, the same normal owner browser and existing Hermes
identity completed an E2B response: first text 33.598 s, completion 33.779 s.
This was an explicitly preloaded model, not cold-model acceptance. A subsequent
Stop returned HTTP 200 with `stopped: true`, and the UI left its busy state.
The earlier missed cancellation and failures remain recorded. There was no
cloud fallback, re-enrollment or change to the global 12B default. Phone testing
was removed from this pass by the owner; independent-network acceptance remains
unclaimed and is not a device prerequisite for this pass.

**Puppy interface — 17 October:** serving source `7b0d4c2a22` reuses One’s
composer, bubbles and Markdown. The responsive model/“This machine” ribbon,
partial-answer Stop and portal retirement pass 320 affected Chromium/WebKit
checks at 320, 390, 768 and 1280 px; ten optional exports were not run.
A real 1.5 px offset is fixed, with the original layout as a failing control.
The local bridge cancels its same upstream stream; focused cancellation checks
pass. Gemma 12B stays the default; this interface pass made **zero model calls**.
Normal-owner background readback at 17:11 UTC confirms the deployed ribbon and
composer share the same 760 px measure and start line (0 px discrepancy), both
controls are 44 px high, and the editor is 16 px with no horizontal overflow.
“This machine” opens with explicitly reported model, memory and scheduled-work
observations. Same-session Settings navigation remains unlocked. A separate
background cold-tab session hold is retained as a failed observation; it is not
cold-start acceptance. No Chrome activation or window resizing occurred.
The cold Puppy route was missing from the existing verified-owner recovery list.
One supported Next refresh reaches normal unlock; the narrow allowlist addition
passes all 20 owning checks and fails on the old code. It now serves in
`991a06ccbc01`; normal owner cold entry and passphrase unlock pass. Fresh live
readback confirms Gemma 12B, the 760 px ribbon/composer, zero start/end-line
discrepancy, 44 px controls, 16 px input and no overflow. No model call, viewport
resize or activation command was used for that UI check; no authentication or
vault gate changed.

**Latest default-model result — Dev 25:** the existing relay restarted only after
owner-approved digest/recovery verification. It obtained a fresh signed binding
and sealed connection. One Gemma 12B turn emitted thinking, text and a terminal
result: 26 characters, reported `google/gemma-4-12b`, provider `puppy`, runtime
`puppy_relay`. Request-to-first-text was 35.257 s and completion 35.509 s;
device model first content was 25.308 s. The occluded browser proves received
stream progress, not foreground paint or a cold-start percentile. The response
settled to idle; ribbon/composer share a 760 px measure with 0 px edge mismatch.
No other model, cloud fallback, re-enrollment or configuration change occurred.
The standby relay was later restored from its unchanged profile after exit 137;
the termination cause is unconfirmed and no inference was repeated.
The earlier Dev 23 generic and typed 60-second failures remain retained. The
installed 90/95-second first-data repair keeps later inactivity and total bounds.

The initial Dev 25 setup job was refused by migration 961's owner-admission guard
before any ARM effect. Its scheduled approval was preserved; one normal retry
completed the same operation. The local correction acquires owner/erasure locks
before the exact job row and appends against the current journal. Whole-journal
replacement requires an explicit revision comparison. Fifty-nine focused cases
are covered (58 initial passes plus the corrected driver-wrapper case); the
original source fails the contention negative control. The guard and migration
are unchanged. The full local mirror's parallel leg records 21,249 passes and
one race-hook mismatch: its old SQL-prefix check missed the new CTE. The corrected
hook covers quoted and unquoted writes; all 27 owning cases and an unfenced-writer
negative control pass. Production code is unchanged by that fixture repair.
The canonical remainder passes: 1,470 serial checks, all imports, web-core,
packed MCP and integration. Exact-source hosted CI is blocked by unrelated Wallet
WebKit checks: the original Add-height failure passes on the sole job rerun,
which instead exhausts the Sharing test's 30-second clock. Both cases pass
unchanged locally. The reviewed split separates dismissal from confirmed
revocation while retaining every assertion and timeout. All 12 affected
Chromium/WebKit cases pass at 320, 390 and 1440 px without retries; the longest
takes 2.795 seconds locally after extraction. This qualifies the test split, not hosted reliability.
The corrected candidate passes complete hosted CI and one backend-only dev rollout.
Both original failed attempts remain retained; no new pod image or installation occurred.

Hermes' queued validation exposed inherited runner labels unavailable to this
organization. The companion uses standard hosted runners with bounded workers;
workflow lint and independent review pass. No test selection or timeout changed,
and that earlier run did not establish the new allowance. The selected relay now runs `f082c71325`. The first fully
executed companion suite reports 39,382 Python passes and 77 failures across
broader inherited surfaces; full Hermes validation is not green. Its Puppy
credential-port fixture repair passes 41 focused checks without model calls.
Follow-up CI retains a desktop mock failure (seven owning checks pass after
its local correction); Python reached 38,805 passes and 76 failures before
cancellation, so that partial run is not a full-suite result. The two test-only
corrections are pushed as `f082c71325`; hosted JS/TS, native OS checks and Python
E2E pass. The broad Python job was cancelled after 30 minutes; its incomplete
result is not a full-suite pass. These outcomes are separate from application CI. GitHub reports unresolved critical
companion dependency alerts, including installed PyJWT and AnyIO. Source review
finds no exposed path through this sealed relay; dependency remediation and
broader distribution clearance remain separate requirements.

The frozen `991a06ccbc` local core passed: 21,250 parallel Python checks,
1,466 serial checks, web-core, packed MCP and integration. Its exact-SHA hosted
run passed after a single Wallet WebKit job rerun on unchanged source; the original failure is retained. Earlier stale fixture failures, the config test's environment
leak and required-consent fixture corrections remain in Git history and retained
receipts; runtime consent enforcement and the architecture ratchet are unchanged.
Headless frame probes include hitches and do not certify physical-device pacing.

Puppy requires a registry-confirmed BYOC assignment and current owner/device/pod
grant. Shared and Hussh-hosted modes refuse inference. Status, encrypted sync and
relay admission are separate facts. Existing owners retain resources and selected
hosting; no automatic upgrade is authorized.

## Performance and economics

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Matched cloud chat | GCP: 20 cold p95 71.721 s / 20 warm 7.700 s; Azure: 20 cold 71.304 s / 20 warm 13.389 s | Cold ≤30 s target fails; nominal vCPU equality is not performance equivalence |
| Latest Dev 21 personal cloud chat | 17 October: POST to first content 6.261 s / completion 7.459 s. Confirmed zero-instance turn: Send to first content 44.837 s / completion 46.040 s; capabilities request 40.304 s | One new warm/unqualified-start sample and one genuine cold sample, not p95. Both reach `RUN_FINISHED` with nonempty UI responses. The cold target fails; wake/readiness dominates this sample. Preloaded-model Puppy response and cancellation pass; cold-model failures remain recorded above |
| Runtime | Earlier ten-minute soak settled 20 synthetic operations/cloud. The personal Dev 25 revision reached zero replicas after its successful Puppy turn, observed at 03:40 UTC on 18 October; prior Dev 23 idle-return proof remains | Read-only control-plane observations made no pod wake requests. This sample does not establish exact grace timing, concurrent Puppy/Files capacity or a cold-start percentile |
| Model qualification | Gemini 3.8 tools 2/3; 3.5 Flash LOW / Flash-Lite LOW 3/3 tools + 5/6 first-tool; Azure Luna 3/3 + 6/6 | Small bounded sample, defaults unchanged; provider failures/429s retained; estimated charge $1.96791915 within $2 ceiling |
| Monthly package | 30 billable hours, 50 GiB, 1,500 modeled calls + $5 reserve: Google/3.8 $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32 | Dated planning estimates, not equivalent quality, invoices or quotas |

Browser timings above measure received stream content in an occluded tab; physical
frame-paint latency was not measured.

Economy qualification is **1 vCPU / 2 GiB, min 0/max 1, one worker**. GCP concurrency
8 and Azure HTTP threshold 8 have different semantics. Ten-minute sockets and
platform scale-down tails are paid time. Polling must not wake compute. Focused
negative controls exposed hidden-tab and
health-refresh re-wakes; a bounded frontend fix passes all 16 wake tests locally,
including fresh foreground wake and current fault/owner fences. This fix now serves in `7b0d4c2a22`; it is not asserted as the cause of the
earlier observed live wake. Spending
thresholds warn without stopping service. See [whole-package and VM assumptions](../operations/private-files-library.md#whole-package-planning-budget).

## Owners and next gate

1. **Engineering:** release and verify the upload-reconciliation/refusal correction, finish the retained synthetic deletion, then native connectors/recorded commands and measured cold latency. Shared Move is now verified; preserve exact approval authority.
2. **Operations:** complete disposable lifecycle cleanup, production migration/release graduation, erasure/retention, IAM, billing, recovery and independent UAT acceptance.
3. **Owner/device:** Dev 25’s selected Gemma 12B response is verified; preserve that default without further model sweeps. Cold-model percentiles and independent-network acceptance remain unclaimed. Phone testing is outside this pass.

[Application PR #7555](https://github.com/hushh-labs/hushh-research/pull/7555) remains
draft. No application merge, UAT/production deployment or stable publication occurred.
Operational owners: [Files](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[account deletion](../operations/account-deletion-rollout.md),
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md),
[cloud moves](../architecture/pod-migration.md) and
[deployment standard](../architecture/deployment-standard.md).

## Reviewed integration debt

Frozen ADK intake preserves private-runtime authority and canonical CI/browser
coverage. Focused UI checks, browser collection, typecheck and design checks pass;
streamed-command replay and session-renewal scroll regressions retain failing
old-source controls. Workflow history now survives either merge-parent order,
with exact retired revisions still refused;48 focused checks and two old-source
failures prove this correction. Dev 22 image publication and exact Azure recovery
qualified the Dev 23 offer now installed through normal owner approval. The new
Dev 24 repair passed native Files recovery on both clouds and authenticated
Azure encrypted-history/update continuity. The published Dev 25 offer reuses that
exact image and admits only the tested Dev 23 digest. Normal owner approval has
installed and verified it. No install is offered by a version label alone.

A subsequent source review confirmed a missing GCP quota-use grant and its cleanup
obligation. The local correction discloses/applies the exact Consumer role and
extends the existing deletion journal, archive and finalization dependency. Dev-only
964 preserves legacy receipts; rollback locks custody and refuses unresolved
provision attempts. Focused checks: 320 provisioning/IAM, 18 orchestration, ten real
PostgreSQL erasure cases and two schema replay/rollback cases pass. Restoring the
old Vertex-only completion prerequisite makes the quota-boundary test fail. Original failed runs and independent negative controls remain retained. The
current combined verification above supersedes those partial local attempts;
source qualification does not prove the unresolved GCP provider access.

Historical anchor: the [architecture baseline](./architecture-fitness-baseline.json)
owns reviewed spans, hashes, parents and negative controls. Budgets 500/250/80 and
exclusions remain unchanged; CI rejects new or worsened findings. Git retains
integration chronology. Source qualification is not deployed acceptance.

The 2026-10-17 scope-commerce integration qualification records exactly 148
size occurrences at source `da6b4cdb8dec60f569c8e242ed7c37155e172622`:
80 incoming-main byte matches, 66 retained-parent matches, one migration union
within its parent size and one bounded test correction. Independent review covers
all 26 retained production deltas. All 2,835 prior occurrences and history remain;
129 exact value changes and 19 additions produce 2,854 rows. Every individual
one-line growth control still fails. Scanner, exclusions and budgets remain
unchanged. The canonical commerce reference owns remaining release and financial
acceptance; this qualification does not establish them.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and gates belong to the deployment standard.
