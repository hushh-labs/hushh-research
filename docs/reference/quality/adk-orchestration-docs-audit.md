# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-08

**Dev 10 is deployed and independently verified at `eff9466572b9`.
GCP isolated image recovery, Files and chat pass. Owner acceptance and Azure
qualification remain distinct gates.**
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
| Source | `eff9466572b9d2b150566b1471ef1a5dfdec097f`; [exact-SHA hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/37738518079) passed. Main `8a0d8a9f8` and frozen ADK `31932bb01ae9` are included. | Later performance corrections have focused evidence; they are not part of this deployed image. |
| Dev application | [Governed deployment 37740744027](https://github.com/hushh-labs/hushh-research/actions/runs/37740744027) succeeded. Independent readback: backend `consent-protocol-00147-tl7`, frontend `hushh-webapp-00125-zb9`, exact source/run, both ready with 100% traffic. | Application release success does not install owner pods or prove their journeys. |
| Schema / recovery | All 55 dev-manifest migrations match, including 957; canonical schema version 284 has no missing required table, column or function. | Isolated database restoration remains separate from owner-image recovery. |
| Pod offer | `2026.10-dev.10+eff9466572b9.20c9d4f2`; immutable digest `sha256:20c9d4f2460cef92d9539938539406f5e363546eb2c5c1cdb65ce60fc3fd139b`; source and publishing run verified. | Published metadata still has zero qualified predecessor digests. The newly completed Dev 9 → 10 fixture evidence does not amend that immutable offer or approve an owner installation. |

Serving application digests: backend
`sha256:a58886614b4dfc7ecd393b2bf4dc5d396f2d9286c7d361d22d200a410053e2fb`;
frontend `sha256:162d595c3829a088d30848518fb75560f13d8a71b22ac65a56ff41503c6de196`.
Rollback targets remain backend `00146-mld` and frontend `00124-lp8` from Dev 9
(`d496e5ce80d0`). Deployment completed in 16m16s, including backend build 271s,
frontend build 148s and only 3s waiting for the parallel frontend build.

## Journey matrix

| Journey | Source / local evidence | Live gate still open |
| --- | --- | --- |
| Placement / setup | Explicit Shared and `unplaced`; assigned/pending modes preserved. Automatic direct setup checks identity, IAM, exact routes, CORS and admission. | New/existing setup; billing/policy retry without duplicate resources. |
| Private connectors | Sealed native PKCE, credential hydration, declared pod routes and exact approval/resume. Refresh/CAS and account/project transitions fence old readers. | Real provider sign-in, scope upgrade, restart and verified removal of unchanged legacy credentials/readers. |
| Notifications / consent | OAuth-project topic, owner-project authenticated subscription, durable coalescing/checkpoints, incarnation-bound revocations and signed metadata feeds. Nav receives owner authority. | Cloud provisioning, duplicate/lost delivery, renewal, queue drain and idle return. Reserved/commercial scopes retain canonical authority. |
| Files | Dedicated `agent_files` and `/one/files` explorer; GCS and Azure Blob/Queue adapters, consented organization and exact upgrade checkpoints. | GCP Dev 10 transfer continuity and authenticated organization passed on a disposable pod. Azure and normal-owner installation still require live acceptance. |
| Puppy | Existing trusted identity and signed direct stream retained; prior response/cancellation/withdrawal receipts. The existing Hermes relay is running in metadata-only activation wait. | Fresh binding/response, independent active internet, acceptable cold latency and bounded overlap. A waiting process or heartbeat is not inference acceptance. |
| Updates / recovery | Exact owner approval, durable operation, authenticated drain and shared Settings/Feed state. | Dev 9 → 10 idle handoff, installed digest, identity, configuration, encrypted conversation and byte-exact Files passed in isolation. Owner Settings approval and active-work drain remain separate. |
| Release experience | Existing dev accounts receive concise notes after unlock/setup; new/unknown accounts skip catch-up. Installed-pod notes require exact retained completion receipts. Hosting is untouched. | Actual owner-update receipt and production announcement/cohort qualification. Acknowledgement is per owner/installation, not a global cross-device receipt. |
| Computer Use | Pod task runtime, scoped PKM, separate processing/disclosure reviews, preview/takeover and encrypted origin-bound remembered sessions with race-safe Forget. | Both execution gates remain closed. No real owner information or remembered login was admitted. |

## Blockers and next evidence

| Owner | Required next evidence |
| --- | --- |
| Release / recovery | Isolated synthetic authority qualifies image-pair recovery separately from normal-owner Settings approval. Dedicated reader access is repaired. GCP Dev 9 → 10 fixture recovery now passes; Azure's Free Trial subscription refuses a second Container Apps environment and OpenAI S0 eligibility. Resolve that account prerequisite without changing the existing personal pod. |
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

The combined local core run at `25858979c` found ten integration failures;
`a40a9c740` corrected route classifications and stale lifecycle fixtures (82 nearest
checks passed). The 16,530 other parallel cases passed; 137 were skipped.
The isolated database lane passed all 645 cases across its initial and resumed
files after using the required local test identity. MCP and 380 integration
checks passed, alongside web-core, secrets and governance. Collection admits
23,417 tests. Hosted validation and the new deployment remain separate receipts.
The prior hosted iOS failure was main-actor starvation in observer registration;
`2f47a849a` preserves the existing concurrent async-test correction. Hosted run
[37733843501](https://github.com/hushh-labs/hushh-research/actions/runs/37733843501)
then refused stale main and the imported five-line privacy-fixture ratchet delta.
The four main commits and that independently reviewed baseline slot are reconciled;
no test or structural budget was removed.

The disposable GCP runtime passed real project/billing setup, signed admission,
authenticated idle handoff and an immutable predecessor-to-Dev-9 image transition.
The pod key and synthetic configuration survived. Live Files then passed a
4 MiB + 1 KiB upload with durable resume, duplicate-chunk idempotency, byte-exact
download, rename/move/undo and trash/restore in 22.5 seconds. Analysis remained off;
storage reported seven-day soft deletion, so trash is not physical deletion.
Automatic organization then completed through authenticated Cloud Tasks delivery
after explicit analysis opt-in; exclusions refused access and cancellation retained
original bytes. Analysis was disabled again after the synthetic rehearsal.
Owner-project inference returned 403. The explicitly approved personal dev model
bridge subsequently completed a real pod turn: first text 26.176 seconds, total
33.336 seconds. Custody and recovery remain in the owner project. A subsequent genuine scale-to-zero wake took 46.662s to admission, 72.792s
to first text and 80.234s total. It misses the 30s target. Native inference was
1.117s; most chat delay was memory/session/request preparation. One sample is
not a p95 result. The later Dev 10 warm response took 24.992s to first text.
Normal-owner Settings approval and bounded concurrent acceptance remain open.

Dev 10 subsequently preserved the same disposable service, key, configuration,
synthetic encrypted conversation and byte-exact 4 MiB + 1 KiB file through image
replacement. Automatic Files organization completed in one authenticated queue
attempt and retained original bytes; cancellation was rechecked separately.
The startup correction reuses custody only within one boot and precompiles
installed dependencies (283 focused cases). Storage pooling keeps each worker
and store separate, rejects cookie persistence and closes refused streams before
credential refresh (184 focused cases); 13 chat boundary cases also pass.
These corrections require their own image and measured latency readback.

The disposable runtime's inherited concurrency of 80 exposed the no-Files renderer
gap. The corrected renderer and Files adapter pass 95 nearest tests, preserving
existing owner sizing and concurrency. Authenticated idle handoff changed only the
disposable fixture to concurrency eight; the image, service identity, 1 vCPU / 2 GiB
and minimum-zero / maximum-one limits were preserved. Sleep/wake and full capacity
qualification remain separate live gates.

Hosted `48721ce9c` found two stale icon assertions and a merged, unused native
environment resolver. The reviewed correction preserves vector/color/route and
native-target guards; all three nearest files passed (28 cases, two existing skips).
Concurrent commerce documentation was preserved. Hosted CI still governs the
final combined revision.

Gmail now queues identifiers into its durable application consumer and settles
only processed deliveries. The frozen migration-956 Scheduler URL reaches the
same authenticated handler as `/pod/tick`; positive and negative route controls
pass. Existing images need the verified release before that correction is live.

- Exact application local core passed in **438 seconds**: 16,094 protocol,
  572 isolated PostgreSQL and 380 integration checks, plus web, governance,
  secrets and MCP. Hosted validation took **26m16s**, led by iOS at **24m21s**.
  Four manual-run PR-only jobs were intentionally skipped; DCO passed separately.
- Dev's active deployment job took **16m54s**; created-to-terminal was **18m23s**.
  Backend Cloud Build took 318 seconds; frontend took 143 seconds. These measure
  deployment, separately from source CI and owner installation.
- The corrected semantic verifier passes 16 nearest cases; its old predicate
  fails four private-mode controls. HTTP 401/503 and unrelated/contradictory 409s
  still block. The live private refusal explicitly reports recovery unverified.
  The new Drive recheck is fenced before shared exchange: 10 focused cases pass;
  removing the guard fails the existing private-placement control.
- Release notices pass 56 frontend and 74 backend checks, four broken boundary
  controls, 24 Chromium/WebKit responsive/theme states and two-tab behavior.
  These are synthetic UI checks, not owner-cloud or production acceptance.
- The bounded dev/UAT timing review supports scope-aware comparison. Only proven
  duplicate targeted selection was consolidated; security, browser, native,
  migration and provenance gates remain. See [dev timing](../operations/dev-fast-lane.md#deployment-duration-and-independent-work).

### Reviewed integration debt

At integrated source `27375a3d2`, the unchanged ratchet identified 99 imported
ADK findings and 53 composition findings. The review preserves exact source and
per-finding rationale in [the baseline](./architecture-fitness-baseline.json).
Bounded Gmail history, Azure custody/configuration and Files-adapter extractions
resolve six findings and tighten one. The remaining 46 are individually reviewed
coupled authority, lifecycle, merge and core-test additions. This is visible debt;
500/250/80 budgets and the full new-or-worsened gate remain unchanged.
Compatibility facades retain existing callers. Nearest checks passed (107
Gmail/Azure checks, 76 Azure lifecycle checks and 40 Files/setup checks; overlapping
suites are not additive). Prior source rendered 181 Mermaid figures; that dated
result is not cloud acceptance.

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
| Gemini 3.8 Flash | Native tools 2/3; one HTTP 504. Current first-tool roster 5/6, with email delegation missed; no 429 | Six bounded cases cost an estimated $0.0887, within the $2 stage ceiling including the conservative prior-use reserve. Not qualified to replace the governed default. |
| Azure GPT-6 Luna | Catalog and synthetic deployment succeeded; operator inference returned 401 on both models | Pod-native console probe produced no rows; neither success nor inference refusal. Temporary role/deployment removed with absence readback. |
| Resources | Local boot 3.07 s / 281.5 MiB; 64 MiB Files with 4 MiB encrypted chunks, 1/2/4/8 transfers, byte-exact, peak 601.8 MiB. Azure low-load maximum 369.6 MiB | No constrained combined-cloud workload, cold-start p95 or quota proof; edge 404s are not feature evidence. |

Whole monthly estimates at 30 billable hours, 50 GiB and 1,500 modeled calls are
$38.69 Google/Flash and $18.74 Azure/Luna, including a $5 planning reserve.
Different models are not equivalent quality. [Package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget)
include disks, retained addresses and a hypothetical wake service. Model calls,
resource hours and scale-down tails remain separate meters. Promotional credits
and invoices still need reconciliation; Computer Use is excluded and separately
gated. The matched qualification target is 1 vCPU / 2 GiB; existing selections
remain authoritative. Twenty cold/warm samples per cloud, bounded overlap and
idle return remain required. No observed 429 establishes quota capacity.

## Next gate and historical boundaries

One normal-owner window must prove setup/provider transitions, Files, direct
Puppy, exact update/recovery and bounded wake/idle behavior on the qualified image.
Computer Use acceptance remains separate for each cloud. The dated dev release
receipts above remain historical; the combined candidate requires its own CI,
deployment and journey receipts.
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
