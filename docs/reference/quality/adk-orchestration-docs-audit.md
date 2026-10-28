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


## Current decision — 26 October 2026, 09:25 UTC

**The application correction is accepted on Dev and UAT. Both clouds pass the new
Browser image's component and encrypted-recovery checks. Installed-owner Browser
acceptance and safe account-generation rollout remain open.**

[PR #8468](https://github.com/hushh-labs/hushh-research/pull/8468) landed as
`7d5546e471` after the local core, exact hosted CI and landed smoke. Its Dev
[release](https://github.com/hushh-labs/hushh-research/actions/runs/40258969686)
and UAT [release](https://github.com/hushh-labs/hushh-research/actions/runs/40263257564)
passed. Peer phone-transfer changes from main are preserved; Dev now serves
`c0bf05df4f` on both environments. The later UAT
[release](https://github.com/hushh-labs/hushh-research/actions/runs/40264162428)
passed; actual serving revisions and digests were read back. No production change
or new Browser installation is claimed.

The next checkpoint is [PR #8473](https://github.com/hushh-labs/hushh-research/pull/8473).
Its combined `82aef94b9a` local core passed in 64m16s, and exact hosted
[CI](https://github.com/hushh-labs/hushh-research/actions/runs/40294784031)
passed. Integration now completes in 5m40s after correcting the preferred Ubuntu
mirror; the prior attempt exhausted its 20-minute budget. Both browser engines
and all security/lifecycle gates remain enabled.

A concurrent main release introduced financial migration 426 during validation.
The unshipped WorkOS migration moves to 427; main's financial SQL and the WorkOS
SQL bodies remain byte-identical. The normal merge preserves both implementations.
Combined replay and generation tests, regenerated contracts and a new exact-head
hosted result are required before Admin landing. This candidate is not deployed.

Read-only provider evidence now confirms no Directory Sync connections in the
WorkOS environment whose webhook secret matches UAT. The local continuation removes
the blanket WorkOS generation-activation refusal, retaining original-generation
capture, replacement-SSO refusal and the separate HushhTech guard. Real isolated
Firebase transport passed created/linked cases with one mutation POST each and
verified test-identity cleanup. Directory Sync is not configured or qualified;
historical unknown events still refuse safely. Public generation activation still
requires installed migrations, drained old consumers and deployed normal-provider
acceptance. Production Firebase identities were not mutated.

| Boundary | Verified outcome | Remaining acceptance |
|---|---|---|
| Application | Dev backend `00252-cfk` / frontend `00216-vl7`; UAT backend `02591-zod` / frontend `02172-s4l`; both source `c0bf05df4f`, 100% traffic | Next combined lifecycle candidate retains its own acceptance |
| Browser image | Genuine source `7d5546e471`, digest `09d4ce51…d5deea`; controlled native execution passes on Cloud Run and Container Apps | Publish qualified compatibility metadata and install through exact owner approval |
| Browser component | Both clouds pass research, responsive control, zero model observations during manual login, encrypted remember/restore, logout, Forget, one reviewed save and joined Stop | Actual owner HTTP takeover, reconnect and signed-in journeys; GitHub and broader sites remain unqualified |
| Encrypted recovery | GCP predecessor `26bab163…061809` and Azure predecessor `6e57f251…eeac423` preserve identity, six records, consent, revocation and 245,763 exact file bytes on the new image | Installed active-work drain and recovery |
| Installed owners | Azure Dev 30 update and Puppy/Gemma 12B response passed. GCP's original approved Dev 30/Files update now verifies image `6e57f251…eeac423` through its existing operation | Browser task reconciliation, active-work acceptance and current-image Files organization |
| Fixed-term sharing | Temporary 97/1711 sandbox admission verified. Original 54/1711 secret and runtime restored through successful governed rollout, with both owner readbacks | Account 97 has zero funded balance and no funding lots; no purchase/funding was attempted. Request/access/revocation acceptance remains open |
| Account generations | Isolated real-mail two-cycle proof preserves Firebase UID and refuses retired sessions | Public admission remains off; WorkOS membership/journal hardening, current legacy inventory and isolated provider transport have evidence; installed migration/drain and ordinary-provider acceptance remain open |
| Cleanup | Browser qualification compute, temporary inference role, copied images and both recovery fixtures removed with provider absence receipts | Disposable Cloudflare site awaits connector reconnection for deletion; synthetic state only, with serving expiry |

The stranded GCP update completed through its original approval and operation,
with one conditional configuration replacement and normal provider acknowledgement
reconciliation. Its completed queue and IAM work was not repeated; the lease was
not manually cleared. A prior attempt refused a changed runtime epoch before
reservation or dispatch. All repair/observation jobs were removed after terminal
provider results. This settles that image/Files update, not Browser activation.

The next local candidate also closes the WorkOS email-based callback gap:
verified exchange captures immutable directory attribution, delayed work retains its
original generation, and provider writes use the existing dispatch/settlement journal.
Held membership/profile tokens cannot reopen an offboarded work session. SSO-only
organizations retain a bounded empty-directory path. Migration 427 is forward-only;
these changes are not deployed or permission to activate public re-registration.
The [SSO reference](../architecture/enterprise-sso-workos-adr.md) records legacy
coverage and provider qualification still required.

A separate local CI correction checks a parallel frontend build once before
lifecycle migration. Known terminal failure blocks the release without rolling back
healthy services; pending builds retain the final immutable-image join. Its executable
negative control reproduces unnecessary rollback flags in all three former classifiers.
This improvement is verified locally and has not run on the hosted deployment path.

The frontend heap correction is verified on the real build host: Cloud Build
`bc9973e1-e96a-44e0-88cc-9ab76c0528f9` passed TypeScript and 188 prerendered pages
in approximately 5m44s. The builder permits 4 GiB of old-space; its worker bounds
and the runtime image remain unchanged. The preceding failed build took 12m50s
to be noticed after termination. Earlier failure detection is a measured CI
improvement opportunity, not permission to remove deployment gates.

Qualification remains bound to the exact image, host, Chromium mode and model
transport. GCP used Gemini 3.7 Flash; Azure used the owner's verified
`one-chat` GPT-5.6 Luna deployment. The qualification fixture and synthetic
approvals do not establish a real owner journey. New peer pod-source changes
must not be relabelled as part of this already qualified image.

### Earlier correction evidence

The canonical UAT reviewer has an explicit Shared choice, no pod registry row and
no pending cloud job. Metadata-only headless verification of the older serving
application unlocked and rendered Finance; it does not qualify the failed candidate.
A deterministic same-account pending-to-validated regression fails on the prior source:
Finance placement can retain an early refusal after authentication recovers. The
correction in [PR #8464](https://github.com/hushh-labs/hushh-research/pull/8464)
rechecks the validated UID, owner and account generation; all 34
nearest cases, TypeScript, lint and UI contracts pass. Private routing remains
fail closed. The later UAT application receipt passed; it does not establish the
precise cause of each earlier failure. Do not silently change the fixture's placement.

Peer [PR #8463](https://github.com/hushh-labs/hushh-research/pull/8463)
landed as `7266b4d2e9` while the local correction was being verified. Its reviewed
bootstrap implementation is inherited; the duplicate local implementation is
retired. The combined integration run found an obsolete duplicate vault mock in
the Account recovery test; removing that duplicate preserves the real recovery
assertions. All 38 owning bootstrap, analytics and recovery cases pass.

The reviewer vault bootstrap could start before authentication settled and ignore
a refused unlock callback, then falsely publish `vault_unlocked`. The vault itself
remained sealed. The correction waits for the verified application owner, fences
stale work and reports success only from the unlocked context. The original
source fails the focused web/native regression. This explains a possible false
acceptance prerequisite; it does not yet prove the deployed UAT failure resolved
or explain the separate ordinary-owner session hold. A green continue-on-error
workflow step is not a successful acceptance receipt.

The pod publication retained image source `9174abfbe5` despite changed Browser
control and dispatch modules. Archive provenance exposed the mismatch before any
new owner installation. The corrective release removes that pin, retires the
old image's active Browser qualification/compatibility offer, and adds a
pre-upload source comparison; its focused regression refuses changed image inputs
while preserving metadata-only reuse. A successful application rollout does not
establish that a private pod received its new executable.

Before the repair, a read-only GCP observation confirmed the original service UID, old image,
generation 21, Ready state and 100% old-revision traffic without the approved
attempt nonce. The temporary observer exited and was deleted. That historical observation did not
prove where the original exception occurred or authorize replay; the later conditional
repair and actual installed-image acknowledgement are recorded above.

Audit logs identified missing read/act-as access on the existing cleanup identity.
The scoped repair and separate Scheduler/log-read permissions allowed activation:
a fresh authenticated worker invocation returned HTTP 200, 98 legacy shared-backend
revisions were retired, and fence removal was confirmed. This is shared-backend
release evidence, not deletion of customer pods.

Peer [PR #8461](https://github.com/hushh-labs/hushh-research/pull/8461) supplies
qualified GCS session-expiry recovery. The separate authorized canonical cleanup
removed seven retained fixture object generations and preserved account/vault rows.
Generic missing resources remain uncertain; restored session custody and original
bucket incarnation qualify the provider's expiry response. The peer fix is retained
through a normal merge, without replacing authored files.

The installed Azure Browser attempt became uncertain during takeover; no
credentials or forms were submitted and the goal was not replayed. Sampled memory
peaked near 833 MiB of 2 GiB with no container restart. This does not establish
OOM absence or justify increasing capacity. The control fix settles validated
execution before rechecking observation permission, without replaying effects or
clearing genuinely uncertain outcomes.

One and Browser share the non-root owner container. GCP retains Chromium's
sandbox; Azure explicitly disables it. Application policy does not contain a
compromised process. Exact qualification covers the controlled HTTPS fixture,
whose earlier instance was deleted with resource-absence readback. Its replacement
passes eight HTTPS fixture controls; installed acceptance and final cleanup remain
required. Authenticated GitHub, selected PKM disclosure and
Browser-to-Files retain separate gates. No production, stable publication or
automatic owner upgrade is authorized.

Two-owner information sharing acceptance covers the existing **fixed-term** flow:
request, exact review, selected encrypted access and revocation/expiry. It does
not add automatic renewal. Paid Sandbox admission for the intended pair is a
separate configuration decision; free readiness does not establish paid access.

The deployed GCP and Azure owner setup checks now preserve the Hosting return
path, expose Finish for the saved connection and return there after finishing.
Azure identifies its existing cloud connection as Azure AI. No owner placement
or model selection was changed for these navigation checks.

Interactive qualification found a new redirect defect after a separate fixture
referrer-policy correction: the login POST succeeds, but its redirected request
can arrive after the executor closes the action scope. The local repair joins
explicit Chromium redirect chains under their original authority, refuses unknown
parents and waits for the final document before returning a frame. The 83 nearest
cases pass; the delayed-redirect regression fails against deployed source. Pinned
local Chromium also passes manual login, observation suppression, encrypted
remembering, new-task restoration, logout rejection, Forget, one reviewed save
and Stop. These are **local driver receipts**, not cloud qualification or installed
owner acceptance; the corrected immutable image still needs that evidence.

### PR #8437 verification history

The following receipts describe the preceding repair sequence; they do not
replace the dated current decision or establish installed-owner acceptance.

[PR #8437](https://github.com/hushh-labs/hushh-research/pull/8437) carries this
correction. Its first hosted run found stale application-owner test admission,
a genuine unresolved-identity avatar crash, and missing pgvector in the native
migration-test installation. The repair keeps generation admission explicit,
guards the avatar read and provisions the matching PostgreSQL prerequisite;
it does not skip migration 033 or weaken owner checks. The original crash fails
the new regression when restored. All 21 affected web files have passing focused
evidence across the repair runs; TypeScript and changed-source lint pass.
Chromium and WebKit connector fixtures pass six cases each. The RCA command now
observes existing hosted CI by default; exact-head/current-attempt clearance
remains mandatory, and a local full suite requires explicit execution. Its 58
focused tests pass. These repairs still require the finished candidate's hosted
validation and deployment; no serving or installed-owner claim follows.

Hosted run [40152110805](https://github.com/hushh-labs/hushh-research/actions/runs/40152110805)
finished unsuccessfully after 33 minutes 29 seconds. Two serial browser packs
reached their 30-minute job bound after unmet fixture admission; the runner did
not spend that time provisioning an owner cloud. Corrected Connections tests
completed 130 cases in 1.9 minutes; all eight keyboard cases subsequently passed
after establishing keyboard modality explicitly in WebKit. The actual null-crash
repair and generation fences remain unchanged. Eighteen Drive request/question
cases pass across both engines. Current AI selection passes 16 responsive cases
plus eight reduced-viewport checks; retired artwork and unavailable-provider
assertions were replaced with the current provider selection/validation contract.
These are synthetic interface checks, not cloud or native-keyboard acceptance.

The follow-up run [40155958370](https://github.com/hushh-labs/hushh-research/actions/runs/40155958370)
finished after **30 minutes 32 seconds**: 22 jobs passed, including backend,
all three full frontend shards, Web Core, both native builds, security and
governance. Its three failing browser shards contained 15 vault/deletion cases
whose synthetic fixtures did not establish the current application principal.
The real admission guard remains unchanged. Those fixtures now publish the exact
synthetic generation-0 principal or consume the complete session response.
Focused proof passes 28 vault cases, four additional recovery/provider-layout
cases, 12 deletion outcomes and both-engine sign-out; two shared-port reuse cases
also pass. These are synthetic provider outcomes, not live cloud cleanup.

Backend passed 23,685 parallel cases in 686.13 seconds and 1,777 shared-database
cases in 760.62 seconds, with the existing 143 skips. The serial phase preserves
isolation against documented PostgreSQL catalog races. iOS completed in 24 minutes
6 seconds, overlapping backend. The pending repaired candidate reuses unchanged application/core evidence and
still requires its own hosted clearance before release. A measured scanner hot
path now prefilters exact literals per file while retaining every regex, AST check
and allowlist. On the same tracked checkout, it completed in 8.325 seconds versus
81.864 seconds, with identical output and zero findings; all 32 nearest runtime
settings cases pass, including ordered violations and boundary near-misses. This
is local scanner evidence, not a claim that total hosted CI is ten times faster.
Task-owned layout bundles were removed after verification; peer processes and
user-level tool installations remain untouched.

Run [40158496907](https://github.com/hushh-labs/hushh-research/actions/runs/40158496907)
then passed all 24 non-backend jobs, including all four browser shards, before the
backend step reached its 32-minute limit. Its parallel phase passed 23,685 cases
in 967.16 seconds; no test failure was reported before the following serial phase
timed out. The source correction runs these existing phases in separate jobs,
each with its own PostgreSQL service, and requires both in the aggregate. Local
standalone execution remains complete by default. All 99 nearest gate/path cases
and four actual runner-fixture cases pass. This is source/focused evidence; the
combined candidate still needs hosted clearance.

Concurrent main [PR #8441](https://github.com/hushh-labs/hushh-research/pull/8441)
is preserved through merge `361bef3229`: its phone-field alignment and shorter
confirmation copy coexist with the lifecycle guards. The combined preview passed
77 focused cases and four Chromium/WebKit phone/deletion cases. Canonical Back
checks passed all 501 cases; combined Back/Search review receipts are regenerated.
No broad source replacement or owner installation occurred.

Main then advanced through [PR #8442](https://github.com/hushh-labs/hushh-research/pull/8442)
to `ac37448c00` while the final push was running. Hosted run 40162104720
correctly refused a stale combined Back receipt before expensive dependent
suites. Merge `83ea60dc2b` preserves the incoming finance behavior and the
shared API wrapper's lifecycle fences. The combined tree passes 168 frontend
cases and 79 affected backend cases; no migration changed. All 501 Back cases pass and combined Back/Search receipts are regenerated.
That candidate’s [run 40162519198](https://github.com/hushh-labs/hushh-research/actions/runs/40162519198)
passed all 27 jobs. Its two backend phases overlapped and completed in 10m36s,
with 25,468 passes and 143 skips. This does not establish the later combined candidate.

The final Admin preflight then refused main drift: [PR #8440](https://github.com/hushh-labs/hushh-research/pull/8440)
added immutable migration 417 and financial-summary behavior. The integration
preserves it and moves only the unapplied lifecycle chain to 418–421. Both
canonical 417 and retained dev 972 rehearsals, plus affected Drive PostgreSQL cases,
pass 49 cases. Two replacement-generation packet regressions fail before the fix;
proper Firebase/application-principal separation then passes 144 nearby frontend
cases. All 501 Back cases pass. Combined generated contracts and fresh exact-head
hosted validation are required before landing.

Main `3895a3d902` is now preserved through merge `fd67dcd5c9`, including its approved
PWM lead policy and privacy-safe probe diagnostics. Its 99 affected backend cases
pass. The retained ADK branch is unchanged at `48140fcd70`. The task-owned HTTPS
Browser fixture has been removed with verified Worker/subdomain absence; its
earlier HTTP controls do not certify installed Browser execution.

At 03:43 UTC on 25 October, read-only corporate ADC inspection found both dev
and UAT backend/frontend services serving main `3895a3d902` at 100% traffic.
That concurrent governed rollout is preserved; it does not contain this branch's
surgical correction. The earlier 01:38 UTC configuration inspection found
`PERSONAL_AGENT_ENABLED=true` in dev and absent in UAT. Twelve hours of bounded request logs contained five UAT
`/byoc/authorize/begin` responses with HTTP 503, while setup-status and suggestion
reads succeeded. No matching dev requests appeared in that bounded window; this
does not establish dev onboarding success or the cause of a separate dev failure.

The local repair consumes the existing status capability before offering cloud
authorization, preserves assignments and pending work, keeps Shared selectable,
and explains the known environment refusal without transient retry advice. It
also fences attach/direct-ingress retries when the surface is paused. UAT needs
explicit non-stable pod publication, owner-cloud identities, qualified custody
and lifecycle configuration before BYOC can be enabled. Copying dev's simulation
block or changing only the master flag is not an acceptable rollout.

Main `b2ee968a59ab` is preserved through merge `c1861b4ae2`, including its parallel
UAT frontend handoff and stronger SQL proof. The new SQL tests exposed admission
resetting erasure's statement timeout; the repair restores the erasure budget
before destructive batches. All five real PostgreSQL cases passed in 2.51 seconds.
The preceding candidate passed web-core in 144.85 seconds and governance in 134.6
seconds; changed-surface checks follow the additional repair. These are local
results, not exact-candidate hosted or serving acceptance.

`.agents` and root `AGENTS.md` are the single authored development framework.
Repository vendor discovery directories, adapters, startup hooks and generated
host fleets have been removed. User-level tool installations, the external shared
handoff and peer edits remain preserved.

Main’s later financial-packet change owns migration 416. The unapplied lifecycle
chain is now 418–421, preserving main’s additional financial-summary migration 417;
its canonical successor marker is `/420`. Historical
measurements below retain their original numbering. Both canonical-416 and rich-dev-972 retained-state upgrades passed on the new
chain in 94.68 seconds. Main’s affected backend cases passed86 tests and its
packet interface passed35 tests; these do not replace hosted validation.

Read-only live catalog inspection at 01:43 UTC found 22 dev and 413 UAT
account-deletion records. Neither serving table yet has the new durable
provider-operation/identity-hash fields or account-generation authority. These
counts do not prove external cleanup or identify currently affected people.
Historical recovery must reconcile retained evidence; missing records cannot be
converted into confirmed provider revocation. Both task-owned SQL proxies exited
and their downloaded executable was removed after the read.

### Earlier local evidence (historical checkpoints)

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
API/auth/UI continuity. The forward chain is registered locally but remains unapplied;
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
passed. Migration 417 now journals remote identity writes and blocks replacement
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

Cloud-only removal now has a draft forward recovery contract (419): approval,
execution admission and unapproved cancellation serialize on the existing owner
locks. Cancellation restores only the exact inert snapshot and retains history;
the legacy restoration and deprovision paths cannot bypass the review. Azure
checks dispatch before owner-access destruction and at SQL worker admission;
GCP carries the captured attempt. The affected backend suite passed 212 cases,
including real PostgreSQL cancellation/approval concurrency; the cleanup interface
passed 14 cases. Forward migrations 416–419 are now registered locally with
matching exact production/UAT and minimum-dev contracts; they remain unapplied.
Canonical 418 adopts the final private-agent schema from the accepted dev lineage,
without replaying historical Shared inference or destructive chat cutover. Recovery
is 419; applied parked SQL and checksums remain unchanged. The nine-case PostgreSQL
suite passed in 86.30 seconds, including canonical-411 and rich-dev-972 upgrades,
retained credential/review/resource state, non-owner backend permissions, client
refusal, unknown authority-object refusal and forward-only rollback. The 206-case
migration/binding/dev-lane/data-model slice passed. These are local PostgreSQL 14.21
results, not hosted PostgreSQL 16, provider removal or installed acceptance.
The strengthened 82-case replay/authority suite passed in 92.34 seconds, including
retained consent/referral records and the historical-replay negative controls.
Actual release-contract catalog checks passed for production, dev and UAT against
both disposable schema lineages. After fresh main claimed 412–415 for recovery
indexes, this unapplied chain moved to 416–419; both cases passed again in 86.03
seconds. Main integration and final combined qualification remain. Activation stays off.

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

Browser startup/viewport repair is in source, but the final installed owner journey
remains unqualified. Research, preview, takeover, handback, reconnect and Stop must
pass on each exact installed image. Login, remembered sessions, selected PKM and
Files transfers retain separate acceptance. The 30-second cold target is an
optimization goal; economy hosting and owner-selected configurations remain.

Same-login re-registration remains staged: shared Firebase identifiers do not
authorize clearing terminal account tombstones or mutating production identity
from dev/UAT. Preserve the existing UID/vault/device/pod bindings and qualify the
explicit lifecycle before promising a fresh start.

## Security

At 07:48 UTC on 25 October, GitHub reports **3 open dependency alerts**
(1 high and 2 moderate), down from 15 after PR #8437 landed. These are the
constrained Zod record and two OpenTelemetry manifest records; no alerts were
dismissed to obtain this reduction. The rolling seven-day inventory records
**177 fixed alert records**, representing 111 distinct advisories and 85 CVEs
across the repository; this is not attribution to one agent. The standalone
mail deployment still requires independent serving evidence. Exact-candidate
secret scanning finds no leaks and zero open secret-scanning alerts. Source
landing and inventory clearance do not establish deployed acceptance.

The remaining constrained OpenTelemetry and Zod findings retain explicit
mitigations. The pinned ADK cap excludes the fixed telemetry version. Incoming
vendor `tracestate` is ignored at the public propagator boundary while preserving
traceparent/outbound context; this is mitigation, not upstream remediation. The
protected worker preserves exact repository/workflow/run/attempt/SHA binding and
cannot replace successful PR validation. Repository-secret removal was verified;
original-token revocation remains separately unverified.

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
