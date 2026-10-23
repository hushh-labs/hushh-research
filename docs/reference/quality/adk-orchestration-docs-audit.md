# Private-pod readiness: CTO decision memo

## Decision — 2026-10-23 UTC

**Main integration is complete; [onboarding/security PR #8365](https://github.com/hushh-labs/hushh-research/pull/8365) awaits corrected exact-head CI and dev acceptance before UAT.**
[PR8337](https://github.com/hushh-labs/hushh-research/pull/8337) landed as
`0ea0f8fce3` after all 26 exact-head checks and landed smoke passed. The preserved
infrastructure branch reconciles subsequent main through `4ac0a122be`, preserving its Drive, Finance, Mail and Azure chat/search changes. Earlier
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

## Current dev incident — 22 October 2026

**Decision: hold UAT promotion of this repair until dev onboarding passes.**
Reported setup failures affect general cohorts, not a single owner: fixed-footer
email preferences obscure controls; private AI setup cannot display its vault
dialog; a one-shot hosting observation can leave every AI choice disabled.
The correction also covers abandoned AI edits, locked saved-key recovery and deletion notices through the real API/authentication path. Local core stages passed; hosted validation found an import-time diagram-export defect, repaired through lazy initialization. Corrected exact-head CI and live acceptance remain pending. Known erased UIDs
remain fenced; the shared Firebase deletion boundary cannot be bypassed.

GitHub's pre-merge inventory reports nine dependency alerts and no secret alerts. Source patches cover
Next.js, DOMPurify (including the actual Mermaid bundle) and Nodemailer. ADK's
supported OTEL cap excludes the patched release: ignore incoming vendor
`tracestate` through the public propagator boundary, preserving traceparent
and outbound context. This is an application mitigation, not an upstream alert
closure. The dev-only unpatched `braces` tooling advisory remains tracked.

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

The C3 application and immutable Dev 28 offer are deployed. Publishing and owner
installation remain separate; Azure has completed its approval, while GCP has not.

| Surface | Exact receipt | Boundary |
| --- | --- | --- |
| Dev app | Read-only ADC, 22 October 22:56 UTC: backend `901838b512` / `00195-2lr`; web `f66b9f320f` / `00164-tfb`; both 100% | Governed runs `39844690705` and `39852036307`; local incident repairs are not deployed |
| UAT app | ADC readback, 22 October 23:47 UTC: backend `901838b512` / `02457-ked`; web `f66b9f320f` / `02013-wg9`, both 100% | Web run `39870899482` succeeded. Later main rollout `39872703798` correctly refused missing exact-SHA dev acceptance; no promotion of the local correction |
| Azure owner pod | Dev 28; digest `8b846022…68ac07`; revision `ca-hussh-one-pod--u31257e45d565` | Normal approval `op_13e165d0d1bf4a6788ae230cc7e2a93f`, verified 02:22:22 UTC. Same service identity, 1 vCPU / 2 GiB, min 0 / max 1. Active-work drain overlap is not established |
| Schema / rollback | 69 dev checksums match; all three private-review CHECK definitions and both 971 lineage markers verified at 05:28 UTC | No historical SQL changed. Latest dev rollout records rollback targets hub `00190-b4p`, web `00158-tds`. History cleanup remains separate |
| Integration | Main `d69c23ce45` includes the reconciled ADK `914e7c044c` and current main contracts | PR7555 merged after exact-head CI; the original infrastructure branch is synchronized without force-push. Nine unrelated peer edits remain uncommitted and excluded |
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
scroll cases pass with the original one-pixel, focus and row-identity assertions. Corrected hosted CI and
live owner acceptance remain required; fixtures alone do not establish either.

Next 16.4.2, DOMPurify 3.4.17 and Nodemailer 10.0.10 are patched in source.
The actual Mermaid browser bundle uses the patched dependency; 223/223 diagrams
rendered. ADK's supported OTEL constraint still prevents its upstream patch.
The incoming-tracestate guard is a mitigation, not an advisory closure. Nodemailer's
standalone production mail service is outside this application rollout; its source
patch does not prove a deployed mail-service upgrade.

The protected worker was independently qualified as run `39861716513`.
Read-only PR receipt consumption and exact-attempt reuse are locally verified;
main cutover and old repository-secret retirement remain required.
Duplicate release monitor #8353 is archived with its journal preserved and active
marker removed; canonical #8304 reconciliation passed in run `39871154431`.
Automatic production/native releases remain disabled.

A deleted UID cannot safely re-enrol under the shared Firebase authority.
This release distinguishes deletion, missing records and transient failures;
isolated dev/UAT authentication and preserved-user migration are staged separately.
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
is separate. Incoming main re-enabled production/native release cadence. This UAT-only candidate restores its existing `enabled: false` hold, preserving the peer implementation, intervals and ledger. Verify the landed hold and in-flight controllers before UAT; do not automatically re-enable catch-up. Manual release authority remains unchanged.

## Performance and economics


| Measurement | Result | Decision |
| --- | --- | --- |
| Delivery cycle | C3 exact-SHA CI 31.2 min; governed rollout 25.5 min | Sequential CI plus rollout is 56.7 min, before local verification, any new pod-image build and owner acceptance. C2's parallel critical paths were Browser 28.47, Python 26.83 and iOS 26.02 min; do not sum parallel jobs |
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

1. **Engineering:** finish corrected exact-SHA hosted validation. Reuse unchanged
   completed core stages and the focused diagram-import regression evidence.
2. **Release owner:** Admin SOP landing, landed smoke, governed dev acceptance,
   then promote the same accepted revision to UAT. Read back actual serving state.
3. **Browser owner:** exact installed-image public research, review, preview,
   takeover, resume, reconnect and Stop remain separate acceptance on each cloud.
   Keep unqualified capabilities unavailable; no expanded feature work blocks this correction.

Reuse unchanged Puppy evidence: 320 Chromium/WebKit responsive cases, shared
760 px ribbon/composer, 0 px edge discrepancy, 44 px controls and no overflow.
Do not rerun it for backend/doc-only changes.

Main integration and the earlier security foundation are landed. This new correction
needs its own dev receipt and UAT acceptance. Production, stable publication,
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
