# Private-pod readiness: CTO decision memo

## Decision — 2026-10-23 UTC

**The onboarding/security correction is accepted on dev and UAT. The CI trigger repair has landed on main.**
[PR #8365](https://github.com/hushh-labs/hushh-research/pull/8365) landed as `51a5a86675`
after all 26 exact-head checks and landed smoke passed. Dev run `39890010863`
passed provenance, environment, schema and semantic checks. UAT run `39892483774`
passed the same gates, private-worker attestation and text recovery. ADC readback
at 04:27 UTC confirms both services on `51a5a86675`, at 100% in both environments. Normal Google-owner
navigation passed refresh, Azure setup, passphrase unlock, Back/Finish and home
with an enabled composer. Fresh Shared/GCP enrollment and deleted-user
re-registration are not established by that owner rehearsal.
[PR8337](https://github.com/hushh-labs/hushh-research/pull/8337) landed as
`0ea0f8fce3` after all 26 exact-head checks and landed smoke passed. The preserved
infrastructure branch inherits main through `04081d3c46`, including Drive, Finance,
Mail, Azure chat/search and filtering, Calendar and Copilot styling without whole-file replacement. Earlier
MVP receipts remain history; they do not verify the current correction candidate.
Production, stable-channel publication and automatic owner upgrades remain held.

Azure Dev 28 retains its approved image and economy configuration. Browser review
and takeover reached the pod, but early takeover exposed `BROWSER_NOT_INITIALIZED`.
Its startup/resize repair is integrated in source; no new pod image was installed.
GCP inventory and old-domain repair preserved image, keys and identity. Browser
remains unqualified on installed owner images. Advanced private context, remembered
logins, broad capacity studies and retained synthetic erasure remain follow-ups.

The [public-research MVP](../../future/personal-agent/browser-completion-plan.md#immediate-mvp--critical-path-first)
is P0: ask One, review, browse, take control, resume, reconnect and stop. Login,
remembered sessions, private-context disclosure and transfers follow that proof.
The 30-second cold target is an optimization goal. Economy hosting stays selected.

## Onboarding correction — 23 October 2026

Reported setup failures affected general cohorts, not a single owner: fixed-footer
email preferences obscure controls; private AI setup cannot display its vault
dialog; a one-shot hosting observation can leave every AI choice disabled.
The correction also covers abandoned AI edits, locked saved-key recovery and deletion notices through the real API/authentication path. Local core and exact-head CI passed. The deployed normal-owner rehearsal reached home without a setup loop; optional preferences remained clear of the fixed Finish control at 1464 × 929, with zero horizontal overflow. The inherited diagram-import and Mail-test failures were repaired without excluding checks. Known erased UIDs
remain fenced; the shared Firebase deletion boundary cannot be bypassed.

The earlier nine-alert inventory is superseded by the refreshed two-alert
inventory above. Seven source-patched alerts are now closed by GitHub; none was
manually dismissed. Source patches cover
Next.js, DOMPurify (including the actual Mermaid bundle) and Nodemailer. ADK's
supported OTEL cap excludes the patched release: ignore incoming vendor
`tracestate` through the public propagator boundary, preserving traceparent
and outbound context. This is an application mitigation, not an upstream alert
closure. The dev-only unpatched `braces` tooling advisory remains tracked.

## Latest stabilization and cloud removal — 23 October, 10:15 UTC

[PR8377](https://github.com/hushh-labs/hushh-research/pull/8377) landed as
`49975547b6`. One frozen-candidate core mirror completed in 19m41s; all 26 hosted
PR checks and exact landed smoke passed. [Dev39928813587](https://github.com/hushh-labs/hushh-research/actions/runs/39928813587)
completed successfully. Verified ADC readback at 09:26 UTC: backend
`consent-protocol-00203-w5s` and frontend `hushh-webapp-00171-wsr`, both 100% at that
SHA. UAT’s latest successful run remains `39920618646` at `989afe4336`; it has not
received the subsequent local repair.

A real background Chrome owner reached the verified Azure AI selection with
Finish enabled, then stalled at the setup shell. The existing one-attempt,
owner-fenced streamed-shell recovery omitted setup routes; both routes are now
included locally. Tests cover them; installed verification waits for the next
candidate. Do not generalize earlier successful home navigation to this newer
failed journey.

GitHub’s refreshed dependency inventory now has **two open OpenTelemetry alerts**
(498,487); the seven patched alerts are closed. The ADK-supported version cap
still excludes the fixed release. Incoming-tracestate mitigation remains
qualified application protection, not upstream remediation. Secret and code
scanning were clear at the prior verified read.

The new **Remove cloud, keep account** flow and read-only Hosting inspection are
local follow-up source. They reuse exact owner/resource erasure authority, retain
uncertain cleanup, preserve previous homes and fence stale replacement callbacks.
Dev-only migration972 is not deployed. Neither provider’s standalone cloud
removal has live owner acceptance. The [deletion runbook](../operations/account-deletion-rollout.md#remove-cloud-while-keeping-the-account)
owns its authority, recovery and unavailable boundaries.

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

## Source and serving evidence

The corrected application and immutable Dev 28 offer are deployed. Publishing and owner
installation remain separate; Azure has completed its approval, while GCP has not.

| Surface | Exact receipt | Boundary |
| --- | --- | --- |
| Dev app | ADC, 23 October 04:27 UTC: both `51a5a86675`; backend `00199-cvk`, web `00168-2xq`, both 100% | Governed run `39890010863`; immutable digests, schema, parity, semantics and normal-owner setup/Back/Finish accepted |
| UAT app | ADC, 23 October 04:27 UTC: both `51a5a86675`; backend `02469-vej`, web `02026-9j2`, both 100% | Governed run `39892483774`: healthy; exact-SHA dev predecessor, schema, parity, provenance, semantics, worker and text recovery passed |
| Azure owner pod | Dev 28; digest `8b846022…68ac07`; revision `ca-hussh-one-pod--u31257e45d565` | Normal approval `op_13e165d0d1bf4a6788ae230cc7e2a93f`, verified 02:22:22 UTC. Same service identity, 1 vCPU / 2 GiB, min 0 / max 1. Active-work drain overlap is not established |
| Schema / rollback | Dev `39890010863` and UAT `39892483774` passed pre/post-deploy schema guards with no violations; this correction adds no SQL | Rollback targets: dev `00198-bps` / `00167-7zr`; UAT `02466-rec` / `02022-wwl`. Earlier 69-checksum/private-review replay evidence remains historical; it does not establish every current owner's placement. History cleanup stays separate |
| Integration | Correction `51a5a86675` preserves reconciled ADK lineage and main through `4ac0a122be`, including Drive, Finance, Mail and Azure chat/search | PR8365 passed 26 exact-head checks; original branch fast-forwarded without force-push. Nine unrelated peer edits and the active ADK tree remain excluded |
| Published pod offer | Dev 28 reuses image `sha256:8b846022947bca939fba48cddf1101f3c26dddfb043ab41e20bd7407e068ac07`, source `67a64533ac6a` | Both exact personal predecessors recovered identity, six sealed records, consent/PKM state and 245,763 exact file bytes. Temporary resources cleaned; GCP seven-day soft-delete retention preserved |
| GCP configuration / inventory | Revision `00019-p6z`, unchanged predecessor `26bab163…61809`, 1 vCPU / 2 GiB / concurrency 8, min 0 / max 1 | Guarded inventory reconciliation committed locally as `02a7aec016` and applied. Storage protection enforced; all 39 objects preserved. Authenticated domain repair recovered identical keys, permits both exact dev domains and refuses unrelated origins; temporary job absence verified |
| Browser component evidence | GCP Gemini 3.8: 20.366 s / three rounds; Azure actual `one-chat` GPT-5.6 Luna: 16.823 s / five rounds | Real frames, native continuations, 390 × 844 resize, login-observation fencing and joined Stop. Component takeover followed model completion. These are not installed-owner, cold or full-pod capacity results |

### Correction evidence

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
| Current delivery cycle | Exact-head CI: 29m18s including one failed-jobs-only retry; dev: 19m50s; UAT: 76m15s | UAT includes 33m48s initial queue; deployment job 39m51s. CI initial queue 1m44s; dev 5s. Measure from dispatch to last job completion; never sum parallel jobs or call queue time test execution |
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
   The application correction, dev owner acceptance and UAT promotion are complete.
2. **Security owner:** retain the two ADK-constrained OTEL records and verify
   GitHub's closure of the seven patched records. Original-token revocation
   remains separately unverified; the exposed repository secret is retired.
3. **Browser owner:** exact installed-image public research, review, preview,
   takeover, resume, reconnect and Stop remain separate acceptance on each cloud.
   Keep unqualified capabilities unavailable; no expanded feature work blocks this correction.

Reuse unchanged Puppy evidence: 320 Chromium/WebKit responsive cases, shared
760 px ribbon/composer, 0 px edge discrepancy, 44 px controls and no overflow.
Do not rerun it for backend/doc-only changes.

Main integration and this correction have verified dev and UAT receipts. The
CI trigger follow-up does not require another application rollout. Production, stable publication,
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
