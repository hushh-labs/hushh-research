# Private-pod readiness: CTO decision memo

## Decision — 2026-10-18 UTC

**Continue dev qualification. Hold application promotion.** Azure owner chat,
Files and an exact-approved update have live receipts. Puppy has a streamed
Gemma 12B response through the same owner pod. GCP native AI access, retained
Shared deletion, cold latency and Browser execution prevent a complete readiness claim.

Private execution stays in the selected owner cloud. The hub coordinates identity,
consent, placement and updates. Puppy inference executes on the explicitly granted
trusted machine through its bound pod; it never silently falls back to cloud AI.
Selected external model providers retain their disclosed processing boundary.

## What works / what must change

| Journey | Demonstrated outcome | Next measurable result |
| --- | --- | --- |
| Owner cloud / AI | Azure normal owner chat completes; provider-aware GCP/Azure onboarding and encrypted custom-key choices serve dev | GCP owner-project Vertex currently returns 403. Resolve that exact authority/provider refusal and complete a real owner-pod response; no implicit bridge substitution |
| Voice | GCP recorded transcription/commands use admitted pod routes and the authorized model factory. Local correction disables Azure capture, Live admission and recorded transcription; private Live cannot borrow the shared model key | Complete focused boundary checks, then release the correction. Actual GCP recorded audio remains live-unverified; native conversational Live requires its own compatible model |
| Files | Dedicated ADK specialist and explorer. Personal and fresh Shared Move, stable identity, byte-exact download and Undo pass; earlier interrupted 4,195,328-byte transfer and selected analysis pass | Finish the retained synthetic deletion after the guarded correction serves; qualify fresh setup and current-image organization without disturbing owners |
| Software updates | Personal Azure Dev 25 approved in Settings; same durable operation, recovery, installed digest, unchanged incarnation and exactly one Feed completion verified | Preserve exact tested predecessor compatibility; broader interruption and rollback acceptance stays distinct |
| Puppy | Existing Hermes identity and grant; signed binding, sealed WSS, streamed Gemma 12B response and idle UI. Previous Stop, withdrawal, refusal and re-enable receipts retained | Keep the default and existing relay. No model sweep. Independent-network and cold-model percentiles are unclaimed; phone testing was waived |
| Browser Use | Native ADK adapter, responsive preview, mouse/touch control, fenced takeover/handback, private checkpoints and encrypted remembered sessions tested locally | **Disabled on both clouds.** GCP native worker cannot adopt required non-root identity, so Chromium refuses startup. Azure native execution identity/Chromium/transport remain unqualified. No unsandboxed or alternative-executor fallback |
| Background / continuity | Files queue delivery and preservation of originals previously demonstrated on both clouds; durable update and command/MCP recovery owners exist | Prove current-image connectors/recorded commands and supported continuation. General goals, Azure due-time delivery and scheduled browser work are not qualified |
| Erasure / transitions | Earlier disposable Shared erasure verified objects and Firebase absence. Explicit Shared/assigned/pending placement is preserved | Fresh Shared deletion is fenced on one uncertain upload. Environment-specific migration, external revocation and cloud cleanup must have receipts; unknown placement never silently becomes Shared |

## Source and serving evidence

| Surface | Exact evidence | Scope |
| --- | --- | --- |
| Dev application | Hub source `e9482e4319ad`, revision `consent-protocol-00185-f9z`, image `73c3632206cd`; frontend source `991a06ccbc01`, revision `hushh-webapp-00153-7ck`, image `3796e3503566`; both 100% traffic | Last independent ADC readback. [Exact-SHA CI](https://github.com/hushh-labs/hushh-research/actions/runs/39104101777) and [governed dev deployment](https://github.com/hushh-labs/hushh-research/actions/runs/39105713670) succeeded. GitHub governs; Cloud Build builds |
| Installed personal pod | `2026.10-dev.25+991a06ccbc01.4a3b29a7`; image `sha256:4a3b29a74641d7eac470da43d18f01c5039f4c0327ed84811ce2f0bfa939ac9a`; revision `ca-hussh-one-pod--u36234007817f` | Operation `op_b9a279571aaf47bcaffdbc4689c80d6c` verified 03:19:39 UTC. Only tested predecessor `250aea9e…fc69f1` admitted. Initial lock refusal retained; normal retry completed the same operation |
| Recovery | Both native workers recovered 4,195,328 Files bytes exactly from the admitted predecessor; temporary workers removed with absence readback | Azure authenticated replacement also retained encrypted chat, settings and key identity. This is not live rollback fault-injection proof |
| Local correction | Unpushed `db8c9bab2f01`: completed upload receipt settles before post-send refusal; uncertain cancellation needs HTTP 499, exact-object/bucket proof and CAS; safe `409 FILES_ERASURE_WAITING_FOR_WRITES` preserves a confirmed-active session | 99 Python, 37 frontend, 472 Back cases, typecheck and UI-contract verification pass. The full core was interrupted before completion; it is **not** a pass. New owner-cloud voice/docs changes remain local until the combined candidate is frozen |
| Owner-cloud voice correction | Azure capture and transcription disabled; private Live model reporting and construction require the same known Vertex transport, never a shared key | 286 backend passes, 73 existing skips, 60 frontend passes; all three security regressions fail on old source. Typecheck, UI contracts, skills and isolated docs pass. These are local results, not an installed pod upgrade |

The first combined governance attempt refused four new or worsened architecture
findings. Moving the regression into the owning voice suite and extracting the
existing deletion-result handler preserves behavior: 17 affected checks pass and
the unchanged ratchet now reports zero new or worsened findings. The original
failure is retained; it is not a full-core pass.
| Schema / rollback | 65 migration rows, 964 applied, no required-contract/checksum mismatch; history cleanup 249 deferred | Application rollback: hub `00184-fkl` / source `39dd047b92a0`, frontend `00153-7ck` / source `991a06ccbc01`. Application rollback cannot recover destructively deleted history |
| Hermes | Source `f082c71325`; profile and Gemma 12B default preserved | Focused relay checks and live response pass. Broad companion Python validation is incomplete and dependency alerts remain; this is not distribution clearance |

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

### Retained Shared deletion

The fresh synthetic Shared owner completed a normal cold unlock, 32 KiB upload,
Move/download/Undo on the deployed frontend. The authentication/phone setup used
operator fixtures, not ordinary Google/CAPTCHA/SMS onboarding. Background analysis
stayed off and no model call occurred. Normal deletion returned 500 twice; the
account remains fenced with its vault and one uncertain create-only receipt.
Exact provider-session status 412 is **not** terminal proof. No SQL fence or provider
object was manually cleared. The local correction above needs governed release
and an observed product cleanup result before this row can pass.

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

1. **Engineering:** finish the voice/owner-cloud boundary correction, freeze the combined candidate, complete one core mirror and exact-SHA hosted CI; deploy dev once and read back serving revisions.
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

## Visual Context

Use the [Founder/CTO diagram guide](../architecture/README.md#founder-and-cto-diagram-guide)
and [private-agent north star](../architecture/private-agent-north-star.md).
Operating detail stays in the [dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[Files runbook](../operations/private-files-library.md),
[deletion runbook](../operations/account-deletion-rollout.md) and
[deployment standard](../architecture/deployment-standard.md).

## Reviewed integration debt

Historical anchor: the [architecture baseline](./architecture-fitness-baseline.json)
owns reviewed spans, hashes and negative controls; the ratchet, exclusions and
budgets remain unchanged. Existing integration chronology and original failed
runs remain in Git. Scope-commerce qualification at `da6b4cdb8dec` retained all
26 reviewed production deltas; it does not establish financial release acceptance.
The separate workflow/Admin repair [PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121)
passed protection parity; it grants no application promotion.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and gates belong to the deployment standard.
