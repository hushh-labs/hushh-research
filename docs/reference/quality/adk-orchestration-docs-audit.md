# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-10

**Production rollout is withheld.** The personal Azure pod completed its exact
owner-approved Dev 12 update. Live Files transfer, reversible changes and queue
organization passed; post-update Puppy inference and cancellation passed. Native
provider journeys, independent-network acceptance, active-work update drain and
the cold-response target still require evidence.
The integrated candidate passed complete hosted CI and now serves on dev.
Both disposable clouds passed recovery from the exact personal predecessor to
the newly built image; normal owner approval and active-work drain remain a
separate acceptance step. Keep
owner resources, selected configurations and trusted identities. No application
merge to main, UAT/production deployment or stable-channel publication is included.
Computer Use and cross-cloud moves remain disabled. The new load-balancer domain
serves TLS and an authenticated, unlocked owner session. Same-image maintenance
restored the personal Azure pod's exact-origin CORS admission. Cloud chat now
completes in that browser; Puppy also completes a streamed local-model response
on the new origin after correcting the standalone relay's certificate trust setup.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Integrated source | `1d88a25b7e47` integrates infrastructure `fac10c796d`, frozen ADK `b5fc73b5c6` and main `89cf5c75f7`; final build settings and upload inputs are verified | All ten concurrent edit hashes are preserved. Later unrelated changes belong to the next cycle. |
| Validation | Exact `1d88a25b7e47` local core passed in 556.97 s, including 736 PostgreSQL cases; [complete hosted CI 38107556332](https://github.com/hushh-labs/hushh-research/actions/runs/38107556332) passed all 19 selected lanes | Browser/native/security gates remain intact. Original failed build and fixture receipts are retained. |
| Dev application | [Governed run 38108838521](https://github.com/hushh-labs/hushh-research/actions/runs/38108838521) succeeded: backend `consent-protocol-00157-85f`, frontend `hushh-webapp-00135-9tq`, both exact `1d88a25b7e47`, 100% traffic and immutable digests | GitHub Actions governs; Cloud Build builds. Pre/post migration guard and candidate health passed. Rollback targets remain backend `00156-rn4` and frontend `00134-sgj`. |
| Pod publication / recovery | Dev 14 image `sha256:cdcf8dc2…ed24839` has original image source `1d88a25b7e47` and publisher `38108838521`. Disposable GCP and Azure qualified exact predecessor `sha256:e213acf2…7ffa1e` through authenticated idle handoff, image replacement, recovery and a new real chat | Keys, configuration and encrypted history retained on both clouds; GCP additionally preserved byte-exact Files content, metadata and preferences. Azure fixture had Files disabled. These are operator fixture receipts, not normal owner approval, active-work drain or rollback evidence. Dev 15 reuses that immutable image and offers only this qualified predecessor. |
| Migration readback | Read-only dev contract: expected schema 304, no missing tables/columns/functions, all 56 parked-manifest checksums match applied rows | Replay does not record every canonical migration in the release ledger. Canonical 249 remains checksum-deferred; no destructive cutover or production migration is claimed. |
| Personal Azure pod | Exact owner-approved Dev 12 digest `e213acf2468179177371709fb2651eb622439ec8c2a2df3d11394d23867ffa1e`; October 10 same-image origin maintenance produces ready revision `o6e5cb5766bed` | Authenticated idle handoff and recovery readback passed. Same service, identity, keys/storage, min 0/max 1, 0.5 vCPU/1 GiB, HTTP threshold 8 and queue scaler retained. Approved old/new origins pass; foreign origin and unauthenticated machine routes refuse. No image upgrade or resize. |
| Update repair | Null scaler normalization and durable pre-dispatch replacement intent are source-backed; bounded legacy continuation requires exact owner/operation/resource/readback evidence | The original pre-replacement failure remains recorded. Normal owner Microsoft continuation completed the same operation; no lease reset, duplicate approval or reinstallation. Dev 13 is published but not installed and is not qualified for this predecessor. |
| Files interface | Correction verified atop `c3fc60c2cb`: shared Files top bar and reading-width explorer; inline rename, hierarchical Back, secondary Activity/settings, observed retention and requested usage | Local source only: 38 focused frontend cases pass, including dialog closure on vault lock, safe failure feedback and retained transfer recovery hints; 28 Files route/job cases pass across two focused runs, including authority/integrity refusal after upload. TypeScript/lint and architecture ratchet pass. Actual components/CSS at 390/768/1440 px: 0 px list/search gutter mismatch or refresh shift, no overflow, p95 frames 9 ms, zero frames over 50 ms. Synthetic layout ports do not prove cloud behavior. The Files correction commit `3a443` is contained in serving source `1d88a25b7e47`; deployed responsive readback remains separate from the local measurements. |
| Migration lineage | Canonical 249/289–298 preserved; pending enrollment 299, commerce 300, Shared choice 301, profile bridge 302, placement-reader foundation 303 and evidenced legacy Shared continuity 304 | Read-only dev ledger has no canonical 290–304 entries; recorded parked checksums match. Pending files were renumbered without changing applied history. Destructive 249 remains deferred; no production migration is claimed. |

## Acceptance matrix

| Journey | Source / isolated evidence | Required live acceptance |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer; both clouds pass isolated transfer/revision tests | **Azure passed:** normal-owner 4 MiB + 1 KiB upload/download interruption and resume; SHA-256 byte match; folder creation, move/undo, trash/restore. Download save adapter was memory-backed for the synthetic test, not OS disk proof. |
| Files organization | Bounded consent, exclusions, delivery and cancellation contracts. **GCP isolated:** authenticated Cloud Tasks organized one synthetic upload in 46.0 s; original bytes verified and analysis preferences restored | **Azure passed:** explicit opt-in, actual managed-identity queue job completed, queued job cancelled with original retained. Excluded upload produced no extra history job. Initial analysis/automatic-off preferences restored. Same-session storage-usage retry returned 200 on the unchanged image after an initial 503; the failed attempt is retained without an invented cause. Fixture evidence does not establish fresh owner sign-in. |
| Software updates | Exact predecessor `ace34069` → `e213acf2` and then `e213acf2` → `cdcf8dc2` isolated recovery qualifies both clouds | **Azure normal update passed:** exact release approval/continuation, actual restart, installed digest and matching completion receipt. Settings displays verified completion/changelog. Successful active-work drain, live rollback and broader continuity are not established by this idle continuation. |
| Private chat | Current image completes 20 cold + 20 warm turns per cloud; bounded one/two/four chat–Files–status overlap and ten-minute soak pass | **New-origin browser passed:** synthetic owner-pod response completed within a 34.6 s observation window without an error. This was not an instrumented cold/first-token sample. Recorded voice and complete connector approval/resume remain separate. |
| Puppy | Existing Hermes identity/grant; signed endpoint, inference-only sealed binding, bounded stream and idle grace. Cancellation-race repair retains an exact transport receipt for 60 seconds, without a new approval ledger; 65 focused cases pass and the broken-path negative control fails | **New-origin Azure passed:** normal browser receives local Gemma 4 12B responses; restarting the same relay returns first text in 2.168 s. Owner withdrawal closes its sealed session and refuses a new turn; re-enable returns another answer in 2.383 s. Prior zero-replica/idle-wake receipts remain valid. **Current image gap:** device cancellation succeeds but its late stop verification can report unconfirmed after disconnect; the candidate repair requires an owner-approved pod installation. Independent internet paths remain unverified. |
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
| New-origin Puppy warm response | Signed admission **1.413 s**, sealed WSS **0.402 s**, local-model first text **7.292 s**, completion **7.294 s** | Normal unlocked owner browser displays the synthetic answer. Missing OS CA roots caused the retained WSS failure; explicit verified trust fixes both relay paths. Nearest Hermes suites pass 60 cases. After restarting the same relay, fresh admission took **1.639 s**, WSS **0.363 s**, first text **2.168 s** and completion **2.169 s**; the normal browser received another finite response. These are two warm samples, not the cold target or independent-network proof. |
| Approved dev bridge | GCP disposable predecessor completes real cloud chat: first text **21.192 s**, completion **27.917 s** after narrowly scoped model grants and same-image authenticated maintenance | One sample, not p95 or clean cold evidence. Native custody remains in the qualification project; the separately approved dev model bridge is not a production model-custody claim. |
| Bounded runtime | Ten-minute soak settles 20 synthetic operations/cloud; Azure sampled memory 0.500 GiB/CPU 0.092 cores; GCP one-minute p95 memory 20.95% of 2 GiB/CPU 31.95% | Different aggregations; not comparable peak capacity or real Puppy overlap |
| Model qualification | Gemini 3.8 tools 2/3 (504); 3.5 Flash LOW 3/3 tools + 5/6 first-tool; Flash-Lite LOW 3/3 + 5/6 (Drive refusal); Azure Luna 3/3 + 6/6 | Small bounded sample. Governed defaults unchanged. Preserve observed 429/retry failures; qualification estimate $1.96791915 of $2 ceiling |
| Monthly package | 30 billable hours, 50 GiB, 1,500 modeled calls + $5 reserve: **Google/3.8 Flash $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32** | Dated planning estimates, not equivalent quality, invoice or quota. Infrastructure/model rates retain their verified dates and exclusions |

See [whole-package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget).
VM comparisons include disk, IP, image custody, hypothetical wake control and AI.
Equal vCPU labels do not prove equal performance. Open sockets and scale-down
tails extend paid time. Spending thresholds warn without stopping service.

## Reviewed integration debt

The October 10 candidate combines infrastructure `fac10c796d`, ADK `b5fc73b5c6`
and main `89cf5c75f7`. Independent review accepted 239 inherited finding slots
and 75 exact integration spans. Calendar selection and Mail dispatch were
extracted into existing-module genes before accepting the combined baseline.
Exact occurrence-ranked values and source hashes are retained in the governed
baseline. Budgets (500/250/80), scanner, exclusions and future regression gates
are unchanged. Final review accepts only four exact-owner regression assertions
and fourteen generated compatibility lines, plus the exact 503-line deployment
fixture span after mandatory formatting. Duplicate provider-binding checks have
a bounded consolidation follow-up under quality contracts. Direct-message timestamp presentation
and the network route catalog are extracted into their existing owners instead
of raising those size allowances. This records structural debt, not live acceptance.

The October 11 synchronization retains the original 2,328 baseline entries and
reviews only 225 changed occurrence-ranked slots against infrastructure
`f0517d5f` and incoming main `14a052a8`: 154 exact main sources, 26 metrics
within the incoming parent's sizes, and 45 bounded combined spans. Independent
backend, frontend/native and deployment reviews inspected the combined spans;
their exact values, parent values, source hashes and reasons are recorded under
`main_synchronization_20261011` in the baseline. The four changed same-named
Drive operation slots remain 1/2/3/5; unchanged slots 0/4 are preserved. No
scanner, budget, exclusion, dependency or import rule changed. A one-line future
growth negative control still fails the ratchet. Required core and hosted CI
remain separate gates; accepting inherited size debt proves neither deployment
nor the scope-payment lifecycle.

The subsequent `5685d52f` hardening is integrated through the same branch.
Seven additional size slots are independently reviewed under
`main_profile_hardening_20261011`: incoming main research/card/fixture spans,
the retained attachment-test union, and the generated compatibility revision.
The owner-bound no-store and sequential Search receipts improve public research
admission; they do not implement selected-owner private model processing. The
feature remains default-off pending that qualification. Capability and Location
schema producers also restore DDL column ordering without changing the required
schema sets or migration head 311.

## Owners and next gate

| Owner | Required receipt |
| --- | --- |
| Engineering / release | Source and live dev build repairs are verified. Publish only the qualified immutable image transition, then prove the normal owner-approved active-work update separately. Azure Dev 12 Files acceptance remains valid; canonical 249 stays deferred. |
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
The former branch-only profile bridge is now pending canonical 302; canonical 249 remains
deferred in shared-dev pending separate cutover evidence. Current acceptance belongs to the
matrix above; Git history retains the chronology.
