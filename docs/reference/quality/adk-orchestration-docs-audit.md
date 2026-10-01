# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). The
Files-led matrix below carries this revision-bound decision.

**Decision at 2026-09-30:** The combined application candidate is live and healthy
on dev. **Hold existing-owner Files activation and main, UAT, production, and
stable-channel promotion.** The personal pod still serves its prior image with
Files disabled. A published dev offer does not install or configure it.

This revision-bound memo is not a fleet register. The [One hierarchy](../one/one-agent-hierarchy.md),
[private Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md), and
[deployment standard](../architecture/deployment-standard.md) own reusable
contracts and operator steps. Git history retains the earlier audit chronology.

## Decision evidence

Source `830f1f94c` integrates local ADK `01fa7ba7b`, passed one local core
mirror and [exact-SHA hosted CI 36792703786](https://github.com/hushh-labs/hushh-research/actions/runs/36792703786).
The [main-owned dev workflow 36794526362](https://github.com/hushh-labs/hushh-research/actions/runs/36794526362)
finished `healthy`, scope `all`. Independent Cloud Run readback found backend
`consent-protocol-00121-94t` (`sha256:a05f5db2…cf009`) and frontend
`hushh-webapp-00101-tlw` (`sha256:1aa4eeee…07c7e1`) each serving 100%,
Ready, and labeled with that source and workflow. Rollback revisions are
`consent-protocol-00120-6gz` and `hushh-webapp-00100-xnh`. The dev migration
log reports Files migration 943 already applied; the postdeploy schema guard
has zero violations. The dependency check still reports degraded
`ria_stage1_query_only`, outside this Files decision.

The workflow published **dev-only** release
`2026.09-dev.9+830f1f94ca78.eee0035e`, pod image `sha256:eee0035e…2069f`,
with only the personal pod's exact predecessor `sha256:1054cdf6…f0392` in
its compatibility metadata. The owner's same pod still serves that predecessor
at 100%, minimum zero, maximum one, one worker and concurrency eight. Old →
new → old synthetic encrypted-log replay passed, and core recovery and handoff
source is unchanged; no isolated **image-level cloud recovery** rehearsal exists.
Therefore the release is published but **owner installation remains unverified
and gated**. Local merge `7224e1a` adds later ADK reviewer and Memory refinements;
it is not pushed or deployed. It must not be confused with serving `830f1f94c`.
The next local candidate selectively incorporates local ADK `e3e41eaac`,
including its Memory refusal-order correction. Agent registries were
regenerated from this branch's authored sources. Exact email/phone directory
lookup was held because the route lacks verified-requester and durable lookup
budgets; name-only search remains. In-chat Memory approval now shows the
proposed destination, values and affected people and requires the current
unlocked card set. None of these local changes is serving on dev.

## Files-led acceptance matrix

| Area | Dated evidence and classification | Blocking proof / accountable owner |
| --- | --- | --- |
| **Existing-owner Files setup** | **Blocked.** The normal owner browser admitted to the old pod, but list returned 503 and the old release plan returned 409. The new offer is published; no image, bucket, queue, worker or owner configuration changed. | Files and release owners: prove old-image → new-image encrypted recovery in an isolated cloud pod, then use the normal owner's exact Files plan and approval. Verify installed digest, configuration and retained information. An image-only approval cannot enable Files. |
| **Files workspace and transfer** | **Local UI accepted; live target pending.** The move picker reaches paginated nested folders and mobile actions remain usable at 320–1280 px. Focused Files tests passed. A prior already-enabled reviewer pod passed interrupted 5 MiB upload/resume, byte-exact download, rename/undo and Trash/restore. | Files browser/pod owners: repeat cold admission, list, transfer and cleanup on the newly enabled owner pod. The prior reviewer transfer does not prove this image, owner cloud or normal enrollment. |
| **Files Agent, billing and recovery** | **Source-backed only.** Opt-in, exclusions, bounded jobs, same-project billing retry and configuration approval exist; synthetic tests passed. | Files and BYOC owners: prove real GCS, KMS, Cloud Tasks and model access, organization/cancellation, missing-billing return, and uncertain-step recovery on disposable setup. Preserve originals and record target-bound receipts. |
| **Chat, commands and connectors** | **Source/CI accepted; new live turns pending.** Queued chat delivery now checks status before resend. Owner-private MCP calls retain owner authority; review-required calls retain the exact one-use ledger. A historical cold browser wait timed out before a roughly 131-second pod completion. | Runtime/agent owners: measure fresh cold and warm turns, recorded command completion and a safe review-required connector approval/resume fixture. Do not infer those journeys from a 200 health response. |
| **Puppy and machine report** | **Metadata current; live turn pending.** The named owner's Mac reports fresh model/spec details and polls the control lane. Its Firebase UID, grant and pod binding match. Five postdeploy model preflights passed CORS and ingress, but no GET, activation, broker link or inference completion was observed. A local, unpushed UI fix exposes a failed device read and retry; the separate Hermes heartbeat-retry fix is neither pushed nor running. | Device/browser owners: capture the normal browser request outcome, read the actual panel, and prove direct WSS inference/cancellation on independent connections. Heartbeat and preflight alone do not establish relay acceptance. |
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

1. **Files and pod-release owners:** create a phone-verified disposable dev owner and
   isolated cloud substrate; prove the exact installed predecessor image can
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
the subsequent provisioning and recovery contract. The 2026-09-30 matrix
above supersedes that checkpoint for the dev decision; the older tests do not
resolve the installed-image compatibility refusal.
