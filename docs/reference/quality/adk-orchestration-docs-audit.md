# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-08

**The economical BYOC candidate is integrated on the infrastructure branch.
Dev 9 remains the last verified serving release; no owner upgrade is implied.**
New-owner defaults are 1 vCPU, 2 GiB, minimum zero, maximum one and one worker.
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
| Source | `d496e5ce80d0021ec157844786c4c7aa836c6588`; integrated main `1de271b46fa7`, frozen local ADK `eb76e00af60a`. [Hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/37632160188) passed: 18 jobs, four expected PR-only skips. Supplemental DCO passed. | Later main/ADK and 338 independent dirty leaves are outside this frozen release. Draft PR 7555 conflicts with newer main; no merge occurred. |
| Dev application | [Governed deployment 37654169081](https://github.com/hushh-labs/hushh-research/actions/runs/37654169081) succeeded. Independent readback: backend `consent-protocol-00146-mld`, frontend `hushh-webapp-00124-lp8`, both exact source/run and 100% traffic. Health, provenance, parity and schema passed. | RIA stage-one provider is degraded. Canonical private-placement refusal is verified; it is not command recovery on a pod. |
| Schema / recovery | All 54 dev-manifest migrations, including 944/955/956, are applied with matching checksums; no required schema gap. Isolated restoration preserved retained ciphertext through two schema replays. | Database recovery does not qualify owner-image recovery or production migrations. |
| Pod offer | Serving Dev 9: `2026.10-dev.9+d496e5ce80d0.4c16f7d9`; immutable digest `sha256:4c16f7d941c62c8db17b63c0e7929efa30a4661512d427519681760ec7089783`; exact source and publishing run verified. | Zero qualified predecessor digests. Publication does not install; exact image-pair recovery and normal Settings approval remain mandatory. |

Application digests: backend
`sha256:7d18b84b1881d3e9c02ea914cd0109437665072e90759316ba917812859cd754`;
frontend `sha256:b643c857b276d07e6a8b028db401901b693c6ef6e5dd483f493a302fd8e92ae9`.
Captured rollback revisions remain backend `00144-rs9` and frontend `00123-f6c`.
The [previous failed deployment](https://github.com/hushh-labs/hushh-research/actions/runs/37607407334)
and its mixed serving pair remain historical evidence.

## Journey matrix

| Journey | Source / local evidence | Live gate still open |
| --- | --- | --- |
| Placement / setup | Explicit Shared and `unplaced`; assigned/pending modes preserved. Automatic direct setup checks identity, IAM, exact routes, CORS and admission. | New/existing setup; billing/policy retry without duplicate resources. |
| Private connectors | Sealed native PKCE, credential hydration, declared pod routes and exact approval/resume. Refresh/CAS and account/project transitions fence old readers. | Real provider sign-in, scope upgrade, restart and verified removal of unchanged legacy credentials/readers. |
| Notifications / consent | OAuth-project topic, owner-project authenticated subscription, durable coalescing/checkpoints, incarnation-bound revocations and signed metadata feeds. Nav receives owner authority. | Cloud provisioning, duplicate/lost delivery, renewal, queue drain and idle return. Reserved/commercial scopes retain canonical authority. |
| Files | Dedicated `agent_files` and `/one/files` explorer; GCS and Azure Blob/Queue adapters, consented organization and exact upgrade checkpoints. | Both-cloud transfer, queue completion and organization on the new executable image; predecessor recovery qualification before owner installation. |
| Puppy | Existing trusted identity and signed direct stream retained; prior response/cancellation/withdrawal receipts. The existing Hermes relay is running in metadata-only activation wait. | Fresh binding/response, independent active internet, acceptable cold latency and bounded overlap. A waiting process or heartbeat is not inference acceptance. |
| Updates / recovery | Exact owner approval, durable operation, authenticated drain and shared Settings/Feed state. | Actual predecessor pair, active-work handoff, one restart, digest/recovery verification and continuation. Historical Dev 4/5 success does not qualify Dev 9. |
| Release experience | Existing dev accounts receive concise notes after unlock/setup; new/unknown accounts skip catch-up. Installed-pod notes require exact retained completion receipts. Hosting is untouched. | Actual owner-update receipt and production announcement/cohort qualification. Acknowledgement is per owner/installation, not a global cross-device receipt. |
| Computer Use | Pod task runtime, scoped PKM, separate processing/disclosure reviews, preview/takeover and encrypted origin-bound remembered sessions with race-safe Forget. | Both execution gates remain closed. No real owner information or remembered login was admitted. |

## Blockers and next evidence

| Owner | Required next evidence |
| --- | --- |
| Release / recovery | Isolated synthetic authority qualifies image-pair recovery separately from normal-owner Settings approval. Dedicated reader access is repaired. A fresh GCP fixture has verified recovery infrastructure and the immutable predecessor; Azure's Free Trial subscription refuses a second Container Apps environment. Resolve that account prerequisite without changing the existing personal pod. |
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
These receipts establish storage and bounded recovery, not normal-owner Settings
approval, organization or concurrent chat. Chat returned provider 403 without text;
model and latency acceptance remain unverified.

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
| Gemini 3.8 Flash native tools | 2/3; one HTTP 504 after 28.64 seconds; no 429 | Completion, first-tool quality and capacity remain unqualified. |
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
