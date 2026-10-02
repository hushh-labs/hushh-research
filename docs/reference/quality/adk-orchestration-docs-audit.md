# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
The Files-led matrix below carries the release decision.

**Decision — 2026-10-01: integrated dev candidate verified; owner installation held.**
Dev serves `be747f06168b`. The personal pod remains on its predecessor with
Files disabled. Exact-image recovery, disposable maintenance, and normal Files
plan approval/installation passed. Live interrupted transfer and byte-exact
download, move/undo, and automatic organization through the owner-project queue
passed. Target-bound recovery passed. Qualified-offer publication, normal personal image
installation and complete Puppy cancellation remain gates. No main,
UAT, production, stable-channel or automatic owner upgrade is authorized here.

The [One hierarchy](../one/one-agent-hierarchy.md), [Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md) and
[deployment standard](../architecture/deployment-standard.md) own reusable guidance.
Git history retains the earlier chronology; this memo records current evidence.

## Source and serving evidence

- **Application:** [exact-SHA CI 36942837069](https://github.com/hushh-labs/hushh-research/actions/runs/36942837069)
  and [governed dev deployment 36945406853](https://github.com/hushh-labs/hushh-research/actions/runs/36945406853)
  succeeded. Independent readback confirmed backend `consent-protocol-00123-z2h`
  and frontend `hushh-webapp-00103-l8d` at 100% traffic on `be747f06168b`.
  Immutable digests: backend `720629cc…78664`, frontend `70df50f3…ea7a06`.
  Rollback targets remain `00122-s69` / `00102-ls2`. Provenance, runtime parity,
  schema and semantic checks passed; RIA remains `ria_stage1_query_only` degraded.
- **Integrated candidate:** frozen main `f5ed2eb82fbe` and local ADK
  `1b08a07ebe93` are preserved in `be747f06168b`. The local core mirror passed
  in 245 seconds; [full hosted CI 36942837069](https://github.com/hushh-labs/hushh-research/actions/runs/36942837069)
  passed on that exact SHA. The phone revalidation regression and signed binding
  clock-lead refusal are corrected, including negative controls. The prior two
  failed hosted results remain recorded; neither was accepted as green.
  [Dev deployment 36945406853](https://github.com/hushh-labs/hushh-research/actions/runs/36945406853)
  completed. Owner installation remains separate from application deployment.
- **Schema:** the dev pre/post-deploy schema gates passed, including migration
  262's payment tables. Payments remain disabled and unaccepted operationally.
  Earlier 943–946 checks remain recorded; an applied 944 row does not prove
  destructive-history recovery. The original 249 cleanup remains deferred.
- **Offer:** published `.1+be747f06168b.d02509f1` names immutable pod digest
  `sha256:d02509f1…9d23f` with **no supported predecessor**. The personal owner
  still runs exact `sha256:1054cdf6…f0392`. Cloud Build `82d767a5` passed actual
  predecessor → exact target → target restart: encrypted Files integrity,
  session continuation, identity, revocation, memory and PKM summary recovery.
  This uses synthetic local adapters inside the images, not owner-cloud IAM or
  normal installation. The reviewed `.2` descriptor qualifies only that exact
  predecessor and pins the original archive/image for reuse without rebuilding.
  Its publication and personal Settings approval have not yet occurred.
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
| **Existing-owner Files setup** | Disposable normal owner approved the exact Files plan. Queue continuation, installed digest, enabled capability and direct admission passed. Personal predecessor remains unchanged. | Release/BYOC: publish the exact qualified offer, then obtain the personal owner's exact installation approval. |
| **Files explorer and transfer** | Disposable live 5 MiB interrupted/resumed upload, byte-exact download, rename/undo, move/undo, trash/restore and same-session vault continuity passed on the enabled target. Local paginated move/mobile checks pass. Cancellation feedback now follows the returned job state; the regression fails on prior code. | Files: live exclusions/cancellation, cold recovery, post-organization byte verification and synthetic cleanup. New target needs its own affected checks. |
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

1. Publish the reviewed compatibility descriptor and cancellation feedback through
   exact-SHA CI and the main-owned dev workflow. Reuse the qualified immutable
   pod image; no second pod-image build is needed.
2. Verify the same target digest and exact predecessor in the serving offer, then
   use normal owner Settings approval. Never substitute a rebuilt image into proof.
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
