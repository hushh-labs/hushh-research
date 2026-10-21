# Private-pod readiness: CTO decision memo

## Decision — 2026-10-20 UTC

**Continue dev qualification. Hold application promotion.** Azure owner chat,
Files and an exact-approved update have live receipts. Puppy has a streamed
Gemma 12B response through the same owner pod. GCP dev acceptance uses the approved
Gemini bridge. Retained Shared deletion and Browser production composition still
prevent a complete readiness claim.
Cold latency remains a measured usability constraint; the former 30-second target
is an optimization goal, not a release gate. Economy hosting remains selected.

Browser's immediate milestone is the [public-research MVP](../../future/personal-agent/browser-completion-plan.md#immediate-mvp--critical-path-first):
protected execution, one ADK task, preview/takeover and reconnect/stop.
Remembered sessions, PKM autofill, transfers and scheduled browsing follow that
proof. This prioritization does not change either cloud's disabled status.

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
| Owner cloud / AI | Azure normal owner chat completes; provider-aware GCP/Azure onboarding and encrypted custom-key choices serve dev. Approved dev Gemini bridge access returns 200 | Complete the GCP owner journey through its explicitly configured bridge. Native project Vertex is restricted and is not a dev release prerequisite; bridge access does not prove native access |
| Voice | Deployed app selects GCP recorded commands and disables Azure capture. Source-qualified pod guards refuse Azure transcription/Live and a shared Live key | The workflow reused reviewed Dev 25; pod guards are not installed. A fresh image needs exact-predecessor recovery and owner approval. GCP recorded audio remains live-unverified; conversational Live also needs a compatible native model |
| Files | Dedicated ADK specialist and explorer. Personal and fresh Shared Move, stable identity, byte-exact download and Undo pass; earlier interrupted 4,195,328-byte transfer and selected analysis pass | Finish the retained synthetic deletion after the guarded correction serves; qualify fresh setup and current-image organization without disturbing owners |
| Software updates | Personal Azure Dev 25 approved in Settings; same durable operation, recovery, installed digest, unchanged incarnation and exactly one Feed completion verified | Preserve exact tested predecessor compatibility; broader interruption and rollback acceptance stays distinct |
| Puppy | Existing Hermes identity and grant; signed binding, sealed WSS, streamed Gemma 12B response and idle UI. Previous Stop, withdrawal, refusal and re-enable receipts retained | Keep the default and existing relay. No model sweep. Independent-network and cold-model percentiles are unclaimed; phone testing was waived |
| Browser Use | Combined protected Chromium/native ADK public-research components pass: GCP 47.6 s through its approved Gemini bridge; Azure VM 13.7 s with encrypted restart continuity. Both pass responsive control mechanics after task completion | **Disabled on both owner runtimes.** Apply dev approval migration 966, bind an exact qualified deployment, then prove active-task owner approval/takeover/reconnect. Component timings exclude cloud startup; existing Azure owners stay on Container Apps |
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
| Unified development system | One `.agents` source tree; 19 engineering lanes, 45 governed skills and routing case files; native host paths are checked links. Imported bytes/licenses and peer MCP configuration preserved | Local routing/governance checks pass; no host restart, main publication or application deployment implied |
| Source-qualified pod voice guards | Pod source refuses Azure transcription/Live; private Live reporting and construction require the same known Vertex transport, never a shared key | 286 backend passes, 73 existing skips, 60 frontend passes; all three security regressions fail on old source. Typecheck, UI contracts, skills and isolated docs pass. These are local results, not an installed pod upgrade |
| Built-in Browser prerequisite hardening | Private PKM index and SQLite sidecars, image umask, inherited Browser process guards and model-independent authenticated scheduled delivery | 35 focused PKM/Browser and 34 scheduling/Files checks pass; the three PKM security cases fail on original source. Six modules typecheck; architecture ratchet has zero new/worsened findings. These changes are not installed; scheduling remains Files-only |
| Scheduled execution | Authored One task head, actual connector discovery and native review/terminal checkpoints pass controlled restart with one effect through the existing ledger. Durable AI selection/destination replaces cache counters as restart identity; uncertain dispatch stays non-replayable | Local SDK/scripted-model/MCP-fixture acceptance uses real PostgreSQL; affected roster/authority checks and typing pass. Not installed: production worker/effect-port composition, parked-segment reclaim, owner continuation and Azure timers remain open. Broader specialist typing retains four pre-existing findings |
| Browser worker transport | Typed commands and network requests retain exact owner/task/incarnation binding, host broker checks, uncertain-response fencing and joined teardown. Page-resource bursts queue before dispatch | 11 focused transport cases pass; removing binding validation fails the owner test, and the six-resource burst fails on the previous implementation. Local source only; production launcher, review coordination and model composition remain uninstalled |
| Browser launch and public access | Synthetic GCP image `f91166cae1b9` verifies the actual separate-UID launcher, protected Chromium, public-document/search frames and stop. Browser startup 3.452 s; page/frame times 1.212 / 2.061 s exclude cloud provisioning | 34 focused cases pass; descriptor, HTTP framing and update-permit regressions have failing negative controls. Job, identity and image removed with absence readback. No owner installation, real Gunicorn restart or model-task acceptance is claimed |
| Shared continuity and capability corrections | Local 405 excludes retained cloud/signing evidence; dev-only 965 repairs only incompatible inferred Shared choices and preserves historical receipts/explicit choices. Puppy and Scheduled tasks check placement before private execution; known Browser tasks expose reconnect failures | 60 PostgreSQL/manifest checks, 48 UI passes with 2 existing skips, and 24 Browser UI checks pass. These changes are not deployed |
| Normal release acceptance | Local UAT gate requires exact-SHA dev acceptance; production requires UAT and its dev chain for either image path. Immutable workflow-attempt/artifact and serving proofs retain existing health policy | 50 focused release/readiness checks and 6 actual-shell missing-classifier cases pass; independent source review passes. This operations change is not merged or active on GitHub |
| Schema / rollback | Post-deploy: 65 migration rows, 964 applied, no failed migration or required-contract/checksum mismatch; history cleanup 249 deferred | Captured rollback: hub `00185-f9z` / source `e9482e4319ad`, frontend `00153-7ck` / source `991a06ccbc01`. Application rollback cannot recover destructively deleted history |
| Hermes | Source `f082c71325`; profile and Gemma 12B default preserved | Focused relay checks and live response pass. Broad companion Python validation is incomplete and dependency alerts remain; this is not distribution clearance |

**Deployed application verification receipt:** the broad parallel run retained 21,253 passes and one
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

The disposable GCP workload has the declared Vertex/Consumer roles. A bounded
native request on 20 October confirms the expected workload identity and an
explicit provider **dunning denial** in **0.074 s**. The billing API independently
reports the project linked and the account open. The owner confirms the organization's
AI restriction is the reason for the approved dev bridge. Native access is not a dev
release prerequisite; the earlier generic 403 did not establish an IAM defect. No
additional grant, model retry or project substitution was made. The diagnostic Job is absent.
A separate approved bridge diagnostic returned HTTP 200 in 1.046 s (3 input /
1 output tokens). This is the intended dev AI path, with explicit configuration and
processing disclosure. It proves bridge access, not a completed owner chat or native
owner-project Vertex. GCP recorded voice and Browser model acceptance retain their
own transport and capability checks.

Local source now gives chat, specialists, Browser, recorded commands and AI
verification one explicit dev bridge binding. Actual metadata identity is checked
before a token reaches Vertex. BYOK, owner custody, Files approval and Live remain
separate. The 178 focused provider/selection/specialist cases pass, alongside the
unchanged 74 ADC/update cases; eight changed modules typecheck. This is not installed
owner acceptance. Configuration and release follow the
[model project runbook](../operations/dev-pod-first-light-runbook.md#model-project-ownership).

The approved built-in Browser probe ran on ordinary cloud containers. Azure's
application service passes UID 10002, filesystem denial, direct-socket and Unix
datagram denial, worker exit and scratch cleanup. Its independent user-namespace
check returns `EPERM` before our guard; sandboxed Chromium has emitted no frame.
GCP Gen 2 returns `ENOSYS` for Landlock, but the alternative private namespace
boundary now produces a real sandboxed frame with agent-file, environment, process
and direct-socket restrictions intact. A second probe used the actual Playwright
executor over a preconnected private stream: navigation, click, typing and scrolling
returned distinct frames; worker exit and process-group absence passed. Both
disposable jobs, identities and images were removed with absence readback. Owner
pods and images are unchanged. Five focused transport cases pass, including
concurrent Stop; the correlation and shutdown regressions fail on broken source.
The subsequent real launcher probe also served public documentation and search
through the pinned-address broker, with HTTP 200, frames and confirmed shutdown.
It exposed and fixed inherited-descriptor and HTTP framing defects. The Azure
B2als_v2 probe now also renders protected public pages under the 1 vCPU / 2 GiB
application limit: initialize **0.759 s**, frames **2.544 s / 2.153 s**. VM power
restart took **22.021 s** after the application was removed; this is not agent wake
latency. Deallocation and final resource-group absence were verified. Actual
owner review and Azure hosting lifecycle remain open. Both clouds
stay disabled; synthetic evidence does not qualify an installed owner capability.
Earlier provider-managed probes are historical. See the
[Browser qualification record](../../../consent-protocol/docs/reference/private-browser-runtime.md#built-in-process-qualification--2026-10-20-utc).

Live ledger readback confirms dev 955/958 checksums are unchanged and 405 is
unapplied in all three environments. UAT has no hosting-choice columns; production
has neither the migration ledger nor pod registry. This read-only check changed
no cohort. The owner's Azure model remains `one-chat` / `gpt-5-mini` 2025-08-07;
its native `computer` request returned HTTP 400. The same workload identity
successfully called a temporary `gpt-6-luna` deployment. The native ADK adapter
then completed a two-call screenshot continuation: **2.022 / 1.309 s**, 2,827 input
and 29 output tokens in total. The corrected request omits empty legacy safety
fields that caused the original HTTP 400; nonempty checks retain exact review.
Temporary deployments were deleted; the owner's model selection stayed unchanged.

The full `Dockerfile.pod` image `438433f083bc` also passes protected public browsing
on the disposable VM: initialization **0.909 s**, page/frame **1.758 / 1.371 s**,
24 broker requests, confirmed stop and no OOM. Disabled bootstrap drops all
capabilities and starts no helper. VM, ACR, source object and image absence were
verified. This frozen image predates the final model/lifecycle fixes; its receipt
qualifies the unchanged executor, not current Gunicorn/recovery composition.

Rebuilt image `9d33df90e7a4` now passes synthetic encrypted recovery on a
northcentralus B2als_v2 host with the application capped at 1 vCPU / 2 GiB.
Actual IMDS identity and Key Vault/Blob custody retain the same key, sealed log,
sequence and incarnation after deallocation/start; sibling reads and key signing
are refused. Restored custody takes **1.852 s**; VM start-to-running **10.841 s**.
Protected public frames and joined stop pass without OOM. Resource group, deleted
vault, source object and image absence are verified. This is neither an owner
installation nor an application wake measurement; burst-credit metrics remain
unverified. Exact provenance is in the linked Browser qualification record.

Public-pilot source binds recovery, the native model, exact hub review, sealed
dispatch and update admission. Joined shutdown fixes cancel/drain/model-completion
races: one terminal checkpoint and private-reference cleanup precede update idle.
The final focused Browser/ADK and release-contract pass covers **153 cases**, with
six changed modules typechecked. Image/bootstrap **53** and UI **26** prior checks
remain scoped evidence. The final core mirror, hosted CI and deployment have not
run on this working candidate. Login, private context and remembered-session
composition remain unavailable in the controlled public pilot. The
[Azure VM lifecycle and cost proposal](../../future/personal-agent/browser-completion-plan.md#azure-vm-hosting-proposal--qualification-only)
records the missing host adapter and retained-resource costs.

The composed local Browser journey now exercises One delegation, actual
PostgreSQL owner approval, pre/post-commit response loss, duplicate discovery,
takeover/handback and sealed update drain. The old consume implementation fails
the pre-commit retry control. Browser/model execution is substituted in this
check; cloud and installed-owner evidence remains separate. The internal Azure
VM power port retains uncertain requests and authenticated drain. The new
coordinator connects the existing owner wake route to exact installed VM records,
checks live session authority, unchanged keys/image and the original sealed idle
cursor, then releases the same operation. It reconciles the original ARM dispatch
and lost release responses across restart; cancellation joins its real worker.
Parked dev migration 967 fences competing lifecycle changes and reserves receipt
capacity. The normal installer has separate controlled HTTPS/recovery proof.
Source now routes explicit VM bindings to read-only observation and refuses
generic key-rotating adoption. The exact owner-JIT image update now composes drain,
three committed cloud requests, same-key recovery and original-cursor release.
Real PostgreSQL verifies atomic target publication and terminal power-receipt
retirement; changed keys, host, root hash, configuration, release and lease refuse.
Read-only completed-update recovery and journal-proven no-dispatch cleanup pass,
including cancellation. Unknown effects stay fenced. Dev 967/968 remain unapplied.
The customer host offer, scoped external grant, uncertain-operation repair,
erasure, unattended idle trigger and installed owner journey remain unqualified.
No customer VM availability is claimed.

**Local evidence:** 66 focused VM/recovery/control cases pass, including both
restart boundaries, active-work drain, wrong key/digest/cursor/lease refusals and
GET-only provider reconciliation. Seven changed source modules typecheck. Prior
22 admission cases and their failed-broken-code control remain valid.
The reviewed dev inference bridge configuration and specialist test ceilings keep
global architecture budgets unchanged. The dashboard now integrates Scheduled
tasks in its header and uses the folder glyph for Files: 26 focused UI cases pass
(two existing skips), plus compiled-CSS layout checks at 320/393/430/768/1440 px.
These are source/fixture results; no serving pod or owner installation changed.

### Local integration candidate — 2026-10-19 UTC

Main baseline `f47a4832dbc` and frozen local ADK `42bb9823005` are integrated
through `b14bc29901` on the existing primary infrastructure branch. All ten peer
drafts were preserved, including the PDF authoring paths moved to `.agents`.
The active ADK tree and its later commits remain separate from this frozen intake.
Provider-aware AI, Puppy controls, Wallet reopen assertions and original owner/vault
generation fences survive the extracted UI models. New Drive file routes enforce
Shared content admission; reset and deletion explicitly erase processing approval.

**All local core stages pass on that unchanged revision**, after focused retries
for isolated database setup: 21,737 parallel passes, 1,215 serial passes, the complete
26-case refused-fixture modules, and 396 additional real PostgreSQL cases. The
parallel/serial runs retained 195/358 conditional or environment skips; the additional
run exercises the dedicated-URL fixtures. Every test imports (29,899 collected).
Web-core, MCP package verification and integration pass, including 191 frontend and
396 backend PKM cases. Original refusals remain recorded; passed suites were reused.
Local PostgreSQL is version 14; hosted CI owns version 17 and browser-layout parity.

Focused authority, Back, recovery and negative controls also pass. No assertion,
consent gate or global architecture budget was weakened. Reviewed exact debt ceilings
retain the historical findings and 500/250/80 budgets. Canonical `.agents` sources
retain 45 governed skills, 22 practices, 19 lanes and 40 workflows behind checked
adapters. All 209 maintained diagrams render; changed maps were visually inspected.
The private-pod Wiki correction persisted and passed readback. Test databases close
after use; the existing browser and peer database remain untouched. No new hosted CI,
push, pod installation or environment deployment is claimed by these local receipts.

Files recovery now persists provider-confirmed cancellation before later checks and
retains it across failure/restart. Exact-session HTTP 410 is a separate invalidation
proof; HTTP 404/412 remain refused. Focused boundary checks pass. Gmail restart
continuation now runs after authority recovery without blocking foreground admission;
it retains an update permit and is cancelled and joined during shutdown.
These changes are not deployed and do not establish a successful live erasure or
a new cold-start percentile.

The Browser-first working slice preserves issuer expiry, normalizes only observed
Azure readback defaults, rejects JSON type substitution and closes failed-probe
scratch. Focused boundary checks and negative controls pass; original scalar-type
and scratch-lifecycle defects are independently reproduced. All 107 focused native/authority cases and ten CI partition cases pass: analytics' non-Vitest checks remain and
Siri runs once. Required security/browser/migration gates and architecture budgets
remain unchanged. This slice is not the final core-frozen or deployed candidate.

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

The [local normal-release transition plan](../../future/personal-agent/NORMAL-RELEASE-TRANSITION.md)
records CI consolidation, Shared continuity and changelog promotion. The completed
candidate must pass the approved gates before a governed dev rollout; main, UAT,
production and stable publication remain separate decisions.

1. **P0 Engineering:** qualify the combined Browser owner journey and Azure host lifecycle; public-pilot ports and protected packaged-image execution now have separate evidence. Finish the public-research MVP before advanced browser features or all-family scheduling. The historical app release/readback is complete. A fresh pod image must remove the deliberate Dev 25 reuse pin, qualify recovery from the actual installed digest and use exact owner approval. Do not describe the reused image as the new source.
2. **Engineering + Operations:** finish retained synthetic erasure, the approved GCP bridge owner journey and recorded commands/connectors. Measure startup changes with three cold and three warm samples per cloud; do not claim a new percentile. Keep Browser disabled until each native gate passes.
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
Independent review permits only the specialist test module's 568→575 line ceiling:
the new owner-ADC case covers bridge dispatch plus consent rechecks; the 500-line
budget and production limits are unchanged.
The separate workflow/Admin repair [PR #8121](https://github.com/hushh-labs/hushh-research/pull/8121)
passed protection parity; it grants no application promotion.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and gates belong to the deployment standard.
