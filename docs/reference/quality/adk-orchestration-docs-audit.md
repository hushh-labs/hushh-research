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
Finish one integrated candidate on the existing infrastructure branch. Keep
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
| Integrated source | Candidate base `2bd5b0b0ba` integrates infrastructure `fac10c796d`, frozen ADK `b5fc73b5c6` and main `89cf5c75f7`; final repairs preserve owner admission, Calendar grant fencing and payload-based hub route classes | Final exact-SHA hosted CI and deployment remain required. Concurrent PDF/host edits are excluded and hash-preserved. |
| Validation | Exact `3e02cb4aba` local core passed: 17,358 unit, 475 PostgreSQL and 387 integration cases, plus MCP, governance and web build. [Hosted run 38098149334](https://github.com/hushh-labs/hushh-research/actions/runs/38098149334) found stale Feed/native fixtures and three browser-fixture merge defects | Repairs retain actual-component geometry, native-region coverage and authorization gates. The repaired candidate needs its own terminal hosted success before deployment. |
| Dev application | October 10 ADC readback: backend `consent-protocol-00156-rn4` and frontend `hushh-webapp-00134-sgj`, both at `5b72e7ee0f`, 100% traffic; [governed run 38057783264](https://github.com/hushh-labs/hushh-research/actions/runs/38057783264) succeeded | GitHub Actions governs; Cloud Build builds. Previous mixed-serving and failed DNS receipts are retained. These revisions do not contain the frozen candidate. |
| Update discovery | Serving dev hub has no pod image/release offer configured. An application-only deploy replaced its environment without retaining these two fields | Source repair validates the immutable offer from the single serving revision and preserves its original provenance. Restore discovery through governed publication; no owner installation is implied. |
| Serving digests | Backend `53b708531404d6b66320feb6a352517c5461e932c8caf0d3873657733c1f5aa2`; frontend `2919a575723014a061d0837620f1dea81f0f9f69c4b8de6bc2801585bf8991ea` | Application serving evidence is separate from owner installation. |
| Personal Azure pod | Exact owner-approved Dev 12 digest `e213acf2468179177371709fb2651eb622439ec8c2a2df3d11394d23867ffa1e`; October 10 same-image origin maintenance produces ready revision `o6e5cb5766bed` | Authenticated idle handoff and recovery readback passed. Same service, identity, keys/storage, min 0/max 1, 0.5 vCPU/1 GiB, HTTP threshold 8 and queue scaler retained. Approved old/new origins pass; foreign origin and unauthenticated machine routes refuse. No image upgrade or resize. |
| Update repair | Null scaler normalization and durable pre-dispatch replacement intent are source-backed; bounded legacy continuation requires exact owner/operation/resource/readback evidence | The original pre-replacement failure remains recorded. Normal owner Microsoft continuation completed the same operation; no lease reset, duplicate approval or reinstallation. Dev 13 is published but not installed and is not qualified for this predecessor. |
| Files interface | Correction verified atop `c3fc60c2cb`: shared Files top bar and reading-width explorer; inline rename, hierarchical Back, secondary Activity/settings, observed retention and requested usage | Local source only: 38 focused frontend cases pass, including dialog closure on vault lock, safe failure feedback and retained transfer recovery hints; 28 Files route/job cases pass across two focused runs, including authority/integrity refusal after upload. TypeScript/lint and architecture ratchet pass. Actual components/CSS at 390/768/1440 px: 0 px list/search gutter mismatch or refresh shift, no overflow, p95 frames 9 ms, zero frames over 50 ms. Synthetic layout ports do not prove cloud behavior. The Files correction commit `3a443` is contained in serving revision `5b72e7ee0f`; deployed responsive readback remains separate from the local measurements. |
| Migration lineage | Canonical 249/289–298 preserved; pending enrollment 299, commerce 300, Shared choice 301, profile bridge 302, placement-reader foundation 303 and evidenced legacy Shared continuity 304 | Read-only dev ledger has no canonical 290–304 entries; recorded parked checksums match. Pending files were renumbered without changing applied history. Destructive 249 remains deferred; no production migration is claimed. |

## Acceptance matrix

| Journey | Source / isolated evidence | Required live acceptance |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer; both clouds pass isolated transfer/revision tests | **Azure passed:** normal-owner 4 MiB + 1 KiB upload/download interruption and resume; SHA-256 byte match; folder creation, move/undo, trash/restore. Download save adapter was memory-backed for the synthetic test, not OS disk proof. |
| Files organization | Bounded consent, exclusions, delivery and cancellation contracts | **Azure passed:** explicit opt-in, actual managed-identity queue job completed, queued job cancelled with original retained. Excluded upload produced no extra history job. Initial analysis/automatic-off preferences restored. Same-session storage-usage retry returned 200 on the unchanged image after an initial 503; the failed attempt is retained without an invented cause. Other owners/cloud journeys remain separate. |
| Software updates | Exact predecessor `ace34069` → `e213acf2` isolated recovery qualifies both clouds | **Azure normal update passed:** exact release approval/continuation, actual restart, installed digest and matching completion receipt. Settings displays verified completion/changelog. Successful active-work drain, live rollback and broader continuity are not established by this idle continuation. |
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

## Owners and next gate

| Owner | Required receipt |
| --- | --- |
| Engineering / release | Prior 2349 acceptance is retained; the combined candidate still needs its own exact-SHA CI, governed deployment and serving readback. Azure held Dev 12 update and live Files gates now pass. Files layout correction now includes shared top-bar title, bounded explorer, inline rename, hierarchical Back and audited settings. Local responsive evidence is separate from live acceptance; canonical 249 stays deferred. |
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
