# Private-pod readiness: CTO decision memo

## Decision — 2026-10-22 UTC

**Dev publication and Azure installation verified; hold main promotion.**
Azure Dev 28 completed its normal owner-approved update with the expected digest
and unchanged economy configuration. Its first Browser task reached the pod but
failed before review: live action-ledger CHECKs exclude `pod_chat` despite matching
parked migration receipts. The forward repair and protected canonical replay pass
57 focused checks locally; they are not deployed. GCP's genuine legacy inventory
needs creation-evidence reconciliation. Installed Browser, capacity, remaining
core lifecycle and retained Shared erasure are still acceptance gates.

The [public-research MVP](../../future/personal-agent/browser-completion-plan.md#immediate-mvp--critical-path-first)
is P0: ask One, review, browse, take control, resume, reconnect and stop. Login,
remembered sessions, private-context disclosure and transfers follow that proof.
The 30-second cold target is an optimization goal. Economy hosting stays selected.

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
| Browser | Immutable-image native research passes on both clouds. Azure owner configuration is installed; One created a real task, which stopped with `BROWSER_REVIEW_UNAVAILABLE` before launch | Apply the tested dev-only 971/replay correction, then prove owner review, active takeover, reconnect and Stop. GCP legacy inventory remains a prerequisite |
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
The local follow-up projects the effective managed processor into an opt-in
response field and renders matching disclosure, preserving old strict clients and
historical receipts. Source review, 25 backend cases and 37 frontend cases pass;
one existing PostgreSQL case is unperformed in that local run. It is not pushed
over the frozen release candidate and does not replace the qualified pod image.

### Retained Shared deletion

The synthetic account, vault and original library remain fenced after
`409 FILES_ERASURE_WAITING_FOR_WRITES`. Exact-session status and cancellation return
412; retained bytes differ from the expected write. An isolated synthetic final-PUT
precondition failure reproduces that latched response. A documented malformed-range
abort also returns 412, so neither establishes termination. The original write
fence and objects remain intact. No SQL override, direct provider deletion or
blind retry is permitted. Its earlier
32 KiB upload/Move/download/Undo used operator authentication/phone fixtures, not
ordinary Google/CAPTCHA/SMS onboarding. The old RAM-only passphrase is gone;
subsequent cleanup must not be described as normal unlocked-UI vault recovery.

## Source and serving evidence

The C2 application and immutable Dev 28 offer are deployed. Publishing and owner
installation remain separate; Azure has completed its approval, while GCP has not.

| Surface | Exact receipt | Boundary |
| --- | --- | --- |
| Dev app | `f055c05948`; hub `00189-j24` / `c4f0f7b49557`; web `00157-9sx` / `40048a2a1785`; both 100% | [26/26 CI](https://github.com/hushh-labs/hushh-research/actions/runs/39703303543) and [governed rollout](https://github.com/hushh-labs/hushh-research/actions/runs/39706459253) succeeded. ADC serving readback: 22 October, 01:57 UTC |
| Azure owner pod | Dev 28; digest `8b846022…68ac07`; revision `ca-hussh-one-pod--u31257e45d565` | Normal approval `op_13e165d0d1bf4a6788ae230cc7e2a93f`, verified 02:22:22 UTC. Same service identity, 1 vCPU / 2 GiB, min 0 / max 1. Active-work drain overlap is not established |
| Schema / rollback | 68 accepted dev checksums match; standard shape checks pass. Actual ledger channel/session CHECKs exclude private reviews | Ledger parity did not detect semantic drift. Local 971 plus pinned 212/231/248 replay repair addresses it; no applied SQL changed. Ready rollback targets: hub `00188-lrc`, web `00156-p2n`. History cleanup remains separate |
| Local integration | `cd7556e9a7` includes main `c241cfe554`, frozen ADK `914e7c044c` and opt-in provider disclosure `2bbbec2f52` | Unpushed. Nine peer edits and active ADK remain preserved; the subsequent migration repair is local |
| Published pod offer | Dev 28 reuses image `sha256:8b846022947bca939fba48cddf1101f3c26dddfb043ab41e20bd7407e068ac07`, source `67a64533ac6a` | Both exact personal predecessors recovered identity, six sealed records, consent/PKM state and 245,763 exact file bytes. Temporary resources cleaned; GCP seven-day soft-delete retention preserved |
| GCP configuration / inventory | Revision `00018-jrz`, predecessor `26bab163…61809`, 1 vCPU / 2 GiB / concurrency 8 | Prior authenticated maintenance/recovery passed. Legacy receipt lacks typed creation inventory. Owner CLI readback verifies current bucket/key and historical creation events; reconciliation is not committed or applied |
| Browser component evidence | GCP Gemini 3.8: 20.366 s / three rounds; Azure actual `one-chat` GPT-5.6 Luna: 16.823 s / five rounds | Real frames, native continuations, 390 × 844 resize, login-observation fencing and joined Stop. Component takeover followed model completion. These are not installed-owner, cold or full-pod capacity results |

### Current local implementation

Main through `c241cfe554` and ADK `914e7c044c` are reconciled without whole-file
overrides. The effective-provider disclosure follow-up preserves old strict clients
and historical receipts: 25 backend and 37 frontend checks pass, with one existing
PostgreSQL case unperformed in that run. It remains local.

The installed Azure Browser task `browser_30ef3daedbef437c9a16d3aa500ba479`
failed at the initial model-processing review. Hub logs show HTTP 503; read-only
constraint inspection reproduces the cause. Canonical base SQL replays each dev
deploy while applied parked SQL is skipped. Forward dev-only 971 repairs the
channel checks; checksum-pinned replay adapters retain the exact validated successor
and execute unrelated document/ADK DDL. Real PostgreSQL tests reproduce the original
refusal, preserve a real review through two replays, reject malformed successors,
and prove rollback refuses retained history. Fifty-seven focused checks pass.
No live schema repair or replacement pod image is claimed.

The qualified public policy permits Python documentation only. Login, submissions,
selected PKM production and Files downloads need their own policy/owner acceptance.
The exact pod-recipient PKM consumer exists; its normal owner-approved producer is
unfinished. Never substitute a broad replica or handcrafted grant.

The earlier full core and C2 hosted receipts remain valid for their frozen inputs.
The completed next source batch still requires one core mirror, exact-SHA hosted
validation and governed dev rollout. Original fixture failures remain retained.
The dev Gemini bridge is explicit; the owner configuration and serving checks are
separate from Shared AI policy. No new model sweep is required.

## Performance and economics


| Measurement | Result | Decision |
| --- | --- | --- |
| Delivery cycle | C2 CI 31.9 min; governed rollout approximately 21.7 min | Parallel critical paths: Browser 28.47, Python 26.83, iOS 26.02 min. CI plus rollout is 53.6 min, before local verification and owner acceptance; do not sum parallel jobs |
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

1. **Engineering — Browser P0:** finish local replay-repair verification, then
   exact-SHA CI/dev and installed Azure task review/takeover/reconnect/Stop. Repair
   GCP inventory through a guarded, evidence-backed owner lifecycle before setup.
2. **Engineering + Operations:** finish current-image Files organization, supported
   connector/voice continuity, capacity and retained erasure. Reuse unchanged
   Puppy evidence and historical latency; no model sweep or artificial keepalive.
3. **Release owner:** record each installed journey separately, then conditional
   Admin SOP main merge and landed-SHA smoke/dev receipt. A green ledger, health
   response or qualified component cannot substitute for the owner journey.

Reuse unchanged Puppy evidence: 320 Chromium/WebKit responsive cases, shared
760 px ribbon/composer, 0 px edge discrepancy, 44 px controls and no overflow.
Do not rerun it for backend/doc-only changes.

[Application PR #7555](https://github.com/hushh-labs/hushh-research/pull/7555) remains
draft. Main merge is authorized only after installed Browser/core acceptance and
Admin SOP gates; the landed SHA needs its own smoke and dev receipt. UAT/production
rollout, stable publication and automatic owner upgrades remain unauthorized. Managed Hussh provisioning and unqualified hosting
moves remain unavailable. Production additionally needs migration/channel
qualification, IAM, erasure/recovery, hub capacity and independent UAT acceptance.

## Reviewed integration debt


Historical anchor: the [architecture baseline](./architecture-fitness-baseline.json)
owns reviewed spans, hashes and negative controls. The 2026-10-19 integration
record preserves all prior annotations, maps only active moved identities and binds
selective ceilings to exact source hashes and parent provenance; the ratchet,
exclusions and budgets remain unchanged. Existing integration chronology and original failed
runs remain in Git. Scope-commerce qualification at `da6b4cdb8dec` retained all
26 reviewed production deltas; it does not establish financial release acceptance.
Independent review permits only the specialist test module's 568→575 line ceiling:
the new owner-ADC case covers bridge dispatch plus consent rechecks; the 500-line
budget and production limits are unchanged.
The separate workflow/Admin repair [PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121)
passed protection parity; it grants no application promotion.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and gates belong to the deployment standard.
