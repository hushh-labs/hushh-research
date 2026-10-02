# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
The Files-led matrix below carries the release decision.

**Decision — 2026-10-02: Files and the owner-approved dev update pass;
full dev acceptance and production remain blocked.**
Both dev application services now serve verified source `a9c479328fd0`.
The personal pod retains its independently qualified `.4` image, encrypted
information, trusted device and selected on-demand configuration. Private chat
and typed/recorded synthetic commands pass through that pod. Puppy failed the
two-operation and cold rehearsals before inference had time to finish; recovery
work and client deadline allocation are confirmed defects. Eligible connector review, billing recovery
and bounded mixed work remain gates. No main, UAT, production or stable-channel
promotion occurred.

Reusable guidance lives in the [One hierarchy](../one/one-agent-hierarchy.md),
[Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md) and
[deployment standard](../architecture/deployment-standard.md).
Git history retains the earlier chronology; this memo records current evidence.

## Source and serving evidence

- **Application:** [exact-SHA CI](https://github.com/hushh-labs/hushh-research/actions/runs/37020459136)
  and [governed dev deployment](https://github.com/hushh-labs/hushh-research/actions/runs/37023785833)
  succeeded for `a9c479328fd04dfc8f5394202ca43090e5d93975`. Independent readback
  at 15:43 UTC confirmed backend `consent-protocol-00128-kk2` and frontend
  `hushh-webapp-00107-j72`, both at 100% traffic on that SHA. Immutable digests
  are `sha256:9c4eb6fe3483805f772a7027f0b32a3f056eb4d05ae0c74d326248ac6ad1dedf`
  and `sha256:11fc24397c5b0d948a8fae132f2cf6ae910e965bead2b56ba879cd966fd12fac`.
  GitHub Actions governed; Cloud Build built and deployed. Health, provenance,
  model, parity and database guards passed. Application rollback targets are
  `00127-qhs` / `00106-s2d`. Deployment took approximately 21 minutes; no speed
  improvement or live rollback acceptance is claimed.
- **Integration boundary:** the refresh froze main `43c70034dd99` and clean local
  ADK `b398a9de5166`. Two relevant reviewer fixes were carried selectively; the
  wider Drive, voice, production, native and CI-policy delta remains outside this
  bounded release. Peer commits through `e8f5b20c6` were preserved by normal merge
  `1d45e5fe21` and now serve in the candidate. Azure selection remains disabled;
  this is GCP acceptance only. Unrelated PDF work is excluded.
- **Pod offer and installation:** dev-only `2026.10-dev.4+b70ee404bfa7.730e1702`
  reuses immutable image source `b70ee404bfa7`, target `sha256:730e1702…43d1d5`,
  and only qualified predecessor `sha256:d02509f1…9d23f`. Actual immutable-image
  predecessor → target → restart tests proved synthetic encrypted Files, session,
  authority-tombstone and PKM-summary continuity without source overlays.
  Normal Settings approval during active synthetic chat retained one operation
  under repeated approval; durable idle preceded replacement. Revision
  `00024-x8z` subsequently reconciled to digest-verified success, preserving
  service identity, keys, storage and Files queue. The original harness missed
  the draining overlap and failed final readback; independent readback verified
  completion. Fresh unlock recovered the exact synthetic user message and a
  completed assistant response, without an exact assistant-byte comparator.
- **Updates and Feed:** the missing historical notice was repaired through the
  existing Feed writer: two calls produced one operation-key notice and no
  registry mutation. Settings/Feed readback agrees. The corrected automatic
  reconciled projection now serves in `a9c479328fd0`; this deployment does not
  prove a second normal update or observed drain overlap.
- **Economic configuration:** fresh management readback preserves 1 vCPU/1 GiB,
  minimum zero, revision maximum one instance, concurrency eight and ten-minute
  relay grace; the immutable image retains one worker. The service-level maximum
  is distinct from the serving revision limit. Earlier metrics recorded zero
  active/idle instances followed by a roughly 104-second wake. Updated-image
  metrics recorded zero at 14:24 UTC and again at 17:00 UTC before the cold Puppy
  rehearsal. Empty metrics series remain unavailable evidence, not zero.
  Capacity remains unproved.
- **Schema:** pre/post-deploy guards passed at integrated version 262. Migrations
  943, 944 and 946–949 are applied with source-matching checksums. Ledger 249 is
  the public-profile bridge, not the destructive cleanup. Dev history cutover
  **944 already completed on September 28**, governed by
  [run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630)
  at source `83f307dd993c`. Dated readback confirmed intended legacy rows absent
  and retained fingerprints unchanged. Live retained BYOK tables were empty;
  nonempty restoration/preservation was proved separately in isolated fixtures.
  The ledger's null deployment-SHA field is a provenance limitation; dated
  workflow/readback supplies the evidence. Matching cleanup was skipped on this
  deployment. Do not rerun it or describe its no-op SQL rollback as recovery.
  Retained-backup erasure and UAT/production cutover are not established.
- **Environment limits:** dev uses the approved personal Gemini bridge and
  governed Gemini 3.6 Flash configuration. RIA remains `ria_stage1_query_only`
  degraded. Production pod migrations, release-channel graduation and production
  IAM/billing remain unaccepted.

## Files-led acceptance

| Journey | Verified | Remaining gate / owner |
| --- | --- | --- |
| **Files setup** | Exact-plan approval, same-operation queue continuation, installed capability, encrypted keys and queue configuration. | Preserve the existing operation, bucket and selected hosting settings. |
| **Files explorer and transfer** | Live 5 MiB interrupted/resumed upload, byte-exact download, folders, rename/move undo, trash/restore and same-session continuity; mobile/paginated move checks. | Files: mixed-work recheck; trash retention is not physical deletion. |
| **Files Agent and jobs** | Explicit opt-in/exclusions, automatic organization of a new synthetic upload, authenticated queue completion, terminal cancellation and original-byte preservation on the installed image. Isolated malicious/unsupported-content tests. | Files: bounded overlapping work. Original analysis settings restored; synthetic creations trashed under retention. Failed and cancellation-only harness receipts stay separate. |
| **Chat and recovery** | Two direct browser replies completed in approximately 74 and 71 seconds on the serving candidate; terminal UI and exact-thread history agree. Signed admission, same-session continuity and pod/hub session revocation pass. Fresh unlock recovered exact synthetic user and completed assistant information. | Runtime: original failed/inconclusive harness receipts remain preserved. Recovery latency remains poor. |
| **Commands and connectors** | Typed and five-second recorded synthetic commands completed pod transcription/assessment and the existing hub ledger's Location settings plan on this serving candidate; same-session continuity and both cleanup authorities pass. | Runtime: a real physical microphone and eligible connector approval/resume are unverified. This owner's inventory has no eligible saved review-required read-only fixture. |
| **Puppy and machine** | Existing Hermes identity: direct response, `200/stopped`, released work, Mac inference cancellation, reconnect, owner withdrawal/new-binding refusal and re-enable; dated model/capacity report. A controlled relay restart followed by a warm browser response passed in approximately 73 seconds. | Runtime: mixed work exhausted the 155-second pod timeout after approximately 151 seconds of recovery. The confirmed-zero cold browser attempt exhausted its 205-second total after 172 seconds of setup. Independent active internet and usable cold latency remain unverified. Failed receipts are retained. |
| **Updates and runtime** | Exact `.4` approval, one operation, durable idle, restart, digest/key/configuration and Settings/Feed verification. Automatic projection correction is deployed. | Updates/runtime: observed drain overlap, bounded mixed work and measured idle/wake after the final candidate. No live rollback-fault acceptance. |
| **Billing recovery** | Typed retry contracts preserve the recorded project and setup operation. | Provisioning: real missing-billing return through fresh authorization on a disposable setup; never disable an existing owner's billing to manufacture failure. |
| **Production** | No main, UAT, production or stable-channel promotion. | Release/security: finish dev acceptance, graduate migrations/channels and prove production IAM/billing and UAT recovery/rollback. |

## Verification and measured debt

### Reviewed integration debt

The completed candidate passed focused trust-boundary checks, typecheck, owning
contracts, the final local core mirror in 287 seconds and exact-SHA hosted CI.
The read-only Location bootstrap correction preserves ordinary owner behavior;
its nearest regression and broken-code negative control pass. The new-or-worsened
fitness ratchet passes without widening a handwritten allowance.

Cold admission now has its own bounded wait; the existing 90-second byte-based
stream-silence budget starts after successful response headers. Cancellation
refuses late private writes without cancelling another caller's shared admission.
Feed completion remains a best-effort projection after verified registry
publication; status is a pure reader and install authority is unchanged.

Private-chat diagnostics exposed two harness defects: new-chat reset was not
awaited and failed network reads could wait indefinitely for stream completion.
Original failed receipts remain preserved. Optional CDP body access is not a
substitute for terminal UI and exact-thread history evidence.

The mixed rehearsal passed one chat operation. At two operations, One completed
in approximately 66 seconds, but Puppy exhausted the 155-second route budget.
Correlated pod/device stages show a 48-second PKM rebuild, another full scan used
only for statistics, then memory hydration. Local inference started approximately
151 seconds into the request and was cancelled four seconds later. A warm retry
admitted the relay in 1.7 seconds and generated locally in nine seconds. The
four-operation and ten-minute soak stages were not run after this failure.

The pending `.5` source correction retains the exact verified rebuild count and
removes that statistics scan. All 28 resolver tests and five existing PKM/log
recovery tests pass; restoring the old initializer makes the nearest regression
read ten objects instead of five. Independent boundary review found no change to
owner, erasure, initialization or constructor contracts. This is local evidence;
the `.4` owner image remains installed. `.5` compatibility stays empty until the
exact immutable predecessor-to-target recovery rehearsal passes. The completed
count-only candidate passed its local core mirror in 407 seconds and docs/link
governance. Its [hosted validation](https://github.com/hushh-labs/hushh-research/actions/runs/37037299501)
succeeded for `09d0e4f9af4e`. Deployment is held for the completed deadline fix;
the combined candidate still requires its own exact-SHA validation.

A subsequent cold Puppy attempt followed observed zero active/idle instances.
The browser submitted at 17:02:43 UTC, but direct inference dispatched only at
17:05:35; its 205-second deadline cancelled at 17:06:08. Two client timers included
preparation, leaving approximately 33 seconds for inference. The pending source
fix keeps preparation bounded at 205 seconds and starts a fresh 170-second
inference ceiling only at the authenticated direct POST. UI waiting begins at
that same point; cancellation authority and no-cloud-fallback remain unchanged.
This fixes deadline allocation, not the underlying cold-start latency. Both
pod/hub cleanup succeeded and the old browser session was refused afterward.
All 41 focused stream/parser/UI checks pass, including the real inference
deadline and authenticated stop. The delayed-admission regression fails with
the old stream consumer substituted in memory; shared source files are not
overwritten. Typecheck, docs links and diagram governance pass. Independent
review found no change to admission, consent or cancellation authority.
The completed recovery-plus-deadline candidate passed the local core mirror
in 334 seconds, including the unchanged architecture ratchet. The first attempt
stopped at duplicated test scaffolding; consolidation into the existing shared
SSE helper cleared that finding without a baseline allowance or removed coverage.

A prior Puppy response took approximately 139 seconds, including 98 seconds of
local generation and 37 seconds to first content. Recovery replay held 459
records and one correlated completion took 117 seconds. The bounded HTTP startup
budget repair was failed-start maintenance, separate from the normal image
update. These measurements identify usability debt, not a latency guarantee.
No confirmed provider 429 count or sustainable capacity envelope is available.

## Next gate and board alignment

1. Qualify and offer the recovery correction through the governed dev channel;
   install only through exact owner approval. Repeat the failed two-operation
   stage before bounded four-operation work, soak and idle/wake observations.
2. Finish the eligible connector, disposable billing-return and independent-internet
   Puppy journeys when their concrete prerequisites are available. Do not mark
   unperformed journeys passed or repeat unrelated deployments.
3. Reconcile the affected private Wiki sections against this evidence and read
   back every edit. The broader Wiki corpus remains a separate audit scope.
4. [#5507 Personal GCP Pod simulation](https://github.com/hushh-labs/hushh-research/issues/5507)
   remains **In Progress**. [#6790 ADK migration](https://github.com/hushh-labs/hushh-research/issues/6790)
   is closed for its source scope; historical Puppy Done cards do not close acceptance.

The [Plaid contract](../kai/plaid-vault-passthrough.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md) retain
separate rollout and exchange/cache gates.

## GCP-only pod deployment correction — 2026-09-25

Historical anchor: Anypoint pod deployment was removed; the CRM connector is
retained. The deployment standard owns current placement and disabled choices.

## Files continuation evidence — 2026-09-25

Historical anchor: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own subsequent decisions.
