# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Trust and execution boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-17 UTC

**Continue dev qualification; hold the application merge and production rollout.**
The exact CI-green application is deployed. The personal Azure owner approved and
installed Dev 23 through Settings. Normal owner approval, authenticated handoff,
recovery, digest readback and one Feed completion event are verified. Prior normal chat,
retained Files bytes and Puppy streaming/Stop receipts remain; the latest default-model
Puppy turn times out before text and is not accepted. This resolves
the old-image normal-chat refusal. Shared Files transfer, consented analysis and
reversible management pass. The disposable Shared account was erased through the
product API with independent provider checks; a bounded-cleanup response defect
is fixed and deployed in `0b1d4202d9`. Personal-pod Move/download/undo now passes;
Shared-specific Move, cold latency and connectors remain gates. An earlier preloaded-model
Puppy response and pod-confirmed Stop pass; those receipts do not clear the latest Gemma 12B failure.
Computer Use, managed Hussh provisioning and cross-cloud Files moves stay disabled.

## Source and serving evidence

| Surface | Verified evidence | Boundary |
| --- | --- | --- |
| Application | `7b0d4c2a22`; [complete exact-SHA hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/39047264306) and final local core pass | Concurrent changes through `216f259306` are integrated. Later independent scope-commerce commits are outside this deployed candidate. Immutable pod-image source remains `0b1d4202d9` |
| Dev hub/frontend | [Governed deployment](https://github.com/hushh-labs/hushh-research/actions/runs/39050162065) succeeded. Approved-ADC readback: backend `00180-jg4` / `45f5e81c6c88`; frontend `00152-5mh` / `d0842f4210a1`; both source `7b0d4c2a22`, 100% traffic | GitHub governs; Cloud Build builds. Trusted workflow definition main `fd3b00b3c160`. The same-SHA backend-only [publication run](https://github.com/hushh-labs/hushh-research/actions/runs/39052082764) also succeeded; frontend was not redeployed |
| Schema / rollback | Deployment migration guard/runtime parity pass, including the dev-only 964 candidate. History cleanup 249 remains deferred. Prior application rollback target: `5b493370ae`, backend `00178-mv6`, frontend `00151-s57` | Application rollback does not reverse schema changes or recover deleted information. No destructive cutover performed |
| Published pod release | `2026.10-dev.23+0b1d4202d9b1.250aea9e`, immutable `sha256:250aea9ee2a5cfe5faf2feceb450d8ee9386d7c6d4d678478248af7630fc69f1`; image source `0b1d4202d9`, publisher `39052082764` | Serving/archive equality verified; archive generation `1792257167353875`, SHA-256 `7a15c5ecf05432856e675455691a363e218987e039cbff8e16c960eb0599813b`. Only exact predecessor `72b049df…842b001b` admitted. Publishing does not install |
| Personal Azure pod | Settings-approved Dev 23 operation `op_80762d405b414642ad7db95eb4177cd4`; verified 17:30:21 UTC; revision `ca-hussh-one-pod--u7be9dcdfe17e`, installed digest `250aea9e…fc69f1` | Independent ARM readback: same service and attached identity; 1 vCPU, 2 GiB, min 0/max 1, one worker, HTTP threshold 8, relay grace 600 s. Exactly one matching Feed completion; no account/device reset |
| Prior Dev 21 qualification | Both disposable clouds recovered 4,195,328 Files bytes using native identities, then upgraded from exact predecessor. Azure also retained encrypted chat/settings and completed another real response. Temporary Jobs deleted and absence verified | GCP live chat continuity and live rollback remain unverified; isolated evidence is distinct from personal Settings approval |
| New Dev 22 native recovery | Exact `250aea9e…fc69f1` image recovers the retained 4,195,328-byte Files fixture on both clouds using native identities; keys remain inside the runtime. Both temporary Jobs were deleted and absence verified | GCP log-read 429 reconciled without rerunning its successful worker. Azure authenticated replacement retained Files, settings, key identity and the exact encrypted chat; the subsequent response reached `RUN_FINISHED` (13.089 s first content / 20.401 s completion). GCP chat returned `AGENT_ERROR` before replacement. A native-identity model probe independently returns Vertex `403 PERMISSION_DENIED` despite enabled billing/API and the existing Vertex AI User grant; a fixture-only Service Usage Consumer grant was tried, then removed by an etag-preserving exact diff with independent readback. A fresh synthetic turn still failed after seven minutes; this is not the established chat fix and no model fallback occurred. The published Dev 23 descriptor admits only exact Dev 21 digest `72b049df…842b001b` for the proven Azure owner transition. Normal Settings approval completed operation `op_80762d405b414642ad7db95eb4177cd4`; durable idle, installed digest and recovery verification are recorded. GCP chat acceptance remains separate. GCP chat acceptance is not inferred |

Native GCP diagnostics confirm the expected workload identity and requested
cloud-platform scope. REST `v1` and the pinned SDK’s `v1beta1` both return 403,
including the exact declared Vertex/Consumer role pair; the SDK sample took
0.128 s. Temporary Jobs and diagnostic grants were removed with readback.
Transport parity is established; the provider refusal remains unresolved.
Policy readback and the bounded 120-second waits do not exclude IAM propagation.
No model fallback, personal-resource change or further IAM widening is justified.

The workflow-only Admin repair and `azfx` removal landed separately through
[PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121), with live protection
parity and landed-SHA smoke verified. Neither grants application promotion.

## Acceptance matrix

| Journey | Demonstrated | Remaining condition / owner |
| --- | --- | --- |
| Normal private chat | Dev 21 normal owner UI, full unchanged tool catalog: HTTP 200 and `RUN_FINISHED`; POST to first content 3.141 s, completion 4.046 s. Earlier synthetic story remains visible in the same unlocked tab | One warm sample; cold p95 and recorded voice/connector journeys remain Engineering acceptance |
| Files workspace | Dedicated `agent_files` explorer. On deployed `f378a75b5588`, normal owner navigation, folder creation, 32 KiB upload, actual Move dialog, destination readback, byte-exact download and undo with stable identity pass. Only the new synthetic file/folder were trashed. Earlier interrupted transfers, rename/undo, trash/restore and cold unlock receipts remain | Personal-pod acceptance does not prove Shared-specific Move. Fresh/existing setup and UAT storage/IAM acceptance remain; trash is not immediate physical erasure |
| Organization | Prior normal Azure owner queue/terminal result preserves original bytes. Exact earlier target completed automatic synthetic jobs on GCP Cloud Tasks and Azure Storage Queue; original content remained byte-exact and settings restored | Current-image live foreground analysis and fresh provisioning are not inferred from older receipts |
| Software update | Dev 23 normal Settings approval produces one durable operation. The synthetic chat has its normal tool catalog: active work observed, authenticated prepare at 17:27:37, `RUN_FINISHED` at 17:27:44, durable idle receipt at 17:27:47, verified replacement at 17:30:21. Settings navigation/re-unlock follows the same operation; the Feed has exactly one completion event | The initial overlap attempt finished during provider selection and is retained. Server request receipts corroborate the second overlap and polling until durable idle; no destructive fault injection or live rollback performed |
| Puppy | Prior Dev 21: existing Hermes identity/grant, real local Gemma response streams; Stop returns HTTP 200 `stopped`; next response completes in 8.176 s, first text 8.027 s. No cloud fallback | First postrestart response took 67.133 s; local inference first content took 54.916 s. After a verified zero-instance wake, Puppy reconnects and completes another response in 28.923 s from turn start. Fresh owner withdrawal returns pod `revoked: true`; new binding is refused with 403 `PUPPY_OWNER_APPROVAL_REQUIRED`; re-enable preserves the same device and completes another response in 29.813 s. Independent phone/Mac internet remains unverified; reduced-motion emulation let the occluded owner pane mount, so this is functional rather than visual acceptance |
| Restart continuation | New installed image includes sealed private command/MCP recovery; Files jobs and updates retain their existing durable owners | Source/recovery tests do not prove every live connector/command continuation. Current admission and exact review remain necessary; uncertain effects cannot be blindly replayed |
| AI / setup | Provider-aware Shared/GCP/Azure defaults, encrypted Azure custom keys, public-destination validation, quota preflight, billing recovery and durable setup retry are implemented and serving | Live custom-key/default responses, missing-billing return and fresh native sign-in on both platforms remain acceptance rows. Cloud readiness cannot imply available model quota |
| Shared Files | Same disposable owner selected Shared and managed AI, created its vault normally, then cold-unlocked the same library. Interrupted/resumed 4,195,328-byte upload and byte-exact download pass; first chunk written once. Folder creation, inline rename/undo, trash/restore, warm-route vault continuity and explicit selected-file analysis pass; original bytes remain intact and Shared automatic organization stays unavailable | Move focus repair now serves and passes focused Chromium/WebKit cases; old-source negative control fails. Live repaired Move remains pending. Product cleanup succeeded after an operator-reviewed continuation of the settled first batch; this is not normal-UI deletion proof. Phone setup used a separately declared official Firebase configured-number fixture with signed proof and verified temporary-identity cleanup; ordinary CAPTCHA/SMS/legal UX is **not** passed. Original failed attempts remain recorded. A host restart ended the memory-only harness session; the same synthetic library and identity were subsequently erased through the product API without reset or recreation |
| Account/cloud cleanup | Disposable Shared product deletion completed at 08:03 UTC; independent reads verify active/versioned object absence and Firebase identity absence. The original 500 and retained fence are preserved. Deployed fix returns exact `409 FILES_ERASURE_IN_PROGRESS`, keeps keys/session only after active-owner proof and permits deliberate retry; 68 web / 7 route tests and architecture ratchet pass | The exact pending-cleanup response fix now serves in `0b1d4202d9`; normal deletion-UI acceptance remains unperformed. Provider soft-deletion listing is unavailable without versioning; this fixture has creation-bound no-soft-delete history, not universal physical-erasure proof. Azure full lifecycle remains separate; personal accounts were not deleted |
| Existing users | Explicit Shared choice and evidenced legacy cohort; assigned/pending/unresolved pods cannot silently become Shared. Existing-user changelog excludes new users | Environment-specific cohort/schema graduation and reviewed changelog content require UAT/production readback |
| Computer Use / scheduling | Responsive local preview/takeover/handback, owner fencing and metadata-only recovery tested. Files-only scheduling/outbox preserved | Native GCP identity/bridge and Azure execution/privacy gates remain closed. Azure due-time delivery, general goals and scheduled browser work unavailable |
| Hussh-managed hosting / moves | Project-shard custody/capacity design; fail-closed provisioning and transfer admission | No qualified shard or migration offer. Shared-to-pod, reverse and cross-cloud moves require verified destination readability and source-cleanup receipts |
| Security | Capacitor 8.4.3 matches the critical upstream proxy fix; negative control fails on old code. Bounded triage found no confirmed attacker-reachable path for 15 remaining high advisories | Affected versions remain, including urllib3 streaming and Sharp/librsvg. This is not vulnerability clearance or native-binary acceptance |

**Latest Puppy follow-up — 17 October:** two initial local-model attempts
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
passes all 20 owning checks and fails on the old code. This follow-up is local,
not included in deployed `7b0d4c2a22`; no authentication or vault gate changes.

**Latest default-model result — Dev 23:** the same Hermes identity reconnects
with a new sealed session after installation. Two bounded Gemma 12B turns receive
local HTTP 200 headers but no text before a 60-second read timeout. The original
generic failure is retained. Hermes `fd8cd41dbe` now carries that timeout through
the existing pod/browser `PUPPY_TIMEOUT` contract; the second UI settles without
an endless busy state. No other model was tested or selected. The coordinated
90/95-second first-data repair, existing 60/65-second subsequent inactivity limits
and unchanged 120-second pod bound pass focused source checks; empty frames cannot
extend them. It is **not deployed or live accepted**. Gemma 12B remains the default.

Final local core passed: 21,248 parallel Python checks, 1,466 serial checks,
web-core, packed MCP and integration. The exact-SHA hosted run linked above
passed every job. Earlier stale fixture failures, the config test’s environment
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
| Runtime | Earlier ten-minute soak settled 20 synthetic operations/cloud; old-image zero-replica observations retained. On 17 October, the personal Dev 21 pod again reached zero at 09:14:30 UTC, with zero queued messages | ARM and queue-metadata reads made no pod requests. The hidden tab made no direct request during a bounded 45 s observation, and Hermes had no established pod socket. This does not prove comparable peaks or concurrent Puppy/Files capacity |
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

1. **Engineering:** Shared Files owner acceptance, native connectors/recorded commands and measured cold latency; preserve exact approval authority.
2. **Operations:** complete disposable lifecycle cleanup, production migration/release graduation, erasure/retention, IAM, billing, recovery and independent UAT acceptance.
3. **Owner/device:** repeat the proven Mac-side response after the next approved pod installation; cold-model startup remains unqualified. Phone testing is outside this pass by explicit owner decision.

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
are verified above; its live predecessor list remains empty until the separately
reviewed Dev 23 offer serves. No install is offered by a version label alone.

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
