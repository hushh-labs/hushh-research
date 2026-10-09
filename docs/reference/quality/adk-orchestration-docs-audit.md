# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-09

**Production rollout is withheld.** Both clouds have passed isolated Files,
recovery and bounded runtime qualification. Normal owner-approved installation,
provider/native journeys and the cold-response target still require evidence.
Green CI, a healthy endpoint or a published image cannot replace those receipts.

Finish one integrated candidate on the existing infrastructure branch. Keep
owner resources, selected configurations and trusted identities. No application
merge to main, UAT/production deployment or stable-channel publication is included.
Computer Use and cross-cloud moves remain disabled.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Integrated source | Main `3e0cfd05402f`; frozen local ADK `64c2739df301`; infrastructure `9834286fb0`; concurrent bridge/consent work through `2bcfab273c` preserved | Integrated in isolation. Final core, hosted CI and governed dev deployment remain required. Later unrelated ADK changes belong to the next cycle. |
| Integration corrections | Private email receipts stay on the sealed pod ledger. Partial/uncertain Gmail changes expose confirmed progress and cannot be replayed. Native composer/panel improvements retain pod status, Files, Hosting and Updates | 128 focused backend and 157 frontend checks pass; TypeScript and changed Swift syntax pass. No new cloud behavior is claimed. |
| Startup correction | Pinned semantic model assets and action vectors are packaged offline in the pod image; lazy hub imports preserve route contracts | Source verified; a new image has not been built or measured. No cold-latency improvement inferred. |
| Dev application | Fresh approved-ADC readback **2026-10-09 10:15 UTC**: source `e30732de37f21759e86b95027252163319de3d60`, [deployment 37832290957](https://github.com/hushh-labs/hushh-research/actions/runs/37832290957), backend `00151-9x6`, frontend `00129-bn5`, 100% traffic | Application remains on the earlier source. Rollback: backend `00150-slh`, frontend `00128-8m7`. |
| Serving image digests | Backend `c26db844ba84e0607bcfd40c5953bb7ec211a659c34ecbb20a403ad77f52cd1b`; frontend `c81cef6c080cabf8799a95b2a9e0df89ea9dfdaebfd736c47bbc0db1e1ab6f3d` | GitHub Actions governs; Cloud Build builds immutable images. |
| Pod offer | Dev-only `2026.10-dev.12+caaa5a82fd9c.e213acf2`, image `e213acf2468179177371709fb2651eb622439ec8c2a2df3d11394d23867ffa1e` | Exact predecessor `ace34069` qualified on both clouds. Publishing did not install it on an owner pod. |
| Migration lineage | Main 284–288 preserved; unchanged commerce/Shared SQL registered as 289/290; original 284/287 retained under `db/legacy/` | Shared-dev ledger has neither old ID. Existing commerce preview remains pinned to its own lineage; never replay this candidate there without reconciliation. Recheck target ledger and recovery before deployment. |

## Acceptance matrix

| Journey | Source / isolated evidence | Required live acceptance |
| --- | --- | --- |
| Files workspace | `agent_files`, dedicated explorer; both clouds pass resumable 4 MiB + 1 KiB transfers, duplicate chunks, byte-exact download, folder move/rename/undo and trash/restore | Normal owner browser, exact Files configuration approval and installation |
| Files organization | GCP authenticated Cloud Tasks and Azure managed-identity Storage Queue complete opted-in synthetic jobs; exclusions and cancellation preserve originals | Owner opt-in/UI, provider IAM and actual queue delivery |
| Software updates | Exact `ace34069` → `e213acf2` recovery passes on both clouds: identity, keys, selected configuration and encrypted information retained | Settings approval during active chat; authenticated drain, one operation across refresh/reconnect, restart, installed digest and Files bytes |
| Private chat | Current image completes 20 cold + 20 warm turns per cloud; bounded one/two/four chat–Files–status overlap and ten-minute soak pass | Normal-browser first-token timing, recorded voice and complete connector approval/resume |
| Puppy | Existing Hermes identity/grant; signed Azure endpoint and inference-only binding; post-zero sealed admission in one attempt; idle release and owner-triggered wake pass | Browser inference, server-side cancellation, withdrawal/re-enable and independent active internet paths |
| Setup / billing | Durable retries preserve assignments/pending state; missing billing has recovery links; explicit Shared/unplaced authority is retained | Fresh setup and billing/policy return without duplicate resources on both clouds; Azure subscription eligibility |
| Google connectors | Sealed native authorization, refresh/restart fences, exact reviews, direct notification coalescing and bounded durable jobs | Native iOS/Android sign-in, provider scope upgrades, notifications and approved legacy hub custody removal |
| Existing Shared users | Actual UAT/production cohort inspected; parked 958 captures only eligible legacy users once, excluding assignments, provisioning and prior choices | Additive schema/backfill graduation before production traffic; no production schema mutation occurred |
| Cloud migration | Record-only prototype refuses source-custody memory and retains unresolved recovery/cleanup receipts | Full private key/object transfer, Files/session readability and provider-resource reconstruction are missing; no cloud move is offered |
| Computer Use | Task/preview/takeover, consented PKM ports and encrypted opt-in remembered sessions are source-backed | Separate cloud sandbox/privacy/lifecycle qualification; capability remains disabled |

Qualification configuration: **1 vCPU, 2 GiB RAM, minimum zero, maximum one
instance, one worker**. GCP request concurrency is eight. Azure's HTTP scaler
threshold of eight is not a request cap. Existing owners retain their selected
settings; the personal Azure pod remains **0.5 vCPU / 1 GiB**. Status polling must
not wake compute; the direct relay idle grace is ten minutes.

## Performance and economics

| Measurement | Result | Decision |
| --- | --- | --- |
| GCP cold / warm first text | Cold 20/20, p95 **71.721 s**; warm 20/20, p95 **7.700 s** | Cold p95 ≤30 s target fails; operator admission included, not browser timing |
| Azure cold / warm first text | Cold 20/20, p95 **71.304 s**; warm 20/20, p95 **13.389 s** | Cold target fails; image pull 26.048 s and recovery 3.251 s measured separately |
| Hermes post-zero admission | Challenge **45.532 s**, admission **46.366 s**, sealed WSS **0.532 s**; total owner preflight/control **57.125 s** | Finite challenge wait fixed the observed 30.212 s timeout; this is not first-token or full browser acceptance |
| Bounded runtime | Ten-minute soak settles 20 synthetic operations/cloud; Azure sampled memory 0.500 GiB/CPU 0.092 cores; GCP one-minute p95 memory 20.95% of 2 GiB/CPU 31.95% | Different aggregations; not comparable peak capacity or real Puppy overlap |
| Model qualification | Gemini 3.8 tools 2/3 (504); 3.5 Flash LOW 3/3 tools + 5/6 first-tool; Flash-Lite LOW 3/3 + 5/6 (Drive refusal); Azure Luna 3/3 + 6/6 | Small bounded sample. Governed defaults unchanged. Preserve observed 429/retry failures; qualification estimate $1.96791915 of $2 ceiling |
| Monthly package | 30 billable hours, 50 GiB, 1,500 modeled calls + $5 reserve: **Google/3.8 Flash $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32** | Dated planning estimates, not equivalent quality, invoice or quota. Infrastructure/model rates retain their verified dates and exclusions |

See [whole-package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget).
VM comparisons include disk, IP, image custody, hypothetical wake control and AI.
Equal vCPU labels do not prove equal performance. Open sockets and scale-down
tails extend paid time. Spending thresholds warn without stopping service.

## Reviewed integration debt

At `eb3402499`, 104 exact upstream finding slots and 46 independently reviewed
merge slots were reconciled against frozen source revisions and file hashes.
Budgets (500/250/80), scanner, exclusions and future regression enforcement remain
unchanged. Review found and fixed a Mail account/session race; 43 nearest cases
pass and the original callbacks fail the behavioral negative control. This is a
measured structural-debt baseline, not a readiness or live acceptance receipt.

## Owners and next gate

| Owner | Required receipt |
| --- | --- |
| Engineering / release | One completed core mirror, exact-SHA hosted CI, migration/recovery preflight, governed dev deployment and serving readback |
| Owner / device | Normal Google-authenticated owner browser, memory-only unlock, exact approval; device-session or admin credentials cannot substitute for browser authority |
| Azure subscription | Eligible fresh environment/model resources; existing-environment qualification is narrower |
| Production | Migration/release graduation, actual legacy cohort continuity, IAM, erasure, recovery, hub capacity and independent UAT acceptance |
| Documentation / Wiki | Refresh report using measured results, source/serving distinction and current private Wiki readback; preserve concurrent PDF governance edits |

Operational owners: [Files](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md),
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md),
[cloud-move contract](../architecture/pod-migration.md).

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; CRM remains. Current
Google/Azure choices and cloud-specific gates belong to the deployment standard.

## Files continuation evidence — 2026-09-25

Historical pointer: early source checks were not owner-cloud activation receipts.
Dev history cleanup 944 completed September 28 under
[run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630).
Migration 249 is the public-profile bridge. Current acceptance belongs to the
matrix above; Git history retains the chronology.
