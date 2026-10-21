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

### Retained Shared deletion

The synthetic account, vault and original library remain fenced after
`409 FILES_ERASURE_WAITING_FOR_WRITES`. Provider-session 412 is not terminal proof.
No SQL override, direct provider deletion or blind retry is permitted. Its earlier
32 KiB upload/Move/download/Undo used operator authentication/phone fixtures, not
ordinary Google/CAPTCHA/SMS onboarding. The old RAM-only passphrase is gone;
subsequent cleanup must not be described as normal unlocked-UI vault recovery.

## Source and serving evidence

Serving entries below are the **last recorded readbacks**, not a new observation
from this local implementation pass. No new deployment or owner install occurred.

| Surface | Exact receipt | Boundary |
| --- | --- | --- |
| Dev app | Source `28a0fa109175`; hub `consent-protocol-00186-5zw` / image `d80e03ebc21a`; web `hushh-webapp-00154-jzm` / image `c7f92a59242b`; both 100% | ADC readback 12:21 UTC; [exact-SHA CI](https://github.com/hushh-labs/hushh-research/actions/runs/39122438292), [governed dev rollout](https://github.com/hushh-labs/hushh-research/actions/runs/39125450154) succeeded |
| Personal Azure pod | `2026.10-dev.25+991a06ccbc01.4a3b29a7`; digest `sha256:4a3b29a74641d7eac470da43d18f01c5039f4c0327ed84811ce2f0bfa939ac9a`; revision `ca-hussh-one-pod--u36234007817f` | `op_b9a279571aaf47bcaffdbc4689c80d6c` verified 03:19:39 UTC; exact predecessor `250aea9e…fc69f1`; same identity and 1 vCPU / 2 GiB, min 0 / max 1 |
| Schema / rollback | 65 rows, 964 applied, no required-contract/checksum mismatch; history cleanup deferred | Captured hub rollback `00185-f9z` / `e9482e4319ad`; web `00153-7ck` / `991a06ccbc01`. Application rollback cannot restore deleted history |
| Local integration | Browser `80731a80b3`; frozen ADK `914e7c044c`; main through `f0eca1f983` integrated by `e25cd5f0eb` | Histories and nine unrelated edits preserved. Main's managed Azure capabilities coexist with owner-pod authority and disabled Azure pod voice. Local validation is recorded below; hosted CI and installed acceptance remain separate |
| Browser component qualification | Image `sha256:b48f66b6…b32fbf24a4`: ordinary GCP frames/start 7.145 s, Azure frames/start 1.555 s; both confirmed Stop. Native ACA Luna research 19.460 s, five model round trips at capacity 50 | Synthetic grants, excludes owner HTTP acceptance and full-pod capacity. Capacity 1 returned 429; original failure retained. GCP native Gemini 3.8 research subsequently completed in 96.713 s through the approved bridge: three model round trips, two native actions and two screenshot continuations. This is one component sample, not a latency target pass. Disposable resources and temporary model/RBAC verified removed |

### Current local implementation

Browser implementation is committed at `80731a80b3`; main through `f0eca1f983`
and frozen ADK `914e7c044c` are preserved in the combined ancestry. This candidate
remains uninstalled. Exact download ingress now preserves Browser control and Files
authority, with malformed and neighboring paths refused.
Browser joins now include durable identifier-only delivery through the existing
Files queue, asynchronous input review, native ADK handback, encrypted remembered
sessions and exact owner-approved configuration on Cloud Run and Container Apps.
No additional queue or worker identity is created; one background consumer is
serial, and a Browser task may delay queued Files work for up to fifteen minutes.
GCP replacement reads back the existing queue, worker identity and scoped IAM
before drain and again before replacement. Dev migration 970 adds Azure Browser
admission only; isolated SQL tests are not a live migration receipt.

Selected PKM loading now accepts only existing owner-approved V2 exports encrypted
to the current pod key, with exact grant and source revisions; unavailable exports
do not fall back to replica reads. Ordinary HTTP attachments up to 4 MiB stay in
pod memory until explicit **Save to Files**, with decrypted byte verification.
Stop joins an admitted save; Files completion reuses its consented organization
outbox and reports queue failure separately from saved bytes. Reconnect never
refetches a lost attachment or reruns a completed goal. These new joins still need installed owner acceptance.

Local core verification preserves original failures and resumes only affected stages.
The first parallel manifest passed 22,130 tests; repaired cases and 388 database
setup cases pass on replay. The serial stage passed 1,587 cases; all 79 affected
cases pass in a disposable CI-equivalent PostgreSQL instance, then verified removed.
Counts overlap. Main's changed seams passed 950 plus 342 cases, with every remaining
failure resolved by targeted replay. The uncached readiness and absent provider
location paths now retain their typed public contract.

Governance, package validation, PKM integration (191 frontend and 400 backend cases
across the initial run and repaired path assertion), 495 Back cases, refreshed UI
receipts, typecheck, lint and production frontend build pass. Bandit reports zero
medium/high findings. Final typecheck passes all 395 selected source files; the exact-SHA hosted aggregate
remains required before dispatch. This is local evidence, not installed acceptance.

Component image `sha256:2bfbf9da…dad8db81` now renders both public pages and confirms
supervisor exit on Cloud Run (startup 6.951 s) and Container Apps (1.719 s).
Source archive, disposable services/groups and scoped grants were removed with
readback. Earlier scratch/import failures are retained; build-time restricted-
module imports now catch the packaging defect. These are component receipts,
not installed owner acceptance or full-runtime capacity. The combined candidate
has completed main/ADK intake; exact-SHA hosted CI remains before dev dispatch.

VM hosting is superseded by the agreed Container Apps configuration. Historical
VM receipts do not authorize a customer hosting transition. No owner resources,
placements or selected capacities were changed by this local continuation.
The affected private Wiki release decision was corrected and read back on
2026-10-21.

## Performance and economics


| Measurement | Result | Decision |
| --- | --- | --- |
| Matched cloud chat | 20 cold / 20 warm per cloud: GCP p95 71.721 / 7.700 s; Azure 71.304 / 13.389 s | Retain this historical baseline. Thirty seconds is an optimization goal; fix measured startup work and recovery, without a permanent warm floor |
| Personal chat | Latest zero-instance sample: first content 44.837 s, complete 46.040 s; capabilities 40.304 s | Wake/readiness dominates this sample; not a percentile or physical paint measurement |
| Puppy Dev 25 | First text 35.257 s, complete 35.509 s; device first content 25.308 s | Nonempty Gemma 12B response received in an occluded browser; not cold-model or foreground-paint acceptance |
| Idle | Personal Dev 25 reached zero replicas at 03:40 UTC after the verified turn | No pod wake request was made to obtain this control-plane observation; exact idle-grace timing remains unmeasured |
| Model qualification | Gemini 3.8: tools 2/3; 3.5 Flash / Flash-Lite LOW: 3/3 + 5/6 first-tool; Azure Luna: 3/3 + 6/6. Estimated charge $1.96791915 | Bounded earlier samples; defaults unchanged. Provider failures and 429s retained; no further sweep |
| Planning package | 30 billable hours + 50 GiB + 1,500 modeled calls + $5 reserve: Google/3.8 $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32 | Dated estimates, not invoices, quotas or equivalent model quality. [Full assumptions](../operations/private-files-library.md#whole-package-planning-budget) |

Qualification envelope: **1 vCPU, 2 GiB RAM, min 0 / max 1, one worker**.
GCP concurrency 8 differs from Azure HTTP threshold 8. Ten-minute relay grace and
platform scale-down tails are billable. Existing selected hosting is preserved.
The deployed foreground-wake fix prevents hidden-tab/status polling from extending
paid work; spending thresholds warn without stopping service.

## Next gate and owners

1. **Engineering — Browser P0:** install an exact qualified GCP configuration and
   complete owner task/review/takeover/reconnect/stop; finish the corresponding
   approved Azure whole-host lifecycle. Keep both capabilities disabled until
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
