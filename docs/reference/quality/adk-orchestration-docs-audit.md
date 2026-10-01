# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). The
Files-led matrix below carries this revision-bound decision.

**Decision at 2026-10-01:** Dev still serves baseline `830f1f94c`;
the refreshed candidate `55681083e` passed exact-SHA CI and its governed dev deployment is running. **Hold existing-owner Files activation and main, UAT, production, and
stable-channel promotion.** The personal pod still serves its prior image with
Files disabled. A published dev offer does not install or configure it.

This revision-bound memo is not a fleet register. The [One hierarchy](../one/one-agent-hierarchy.md),
[private Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md), and
[deployment standard](../architecture/deployment-standard.md) own reusable
contracts and operator steps. Git history retains the earlier audit chronology.

## Decision evidence

- **Serving baseline:** `830f1f94c`, [CI 36792703786](https://github.com/hushh-labs/hushh-research/actions/runs/36792703786),
  [dev deployment 36794526362](https://github.com/hushh-labs/hushh-research/actions/runs/36794526362).
  Independent readback found backend `consent-protocol-00121-94t`
  (`sha256:a05f5db2…cf009`) and frontend `hushh-webapp-00101-tlw`
  (`sha256:1aa4eeee…07c7e1`), both Ready at 100% traffic. Rollback targets:
  `consent-protocol-00120-6gz` and `hushh-webapp-00100-xnh`.
- **Refreshed source:** branch commit `62535afa7`, local integration `5daeb48ab`
  with main `599d3ec36`. Local ADK `f2b571762` was inspected: its main Drive
  bundle is integrated; its unrelated iOS test and generated projections are
  not copied over pod-owned contracts. One's composed instruction needed a
  small budget correction and regeneration. Focused boundary/UI/migration
  checks passed after that correction. The complete local core mirror passed
  in 382 seconds, including 8,453 backend tests and the PKM upgrade gate;
  [exact-SHA hosted CI 36898355625](https://github.com/hushh-labs/hushh-research/actions/runs/36898355625)
  passed against `55681083e` on attempt 2. A bounded failed-job rerun resolved
  the browser dependency-install timeout and editor-performance failure;
  no gate was weakened. [Dev deployment 36905545494](https://github.com/hushh-labs/hushh-research/actions/runs/36905545494)
  is running; serving acceptance and owner installation remain unverified.
- **Schema and release:** the 2026-10-01 readback confirmed 943–945 applied
  with checksums matching source;
  source migration 946 fixes exact Files selection at pod claim, and 261
  carries Drive background defaults. Their live application remains unverified.
  Cleanup 944 is already recorded as applied; that ledger row alone does not
  prove its deletion and recovery outcomes. The original migration 249 cleanup
  remains deferred. Published `.9`
  lists predecessor `sha256:1054cdf6…f0392` without isolated image-level recovery
  proof; zero approvals/leases were observed at the last read. Source `.10`
  has **no supported predecessor**. Recheck before deployment and verify the
  unsafe offer is withdrawn when the new hub serves. No automatic installation.
- **Owner and fixture:** the existing owner pod remains on that predecessor,
  Files disabled, minimum zero, maximum one, one worker and concurrency eight.
  A helper configuration typo left the first disposable fixture in a retained
  failed dry-run attempt; no pod or substrate was created. That attempt is
  preserved. A fresh isolated fixture now serves the exact predecessor:
  authenticated identity/key reads pass, anonymous invocation returns 403,
  and the existing collector recorded `provisioned`. Fixture network ingress
  was aligned with dev without changing its template or private IAM.
  Administrator-seeded phone
  verification is not SMS onboarding evidence. Exact old-image → new-image
  cloud recovery remains the Files activation gate.

## Files-led acceptance matrix

| Area | Dated evidence and classification | Blocking proof / accountable owner |
| --- | --- | --- |
| **Existing-owner Files setup** | **Blocked.** The normal owner browser admitted to the old pod, but list returned 503 and the old release plan returned 409. The new offer is published; no image, bucket, queue, worker or owner configuration changed. | Files and release owners: prove old-image → new-image encrypted recovery in an isolated cloud pod, then use the normal owner's exact Files plan and approval. Verify installed digest, configuration and retained information. An image-only approval cannot enable Files. |
| **Files workspace and transfer** | **Local UI accepted; live target pending.** The move picker reaches paginated nested folders and mobile actions remain usable at 320–1280 px. Focused Files tests passed. A prior already-enabled reviewer pod passed interrupted 5 MiB upload/resume, byte-exact download, rename/undo and Trash/restore. | Files browser/pod owners: repeat cold admission, list, transfer and cleanup on the newly enabled owner pod. The prior reviewer transfer does not prove this image, owner cloud or normal enrollment. |
| **Files Agent, billing and recovery** | **Source/CI accepted; cloud recovery pending.** Opt-in, exclusions, bounded jobs, same-project billing retry and configuration approval exist; synthetic tests passed. The replacement disposable predecessor pod is provisioned with private IAM; this is not an upgrade or Files recovery receipt. Exact Files selection and pending-cloud admission corrections await serving verification. | Files and BYOC owners: prove real GCS, KMS, Cloud Tasks and model access, organization/cancellation, missing-billing return, and uncertain-step recovery on disposable setup. Preserve originals and record target-bound receipts. |
| **Chat, commands and connectors** | **Source/CI accepted; new live turns pending.** Queued chat delivery now checks status before resend. Owner-private MCP calls retain owner authority; review-required calls retain the exact one-use ledger. A historical cold browser wait timed out before a roughly 131-second pod completion. | Runtime/agent owners: measure fresh cold and warm turns, recorded command completion and a safe review-required connector approval/resume fixture. Do not infer those journeys from a 200 health response. |
| **Puppy and machine report** | **Partial live acceptance.** A normal owner browser completed a synthetic local-model reply (60.4 seconds overall; 42.1 seconds pod stream) and displayed model/spec/jobs. A later Cancel removed the UI wait but the stream continued; server-side cancellation was not established. Browser cancellation after response headers is corrected in source, and the committed Hermes client includes admission-permit cleanup. | Device/browser owners: restart the exact dev client, prove cancellation after headers and pod work release, reconnect, and independent-internet access. A dated heartbeat is an observation, not a live resource reading. |
| **Updates and bounded runtime** | **Prior `.6` → `.8` owner update accepted.** Active-work drain, duplicate approval coalescing and installed digest were observed then. The new `.9` release has not been installed. | Release/runtime owners: prove exact owner-approved Files update, recovery, Settings/Feed agreement, bounded overlap, idle grace and wake. Do not describe the new release as installed or scale-to-zero as measured. |
| **Production promotion** | **Blocked.** A dated production IAM check found `deploy_authority_drift`. No application main merge, UAT/prod deployment or stable release occurred. | Governance/release owners: reconcile IAM, graduate migrations and release channels, prove billing/recovery and repeat Files, updates and Puppy in UAT. Resolve the degraded RIA dependency separately. |

The 2026-09-24 Plaid passthrough and Mail/Drive findings were source audits,
not rollout receipts. Keep their separate gates with the
[Plaid vault contract](../kai/plaid-vault-passthrough.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md).
The inspected [Plaid client](../../../consent-protocol/hushh_mcp/integrations/plaid/client.py)
still has a generic network retry around POST, and the
generic Kai proxy (`hushh-webapp/app/api/kai/[...path]/route.ts`)
still rebuilds JSON without forwarding the backend vault route's `no-store`
header. Their owners must verify single-use exchange recovery and browser-facing
cache policy before making those claims; this pod decision does not close them.

## Accountable next gate

1. **Files and pod-release owners:** use the disposable dev owner and isolated
   project to prove the exact installed predecessor image can
   hand off to the published candidate image and recover encrypted information.
   Existing reviewer and personal resources are not rehearsal fixtures.
2. **Normal owner approval, after recovery proof:** obtain the read-only Files configuration plan,
   verify its owner, pod incarnation, resources and immutable image, then use
   the existing owner approval and durable update operation. Confirm the same
   service and selected compute, encrypted storage, keys, recovery prefixes,
   installed digest and `POD_FILES_ENABLED` on readback. No reviewer-session
   self-enrolment or implicit Shared fallback is an acceptable shortcut.
3. **One dev acceptance window:** repeat cold Files read, transfer, organization,
   opt-in/exclusion, billing resume, chat, recorded command, exact connector
   review, Puppy, update/restart and bounded idle/wake. Keep private receipts
   in their restricted owner workflow; publish only sanitized outcomes.
4. **Production gate:** complete independent-network Puppy and device cancellation,
   hub load/soak, production IAM provenance, migration/recovery and UAT. Only
   then reconsider main or broader rollout. Each future row remains
   **unverified** until its target-bound result is recorded.

## GCP-only pod deployment correction — 2026-09-25

This heading preserves the historical link. The 2026-09-25 source correction
removed Anypoint as a pod deployment target. Managed `gcp` and owner-project
`user_gcp` are the supported deployment modes; `null` is inert. Unsupported
persisted targets fail closed. The separate CRM connector remains in scope;
no AWS or Azure pod adapter or cloud-resource change followed from that docs
correction. The [deployment standard](../architecture/deployment-standard.md)
owns the current decision. The 2026-08-11 first-light observations on
asynchronous API readiness, exact GCP IAM and rendered-service checks now live
in the [dev runbook](../operations/dev-pod-first-light-runbook.md#owner-project-first-light-checks-2026-08-11-rehearsal).
The [recovery guide](../operations/pod-backup-and-recovery.md) retains the
conditional first-boot key and custody lesson. Neither dated rehearsal proves
fleet-wide recovery or Files readiness.

## Files continuation evidence — 2026-09-25

This heading preserves the historical link. At the 2026-09-25 Research source
checkpoint, focused tests exercised signed browser admission/renewal,
encrypted Files storage and bounded folder-index rebuilding, isolated-schema
migration restoration, queue/worker erasure and consent regressions. They
established source contracts, not deployed schema, live erasure or owner Files
activation. The [Files runbook](../operations/private-files-library.md) owns
the subsequent provisioning and recovery contract. The current matrix
above supersedes that checkpoint for the dev decision; the older tests do not
resolve the installed-image compatibility refusal.
