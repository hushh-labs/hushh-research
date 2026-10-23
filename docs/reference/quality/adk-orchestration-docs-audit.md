# Private-pod readiness: CTO decision memo

## Current decision — 23 October 2026

**The Hosting/AI/cleanup correction is on main. Dev serves `ee77ebdb43`;
UAT has accepted `a68bddc8a8`. The newer model-picker and Puppy warmup repair
is local in [PR #8395](https://github.com/hushh-labs/hushh-research/pull/8395).
Broader installed-pod acceptance remains separate.**

| Surface | Verified state |
| --- | --- |
| Main | PR #8386 correction and PR #8391 typed AI refusals landed; peer Profile/calendar and UAT timing changes through `d0ff6decfb` are preserved locally |
| Dev | [Run 39987252665](https://github.com/hushh-labs/hushh-research/actions/runs/39987252665) accepted `ee77ebdb43` in 24m09s |
| UAT | [Run 39990262675](https://github.com/hushh-labs/hushh-research/actions/runs/39990262675) accepted `a68bddc8a8` in 57m06s; its workflow head `ee77ebdb43` is not its resolved application SHA |
| Serving readback | Corporate ADC: dev backend `00209-h58` / frontend `00176-6p5`; UAT backend `02484-maf` / frontend `02042-6vp`; all 100% traffic and exact receipt provenance |
| Owner pods | No image installation or cloud configuration change in this application release |

The expired risk-snapshot refusal from run `39972103223` is resolved by the
published refresh. PR #8391's management breadcrumb, return route and typed AI
refusals are verified on dev, but are not yet included in UAT's older accepted
revision. The next finished correction must retain the exact-SHA dev → UAT chain.
Production, stable publication and automatic owner upgrades remain held.

### Current account-specific findings

- Both named Azure placements must use their pod's actual connection; the Chat
  picker incorrectly reads Shared's Gemini catalog. The local repair uses admitted
  pod selection metadata, refuses Shared writes/fallback for private placement,
  and does not invent a default-model catalog when an older image omits it.
- Account 54's Azure resource, incarnation, user-assigned identity, image and
  registry coordinates match. Its Azure deployment is `gpt-5-mini`; compute was
  healthy and scaled to zero. This inventory is not live app-admission evidence.
- Account 1711's normal owner API confirmed BYOC placement and a linked but offline
  Puppy. Hermes alone did not start the separate dev relay. Restoring the existing
  `dev-puppy` identity produced authenticated admission in 2,063 ms and a sealed
  connection in 428 ms, without inference or a new grant. The same model menu then
  received the machine's local catalog. These are single observations, not latency
  guarantees.
- A synthetic owner turn subsequently reached the local Gemma 12B service
  (HTTP 200 headers in 34 ms), but timed out before an answer. An isolated
  eight-token local probe returned model data in 454 ms. Installed source permits
  95-second broker prefill but cancels the outer ADK wait at 70 seconds. The local
  correction gives ADK 100-second event waits while retaining the 150-second total
  turn and existing inner deadlines. The timeout-ladder negative control catches
  the old inversion. It still requires a new, owner-approved pod image and live
  answer acceptance; a healthy socket alone does not prove inference.
- The local frontend repair adds a coalesced foreground Chat wake and a bounded
  readiness read on entering/returning to Puppy. Hidden tabs do not wake compute;
  readiness never requests inference or enables a new grant. Owner-generation
  fences retire cached device/model responses and prevent late model writes.
- Real provider removal, broader orphan discovery, account re-registration and
  installed Browser journeys remain the explicit boundaries below.

## Corrected journeys

- Existing owners return from Hosting setup to Hosting through shell/native Back
  and Finish. First-run onboarding keeps its own destination. Finish appears only
  after hosting and AI are verified; abandoned AI edits retain the working choice.
- The explicit cloud-default action verifies the admitted current pod even when
  hub capability discovery is stale. Owner, placement, provider, incarnation and
  configuration checks remain mandatory. The AI card retains the actual verified
  model/deployment; it does not invent a multi-deployment catalog.
- **Remove cloud, keep account** reuses exact reviewed erasure authority. It retains
  the account, vault and PKM; the review explicitly covers cloud-only Files/history
  loss. Progress, provider delays and repairable uncertainty are shown honestly.
  Inspection pauses admission; closing its dialog does not cancel the operation.
- **Check hosting** reads the recorded cloud home without waking or modifying the
  pod. Broad historical orphan discovery and automatic subscription-wide deletion
  are not implemented.
- UAT recovery tracks one exact execution and requires provider success plus its
  bound receipt. Run 39949039317 exposed an 180-second controller cancellation before
  a 207-second worker receipt. The correction preserves task/batch limits, refuses
  retained-job replay and keeps unconfirmed work available for reconciliation.

## Verification and remaining boundaries

One local core passed in 13m01s: 24,489 backend cases passed and 636 skips were
recorded, alongside frontend build/type/lint, security, governance, MCP and
integration. Changed contracts subsequently passed 154 deployment cases and 21
security authority/receipt tests. Original-code negative controls fail; the
architecture ratchet has zero new/worsened findings. The final exact-head hosted
run passed all required lanes, including full web suites, browser packs, backend
and iOS. These layers do not substitute for deployed owner acceptance.

Dev migration 972 passed the pre/post-deploy schema gates with no violations.
Each provider's real standalone removal journey still requires separate evidence. UAT graduation remains separate; missing schema must
keep the control unavailable. The historical account-deletion HTTP 500 was on older
source and its underlying exception was not captured. No personal cloud has been
deleted to qualify this UI.

Browser startup/viewport repair is in source, but the installed Dev28 owner journey
remains unqualified. Research, preview, takeover, handback, reconnect and Stop must
pass on each exact installed image. Login, remembered sessions, selected PKM and
Files transfers retain separate acceptance. The 30-second cold target is an
optimization goal; economy hosting and owner-selected configurations remain.

Same-login re-registration remains staged: shared Firebase identifiers do not
authorize clearing terminal account tombstones or mutating production identity
from dev/UAT. Preserve the existing UID/vault/device/pod bindings and qualify the
explicit lifecycle before promising a fresh start.

## Security

GitHub's refreshed inventory has **two open OpenTelemetry alerts**; seven patched
alerts are closed, with none manually dismissed. The pinned ADK cap excludes the
fixed version. Incoming vendor `tracestate` is ignored at the public propagator
boundary while preserving traceparent/outbound context. This is mitigation, not
upstream remediation. The protected worker accepts verified pending concurrency
states without weakening exact repository/workflow/run/attempt/SHA binding. Its
receipt cannot replace successful PR validation. Repository-secret removal is
verified; original-token revocation remains separately unverified.

Earlier accepted application receipts remain historical evidence:
[PR #8365](https://github.com/hushh-labs/hushh-research/pull/8365) and
[PR #8377](https://github.com/hushh-labs/hushh-research/pull/8377). The
[normal-release plan](../../future/personal-agent/NORMAL-RELEASE-TRANSITION.md)
and [deletion runbook](../operations/account-deletion-rollout.md#remove-cloud-while-keeping-the-account)
own the operating procedures and retained acceptance gates.

## Visual Context

Start with the [Founder/CTO diagram guide](../architecture/README.md#founder-and-cto-diagram-guide)
and [private-agent north star](../architecture/private-agent-north-star.md).
The [Browser reference](../../../consent-protocol/docs/reference/private-browser-runtime.md)
owns exact execution mode, qualification and lifecycle evidence. Operating procedures
stay in the [pod runbook](../operations/dev-pod-first-light-runbook.md),
[Files runbook](../operations/private-files-library.md),
[deletion runbook](../operations/account-deletion-rollout.md) and
[normal-release transition plan](../../future/personal-agent/NORMAL-RELEASE-TRANSITION.md).

Private work stays in the selected owner cloud. The hub coordinates identity,
consent, placement and updates. Puppy runs inference on the granted machine
through its bound pod, with no cloud-model fallback. Model-provider processing
retains its disclosed boundary.

## What works / what must change

| Journey | Recorded outcome | Remaining acceptance |
| --- | --- | --- |
| Hosting / AI | Provider-aware onboarding and encrypted custom-key choices deployed; Azure owner chat completed; approved dev Gemini bridge returned 200 | Complete the GCP owner journey through its configured bridge. Organization-level native Vertex denial is expected; more IAM grants are not its remedy |
| Files | Dedicated specialist/explorer; personal and fresh Shared Move, exact download and Undo; earlier interrupted 4,195,328-byte transfer and selected analysis passed | Current-image organization, fresh setup and retained Shared erasure |
| Updates | Azure Dev 28: normal Browser setup approval and Microsoft handoff, one verified operation and exact installed digest; both predecessor recovery fixtures pass | Active-work overlap remains unproven; finish GCP installation and current-image continuity/Feed checks |
| Puppy | Existing Hermes identity, signed binding, sealed WSS and streamed Gemma 12B; prior Stop, withdrawal/refusal and re-enable passed | Repeat affected paths only. Phone testing waived; independent-network acceptance is unclaimed |
| Browser | Immutable-image native research passes on both clouds. The deployed 971/replay repair clears Azure's initial review failure; a fresh task accepted screen-processing consent and active takeover, then failed Phone resize before initialization | Release the locally verified startup/resize repair, then finish the installed journey. Hidden owner tabs intentionally do not paint frames. Additional interactive policy and GCP acceptance remain unverified |
| Scheduled tasks / connectors | Local One occurrence/review/checkpoint continuity and authenticated HTTP have controlled proof; active worker registration remains Files-only | Preserve existing schedules; all-family expansion is deferred. Current-image connector refresh/review and supported continuation still need acceptance |
| Voice | App selects GCP recorded commands; Azure capture disabled. Stronger private-pod guards are source-qualified | Fresh image and owner approval; GCP recorded audio remains live-unverified. Live needs compatible native transport, never a shared key |
| Erasure / transitions | Earlier Shared erasure verified object/Firebase absence; retained fixture gets safe 409 on deployed source | Reconcile the uncertain write through the product path before erasure; cloud/external-grant cleanup and hosting transfers need their own receipts |
| Security / economy | Authority negatives, explicit shared-owner compromise boundary and minimum-zero configuration have scoped evidence | Installed lifecycle and idle acceptance; dependency alerts, including companion alerts, remain independent clearance requirements |

### Effective AI configuration

Read-only serving evidence on 21 October: UAT Shared selects Azure OpenAI with
the configured GPT-5 mini primary; dev Shared retains Gemini. The current personal
Azure `one-chat` deployment is GPT-5.6 Luna, independently of the earlier temporary
GPT-6 Luna probe. Browser qualification must use that actual connection; no model
upgrade or provider fallback is implied. Shared Files analysis retains its separate
Gemini processing disclosure. The provider-neutral **Use Hussh AI** picker fix is
committed and passes its 40 nearest checks; legacy API identifiers are preserved.
That label correction is deployed in `f055c05948`.
The deployed follow-up projects the effective managed processor into an opt-in
response field and renders matching disclosure, preserving old strict clients and
historical receipts. Source review, 25 backend cases and 37 frontend cases pass;
the combined candidate subsequently completed the core mirror and exact-SHA CI.
It does not replace the qualified pod image.

### Retained Shared deletion

The synthetic account, vault and original library remain fenced after
`409 FILES_ERASURE_WAITING_FOR_WRITES`. Exact-session status and cancellation return
412; retained bytes differ from the expected write. An isolated synthetic final-PUT
precondition failure reproduces that latched response. A later DELETE-only removal
of the write precondition also returns 412; conflicting bytes and generation were
preserved and synthetic active objects cleaned. A documented malformed-range
abort also returns 412, so neither establishes termination. The original write
fence and objects remain intact. No SQL override, direct provider deletion or
blind retry is permitted. Its earlier
32 KiB upload/Move/download/Undo used operator authentication/phone fixtures, not
ordinary Google/CAPTCHA/SMS onboarding. The old RAM-only passphrase is gone;
subsequent cleanup must not be described as normal unlocked-UI vault recovery.

<a id="source-and-serving-evidence"></a>

## Historical source and serving evidence — PR #8365

The earlier correction `51a5a86675` and immutable Dev 28 offer were deployed.
These receipts describe PR #8365, not the current PR #8386 rollout. Publishing and owner
installation remain separate; Azure has completed its approval, while GCP has not.

| Surface | Exact receipt | Boundary |
| --- | --- | --- |
| Dev app | ADC, 23 October 04:27 UTC: both `51a5a86675`; backend `00199-cvk`, web `00168-2xq`, both 100% | Governed run `39890010863`; immutable digests, schema, parity, semantics and normal-owner setup/Back/Finish accepted |
| UAT app | ADC, 23 October 04:27 UTC: both `51a5a86675`; backend `02469-vej`, web `02026-9j2`, both 100% | Governed run `39892483774`: healthy; exact-SHA dev predecessor, schema, parity, provenance, semantics, worker and text recovery passed |
| Azure owner pod | Dev 28; digest `8b846022…68ac07`; revision `ca-hussh-one-pod--u31257e45d565` | Normal approval `op_13e165d0d1bf4a6788ae230cc7e2a93f`, verified 02:22:22 UTC. Same service identity, 1 vCPU / 2 GiB, min 0 / max 1. Active-work drain overlap is not established |
| Schema / rollback | Dev `39890010863` and UAT `39892483774` passed pre/post-deploy schema guards with no violations; that earlier correction added no SQL | Rollback targets: dev `00198-bps` / `00167-7zr`; UAT `02466-rec` / `02022-wwl`. Earlier 69-checksum/private-review replay evidence remains historical; it does not establish every current owner's placement. History cleanup stays separate |
| Integration | Correction `51a5a86675` preserves reconciled ADK lineage and main through `4ac0a122be`, including Drive, Finance, Mail and Azure chat/search | PR #8365 passed 26 exact-head checks; original branch fast-forwarded without force-push. Nine unrelated peer edits and the active ADK tree remain excluded |
| Published pod offer | Dev 28 reuses image `sha256:8b846022947bca939fba48cddf1101f3c26dddfb043ab41e20bd7407e068ac07`, source `67a64533ac6a` | Both exact personal predecessors recovered identity, six sealed records, consent/PKM state and 245,763 exact file bytes. Temporary resources cleaned; GCP seven-day soft-delete retention preserved |
| GCP configuration / inventory | Revision `00019-p6z`, unchanged predecessor `26bab163…61809`, 1 vCPU / 2 GiB / concurrency 8, min 0 / max 1 | Guarded inventory reconciliation committed locally as `02a7aec016` and applied. Storage protection enforced; all 39 objects preserved. Authenticated domain repair recovered identical keys, permits both exact dev domains and refuses unrelated origins; temporary job absence verified |
| Browser component evidence | GCP Gemini 3.8: 20.366 s / three rounds; Azure actual `one-chat` GPT-5.6 Luna: 16.823 s / five rounds | Real frames, native continuations, 390 × 844 resize, login-observation fencing and joined Stop. Component takeover followed model completion. These are not installed-owner, cold or full-pod capacity results |

### Historical correction evidence — PR #8365

The correction preserves nine unrelated peer edits and the active ADK worktree.
Focused evidence: 278 UI cases; 154 backend cases; eight setup layouts at
320/390/800/1440 px in light/dark. TypeScript and tracing mypy passed before the
final candidate freeze. New tests cover real API → AuthProvider invalidation,
verified AI readiness after Back and encrypted-key reads after unlock. Controlled
broken implementations fail their regression checks. Core stages on `6dd4baacd6`
passed with environment-only resumes: 23,113 backend cases passed, 142 skipped;
three Bash 3.2 compatibility failures resolved on modern Bash, with all 33 affected
cases passing. Web production build/types/lint, security/governance, MCP packaging
and integration passed. The later diagram-import repair passes all 19 existing
PDF cases and three real Node/Chromium diagram renders. Main's Mail refresh copy
and browser preconditions are reconciled; all four Chromium/WebKit document/app
scroll cases pass with the original one-pixel, focus and row-identity assertions.
Incoming Azure/auth/readiness integration adds 472 focused passes. Exact-head CI
run `39886820907` passed all 26 checks after one failed-jobs-only editor timing
retry; source and limits were unchanged. Original 27 ms p95 and 121.5 ms maximum
misses remain recorded. Dev owner acceptance covers the actual Google session,
passphrase unlock, connected setup and Back/Finish; fixtures do not certify other
owners' cloud IAM, billing or re-registration.

Next 16.4.2, DOMPurify 3.4.17 and Nodemailer 10.0.10 are patched in source.
The actual Mermaid browser bundle uses the patched dependency; 223/223 diagrams
rendered. ADK's supported OTEL constraint still prevents its upstream patch.
The incoming-tracestate guard is a mitigation, not an advisory closure. Nodemailer's
standalone production mail service is outside this application rollout; its source
patch does not prove a deployed mail-service upgrade.

The protected worker was independently qualified as run `39861716513`.
Main cutover run `39889655505` verified exact-source receipt reuse and skipped
repeat inventory reads/artifact upload. The old repository secret is deleted,
absence is verified, and no same-name organization secret is accessible to this
repository. The main-only protected replacement remains present. The trigger
repair landed in [PR #8371](https://github.com/hushh-labs/hushh-research/pull/8371)
as `04081d3c46`, after all 26 exact-head checks passed in run `39903975455`.
It uses one initial `requested` event and governed retries with fresh exact-attempt
clearance in the final gate. All 21 security, 74 real gate-harness and eight UI-gate
cases pass. The harness correction retains unknown-condition refusal and proves
receipt failure propagation. Live initial/retry receipts are maintained on
[the canonical task](https://github.com/hushh-labs/hushh-research/issues/5507);
qualification must use the new workflow revision. Original PAT
revocation is separately unverified; deleting a stored secret is not revocation.
Duplicate release monitor #8353 is archived with its journal preserved and active
marker removed; canonical #8304 reconciliation passed in run `39871154431`.
Automatic production/native releases remain disabled.

A deleted application account cannot currently re-enrol under the same Firebase UID.
Shared Firebase remains supported; environment-scoped account generations must
fence retired sessions, grants, jobs and writes before same-UID re-enrollment.
The bounded follow-up preserves shared identity, stops prohibited automatic cleanup
retries and keeps the hashed tombstone; it does not yet implement re-registration.
Isolated dev/UAT identity projects remain an alternative, not a mandatory provider prerequisite.
Never clear terminal tombstones, claim cleanup from key destruction, or delete a
production Firebase identity from non-production.

The Browser repair joins initialization before takeover acknowledgement and
publishes viewport epochs. Its negative controls and terminal cleanup are covered;
installed model-directed browsing remains unverified. Public policy currently
admits Python documentation only. Login, submissions, PKM production and downloads
need their own owner-policy acceptance. Deferred producer work is preserved outside
this candidate; never substitute a broad replica or handcrafted grant.

Dev-only 971 repairs review-channel constraints through canonical replay. Historical
checksums and original failed tasks remain preserved. Destructive history cleanup
is separate. Main retains the existing `enabled: false` production/native cadence
hold, preserving its implementation, intervals and ledger. UAT acceptance does
not re-enable catch-up. Manual release authority remains unchanged.

## Performance and economics


| Measurement | Result | Decision |
| --- | --- | --- |
| Earlier PR #8365 delivery cycle | Exact-head CI: 29m18s including one failed-jobs-only retry; dev: 19m50s; UAT: 76m15s | UAT includes 33m48s initial queue; deployment job 39m51s. CI initial queue 1m44s; dev 5s. Measure from dispatch to last job completion; never sum parallel jobs or call queue time test execution |
| CI trigger repair | Exact-head run `39903975455`: 26 checks passed; backend 27m40s; iOS 23m56s | Parallel backend tests 12m10s; isolated serial database tests 11m57s. The earlier failing run stopped before serial checks, so it is not a full-run timing baseline. No limits or isolation weakened |
| Matched cloud chat | 20 cold / 20 warm per cloud: GCP p95 71.721 / 7.700 s; Azure 71.304 / 13.389 s | Retain this historical baseline. Thirty seconds is an optimization goal; fix measured startup work and recovery, without a permanent warm floor |
| Personal chat | Latest zero-instance sample: first content 44.837 s, complete 46.040 s; capabilities 40.304 s | Wake/readiness dominates this sample; not a percentile or physical paint measurement |
| Puppy Dev 25 | First text 35.257 s, complete 35.509 s; device first content 25.308 s | Nonempty Gemma 12B response received in an occluded browser; not cold-model or foreground-paint acceptance |
| Idle | Personal Dev 25 reached zero replicas at 03:40 UTC after the verified turn | No pod wake request was made to obtain this control-plane observation; exact idle-grace timing remains unmeasured |
| Model qualification | Gemini 3.8: tools 2/3; 3.5 Flash / Flash-Lite LOW: 3/3 + 5/6 first-tool; Azure Luna: 3/3 + 6/6. Estimated charge $1.96791915 | Bounded earlier samples; defaults unchanged. Provider failures and 429s retained; no further sweep |
| Current report estimate | 20 useful / 30 billable hours, 10 GiB library, 1,500 calls and $5 reserve: Google/3.8 $37.50; Azure/GPT-5.6 Luna $21.93 per month | Dated planning inputs; excludes qualified Browser capacity and unmeasured startup/scale-down tails. Older 50 GiB/GPT-6 Luna runbook figures describe a different scenario and must not be mixed |

The authenticated pod-status surface now provides bounded numeric memory/peak/limit/OOM, CPU and shared-memory observations. Fourteen focused route/measurement checks pass, including refusal before sampling; the premature-sampling negative fails. Missing kernel counters remain explicit. Capacity acceptance is still pending.

Qualification envelope: **1 vCPU, 2 GiB RAM, min 0 / max 1, one worker**.
GCP concurrency 8 differs from Azure HTTP threshold 8. Ten-minute relay grace and
platform scale-down tails are billable. Existing selected hosting is preserved.
The deployed foreground-wake fix prevents hidden-tab/status polling from extending
paid work; spending thresholds warn without stopping service.

## Next gate and owners

1. **CI/security owner:** preserve one initial worker and fresh exact-attempt retry
   clearance through the governed command. Keep current receipts on the canonical
   task; successful application suites remain retained during a gate-only retry.
   PR #8386 is on main and dev deployment `39968480755` passed.
   Owner Back/Finish and removal explanation passed in background Chrome.
   UAT `39972103223` refused an expired risk snapshot before deployment.
   Validate a refreshed pinned snapshot and repeat the exact-SHA release chain.
2. **Security owner:** retain the two ADK-constrained OTEL records and verify
   GitHub's closure of the seven patched records. Original-token revocation
   remains separately unverified; the exposed repository secret is retired.
3. **Browser owner:** exact installed-image public research, review, preview,
   takeover, resume, reconnect and Stop remain separate acceptance on each cloud.
   Keep unqualified capabilities unavailable; no expanded feature work blocks this correction.

Reuse unchanged Puppy evidence: 320 Chromium/WebKit responsive cases, shared
760 px ribbon/composer, 0 px edge discrepancy, 44 px controls and no overflow.
Do not rerun it for backend/doc-only changes.

Main integration and landed-SHA smoke are verified for `7671c6ca6d`.
The current application correction has healthy dev provenance/schema/semantic
receipts and real owner Back/Finish acceptance. Exact-SHA UAT promotion
was stopped by expired risk evidence; earlier receipts do not replace
its terminal result. Production, stable publication,
automatic owner upgrades, managed Hussh provisioning and unqualified hosting moves
remain unavailable. Broader Files/connector/voice/update/erasure lifecycle evidence,
general schedules and economic qualification stay tracked in the
[normal-release plan](../../future/personal-agent/NORMAL-RELEASE-TRANSITION.md).

## Reviewed integration debt


Historical anchor: the [architecture baseline](./architecture-fitness-baseline.json)
owns reviewed spans, hashes and negative controls. The 2026-10-19 integration
record preserves all prior annotations, maps only active moved identities and binds
selective ceilings to exact source hashes and parent provenance; the ratchet,
exclusions and budgets remain unchanged. Existing integration chronology and original failed
runs remain in Git. Scope-commerce qualification at `da6b4cdb8dec` retained all
26 reviewed production deltas; it does not establish financial release acceptance.
The Drive four-group integration record dated 2026-10-23 retains 39 independently
reviewed size spans with exact source hashes and both integration parents. The
original failed CI run remains linked in the record. Review found and corrected
a partial-refresh readiness defect; scheduler CLI parsing and restoration were
extracted rather than retained as size debt. Growth controls reject a subsequent
increment for every recorded identity. This qualification grants no release or
authenticated UAT acceptance; the 500/250/80 budgets and scanner remain unchanged.
Independent review permits only the specialist test module's 568→575 line ceiling:
the new owner-ADC case covers bridge dispatch plus consent rechecks; the 500-line
budget and production limits are unchanged.
The separate workflow/Admin repair [PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121)
passed protection parity; it grants no application promotion.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and gates belong to the deployment standard.
