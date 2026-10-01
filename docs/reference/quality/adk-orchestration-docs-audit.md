# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
The Files-led matrix below carries the release decision.

**Decision — 2026-10-01: disposable Files activation verified; final release held.**
Dev serves `55681083efbd`. The personal pod remains on its predecessor with
Files disabled. Exact-image recovery, disposable maintenance, and normal Files
plan approval/installation passed. Live interrupted transfer and byte-exact
download, move/undo, and automatic organization through the owner-project queue
passed. The final candidate's CI, normal personal image installation and complete
Puppy cancellation remain gates. No main,
UAT, production, stable-channel or automatic owner upgrade is authorized here.

The [One hierarchy](../one/one-agent-hierarchy.md), [Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md) and
[deployment standard](../architecture/deployment-standard.md) own reusable guidance.
Git history retains the earlier chronology; this memo records current evidence.

## Source and serving evidence

- **Application:** [exact-SHA CI 36898355625](https://github.com/hushh-labs/hushh-research/actions/runs/36898355625)
  passed on attempt 2; [governed dev deployment 36905545494](https://github.com/hushh-labs/hushh-research/actions/runs/36905545494)
  succeeded. Backend `consent-protocol-00122-s69` and frontend
  `hushh-webapp-00102-ls2` were independently read back Ready at 100% traffic,
  both on `55681083efbd`. Immutable digests: backend `b560efad…1957d`, frontend
  `03f77655…785d0`. Application rollback targets: `00121-94t` / `00101-tlw`.
  RIA remains degraded as `ria_stage1_query_only`.
- **Next candidate, local:** frozen main `f5ed2eb82fbe` and local ADK
  `1b08a07ebe93` are integrated in isolation. The root's strict memory review,
  Files instructions, pod status and public route boundaries are preserved.
  Dependency owners combine Stripe and the ADK sentence-transformers 6.0
  security pin; projections are regenerated. New relay readiness and disconnect
  corrections require their own exact-SHA CI and pod installation.
  Candidate `d911915a89d7` passed the local core mirror in 252 seconds. Hosted run `36936377095`
  exposed a moved comparison ancestor after main incorporated the frozen ADK
  revision; only the graph's `from_revision` pointer changed on regeneration.
  Actions, breaking-change results and both predecessor histories are preserved.
  The failed run was stopped; its result is retained. Run `36938614085`
  passed protocol and generated-contract gates but failed one phone-test effect
  timing assertion. The corrected test now waits for the effect and preserves
  the actual pending code across revalidation. A live 13 ms issuer-clock lead
  also exposed a browser binding refusal: the pending fix aligns signed issuance
  tolerance with Hermes's 30 seconds while keeping expiry strict. All 32 direct
  endpoint tests pass; the new case fails on the prior code. Neither correction
  is deployed, and the completed candidate needs exact-SHA hosted validation.
  The completed corrections passed the local core mirror in 245 seconds and
  independent review of all 35 affected browser/phone tests. Expiration remains
  strict; the skew tolerance applies only to verified issuance. Generic skill
  routing now selects core before an ordinary push, preserving the dedicated
  full pre-PR gate and hosted full-suite/browser authority.
- **Schema:** dev readback verified migrations 943–946 and source checksums.
  An applied 944 ledger row does not independently prove deletion or recovery;
  the original 249 cleanup remains deferred. Incoming hub migration 262 must
  precede payment-aware Drive reads. This source integration is not its deployment.
- **Offer:** `.10+55681083efbd.9e34284c` names immutable pod digest
  `sha256:9e34284c…d89ba7` and has **no supported predecessor**. The unsafe `.9`
  compatibility claim is withdrawn. The personal owner still runs exact
  predecessor `sha256:1054cdf6…f0392`. Compatibility must identify exact digests;
  an image built after these proofs needs a new target-bound qualification.
- **Recovery:** two probes used the actual predecessor and target images, then
  restarted the target with synthetic encrypted state. No source overlay was
  used. A disposable owner-project maintenance upgrade subsequently recovered
  on the same service with durable identity/key/cursor, private IAM and selected
  hosting preserved. A helper omitted billing attribution; guarded reconciliation
  restored it. One startup attempt failed; an unchanged-configuration retry passed.
  Preserve both receipts. Administrator-seeded phone verification is not SMS
  onboarding evidence, and maintenance is not a normal owner update receipt.
  The disposable owner's normal Files approval initially stopped at queue HTTP
  403. The existing bounded continuation completed all ten bootstrap steps on
  the same approval/operation; the provider revision and digest were read back,
  Files is enabled, and the lease is released. Two operator-helper pin failures
  preceded it and remain recorded; they refused before recovery. Signed direct
  admission, CORS, machine-route restrictions, durable key continuity and
  encrypted settings/list reads passed on that disposable service. Analysis was
  initially off. These receipts do not upgrade or qualify a personal pod.
  Explicit owner opt-in then enabled automatic organization; a new synthetic
  upload completed with an `organized` result through the authenticated queue.
  The browser harness subsequently ended during an execution interruption; its
  memory-only unlock material was not retained. Earlier receipts remain valid,
  but cold unlock, live exclusions/cancellation and post-organization byte
  verification were not performed. Do not reset an owner or infer those results.

## Reviewed integration debt

The fitness baseline is bound to integrated `785019eb2` (main `f5ed2eb82`,
ADK `1b08a07eb`). Independent review classified 101 size regressions: nine
pre-existing root changes, 76 main/ADK changes, three ADK-only changes, ten
shared changes and three previously unrecorded findings. No new dependency or
import-initialization violations were found. Stripe payment routines, Drive
share stores and voice execution remain measured debt; payments stay disabled
pending migration 262 and separate operational acceptance.

The Puppy stream lifecycle is extracted behind the existing route and passes
87 focused tests. Only the replacement ASGI disconnect regression test and the
regenerated action-card catalog receive reviewed size entries beyond that
baseline. Budgets remain 500/250/80; later new or worsened findings still fail.
The baseline does not establish runtime acceptance.

## Files-led acceptance

| Journey | Verified | Remaining gate / owner |
| --- | --- | --- |
| **Existing-owner Files setup** | Disposable normal owner approved the exact Files plan. Queue continuation, installed digest, enabled capability and direct admission passed. Personal predecessor remains unchanged. | Release/BYOC: qualify the newly built target, then obtain the personal owner's exact installation approval. |
| **Files explorer and transfer** | Disposable live 5 MiB interrupted/resumed upload, byte-exact download, rename/undo, move/undo, trash/restore and same-session vault continuity passed on the enabled target. Local paginated move/mobile checks pass. | Files: live exclusions/cancellation, cold recovery, post-organization byte verification and synthetic cleanup. New target needs its own affected checks. |
| **Files Agent and background jobs** | Canonical `agent_files` and source boundary checks pass. Normal owner explicitly opted in; automatic organization of a new synthetic upload completed through real owner-project GCS/KMS, Cloud Tasks and model access. | Files/BYOC: live exclusion/cancellation, original preservation after organization and missing-billing resume. Local fixtures cover faults, not cloud journey acceptance. |
| **Chat, commands and connector review** | Source checks cover queued completion recovery and exact owner/tool approval ledger. | Runtime: fresh cold/warm pod response, recorded command, exact connector review/resume and no duplicate effect. Health is not journey acceptance. |
| **Puppy and machine** | Real normal-owner direct reply; observed model, capacity and jobs. Latest warm device inference completed in about 4.8 seconds. Existing identity/grant preserved. | Device/runtime: live stop receipt, reconnect, independent active internet and cold latency. Browser Cancel alone is not server cancellation; the older cold usability failure remains unresolved. |
| **Update and on-demand runtime** | Historical `.6`→`.8` owner approval/drain/digest passed; new isolated maintenance recovered. Existing hosting preserved. | Release/runtime: normal approved Files installation, Settings/Feed agreement, restart/continuity, bounded overlap, idle grace and measured wake. No new personal installation is claimed. |
| **Production** | No application merge or broader rollout. | Release/security: dev acceptance, migration/channel graduation, production IAM/billing, recovery/rollback and UAT repetition. Capacity remains unmeasured. |

The new ASGI disconnect test sends a real broker request and verifies matching
stop delivery, cleared busy work and released admission. It fails on the prior
unshielded cleanup. Completed streams must not emit a duplicate cancel. This is
local regression evidence; the personal predecessor does not contain the fix.

## Next gate and board alignment

1. Complete this frozen candidate and run the local core mirror once, then
   exact-SHA hosted CI. Deploy through the governed dev workflow; read back
   application and pod-image provenance separately.
2. Qualify the newly built immutable target from the exact predecessor before
   offering normal owner installation. Reuse verified image metadata only through
   the runbook's pinned dev path; never substitute a rebuilt image into old proof.
3. Use one owner acceptance window for Files plan/approval, transfer/organization,
   update/recovery, Puppy and the remaining commands. Record performed outcomes.
4. Project 79: [#5507 Personal GCP Pod simulation](https://github.com/hushh-labs/hushh-research/issues/5507)
   remains **In Progress**. [#6790 Complete ADK orchestration migration and verification](https://github.com/hushh-labs/hushh-research/issues/6790)
   is already closed/Done for its source scope. Historical Puppy cards do not
   close current relay acceptance. No board dates, statuses or comments were changed.

Three affected private Wiki sections were corrected and read back on 2026-10-01.
The two Files/lifecycle sections were subsequently reconciled with the normal
disposable activation and organization receipts; headings, private visibility
and the single terminal Sources section passed readback.
The older Plaid/Mail findings remain with their [vault contract](../kai/plaid-vault-passthrough.md)
and [Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md);
this pod memo does not close their separate rollout or exchange/cache gates.

## GCP-only pod deployment correction — 2026-09-25

Historical anchor: Anypoint pod deployment was removed; `gcp` / `user_gcp` are
the supported modes. The separate CRM connector remains. Current decisions live
in the deployment standard; first-light guidance lives in the dev runbook.

## Files continuation evidence — 2026-09-25

Historical anchor: source checks covered signed admission, encrypted Files,
bounded indexing, isolated migrations, worker erasure and consent. Those checks
were not owner-cloud activation receipts. The Files contract and current matrix
above own subsequent decisions.
