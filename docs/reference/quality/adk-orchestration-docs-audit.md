# Private-pod readiness: CTO decision memo

## Decision — 2026-10-21 UTC

**Continue dev qualification; hold application promotion.** Existing Azure owner
chat, Files, Puppy and an approved update have live receipts. The current Browser
candidate is locally verified but uninstalled. Installed Browser, Azure host
lifecycle, general scheduling and retained Shared erasure remain release blockers.

The [public-research MVP](../../future/personal-agent/browser-completion-plan.md#immediate-mvp--critical-path-first)
is P0: ask One, review, browse, take control, resume, reconnect and stop. Login,
remembered sessions, private-context disclosure and transfers follow that proof.
The 30-second cold target is an optimization goal. Economy hosting stays selected.

## Visual Context

Start with the [Founder/CTO diagram guide](../architecture/README.md#founder-and-cto-diagram-guide)
and [private-agent north star](../architecture/private-agent-north-star.md).
The [Browser reference](../../../consent-protocol/docs/reference/private-browser-runtime.md)
owns exact execution, qualification and isolation evidence. Operating procedures
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
| Browser | Protected Chromium/native ADK public-research components passed on GCP and disposable Azure VM; responsive mechanics tested after task completion | Disabled on owner runtimes. Dev 966 task approval, 969 GCP configuration approval, immutable qualification and active-task owner takeover/reconnect/stop are still required |
| Scheduled tasks / connectors | Local One occurrence/review/checkpoint continuity and authenticated HTTP have controlled proof; active worker registration remains Files-only | All-family adapters, owner controls, Azure due-time delivery, current-image connector refresh/review and installed continuation |
| Voice | App selects GCP recorded commands; Azure capture disabled. Stronger private-pod guards are source-qualified | Fresh image and owner approval; GCP recorded audio remains live-unverified. Live needs compatible native transport, never a shared key |
| Erasure / transitions | Earlier Shared erasure verified object/Firebase absence; retained fixture gets safe 409 on deployed source | Reconcile the uncertain write through the product path before erasure; cloud/external-grant cleanup and hosting transfers need their own receipts |
| Security / economy | Authority negative controls, inherited Browser isolation and selected minimum-zero configuration have scoped evidence | Installed lifecycle and idle acceptance; dependency alerts, including companion alerts, remain independent clearance requirements |

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
| Local integration | Main `f47a4832dbc` + frozen ADK `42bb9823005` through `b14bc29901`; later source remains on the infrastructure branch | Historical core passed: 21,737 parallel, 1,215 serial, 396 additional PostgreSQL checks. Those receipts do not validate the current working candidate. Active ADK and peer edits are preserved |
| Browser component qualification | GCP Gemini bridge research 47.644 s; Azure VM Luna 13.744 s, with encrypted identity/restart continuity | Excludes cloud startup. Model-directed navigation/screenshots passed; manual controls were exercised after completion. No active-task owner HTTP acceptance or customer VM availability implied |

### Current local implementation

Implementation checkpoint: `dc15a2fec2` (local only).

GCP Browser now has a distinct typed policy plan and approval v2 under the existing
update operation. Registry CAS binds owner, key and placement. Authenticated drain,
exact template/image/policy and 100% serving traffic precede configured status.
Lost-response discovery retains the original operation and qualification even when
the hub target advances; it never dispatches another replacement. Settings reviews
public destinations and model screen processing before approval. The offer flag
stays off until qualification and parked dev migration 969 are present.

Azure VM image updates refresh only captured target evidence and preserve owner
policy. Old root updater/helper bundles refuse; host maintenance and customer
activation remain separate. No qualification pins are installed. The
[VM lifecycle proposal](../../future/personal-agent/browser-completion-plan.md#azure-vm-hosting-proposal--qualification-only)
owns outstanding customer-host admission, external wake, idle/deallocation,
repairable uncertainty and erasure. Dev 965–969 remain subject to governed ledger
verification; isolated schemas are not live migration receipts.

Verification: **262 focused backend checks**, **30 frontend checks**, 15 changed
helper modules typechecked, and three broken-code negative controls for key
rotation, serving traffic and temporary-database cleanup. Generated Back behavior
passed 484 checks; UI contracts and web typecheck pass. Documentation integrity,
links, brand and all 209 diagrams pass. These are local receipts, not installed
acceptance. Original failures and corrected harness results remain preserved.
The final combined candidate still requires its one core mirror and exact-SHA CI.
The private Wiki correction now reads back after transport errors. Write
acknowledgement and durable backup remain unconfirmed.

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
3. **Release owner:** freeze dependency-relevant main/ADK intake once; run the core
   mirror and exact-SHA hosted CI; govern one dev rollout and separately approved
   pod installs. Decide readiness from journey receipts, not source or health flags.

Reuse unchanged Puppy evidence: 320 Chromium/WebKit responsive cases, shared
760 px ribbon/composer, 0 px edge discrepancy, 44 px controls and no overflow.
Do not rerun it for backend/doc-only changes.

[Application PR #7555](https://github.com/hushh-labs/hushh-research/pull/7555) remains
draft. Main merge, UAT/production rollout, stable publication and automatic owner
upgrades remain unauthorized. Managed Hussh provisioning and unqualified hosting
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
