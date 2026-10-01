# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
The Files-led matrix below carries the release decision.

**Decision — 2026-10-01: dev application verified; owner Files activation held.**
Dev serves `55681083efbd`. The personal pod remains on its predecessor with
Files disabled. Exact-image synthetic recovery and a disposable cloud
maintenance upgrade passed. Normal Settings-approved installation, real Files
organization and complete Puppy cancellation remain release gates. No main,
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

## Files-led acceptance

| Journey | Verified | Remaining gate / owner |
| --- | --- | --- |
| **Existing-owner Files setup** | Old pod admits directly; Files returns 503 and setup refuses an unqualified predecessor. Isolated recovery now passes. | Release/BYOC: qualify the exact target, then obtain the normal owner's exact Files plan and installation approval. Verify storage, queue, identity and digest. |
| **Files explorer and transfer** | Local paginated move navigation and mobile actions pass. A prior enabled reviewer pod passed interrupted 5 MiB transfer, byte-exact download, rename/undo and trash/restore. | Files: repeat on the newly enabled target, including cold admission and synthetic cleanup. Prior owner/image evidence does not qualify this release. |
| **Files Agent and background jobs** | Canonical `agent_files`, analysis opt-in, exclusions, bounded job/cancellation and original-preservation contracts pass in source. | Files/BYOC: real GCS/KMS/Cloud Tasks/model access, organization outcome, cancellation and missing-billing resume. Local adapters do not prove cloud permissions. |
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
