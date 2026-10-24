# Private-pod readiness: CTO decision memo

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


## Current decision — 24 October 2026

**The prior application correction is accepted on dev and UAT. The surgical
lifecycle follow-up is local; it has not been merged or deployed.
Installed-pod and desktop acceptance remain separate.**

The preserved infrastructure branch now includes observed main `163ddb96a33e`
through merge `912592cf7d`, without dropping main content or overwriting peer edits.
The dependency-relevant native Profile/phone/device changes from local ADK are
reconciled in `e95fd03b25`; the rest of that branch remains preserved. The former ADK checkout is no longer present; its local branch
`feat/adk-orchestration-runtime` retains 20 unique commits at `48140fcd70`.
Do not describe that checkout as active or assume the remote ADK ref contains its
local work. Local changes add truthful
pod connection metadata and replayable cloud-default verification, fence stale
settings reads, bound AG-UI input before SDK validation, strengthen GCP adoption,
refuse unconfirmed owner-token revocation checks and bind Admin preflight to an
exact source attempt. Compatible mail/Python dependency patches are local too;
the standalone mail deployment remains a separate target.

Focused validation passed 363 backend cases, 90 frontend cases and TypeScript
checking. Hermes's corrected aggregate passed 68 classifier/aggregate cases.
These checks are not the final core mirror, hosted candidate validation or
installed-owner acceptance. The subsequent collection-count refinement has its
own affected verification; it does not dismiss the constrained Zod advisory.

The cleanup worker, ordinary-use fences and atomic erasure consumer are now
composed locally. Refresh intent and replacement custody survive cancellation
and lease recovery; watch-before-revoke and uncertain-effect refusal remain
enforced. Purpose-bound status and the privacy UI preserve identity during
cleanup and require exact local-erasure terms. Latest affected checks passed
**260 backend** and **167 frontend** cases, including real PostgreSQL and
API/auth/UI continuity. The draft migration remains unregistered and unapplied;
replacement-account authority and combined installed acceptance remain on the
critical path. Bounded Hermes source repairs
also passed their affected suites; successful local Python checks do not replace
exact-candidate hosted Python/Nix or an installed Puppy journey.

The local generation authority now passed two real PostgreSQL erase/enroll cycles
with clock-skew fencing, concurrent enrollment, immutable history and retired
UPDATE refusal. Its deliberate missing-guard negative control fails. Firebase
admission preserves the verified identity separately from the captured application
owner; session status exposes both plus generation. The latest affected backend
suite passed 262 cases. Frontend admission now separates the unchanged Firebase
identity from the application owner across AuthProvider, vault custody, identity
cache, pod transport, model selection and sign-in navigation. Focused checks cover
same-UID replacement, late observers/token responses, scoped revocation and recovery;
143 auth/identity/vault cases, 10 API cases, 7 sign-in cases and 34 pod-transport cases
passed. The vault entry, Hosting/setup and mounted One runtime now use the admitted
application owner too. Additional focused suites passed 148 vault-entry/auth,
75 onboarding and 39 runtime/recovery cases; these overlap and are not an additive
total. Pending identities without an application owner stay on recovery. TypeScript
and changed-source lint passed. Enrollment stays disabled while remaining application callers and the combined
candidate are qualified. Federated and purpose-bound email recovery are now
implemented locally; they have not been deployed.
Device/passkey mints now preserve external UID while carrying captured owner/lane;
101 focused device/passkey/auth cases passed, including retired-owner refusal and
unavailable-authority distinction. Email now captures its generation and explicit purpose before delivery;
existing identities cannot be recreated if they disappear during code entry. The Hosting return-only
Back/Finish regression passes 16 focused navigation cases. These are source checks,
not installed or serving acceptance.

The subsequent local deletion correction binds preparation, bank revocation,
submission and recovery to one admitted principal/browser episode. Late results
cannot invalidate another episode or change its onboarding cookies. The deletion
transport leaves lifecycle settlement to that captured operation; the real API
wrapper plus AuthProvider confirms a lost response without a false uncertain state.
The affected frontend suite passed 304 cases; TypeScript and changed-source lint
passed. Draft 413 now journals remote identity writes and blocks replacement
activation while they remain unresolved. Two real PostgreSQL erase/enroll cycles
passed with late settlement and forged-nonce refusal. The no-retry identity update
transport passed 232 affected backend cases, including one physical POST under
lost responses, errors and redirects. These remain local source/fixture results;
no installed image or environment acceptance is inferred.

The latest local registration slice binds explicit Start fresh approval to the
retired generation, qualified cleanup and immutable authentication/review receipt.
Google, Apple and Microsoft require independently fresh sign-in; unknown historical
cleanup stays Action required. The real API/AuthProvider recovery withdraws stale
application admission and reconciles an uncertain response without automatic replay.
Full-account deletion retains Firebase's UID in every environment. The latest
focused checks passed 248 backend, 379 frontend and 41 native privacy cases; these
counts overlap earlier suites. A 127.87-second disposable PostgreSQL rehearsal
passed two erase/enroll cycles, changed-proof replay refusal and pending-write
recovery. TypeScript and changed-source lint passed. This is local source evidence;
remaining owner consumers and installed acceptance still precede activation.
Email enrollment now commits exact proof consumption and activation together,
mints afterward, then rechecks policy, owner and expiry before releasing a token.
The 46 email cases passed on disposable PostgreSQL. A 127.76-second full-schema
two-cycle rehearsal passed concurrent email enrollment, old-code refusal, response
loss and fresh-email registration; 112 frontend/API cases passed. These results
remain local and overlap prior focused suites.

The next local owner-consumer pass uses the admitted application owner throughout
Profile/Memory, Files, Puppy placement, initial contacts, setup settlement, vault
methods and notifications. Firebase User remains the external identity and token
source. Same-UID replacement cases cover Memory, contacts, Files, Puppy and push
registration/sign-out. The focused owner suites passed 142 cases, Files/Puppy 27,
and notification/auth 259; these overlap other evidence and are not a combined
acceptance total. Changed-source lint and TypeScript passed. Combined UI review
receipts were regenerated after main/ADK reconciliation and UI contract verification
passed. The four affected Profile/phone/native/device suites passed 280 cases across
the corrected fixture retry; TypeScript and changed-source lint passed. Activation remains off.

SDK reads now translate the exact captured application owner to Firebase identity
without replacing owner keys in application records. The focused SDK-read suite
passed 547 cases, with its remaining Drive case passing after an explicit test-only
lifecycle fixture repair. Four directory cases include real PostgreSQL projection
and warm-cache retirement refusal. Conditional WorkOS/HushhTech custom-auth paths
now refuse generation-enabled execution explicitly; 133 affected cases passed.
These are bounded source checks, not deployed registration acceptance.

Cloud-only removal now has a draft forward recovery contract (414): approval,
execution admission and unapproved cancellation serialize on the existing owner
locks. Cancellation restores only the exact inert snapshot and retains history;
the legacy restoration and deprovision paths cannot bypass the review. Azure
checks dispatch before owner-access destruction and at SQL worker admission;
GCP carries the captured attempt. The affected backend suite passed 212 cases,
including real PostgreSQL cancellation/approval concurrency; the cleanup interface
passed 14 cases. Migrations 412–414 remain unregistered and unapplied. Installed
provider removal and final combined acceptance are still required. Canonical
release 404 supplies placement readers, not the full dev pod authority schema.
Draft 414 depends on parked 972 and its earlier erasure/update foundations; simply
adding 412–414 to the release manifest cannot qualify UAT. Graduate the final
schema through new forward migrations, preserving applied dev checksums and
excluding historical Shared inference and destructive chat cutover. Clean canonical
replay, rich-dev upgrade and repeated-replay preservation remain required.

The native upstream autofix workflow separately failed to open its generated PR
because Actions cannot create PRs in this repository. Main stayed unchanged.
Its unreviewed `bot/js-autofix` branch is not part of the accepted native image;
retain the patch for manual review. Do not broaden repository permissions. A
canonical-repository guard with artifact-only output is the bounded follow-up.

The remaining critical path is durable provider cleanup before local erasure,
cancel-safe cloud removal, environment-local account generations, then installed
Browser/Puppy acceptance and the governed main → dev → UAT sequence. Keep the
Firebase identity stable; replacement-account authority must never be inferred
from an email or by clearing a retired account's tombstone. The existing
[deletion runbook](../operations/account-deletion-rollout.md) retains this boundary.

| Surface | Verified state |
| --- | --- |
| Prior accepted release | [PR #8401](https://github.com/hushh-labs/hushh-research/pull/8401) landed as `ca83c0bf5a` through authorized Admin queue bypass; [exact-head CI](https://github.com/hushh-labs/hushh-research/actions/runs/40037466640) and [landed smoke](https://github.com/hushh-labs/hushh-research/actions/runs/40040728656) passed |
| Dev | [Run 40041198106](https://github.com/hushh-labs/hushh-research/actions/runs/40041198106) accepted `ca83c0bf5a`, both services; schema, provenance and semantic checks passed. Accepted revisions: backend `00214-nn5`, frontend `00181-mpz`, both 100% |
| UAT | [Run 40043238175](https://github.com/hushh-labs/hushh-research/actions/runs/40043238175) accepted `ca83c0bf5a`; schema, provenance, semantics and Drive-worker attestation passed. Corporate ADC confirms backend `02497-zic` / frontend `02054-lkq`, both 100% |
| Pod image | Genuine Dev29 image `683b7b5f08c0…dc52688`, source `ca83c0bf5a`, archived by dev run `40041198106`; no eligible existing-owner upgrades or Browser qualification pins |
| Last verified serving state | Corporate ADC at 12:41 UTC confirms peer rollouts serve `2732b301cc9e` on dev and UAT. Dev: backend `00222-scm` / frontend `00189-7jk`; UAT: backend `02519-jul` / frontend `02082-svf`; all 100%. Provenance identifies [dev run 40085364751](https://github.com/hushh-labs/hushh-research/actions/runs/40085364751) and [UAT run 40087949679](https://github.com/hushh-labs/hushh-research/actions/runs/40087949679). This is serving evidence, not acceptance of the local surgical follow-up |
| Live lifecycle schema | Read-only corporate ADC/catalog inspection at 12:42 UTC confirms dev has 39 registry columns and the cloud-removal authorities; UAT has 31 registry columns and no cloud-removal table/functions. Neither has account generations. Both owned inspection proxies exited. This confirms the forward-graduation prerequisite; no live schema or owner records were changed |
| Desktop | [Hermes PR #23](https://github.com/hushh-labs/hussh-one-hermes/pull/23) merged by the normal path at `d42ced4d5f70`. Exact-head [CI 40083504664](https://github.com/hushh-labs/hussh-one-hermes/actions/runs/40083504664) and [Nix](https://github.com/hushh-labs/hussh-one-hermes/actions/runs/40083504327) passed; Python completed in 26m23s with the full discovered suite. [Landed fresh-sync](https://github.com/hushh-labs/hussh-one-hermes/actions/runs/40085556487) passed in 3m28s, logged the exact landed checkout and passed 450 guard tests. The native checkout now tracks main with the identical file tree; the finished feature branch was deleted after ancestry proof. No runtime restart or installed Puppy acceptance is claimed |

The accepted application preserves earlier Hosting/AI/cleanup and provider-correct
model routing. It fixes the Puppy picker’s 12-second presentation deadline versus
the desktop’s 15-second activation poll: cached choices remain usable while one
bounded foreground readiness request continues. Owner/view changes cancel stale
observation; no inference, new grant or artificial keepalive is added.

UAT’s earlier failed promotion returned HTTP 200 after 19.2 seconds, beyond the
operator’s 15-second deadline. The merged repair permits two bounded 30-second
read-only attempts; disabled or malformed capabilities still refuse promotion.
A later peer rollout accepted the prior application; the original failure remains
historical evidence. Workflow head, selected application and installed pod are
separate identities. Peer main through `dcc4f611e3`, including Azure-search, public-source research
and lost-vault changes, is inherited on the preserved branch. Those later changes
are not claimed as part of UAT’s `ca83c0bf5a` acceptance. The local ADK branch remains preserved; the former checkout is absent.

The combined local core passed in 783 seconds: 25,018 backend tests, 143 skips,
and frontend/security/governance/MCP/integration checks. Exact-head hosted
Protocol completed in 28m15s. The accepted dev rollout took 20m20s, including
497 seconds for backend/image construction and 114 seconds for frontend build.
These are individual observations, not completion-time guarantees.

Synthetic recovery from predecessor `8b846022…68ac07` to Dev29 passed on both
clouds, preserving identity, records, Files and 15 encrypted objects. Disposable
services/resource groups, vault and temporary images were removed and read back;
GCP’s seven-day object soft-delete retention is reported separately. These are
format-recovery receipts, not normal startup, active-work drain or Browser proof.
Other predecessors remain unqualified. An approved offer and normal owner
installation are still required. Installed Browser and full Puppy inference
are not established by application deployment. Production, stable publication
and automatic owner upgrades remain held.

### Current account-specific findings

- Both named Azure placements must use their pod's actual connection; the Chat
  picker previously read Shared's Gemini catalog. The merged, dev-serving repair uses admitted
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
  95-second broker prefill but cancels the outer ADK wait at 70 seconds. The
  merged correction gives ADK 100-second event waits while retaining the 150-second total
  turn and existing inner deadlines. The timeout-ladder negative control catches
  the old inversion. It still requires a new, owner-approved pod image and live
  answer acceptance; a healthy socket alone does not prove inference.
- The merged, dev-serving frontend repair adds a coalesced foreground Chat wake and a bounded
  readiness read on entering/returning to Puppy. Hidden tabs do not wake compute;
  readiness never requests inference or enables a new grant. Owner-generation
  fences retire cached device/model responses and prevent late model writes.
- A second Puppy regression is reproduced: a 12-second model-list UI deadline
  could expire before the desktop's 15-second activation poll. The merged source keeps
  one bounded foreground connection attempt running after the presentation timer,
  retains cached choices and updates the same menu when readiness arrives.
  Hiding the view or changing owner cancels observation, not a previously
  persisted activation. This does not start inference or preserve cloud uptime.
- [Hermes PR #23](https://github.com/hushh-labs/hussh-one-hermes/pull/23) adds
  profile-owned, opt-in relay startup through its existing gateway supervisor.
  Focused tests cover separate-process contention and cancellation during a
  blocked admission request, including repeated cancellation and delayed cleanup.
  The existing dev profile and relay remain running; no live startup handoff is
  claimed from source tests or a heartbeat.
- Normal owner acceptance on dev proved Hosting → unsaved AI edit → Back →
  re-entry preserves the verified cloud selection, and Finish returns to Hosting
  with the vault unlocked. The cloud-removal review fits the viewport; no removal
  was started. One returned the exact synthetic `private-ready` answer. Puppy's
  last-known Gemma label is visible, but fresh model-list and inference acceptance
  are unclaimed: the background tab correctly suppresses foreground-only reads.
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

The combined PR #8395 candidate passed its local core in 12m58s: 25,003 backend
cases passed with 143 skips, alongside frontend build/type/lint, security,
governance, MCP and integration. Its [exact-head hosted run 40017478921](https://github.com/hushh-labs/hushh-research/actions/runs/40017478921)
passed all 26 jobs, followed by landed-SHA smoke. The collector correction passed
152 focused cases, an original-refused/corrected-verified check against the real
immutable Cloud Build, and a local core in 12m56s with 25,005 backend passes and
143 skips. Peer PR #8398 landed the equivalent correction with stronger missing-
dependency negatives; 185 combined cases passed after reconciliation. These layers
do not substitute for deployed owner acceptance.

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

GitHub's refreshed inventory has **three open dependency alerts**: two
OpenTelemetry records and Zod alert #507. Seven patched alerts are closed, with
none manually dismissed. The pinned ADK cap excludes the
fixed version. Incoming vendor `tracestate` is ignored at the public propagator
boundary while preserving traceparent/outbound context. This is mitigation, not
upstream remediation. The protected worker accepts verified pending concurrency
states without weakening exact repository/workflow/run/attempt/SHA binding. Its
receipt cannot replace successful PR validation. Repository-secret removal is
verified; original-token revocation remains separately unverified.

AG-UI's nested Zod 3 remains affected even though root Zod 4 is patched. A forced
major override is incompatible with the current SDK contracts. No compatible
published dependency-only fix was found. Local pre-parser byte/depth/collection
and SSE-frame bounds passed their affected SDK-consumer checks; this is a
mitigation awaiting candidate deployment, not an upstream fix or a reason to
dismiss the alert.

Earlier accepted application receipts remain historical evidence:
[PR #8365](https://github.com/hushh-labs/hushh-research/pull/8365) and
[PR #8377](https://github.com/hushh-labs/hushh-research/pull/8377). The
[normal-release plan](../../future/personal-agent/NORMAL-RELEASE-TRANSITION.md)
and [deletion runbook](../operations/account-deletion-rollout.md#remove-cloud-while-keeping-the-account)
own the operating procedures and retained acceptance gates.


## What works / what must change

| Journey | Recorded outcome | Remaining acceptance |
| --- | --- | --- |
| Hosting / AI | Provider-aware onboarding and encrypted custom-key choices deployed; Azure owner chat completed; approved dev Gemini bridge returned 200 | Complete the GCP owner journey through its configured bridge. Organization-level native Vertex denial is expected; more IAM grants are not its remedy |
| Files | Dedicated specialist/explorer; personal and fresh Shared Move, exact download and Undo; earlier interrupted 4,195,328-byte transfer and selected analysis passed | Current-image organization, fresh setup and retained Shared erasure |
| Updates | Azure Dev 28: normal Browser setup approval and Microsoft handoff, one verified operation and exact installed digest; both predecessor recovery fixtures pass | Active-work overlap remains unproven; finish GCP installation and current-image continuity/Feed checks |
| Puppy | Existing Hermes identity, signed binding, sealed WSS and streamed Gemma 12B; prior Stop, withdrawal/refusal and re-enable passed | Repeat affected paths only. Phone testing waived; independent-network acceptance is unclaimed |
| Browser | Immutable-image native research passes on both clouds. The deployed 971/replay repair clears Azure's initial review failure; a fresh task accepted screen-processing consent and active takeover, then failed Phone resize before initialization | The repair is in the published Dev29 image; finish exact execution qualification, the approved offer and the installed journey. Hidden owner tabs intentionally do not paint frames. Additional interactive policy and GCP acceptance remain unverified |
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
   PR #8395 is on main and dev acceptance includes owner Back/Finish, removal
   review and an actual One answer. The later dated serving receipt above covers
   dev/UAT `e4840d1915`; complete the surgical follow-up's own candidate validation
   and acceptance before replacing that evidence.
2. **Security owner:** the refreshed research-repository inventory has 15 open
   records at 12:07 UTC on 24 October (4 high, 5 medium, 6 low); local compatible
   patches cover 12, with two ADK-constrained OTEL
   records and nested Zod remaining tracked. Earlier closed alerts are historical
   evidence, not clearance for this inventory. Original-token revocation remains
   separately unverified; the exposed repository secret is retired. The native
   Hermes fork's 314 records are a separate inventory.
3. **Browser owner:** exact installed-image public research, review, preview,
   takeover, resume, reconnect and Stop remain separate acceptance on each cloud.
   Keep unqualified capabilities unavailable; no expanded feature work blocks this correction.

Reuse unchanged Puppy evidence: 320 Chromium/WebKit responsive cases, shared
760 px ribbon/composer, 0 px edge discrepancy, 44 px controls and no overflow.
Do not rerun it for backend/doc-only changes.

Earlier main integration and landed-SHA smoke were verified through `9af321d2a9`.
The current serving application is `2732b301cc9e`, as dated above. The local
surgical candidate has not landed or deployed; its own main/dev/UAT validation
and installed-owner acceptance remain required. Earlier provenance, schema,
semantic and owner Back/Finish receipts do not replace those checks. Production, stable publication,
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
