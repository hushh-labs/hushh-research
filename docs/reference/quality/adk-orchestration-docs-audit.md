# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
The Files-led matrix below carries the release decision.

**Decision — 2026-10-02: personal dev update and Files organization verified; full dev acceptance remains blocked.**
The backend serves `684a44768f32`; frontend remains `deab16040b8a`. The owner
approved the qualified `.4` release during active synthetic chat. One operation
survived duplicate approval, a temporary unconfirmed outcome and reconciliation;
installed digest, durable key and selected hosting configuration are verified.
Owner-cloud Files organization now completes with original bytes preserved.
Files/Puppy cancellation, cold-session history and the existing operation's
repaired Feed notice now pass. Cold-chat UX and remaining journeys gate acceptance.
The cold-admission and reconciled Feed corrections are implemented locally;
their serving verification is pending.
No main, UAT, production or stable-channel promotion occurred.

The [One hierarchy](../one/one-agent-hierarchy.md),
[Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md) and
[deployment standard](../architecture/deployment-standard.md) own reusable guidance.
Git history retains the earlier chronology; this memo records current evidence.

## Source and serving evidence

- **Application:** [exact-SHA CI](https://github.com/hushh-labs/hushh-research/actions/runs/37002829090)
  and [governed backend deployment](https://github.com/hushh-labs/hushh-research/actions/runs/37004180361)
  succeeded for `684a44768f32`. Independent readback confirmed backend
  `consent-protocol-00127-qhs`, SHA `684a44768f32`, and unchanged frontend
  `hushh-webapp-00106-s2d`, SHA `deab16040b8a`, each at 100% traffic. Deployment
  took 19 minutes 24 seconds; no speed improvement is claimed. GitHub Actions
  governed and Cloud Build executed. Health, provenance and database guards passed.
  Application rollback targets are `00126-w5w` / `00106-s2d`.
- **Frozen integration:** main `f5ed2eb82fbe` and local ADK `1b08a07ebe93` are
  the reviewed inputs. Seven concurrent commits through `e1a60e5c2` are preserved
  in the serving application. A further 29 peer commits through `6fc9aa52e92e`
  were accommodated on the existing branch by merge `fe6c02a566f6`; that later
  Azure and related delta was not part of this GCP deployment or acceptance.
  Unrelated PDF edits remain excluded. Local source and serving source differ.
  The October 2 refresh froze main `43c70034dd99` and clean ADK `b398a9de5166`.
  Its two relevant reviewer-harness fixes were carried selectively; the wider
  Drive, voice, production, native and verification-policy delta is deferred
  outside this bounded release. Eighteen additional peer commits through
  `e8f5b20c6` were preserved by normal merge `1d45e5fe21`; that combined source
  awaits qualification and has not served this GCP acceptance.
- **Qualified pod offer:** `2026.10-dev.4+b70ee404bfa7.730e1702` is published,
  reusing immutable target `sha256:730e1702…43d1d5` and original image source
  `b70ee404bfa7`. Only predecessor `sha256:d02509f1…9d23f` is admitted. The archive
  and serving offer passed independent readback. Cloud Build `dda7c96e` proved
  actual predecessor → target → target restart for synthetic encrypted Files,
  session state, authority tombstones and PKM summaries, without source overlays.
  That fixture does not establish owner-cloud IAM, queue delivery or installation.
- **Prior personal acceptance:** the owner approved `.2` during an active synthetic
  pod chat. Authenticated drain, durable idle, one operation under repeated approval,
  restart, installed-digest/key verification and encrypted history passed. The
  subsequent exact Files-plan approval completed a separate same-image configuration
  restart. Legacy resource-receipt reconciliation, enforced public-access prevention
  and a denied queue-create continuation retained the original operation, bucket,
  keys and objects. These receipts do not prove the new `.4` journeys.
- **Current cold-start repair:** two normal browser attempts failed before update
  approval. Cloud Run terminated startup before the predecessor completed recovery;
  a correlated completion took 117 seconds. Its log head held 459 records; source
  performs two serial verified replays before serving. An explicitly authorized,
  compare-and-swap repair changed only the HTTP startup budget from 60 to 240 seconds.
  The old handoff was unavailable; no authenticated drain receipt is claimed for
  this failed-start maintenance. Readback proves the same image/service, unchanged
  configuration and durable key, and an accepting runtime. This restores access;
  it does not establish acceptable cold latency or a normal software update.
- **Current personal update:** normal Settings approval occurred with one active
  pod chat; repeated approval retained one operation. A durable idle receipt
  preceded replacement. The harness missed the draining overlap and its final
  browser readback failed; retain that failed attempt. The new revision
  `00024-x8z` reached 100% traffic. The original operation reconciled from blocked
  to succeeded with exact `.4` digest `730e1702…43d1d5` and its lease released.
  Independent readback verified service/key continuity and Files queue settings.
  Normal Settings now shows installation verified. A fresh unlock recovered the
  exact synthetic user message and completed assistant response; the failed
  original harness did not retain an exact assistant-byte comparator. Feed's
  current status agrees on the same operation, but its historical update notices
  initially lacked that operation's completion receipt. A scoped repair through
  the existing Feed writer produced one source-key notice under two calls, with
  unchanged registry state and owner Settings/Feed readback. This is presentation
  repair, not another installation or proof the serving reconciler is corrected.
  Observed drain overlap remains open.
- **Economic configuration:** 1 vCPU/1 GiB, minimum zero, maximum one instance
  on one serving revision, concurrency eight, one worker and ten-minute relay
  grace are preserved. Before the update, management metrics recorded zero
  active and idle instances at 12:17 UTC; subsequent cold startup took about
  104 seconds. This proves one scale-down/wake, not acceptable latency or load.
- **Schema and rollout:** pre/post-deploy guards passed at integrated version 262.
  Ledger 249 is the public-profile bridge; destructive legacy-history cleanup
  remains deferred. RIA is `ria_stage1_query_only` degraded. Payments, production
  pod migrations and stable publication remain operationally unaccepted.

## Files-led acceptance

| Journey | Verified | Remaining gate / owner |
| --- | --- | --- |
| **Files setup** | Prior personal exact-plan approval, same-operation queue continuation, installed capability and encrypted continuity. | New image, owner identity, encrypted keys and Files queue configuration independently verified. |
| **Files explorer and transfer** | Prior live 5 MiB interrupted/resumed upload, byte-exact download, folders, rename/move undo, trash/restore and same-session continuity. Local mobile/paginated move checks pass. | Files: affected recheck; trash retains billed objects. |
| **Files Agent and jobs** | Explicit opt-in/exclusions, automatic new-upload organization, authenticated queue completion and cancelled job termination pass on the updated owner pod, with original bytes preserved. Earlier live model failure preserved originals; isolated malicious/unsupported-content cases pass. | Files: bounded overlapping work. Initial analysis settings restored; synthetic creations trashed under existing retention. Failed and cancellation-only harness receipts remain separate. |
| **Chat and recovery** | Prior fresh unlock, signed admission, private response, exact encrypted history and pod-side revocation. Startup repair restores authenticated service. | Runtime: cold admission consumed the browser stream watchdog before POST. Local repair separates admission from stream silence; serving frontend is unchanged. Exact history continuity and replay latency remain open. |
| **Commands and connectors** | Exact approval-ledger and completion-recovery source checks pass. | Runtime: recorded command and eligible connector review/resume. This owner's connector inventory has no eligible saved review-required read-only fixture. |
| **Puppy and machine** | Updated-image direct response, `200/stopped`, released pod work and Mac inference cancellation pass; a subsequent response completes. Owner withdrawal confirms pod revocation and refuses a new binding; access re-enabled. Qualified actual model/capacity report passes. | Runtime: independent active internet, updated-image idle wake and latency. The earlier 409 was the canonical rehearsal guard, corrected with an exact pinned cancellation route. A later extra modal-navigation timeout remains a failed harness action. |
| **Updates and runtime** | `.4` normal exact approval, one operation, durable idle, restart, digest/key/configuration and Settings verification pass. Fresh unlock retains exact synthetic user and completed assistant information. Feed current status and repaired historical notice agree, without another install. | Updates: deploy the automatic reconciled projection correction; runtime: observed drain overlap, updated-image idle and bounded load. Exact assistant-byte comparison was unavailable. |
| **Production** | No main, UAT, production or stable-channel promotion. | Release/security: complete dev acceptance, graduate migrations/channels, prove production IAM/billing and UAT recovery/rollback. |

## Verification and measured debt

### Reviewed integration debt

The bounded Files/Puppy corrections passed focused checks, typecheck and full
hosted CI. The qualification's core mirror exposed an erasure fixture leaking
its fence and two unauthored child-model defaults. Owning fixes passed 12,052
parallel and 149 serial protocol tests, 246 declared skips, import collection,
MCP package checks and the 94-check PKM lane. Original failures are retained.
Exact-SHA hosted CI subsequently passed at `deab16040b8a` and `684a44768f32`.

The fitness baseline remains bound to `785019eb2`, with budgets 500/250/80 and
all existing findings retained. The generated catalog's reviewed 1408 → 1409
change preserved the exact pod image ancestor. A further 1409 → 1410 entry
preserves the serving dev workflow revision `9c1f8b9bcf9e2d4b` across deployment.
Independent review and the owning generator verified all eight workflow digests,
actions and refusal policies unchanged; the pod's `83966cd4fefe54f6` remains
compatible. Only that generated finding's measured value changed.
The Puppy stop uses the existing producer and authority, not a second turn ledger;
a stopped pod producer alone does not prove device acknowledgement.

The newly demonstrated startup correction passes 134 focused backend/upgrade
checks. Provisioning allows a bounded 240-second HTTP startup window; image-only
updates preserve observed HTTP health and liveness probes and refuse TCP startup
readiness. Custody and replay latency still need optimization. The existing
150-second update observation window can leave slower starts unconfirmed until
reconciliation; success still requires actual digest/recovery verification.

The cold-admission client correction passed 119 focused checks, typecheck,
service-boundary/docs checks and the final core mirror in 287 seconds. A read-only
qualification review found no material blocker. A bounded liveness extraction
retains the existing service facade and leaves the fitness baseline unchanged;
the new-or-worsened ratchet passes. It is not deployed. The 90-second silence
limit starts after successful response headers, remains byte-based, and still
rejects genuine silence. Cancellation refuses late responses and private writes
without cancelling another caller's shared admission.

The confirmed reconciliation gap now has a local correction: completion emits
through the existing Feed owner only after successful registry publication and
uses the operation ID for existing database deduplication. Failed, unchanged
and lost-publication outcomes do not emit. Feed remains a best-effort projection;
status has no new writes and installation authority is unchanged. Focused
backend (59) and frontend (27) checks pass. The same-image negative control fails
on the original default-true behavior. Combined core passed in 292 seconds at
`b28b953d0`; the sole subsequent contract delta received the owning generator,
runtime-contract and fitness gates. Hosted exact-revision qualification remains
pending. No handwritten fitness allowance was widened.

On the updated image, one Puppy follow-up took about 139 seconds end to end,
including roughly 98 seconds of local-model generation and 37 seconds to first
content. Earlier short-response and cancellation receipts remain separate.
These samples do not establish an acceptable latency envelope. No prompt,
credential or private file content is part of the diagnostic record.

## Next gate and board alignment

1. Qualify and deploy the local cold-admission and Feed corrections on one exact
   branch SHA. Preserve the stream silence limit, shared admission cancellation
   boundary and reviewed fitness baseline.
2. Preserve the installed image and original operation; no further installation
   is needed to repair its Feed notice. Files/Puppy cancellation, fresh history
   and repaired notice readback pass; automatic future projection needs the fix
   deployed.
3. Complete recorded commands, eligible connector, billing and bounded runtime
   journeys. This owner's eligible review-required read-only MCP fixture and
   independent-network browser evidence remain unavailable.
4. [#5507 Personal GCP Pod simulation](https://github.com/hushh-labs/hushh-research/issues/5507)
   remains **In Progress**. [#6790 ADK migration](https://github.com/hushh-labs/hushh-research/issues/6790)
   is closed for its source scope; historical Puppy Done cards do not close this acceptance.

The affected private Wiki sections were reconciled and read back on 2026-10-02;
their qualified dev claims remain private. The older [Plaid contract](../kai/plaid-vault-passthrough.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md) retain
separate rollout and exchange/cache gates.

## GCP-only pod deployment correction — 2026-09-25

Historical anchor: Anypoint pod deployment was removed; `gcp` / `user_gcp` remain.
The separate CRM connector is retained. Current guidance lives in the deployment
standard and dev runbook.

## Files continuation evidence — 2026-09-25

Historical anchor: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own subsequent decisions.
