# Private-pod readiness: CTO decision memo

## Decision — 2026-10-19 UTC

**Continue dev qualification. Hold application promotion.** Azure owner chat,
Files and an exact-approved update have live receipts. Puppy has a streamed
Gemma 12B response through the same owner pod. GCP native AI access, retained
Shared deletion, cold latency and Browser execution prevent a complete readiness claim.

Private execution stays in the selected owner cloud. The hub coordinates identity,
consent, placement and updates. Puppy inference executes on the explicitly granted
trusted machine through its bound pod; it never silently falls back to cloud AI.
Selected external model providers retain their disclosed processing boundary.

## Visual Context

Use the [Founder/CTO diagram guide](../architecture/README.md#founder-and-cto-diagram-guide)
and [private-agent north star](../architecture/private-agent-north-star.md).
Operating detail stays in the [dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[Files runbook](../operations/private-files-library.md),
[deletion runbook](../operations/account-deletion-rollout.md) and
[deployment standard](../architecture/deployment-standard.md).


## What works / what must change

| Journey | Demonstrated outcome | Next measurable result |
| --- | --- | --- |
| Owner cloud / AI | Azure normal owner chat completes; provider-aware GCP/Azure onboarding and encrypted custom-key choices serve dev | The GCP qualification pod's owner-project Vertex returns 403. Resolve that exact provider/authority refusal; no implicit bridge substitution |
| Voice | Deployed app selects GCP recorded commands and disables Azure capture. Source-qualified pod guards refuse Azure transcription/Live and a shared Live key | The workflow reused reviewed Dev 25; pod guards are not installed. A fresh image needs exact-predecessor recovery and owner approval. GCP recorded audio remains live-unverified; conversational Live also needs a compatible native model |
| Files | Dedicated ADK specialist and explorer. Personal and fresh Shared Move, stable identity, byte-exact download and Undo pass; earlier interrupted 4,195,328-byte transfer and selected analysis pass | Finish the retained synthetic deletion after the guarded correction serves; qualify fresh setup and current-image organization without disturbing owners |
| Software updates | Personal Azure Dev 25 approved in Settings; same durable operation, recovery, installed digest, unchanged incarnation and exactly one Feed completion verified | Preserve exact tested predecessor compatibility; broader interruption and rollback acceptance stays distinct |
| Puppy | Existing Hermes identity and grant; signed binding, sealed WSS, streamed Gemma 12B response and idle UI. Previous Stop, withdrawal, refusal and re-enable receipts retained | Keep the default and existing relay. No model sweep. Independent-network and cold-model percentiles are unclaimed; phone testing was waived |
| Browser Use | GCP ADK model port, responsive preview/control, private checkpoints and encrypted remembered-session boundaries tested locally | **Disabled on both clouds.** Production launcher, review/dispatch/current-export adapters and runtime composition are missing; Azure also needs its native model adapter. GCP Chromium identity and Azure native execution/transport remain unqualified. No fallback |
| Background / continuity | Files queue delivery and preservation of originals previously demonstrated on both clouds; durable update and command/MCP recovery owners exist | Prove current-image connectors/recorded commands and supported continuation. General goals, Azure due-time delivery and scheduled browser work are not qualified |
| Erasure / transitions | Earlier Shared erasure verified object/Firebase absence. The retained fixture now receives the intended safe 409 instead of 500 on deployed `28a0fa1091` | Its upload remains unverified; account/vault stay fenced and retained. No direct provider deletion, SQL override or automatic retry. Migration, external revocation and cloud cleanup still need receipts |
| Security | Runtime/authority negative controls and the critical Capacitor patch have source evidence | Dependency alerts, including companion alerts, remain an independent clearance requirement; green CI does not close them |

## Source and serving evidence

| Surface | Exact evidence | Scope |
| --- | --- | --- |
| Dev application | Source `28a0fa109175`; hub `consent-protocol-00186-5zw` / image `d80e03ebc21a`; frontend `hushh-webapp-00154-jzm` / image `c7f92a59242b`; both 100% traffic | Approved-ADC readback at 12:21 UTC. [Exact-SHA CI](https://github.com/hushh-labs/hushh-research/actions/runs/39122438292): 22 successful jobs. [Governed dev deployment](https://github.com/hushh-labs/hushh-research/actions/runs/39125450154) succeeded. GitHub governs; Cloud Build builds |
| Installed personal pod | `2026.10-dev.25+991a06ccbc01.4a3b29a7`; image `sha256:4a3b29a74641d7eac470da43d18f01c5039f4c0327ed84811ce2f0bfa939ac9a`; revision `ca-hussh-one-pod--u36234007817f` | Operation `op_b9a279571aaf47bcaffdbc4689c80d6c` verified 03:19:39 UTC. Only tested predecessor `250aea9e…fc69f1` admitted. Initial lock refusal retained; normal retry completed the same operation. Post-app-deploy image/revision and 1 vCPU / 2 GiB, min 0 / max 1 are unchanged |
| Recovery | Both native workers recovered 4,195,328 Files bytes exactly from the admitted predecessor; temporary workers removed with absence readback | Azure authenticated replacement also retained encrypted chat, settings and key identity. This is not live rollback fault-injection proof |
| Deployed application correction | `28a0fa109175`, executable evidence `21b82a583aa7`: upload receipt settles before post-send refusal; uncertain cancellation requires HTTP 499, exact-object/bucket proof and CAS; safe `409 FILES_ERASURE_WAITING_FOR_WRITES` preserves a confirmed-active session | Local core, exact-SHA hosted CI and governed deployment pass. Live product cleanup returns the safe 409, not completed erasure. Pod hardening remains source-qualified until a fresh image is released and approved |
| Source-qualified pod voice guards | Pod source refuses Azure transcription/Live; private Live reporting and construction require the same known Vertex transport, never a shared key | 286 backend passes, 73 existing skips, 60 frontend passes; all three security regressions fail on old source. Typecheck, UI contracts, skills and isolated docs pass. These are local results, not an installed pod upgrade |
| Schema / rollback | Post-deploy: 65 migration rows, 964 applied, no failed migration or required-contract/checksum mismatch; history cleanup 249 deferred | Captured rollback: hub `00185-f9z` / source `e9482e4319ad`, frontend `00153-7ck` / source `991a06ccbc01`. Application rollback cannot recover destructively deleted history |
| Hermes | Source `f082c71325`; profile and Gemma 12B default preserved | Focused relay checks and live response pass. Broad companion Python validation is incomplete and dependency alerts remain; this is not distribution clearance |

**Verification receipt:** the broad parallel run retained 21,253 passes and one
Live-revocation fixture failure. The fixture now explicitly selects supported native
GCP Live; its complete 15-case suite passes with unchanged assertions. All 1,475
serial database checks and every test import pass. Web-core inputs remained
byte-identical and its completed result was reused. MCP and integration, including
396 PKM checks, pass. Local verification ran no live model evaluation; deployment
ran its existing managed-runtime check. The disposable database and scratch were removed.

Original interrupted, missing-test-environment, strict-type and architecture refusals
are retained. The architecture ratchet now reports zero new or worsened findings;
no budget, assertion, security or consent gate was weakened.

### GCP authority and Browser qualification

The disposable GCP workload has the declared Vertex/Consumer roles; native
owner-project requests still return 403 on REST v1 and the pinned SDK. A separate
approved bridge diagnostic returned HTTP 200 in 1.046 s (3 input / 1 output tokens).
Its temporary Job was removed. This proves bridge access only; it neither repairs
nor authorizes replacing the selected owner-project connection.

GCP's native sandbox probe ran as root and refused the required UID change
(`EPERM`); Chromium never emitted a frame. Azure's earlier enrollment blocker is
stale, but native execution and privacy remain unqualified. Both adapters stay
closed. See [native Browser evidence](../../../consent-protocol/docs/reference/private-browser-runtime.md).

### Local integration candidate — 2026-10-19 UTC

Fresh main `f47a4832dbc` and frozen local ADK `42bb9823005` are integrated
through `a06eac52b5` plus reviewed integration corrections in an isolated checkout. Peer edits and the active ADK tree
remain intact. Provider-aware AI selection, Puppy controls and exact owner/vault
authority were preserved across main's extracted UI models. Async AI/key/device
operations now retain their original owner generation; Wallet reopen assertions
were restored. No new push or environment deployment has occurred in this slice.

Focused receipts: 350 backend passes (73 environment skips), 77 deployment checks,
131 final authority/UI checks, 484 Back cases and 38 ADK error cases. TypeScript,
generated UI contracts and Swift parsing pass. The `.agents` consolidation retains
45 governed skills, 22 practices, 19 lanes and 40 workflows behind checked host
adapters. All 209 maintained diagrams render after seven stale UI snapshots were consolidated;
changed maps were visually inspected. These are local source results, not installed-cloud
acceptance or a full core receipt. Read-only frontend/backend and parent governance
review reconciled 307 exact structural ceilings: 228 findings match a frozen parent;
79 are reviewed compositions. Historical annotations and 500/250/80 budgets remain;
the ratchet and its negative controls pass. This does not clear product blockers.

The combined core run passed web-core and retained 21,397 backend passes; it
also exposed ten source/fixture failures and 388 strict test-database setup errors.
The corrections enforce the content guard on new Drive file routes, erase private
processing approval on reset and deletion, restore canonical schema order, and
follow the new instruction paths. Their 337 focused checks and 766 real local
PostgreSQL checks pass. The omitted-reset-cleanup negative control fails as intended.
Test clusters close after use; the peer database and browser connection are preserved.
The final combined core receipt is still pending. No new hosted CI or deployment is claimed.

Files recovery now persists provider-confirmed cancellation before later checks and
retains it across failure/restart. Exact-session HTTP 410 is a separate invalidation
proof; HTTP 404/412 remain refused. Focused boundary checks pass. Gmail restart
continuation now runs after authority recovery without blocking foreground admission;
it retains an update permit and is cancelled and joined during shutdown.
These changes are not deployed and do not establish a successful live erasure or
a new cold-start percentile.

Verified admin ADC repaired a missing Service Usage Consumer grant on the disposable
GCP qualification workload. Current provisioning already declares that role; this
was existing-resource drift. Its subsequent native owner-project request still
returned HTTP 403 in 0.087 s. The diagnostic Job was deleted and absence verified.
The original bounded observer timed out before reading that late execution receipt;
retained Cloud Logging supplied the result. Native provider acceptance remains open.

### Retained Shared deletion

The fresh synthetic Shared owner completed a normal cold unlock, 32 KiB upload,
Move/download/Undo on the deployed frontend. The authentication/phone setup used
operator fixtures, not ordinary Google/CAPTCHA/SMS onboarding. Background analysis
stayed off and no model call occurred. Normal deletion returned 500 twice; the
account remains fenced with its vault and one uncertain create-only receipt.
Exact provider-session status 412 is **not** terminal proof. No SQL fence or provider
object was manually cleared. After deployment, one admitted product continuation
returned `409 FILES_ERASURE_WAITING_FOR_WRITES` at 12:22 UTC. The synthetic account
and original library remain retained; no retry followed. The earlier process lost
its RAM-only passphrase, so this was operator fixture cleanup, not normal unlocked-UI
deletion or vault recovery.

## Performance and economics

| Measurement | Result | Decision |
| --- | --- | --- |
| Matched cloud chat | 20 cold / 20 warm per cloud: GCP p95 71.721 / 7.700 s; Azure 71.304 / 13.389 s | Cold ≤30 s target fails; equal vCPU labels do not establish equal performance |
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

The [local normal-release transition plan](../../future/personal-agent/NORMAL-RELEASE-TRANSITION.md)
records CI consolidation, Shared continuity and changelog promotion. Nothing in
that proposal authorizes a push or environment rollout.

1. **Engineering:** app release/readback complete. A fresh pod image must remove the deliberate Dev 25 reuse pin, qualify recovery from the actual installed digest and use exact owner approval. Do not describe the reused image as the new source.
2. **Engineering + Operations:** finish retained synthetic erasure, GCP native model authority, recorded commands/connectors and measured cold latency. Keep Browser disabled until each native gate passes.
3. **Release owner:** decide dev readiness from actual journey receipts. Production still requires migration/release-channel graduation, IAM, erasure, recovery, hub capacity and independent UAT acceptance.

Puppy's deployed One-style UI already passes 320 responsive Chromium/WebKit cases.
Live ribbon/composer share a 760 px measure with 0 px edge discrepancy, 44 px
controls, 16 px editor and no overflow. This evidence is reused; no model or UI
requalification loop is required for backend/doc-only changes.

[Application PR #7555](https://github.com/hushh-labs/hushh-research/pull/7555) remains
draft. No application main merge, UAT/production deployment, stable publication or
automatic owner upgrade occurred. Managed Hussh provisioning and unqualified
Shared/pod/cross-cloud moves remain unavailable.


## Reviewed integration debt

Historical anchor: the [architecture baseline](./architecture-fitness-baseline.json)
owns reviewed spans, hashes and negative controls. The 2026-10-19 integration
record preserves all prior annotations, maps only active moved identities and binds
selective ceilings to exact source hashes and parent provenance; the ratchet,
exclusions and budgets remain unchanged. Existing integration chronology and original failed
runs remain in Git. Scope-commerce qualification at `da6b4cdb8dec` retained all
26 reviewed production deltas; it does not establish financial release acceptance.
The separate workflow/Admin repair [PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121)
passed protection parity; it grants no application promotion.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and gates belong to the deployment standard.
