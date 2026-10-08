# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-08

**Dev 11 is deployed and independently verified at `3ab8992ec034`.
GCP isolated image recovery, Files, 20 warm chats and bounded soak pass.
Azure signed admission and encrypted Files transfers pass on a disposable app.
Cold latency and normal-owner acceptance remain release gates.**
New-owner defaults are 1 vCPU, 2 GiB, minimum zero, maximum one and one worker.
GCP request concurrency is explicitly eight, including pods without Files;
an explicit fractional-CPU choice requires concurrency one.
Existing hosting selections remain authoritative. Computer Use stays disabled.

### Candidate changes and verification

- Azure Files now uses owner Blob storage and an identifier-only Storage Queue,
  managed identity and the existing bounded organization worker. Setup selection,
  custody checks, late upgrade checkpoints and dev-only migration 957 are wired.
- Existing Azure pods receive a separately bound Files configuration offer. Fresh
  read-only preflight failures release an unattempted lease; uncertain mutations
  retain recovery authority. No digest is qualified merely by version label.
- Gmail notifications settle only durable processed deliveries. Account rotation
  fences both initial watch creation and later cursor advancement.
- Foreground wake is coalesced; recurring status polling no longer extends paid
  idle. The relay retains its ten-minute grace and existing owner configuration.
- Frozen ADK `31932bb01ae9` includes main `5774656cba82`; concurrent commerce
  `18c3db9ab3b03` is preserved. Gmail keeps migration 283; commerce moves to 284,
  subject to a live ledger check before deployment. Main `8a0d8a9f8` then supplied
  the runtime-prompt packaging and privacy-fixture corrections required by hosted
  freshness; 25 nearest checks passed. The ADK snapshot remains frozen.
- Integrated checks: 198 backend boundary cases, 44 frontend cases and TypeScript
  compilation passed. These establish local behavior, not cloud acceptance.

## Exact release evidence

| Surface | Verified result | Boundary |
| --- | --- | --- |
| Source | `3ab8992ec034f6bfc13de31d254519badabc6719`; [exact-SHA hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/37749515091) passed. Main `bc08971f872a` and frozen ADK `31932bb01ae9` are included. | Later local test/evaluation corrections are separate from the deployed image. |
| Dev application | [Governed deployment 37756665008](https://github.com/hushh-labs/hushh-research/actions/runs/37756665008) succeeded. Independent readback: backend `consent-protocol-00148-9kb`, frontend `hushh-webapp-00126-67p`, exact source/run, both ready with 100% traffic. | Application release success does not install owner pods or prove their journeys. |
| Schema / recovery | All 55 dev-manifest migrations match, including 957; canonical schema version 284 has no missing required table, column or function. | Isolated database restoration remains separate from owner-image recovery. |
| Pod offer | `2026.10-dev.11+3ab8992ec034.f91e6e30`; immutable digest `sha256:f91e6e30835d509e70bec822a7c2abd70a463cb26e3698d959eb132effbe5d80`; source and publishing run verified. | Published metadata has zero qualified predecessor digests. Fixture recovery does not amend that immutable offer or approve an owner installation. |

Serving application digests: backend
`sha256:054da89242b7acdc034913ab37f2583175f9d664266f48a0fc27dc6adf226960`;
frontend `sha256:eb744c15535c95c438c6e9121d227111d28abed5d8377e2ab863af23fa35b104`.
The workflow's preserved predeploy receipt establishes rollback targets backend
`00147-tl7` and frontend `00125-zb9` from Dev 10 (`eff9466572b9`). Deployment
completed in 21m35s. No owner installation or destructive history cutover occurred
in this application deployment.

## Journey matrix

| Journey | Source / local evidence | Live gate still open |
| --- | --- | --- |
| Placement / setup | Explicit Shared and `unplaced`; assigned/pending modes preserved. Automatic direct setup checks identity, IAM, exact routes, CORS and admission. | New/existing setup; billing/policy retry without duplicate resources. |
| Private connectors | Sealed native PKCE, credential hydration, declared pod routes and exact approval/resume. Refresh/CAS and account/project transitions fence old readers. | Real provider sign-in, scope upgrade, restart and verified removal of unchanged legacy credentials/readers. |
| Notifications / consent | OAuth-project topic, owner-project authenticated subscription, durable coalescing/checkpoints, incarnation-bound revocations and signed metadata feeds. Nav receives owner authority. | Cloud provisioning, duplicate/lost delivery, renewal, queue drain and idle return. Reserved/commercial scopes retain canonical authority. |
| Files | Dedicated `agent_files` and `/one/files` explorer; GCS and Azure Blob/Queue adapters, consented organization and exact upgrade checkpoints. | GCP Dev 11 byte-exact continuity and earlier authenticated organization passed. Azure Blob resume, duplicate chunks, move/rename/undo and trash/restore passed (4 MiB + 1 KiB). Azure settings requires the local custody-key correction; organization and owner installation remain unverified. |
| Puppy | Existing trusted identity and signed direct stream retained; prior response/cancellation/withdrawal receipts. The existing Hermes relay is running in metadata-only activation wait. | Fresh binding/response, independent active internet, acceptable cold latency and bounded overlap. A waiting process or heartbeat is not inference acceptance. |
| Updates / recovery | Exact owner approval, durable operation, authenticated drain and shared Settings/Feed state. | Dev 7 → 9 → 10 → 11 chained fixture recovery preserves digest, identity, configuration, encrypted conversation and Files. The last idle handoff reconciled one timed-out operation; no duplicate preparation. Owner Settings approval and active-work drain remain separate. |
| Release experience | Existing dev accounts receive concise notes after unlock/setup; new/unknown accounts skip catch-up. Installed-pod notes require exact retained completion receipts. Hosting is untouched. | Actual owner-update receipt and production announcement/cohort qualification. Acknowledgement is per owner/installation, not a global cross-device receipt. |
| Computer Use | Pod task runtime, scoped PKM, separate processing/disclosure reviews, preview/takeover and encrypted origin-bound remembered sessions with race-safe Forget. | Both execution gates remain closed. No real owner information or remembered login was admitted. |

## Blockers and next evidence

| Owner | Required next evidence |
| --- | --- |
| Release / recovery | Isolated synthetic authority qualifies image-pair recovery separately from normal-owner Settings approval. Dedicated reader access is repaired. GCP chained fixture recovery passes; Azure's Free Trial subscription refuses a second Container Apps environment and OpenAI S0 eligibility. A separate fixture app, identity, key, registry and storage now work using the existing environment without modifying its settings. This is not fresh-environment or model qualification. The authorized disposable subscription API request also returned `NotAllowed`; no subscription was created. Resolve eligibility without changing the existing personal pod. |
| Owner / device | Normal Google-authenticated browser and unlocked vault; native provider flow and a second independent internet path. Google refused the automated Chromium sign-in on October 7; that attempt was stopped. Reviewer-minted sessions and cloud CLI access cannot substitute. The existing Hermes relay is available without re-enrollment. |
| Native / provider | Live iOS authorization and qualified Android public-client registration. Android live opt-in remains false; no client-secret fallback. |
| GCP / browser | Supported non-root worker identity, Chromium sandbox, private broker bridge, denied egress and lifecycle evidence. Required identity switch currently refuses; no unsandboxed fallback. |
| Azure / browser | The earlier bounded preview policy/readback passed; a later read returned 403 and disposable cleanup was confirmed. Worker identity, private bridge, Chromium and enforced isolation remain unqualified. General availability and group membership do not establish execution readiness. |
| Production / placement | Qualify the actual legacy Shared cohort against 955's predicates, then graduate its migration and release channels. Repeat IAM, billing, recovery and product acceptance in UAT. Publish separately reviewed production notes. |

## Existing-user transition

Migration 955 preserves the evidenced legacy Shared cohort only when its `cloud`
setup marker exists and there is no recorded choice, deployment target, detach
history or setup job. Production has not qualified that cohort or graduated 955.
Missing placement alone must not become Shared. Without the migration, unassigned
choice-dependent resolution is unknown; existing assignments remain authoritative.

Preserve assigned pods and pending setup. Existing-account app notes follow normal
unlock and resolved setup; new accounts receive no historical catch-up. Pod notes
follow the exact successful operation, current incarnation and verified installed
digest, independently of a newer offer. Neither notice changes hosting, grants
access or starts an update. The current announcement catalog is dev-only.

## Verification and performance

Candidate `3ab8992ec034` includes main `bc08971f872a` and frozen ADK
`31932bb01ae9`. Concurrent commerce and unrelated PDF work remain preserved.
The local core mirror passed after environment-only fixture resumption:
16,559 parallel protocol cases, 18 affected fixture cases, 645 isolated database
cases and 380 integration cases, plus web-core, secrets, governance and MCP.
These overlapping counts are not a unique-test total. Wallet, deployment and
commerce integration checks passed; the architecture ratchet reports no new or
worsened violations.

[Hosted CI 37749515091](https://github.com/hushh-labs/hushh-research/actions/runs/37749515091)
passed on the exact candidate. Its initial protocol failure was a reproduced
300 ms fixture race. Only failed jobs were resumed; all original successful gates
remain authoritative. The permanent event-based correction passes 167 nearby
cases, a delayed-frame reproduction and a broken-cancellation negative control.
It is a later local test commit, not part of the deployed candidate.

GCP's disposable owner passed real provisioning, signed admission, chained recovery
through Dev 11 and byte-exact Files continuity. Transfers cover 4 MiB + 1 KiB,
durable resume, duplicate chunks, move/rename/undo and trash/restore. Authenticated
Cloud Tasks organization passed after explicit opt-in; exclusions and cancellation
preserved original bytes. Analysis was turned off. Soft deletion is seven days.

| Dev 11 measurement | Observed result | Limit |
| --- | --- | --- |
| GCP warm chat | 20/20 complete; first-text p50 17.000 s, nearest-rank p95 20.277 s | Approved dev Gemini bridge; owner-cloud custody preserved. Earlier interrupted series retained as a failure. |
| GCP genuine cold | Admission 67.742 s; first text 101.005 s; completion 106.120 s | **30-second target failed.** One sample is not p95; prior Dev 10 72.792 s receipt retained. |
| GCP overlap / soak | One, two and four concurrent chat/Files/status operations passed; ten-minute soak settled 20 operations with byte-exact downloads | No real Puppy included. One-minute memory observation ~403 MiB of 2 GiB is not peak memory. |
| Azure Files | 4,195,328 bytes; resumed upload, duplicate chunk, exact download, move/rename/undo and trash/restore passed in 52.628 s | Disposable 1 vCPU / 2 GiB app reuses an unchanged existing environment; custody resources in another region. Settings still returns 503 on the deployed image. |

Two measured defects are fixed locally: Azure's second settings custody check now
uses the same provider-specific key reference as the Files operation; managed
identity queue scaling uses the supported Container Apps `2025-01-01` API.
The latter provisioned the fixture successfully after `2024-03-01` rejected the
scaler identity field.

Local startup changes share one verified scan among existing recovery reducers;
per-turn memory reuses bounded sealed records with fresh custody, verified tails,
owner/incarnation/storage binding and erasure checks. Overflow falls back to full
replay. Unconfigured Gmail watch renewal no longer scans history. This bounds
retained state, not historical startup scan work. Authority, recovery, Azure setup,
Files and queue suites pass (latest affected batch: 166 cases; overlapping earlier
memory suites also pass). No new-image latency improvement is claimed before
serving readback. Remaining performance evidence: 20 cold GCP samples, both Azure
sample sets, mixed Puppy work and idle return on the corrected image.

### Reviewed integration debt

Imported ADK and composition debt remains individually recorded in the
[reviewed baseline](./architecture-fitness-baseline.json). Bounded extractions
resolved six findings and tightened one; the remaining reviewed coupled seams
retain their facades. The 500/250/80 budgets and new-or-worsened gate are unchanged.
Seven bounded local recovery/test size increases received independent authority review and exact source hashes in that baseline; budgets and exclusions are unchanged. Memory composition moved to its existing chat-memory owner, reducing the agent-builder span. Prior rendering of 181 Mermaid figures is dated documentation evidence, not cloud
acceptance. [Dev timing](../operations/dev-fast-lane.md#deployment-duration-and-independent-work)
compares selected services separately from source CI; only measured duplicate
selection was consolidated.

### Historical model and economic qualification — October 7

At `92e9bfd54` plus the named local model/adaptor changes, 80 Files/Azure/erasure,
67 setup/connector, two PostgreSQL selection, three route controls and both
Scheduler receipt cases passed. Those earlier fixtures did not qualify cloud
custody or an owner-image transition. Azure's new-source default is GPT-6 Luna
(`2026-09-22`, Global Standard); the inspected personal deployment still used
GPT-5.6 Luna. Historical first-tool scores were 54/60 and 45–49/60 respectively;
Google's governed default was unchanged.

| Bounded probe | Observed result | Limit |
| --- | --- | --- |
| Flash-Lite native tools | 3/3; valid call IDs/arguments and nonempty result-based answers; no 429 | Approved dev provider, not owner-pod acceptance. |
| Flash-Lite One selection | 4/6 at LOW and MEDIUM; Drive/email delegation missed | Not qualified as One's default. |
| Gemini 3.8 Flash | Native tools 2/3; one HTTP 504. Original first-tool roster 5/6; its legacy email fixture expected a forbidden tool. The corrected admitted mailbox case selected `react_to_message` first and failed the strict first-tool gate; no 429. | The original receipt remains unchanged. Corrected harness rejects inadmissible expectations before a provider call (43 focused checks). Combined conservative reservation and measured calls total $1.6046 against the $2 ceiling. No full task-outcome or default qualification claim. |
| Azure GPT-6 Luna | Actual pod managed identity completed one native tool call and result-based answer in 4.735 s. The second exchange hit 429; its single paced retry also hit 429. | Third exchange and six-case first-tool roster were not run. The corrected console receipt is separate from earlier empty harness results. Synthetic deployment removed; existing GPT-5.6 Luna unchanged. Conservative additional reservation $0.01 leaves the combined qualification budget below $2. |
| Resources | Local boot 3.07 s / 281.5 MiB; 64 MiB Files with 4 MiB encrypted chunks, 1/2/4/8 transfers, byte-exact, peak 601.8 MiB. Azure low-load maximum 369.6 MiB | No constrained combined-cloud workload, cold-start p95 or quota proof; edge 404s are not feature evidence. |

Whole monthly estimates at 30 billable hours, 50 GiB and 1,500 modeled calls are
$38.69 Google/Flash and $18.74 Azure/Luna, including a $5 planning reserve.
Different models are not equivalent quality. [Package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget)
include disks, retained addresses and a hypothetical wake service. Model calls,
resource hours and scale-down tails remain separate meters. Promotional credits
and invoices still need reconciliation; Computer Use is excluded and separately
gated. The matched qualification target is 1 vCPU / 2 GiB; existing selections
remain authoritative. Twenty warm GCP samples and its bounded chat/Files overlap passed; cold GCP,
Azure sampling, real Puppy overlap and final-image idle return remain required. No observed 429 establishes quota capacity.

## Next gate and historical boundaries

One normal-owner window must prove setup/provider transitions, Files, direct
Puppy, exact update/recovery and bounded wake/idle behavior on the qualified image.
Computer Use acceptance remains separate for each cloud. The exact dev release receipts above establish application deployment; cloud
journeys require their own acceptance receipts.
An October 7 readback placed the personal Hermes owner on Azure Dev 7 with
direct readiness and the selected device grant recorded. These are metadata
observations, not new inference, recovery or Dev 9 compatibility receipts.
The isolated restore target is removed. Its restricted recovery point is retained
only until a successful routine backup newer than this release is verified; the
operations owner then deletes that exact rehearsal copy. Existing backups remain.
No main merge, UAT/production deployment, stable publication or automatic upgrade.

Operational owners: [Files contract](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md) and
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md).

Dev history cleanup 944 completed on 2026-09-28 under
[run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630).
Migration 249 is the public-profile bridge. No repeated deletion; a no-op SQL
rollback is not recovery. Earlier cold Puppy and mixed-work failures remain
usability/capacity evidence. Missing measurements are not zero; spending warnings
never stop service.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and their gates belong to the deployment standard.

## Files continuation evidence — 2026-09-25

Historical pointer: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own later acceptance.
