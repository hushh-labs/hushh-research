# Private-pod readiness: CTO decision memo

## Decision — 2026-10-21 UTC

**Continue dev qualification; hold application promotion.** Existing Azure owner
chat, Files, Puppy and an approved update have live receipts. The current Browser
candidate has local contract and cloud component evidence, but is uninstalled.
Installed Browser, measured capacity, remaining core lifecycle and retained Shared
erasure remain release blockers. VM migration and general schedule expansion are
outside the current gate.

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
| Updates | Personal Azure Dev 25: one Settings-approved operation, encrypted recovery, installed digest and one Feed completion | Fresh-image exact-predecessor recovery, active-work interruption and separately approved installation |
| Puppy | Existing Hermes identity, signed binding, sealed WSS and streamed Gemma 12B; prior Stop, withdrawal/refusal and re-enable passed | Repeat affected paths only. Phone testing waived; independent-network acceptance is unclaimed |
| Browser | Same-image real frames and joined shutdown pass on Cloud Run (sandbox on) and Container Apps (sandbox off). Native Luna and Gemini research completed on their configured cloud paths; original 429s remain recorded | Disabled on owner runtimes. Dev 966 task approval, 969/970 cloud configuration approval, immutable qualification and active-task owner takeover/reconnect/stop are still required |
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
local and passes its 40 nearest checks; legacy API identifiers are preserved.

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

The governed dev application deployment completed on 21 October. Its immutable
pod image is published without predecessor compatibility or Browser enablement;
publishing does not install it. Existing personal pod receipts remain unchanged.

| Surface | Exact receipt | Boundary |
| --- | --- | --- |
| Dev app | Source `67a64533ac6a`; hub `consent-protocol-00188-lrc` / digest `4bac612c3642`; web `hushh-webapp-00156-p2n` / digest `84f886ccee86`; both 100% | [All 26 exact-SHA CI jobs](https://github.com/hushh-labs/hushh-research/actions/runs/39691219336) and [governed dev rollout](https://github.com/hushh-labs/hushh-research/actions/runs/39694799698) succeeded. ADC serving readback at 00:15 UTC on 22 October matches revisions, images and provenance. Schema and semantic gates passed; the changed-SHA selector intentionally excluded reviewer/PKM rehearsals |
| Personal Azure pod | `2026.10-dev.25+991a06ccbc01.4a3b29a7`; digest `sha256:4a3b29a74641d7eac470da43d18f01c5039f4c0327ed84811ce2f0bfa939ac9a`; revision `ca-hussh-one-pod--u36234007817f` | `op_b9a279571aaf47bcaffdbc4689c80d6c` verified 03:19:39 UTC; exact predecessor `250aea9e…fc69f1`; same identity and 1 vCPU / 2 GiB, min 0 / max 1 |
| Schema / rollback | Dev migration and postdeploy schema gates passed without contract violations; history cleanup deferred | Rollback hub `00187-lr7`, web `00155-4hr`. Application rollback cannot restore deleted history |
| Local integration | Browser `80731a80b3`; frozen ADK `914e7c044c`; newer main through `f7d80942ed` reconciled locally at `1aafc9f23d` | Nine peer edits and the active ADK tree are preserved. Main's warm Messages cache and production-capacity maintenance retain private-owner admission and governed environment authority; this integration is not deployed |
| New pod image | Dev 27: `sha256:8b846022947bca939fba48cddf1101f3c26dddfb043ab41e20bd7407e068ac07`, source `67a64533ac6a` | Both exact personal predecessors (`26bab163…61809` GCP, `4a3b29a7…939ac9a` Azure) recovered identity, six sealed records, consent/PKM state and 245,763 exact file bytes. Fixtures and temporary images are cleaned; GCP's seven-day provider soft-delete retention is preserved. Dev 28 metadata is prepared locally to reuse this image; publication and owner installation remain separate |
| GCP configuration | Named owner's revision `00018-jrz`, same predecessor `26bab163…61809`, 1 vCPU / 2 GiB / concurrency 8 | Authenticated maintenance handoff and recovery passed; identity, keys, image and on-demand settings unchanged. Task-owned maintenance job removed |
| Browser component qualification | Exact Dev 27 image: GCP Gemini 3.8 public research 20.366 s / three model rounds; actual Azure `one-chat` GPT-5.6 Luna 16.823 s / five rounds | Both produced HTTP 200 and real frames, native model screenshot continuations, 390 × 844 resize, login-observation fencing, handback and joined Stop. Takeover occurred after component model completion. Probe resources, temporary inference role and scoped image copies are absent; the owner's model/SKU is unchanged. No installed-owner HTTP, cold-wake or full-pod capacity claim |

### Current local implementation

Main through `f7d80942ed` and frozen ADK `914e7c044c` are reconciled with the
private-agent work. Streamed exports, dual-principal connector fencing, SOS,
Azure playback, exact provider receipts and Profile controls are preserved.
The final local core was run once. Original failures remain recorded; environment
repairs and the corrected PLG route classification were checked in the affected
stages. The backend manifest totals 24,408 distinct passes and 138 skips across
that run and its replays; all 30,928 available cases collect. The newer main merge
passes 98 Messages, 182 affected frontend, 11 export and 31 operations checks,
typecheck and regenerated UI contracts.
The reviewed architecture ratchet has no regressions; its budgets are unchanged.
A clean web-core check covers the newer frontend dependency before push.

[Exact-candidate validation](https://github.com/hushh-labs/hushh-research/actions/runs/39670721881)
exposed four backend failures: stale connector fixtures, a local-profile assumption
and a missing transitive deployment helper. Their focused repairs pass 124 checks.
An asynchronous Wallet cleanup assertion now waits for actual revocation; 17
nearest cases pass. The corrected candidate's exact-SHA hosted CI and governed
dev application deployment have succeeded.
Earlier core-mirror failures and targeted replays are retained; no full local suite
is repeated for these bounded corrections.

The new-image Browser refusal was traced to Chromium-generated client hints and
language differing from its fixed public profile. The source correction passes
81 nearest checks and the original-code negative. A synthetic source-patched
probe passes native Gemini/Luna research in 24.563/17.073 seconds, takeover,
resize, handback and Stop on both clouds. These component samples do not qualify
the immutable image, owner journey or capacity. Frozen image source `67a64533ac`
passes [26-job CI](https://github.com/hushh-labs/hushh-research/actions/runs/39691219336)
and its [governed build](https://github.com/hushh-labs/hushh-research/actions/runs/39694799698).
Immutable-image native research passed on both clouds, as recorded above.
The original failed images and patched-source probes remain historical evidence.
No personal installation has occurred.

Browser source includes owner-bound ADK execution, durable identifier-only delivery,
exact review, takeover, cancellation, encrypted continuation and remembered sessions.
Selected PKM consumption requires an exact current-pod encrypted export. The
normal person-sharing producer uses a different recipient and consent principal;
its owner-approved pod-recipient production seam remains unfinished. Do not use a
broad replica or a handcrafted grant as acceptance. Byte-verified attachments
remain private until Save to Files. Operating details stay in the Browser reference.
The serial consumer may delay Files work during a bounded Browser task.
Dev 966/969/970 approval and schema requirements remain deployment gates.

The dev bridge is explicit, bound to the exact workload identity and verified by
its configuration operation. Image updates preserve its absence. Secret sync now
retains only an existing environment-pinned dev policy; 86 nearest checks and the
original-code negative pass. The exact approved identity tuple was published to dev runtime configuration
version 220 and read back without changing other fields. Its owner configuration
approval and post-deployment serving verification remain required.

Four native Playwright shards preserve every browser test and worker limit; native
collection proves a complete, disjoint partition. The previous three-shard run
exceeded its time limit twice. The main-owned workflow now includes the compatible
reviewer-path repair in [operations PR #8320](https://github.com/hushh-labs/hushh-research/pull/8320),
which landed through Admin SOP with exact post-merge smoke. The application is
now deployed to dev; the new pod image has not been installed on personal owners.
VM hosting is superseded; historical VM receipts do
not authorize a transition. The private Wiki decision was updated and read back.

## Performance and economics


| Measurement | Result | Decision |
| --- | --- | --- |
| Delivery cycle | Latest exact CI 32.2 min; governed rollout approximately 29.5 min | Parallel CI critical paths: iOS 29.2, Browser 27.5 and Python 25.8 min. Rollout backend build 562 s, frontend 119 s. Earlier 64.2-minute cycle remains historical; do not sum parallel jobs |
| Matched cloud chat | 20 cold / 20 warm per cloud: GCP p95 71.721 / 7.700 s; Azure 71.304 / 13.389 s | Retain this historical baseline. Thirty seconds is an optimization goal; fix measured startup work and recovery, without a permanent warm floor |
| Personal chat | Latest zero-instance sample: first content 44.837 s, complete 46.040 s; capabilities 40.304 s | Wake/readiness dominates this sample; not a percentile or physical paint measurement |
| Puppy Dev 25 | First text 35.257 s, complete 35.509 s; device first content 25.308 s | Nonempty Gemma 12B response received in an occluded browser; not cold-model or foreground-paint acceptance |
| Idle | Personal Dev 25 reached zero replicas at 03:40 UTC after the verified turn | No pod wake request was made to obtain this control-plane observation; exact idle-grace timing remains unmeasured |
| Model qualification | Gemini 3.8: tools 2/3; 3.5 Flash / Flash-Lite LOW: 3/3 + 5/6 first-tool; Azure Luna: 3/3 + 6/6. Estimated charge $1.96791915 | Bounded earlier samples; defaults unchanged. Provider failures and 429s retained; no further sweep |
| Planning package | 30 billable hours + 50 GiB + 1,500 modeled calls + $5 reserve: Google/3.8 $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32 | Dated estimates, not invoices, quotas or equivalent model quality. [Full assumptions](../operations/private-files-library.md#whole-package-planning-budget) |

The authenticated pod-status surface now provides bounded numeric memory/peak/limit/OOM, CPU and shared-memory observations. Fourteen focused route/measurement checks pass, including refusal before sampling; the premature-sampling negative fails. Missing kernel counters remain explicit. Capacity acceptance is still pending.

Qualification envelope: **1 vCPU, 2 GiB RAM, min 0 / max 1, one worker**.
GCP concurrency 8 differs from Azure HTTP threshold 8. Ten-minute relay grace and
platform scale-down tails are billable. Existing selected hosting is preserved.
The deployed foreground-wake fix prevents hidden-tab/status polling from extending
paid work; spending thresholds warn without stopping service.

## Next gate and owners

1. **Engineering — Browser P0:** install an exact qualified GCP configuration and
   complete owner task/review/takeover/reconnect/stop; finish the corresponding
   approved Azure shared-container lifecycle. Keep both capabilities disabled until
   their installed journeys pass. Follow advanced Browser features afterward.
2. **Engineering + Operations:** finish supported scheduled tasks, current-image
   Files organization, GCP recorded commands/connectors and retained erasure.
   Use three cold and three warm samples only for relevant startup changes;
   historical percentiles remain historical. No model sweep or artificial keepalive.
3. **Release owner:** use the frozen, locally verified candidate for exact-SHA
   hosted CI, then govern the image-build and qualified-metadata
   publication runs, then separately approved pod installs. Decide readiness from journey receipts, not source or health flags.

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
