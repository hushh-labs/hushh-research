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
Computer Use and cross-cloud moves remain disabled.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Integrated source | Frozen application `2349b160907f`, containing reviewed main/ADK and concurrent fixes | Local core passes; affected PostgreSQL 769 pass with 38 explicit restored-schema cutover skips. Later root/ADK edits remain outside this serving revision. |
| Hosted CI | [Exact 2349 CI](https://github.com/hushh-labs/hushh-research/actions/runs/38006677635) succeeds; unchanged frontend/browser/native trees have [full 6cda CI](https://github.com/hushh-labs/hushh-research/actions/runs/38004827776) | Backend/security/governance gates were rerun for the exact repair; unchanged browser evidence reused. No gate weakened. |
| Dev application | [Governed dev run](https://github.com/hushh-labs/hushh-research/actions/runs/38007611500) terminal healthy; ADC readback October 10, 00:27 UTC: backend `00154-mjh`, frontend `00132-7mn`, 100% each, matching 2349 provenance | GitHub Actions governs; Cloud Build builds. Prior `00153-nhx` / `00131-6r4` are captured rollback targets. Schema, parity and semantic checks pass. |
| Serving digests | Backend `0997c5173f2adc4935abd252431a377910b96fd0281a64fb769f6997649de1f1`; frontend `c04ca290f6c001f8fac5f3b8db343af867919d65921e421b626914737229485c` | Application serving evidence is separate from owner installation. |
| Personal Azure pod | Held operation completed October 10, 00:31 UTC; exact approved Dev 12 digest `e213acf2468179177371709fb2651eb622439ec8c2a2df3d11394d23867ffa1e`, ready revision `u390d187cc8d1`, matching server-verified release/incarnation receipt | Same service, managed identity, keys/storage selection, min 0/max 1 and 0.5 vCPU/1 GiB retained. HTTP scale threshold 8 and managed-identity Files queue scaler confirmed. No resource resize or offer substitution. |
| Update repair | Null scaler normalization and durable pre-dispatch replacement intent are source-backed; bounded legacy continuation requires exact owner/operation/resource/readback evidence | The original pre-replacement failure remains recorded. Normal owner Microsoft continuation completed the same operation; no lease reset, duplicate approval or reinstallation. Dev 13 is published but not installed and is not qualified for this predecessor. |
| Files interface | Correction verified atop `c3fc60c2cb`: shared Files top bar and reading-width explorer; inline rename, hierarchical Back, secondary Activity/settings, observed retention and requested usage | Local source only: 38 focused frontend cases pass, including dialog closure on vault lock, safe failure feedback and retained transfer recovery hints; 28 Files route/job cases pass across two focused runs, including authority/integrity refusal after upload. TypeScript/lint and architecture ratchet pass. Actual components/CSS at 390/768/1440 px: 0 px list/search gutter mismatch or refresh shift, no overflow, p95 frames 9 ms, zero frames over 50 ms. Synthetic layout ports do not prove cloud behavior; this layout is not yet deployed. |
| Migration lineage | Canonical 249/289–291 preserved; commerce 292, Shared 293 and profile bridge 294 registered | Checksum-pinned dev replay defers destructive 249; no destructive cutover or production migration is claimed. |

## Acceptance matrix

| Journey | Source / isolated evidence | Required live acceptance |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer; both clouds pass isolated transfer/revision tests | **Azure passed:** normal-owner 4 MiB + 1 KiB upload/download interruption and resume; SHA-256 byte match; folder creation, move/undo, trash/restore. Download save adapter was memory-backed for the synthetic test, not OS disk proof. |
| Files organization | Bounded consent, exclusions, delivery and cancellation contracts | **Azure passed:** explicit opt-in, actual managed-identity queue job completed, queued job cancelled with original retained. Excluded upload produced no extra history job. Initial analysis/automatic-off preferences restored. Other owners/cloud journeys remain separate. |
| Software updates | Exact predecessor `ace34069` → `e213acf2` isolated recovery qualifies both clouds | **Azure normal update passed:** exact release approval/continuation, actual restart, installed digest and matching completion receipt. Settings displays verified completion/changelog. Successful active-work drain, live rollback and broader continuity are not established by this idle continuation. |
| Private chat | Current image completes 20 cold + 20 warm turns per cloud; bounded one/two/four chat–Files–status overlap and ten-minute soak pass | Normal-browser first-token timing, recorded voice and complete connector approval/resume |
| Puppy | Existing Hermes identity/grant; signed endpoint and inference-only sealed binding; finite admission and idle grace | **Azure post-update passed:** normal browser response from Gemma 4 12B, fresh sealed admission and device-confirmed cancellation. Initial answer text 52.212 s; follow-up first text 9.847 s. Withdrawal refused new inference grants and closed the relay; re-enable obtained fresh sealed admission and another response in 15.394 s. Idle socket closed, control-plane readback confirmed zero replicas, and one subsequent browser turn woke the same pod: activation 49.892 s, first answer 62.145 s, completion 62.315 s. Independent internet paths remain unverified. |
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
| Engineering / release | Exact 2349 CI, governed deployment and serving readback pass. Azure held Dev 12 update and live Files gates now pass. Files layout correction now includes shared top-bar title, bounded explorer, inline rename, hierarchical Back and audited settings. Local responsive evidence is separate from live acceptance; canonical 249 stays deferred. |
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
The former branch-only profile bridge is now canonical 294; canonical 249 remains
deferred in shared-dev pending separate cutover evidence. Current acceptance belongs to the
matrix above; Git history retains the chronology.
