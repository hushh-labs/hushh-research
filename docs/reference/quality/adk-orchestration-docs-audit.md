# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
The Files-led matrix below carries the release decision.

**Decision — 2026-10-02: qualified dev release published; full dev acceptance remains blocked.**
The application serves `deab16040b8a`. The dev-only `.4` offer qualifies the
personal pod's exact installed predecessor. Its recovery fixture passes, but
publication does not install it. The first normal update rehearsal stopped before
approval: the existing pod failed its cold-start probe. A separately authorized,
same-image configuration repair restored authenticated service and its durable key.
The image update, live Files organization and device-acknowledged Puppy stopping
remain the immediate gate. Production remains blocked; no main merge occurred.

The [One hierarchy](../one/one-agent-hierarchy.md),
[Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md) and
[deployment standard](../architecture/deployment-standard.md) own reusable guidance.
Git history retains the earlier chronology; this memo records current evidence.

## Source and serving evidence

- **Application:** [exact-SHA CI](https://github.com/hushh-labs/hushh-research/actions/runs/36996406889)
  and [governed dev deployment](https://github.com/hushh-labs/hushh-research/actions/runs/36998347566)
  succeeded for `deab16040b8a`. Independent readback confirmed backend
  `consent-protocol-00126-w5w` and frontend `hushh-webapp-00106-s2d`, each at
  100% traffic. Deployment took 18 minutes 23 seconds. GitHub Actions governed;
  Cloud Build built the images. Provenance, candidate health, schema and runtime
  parity passed. Application rollback targets are `00125-b96` / `00105-gw2`.
- **Frozen integration:** main `f5ed2eb82fbe` and local ADK `1b08a07ebe93` remain
  the reviewed inputs. Seven concurrent commits through `e1a60e5c2`, including
  restored coverage and owner-cloud contract corrections, are preserved in the
  serving application. Later unrelated main/ADK changes are outside this release.
  Unrelated PDF edits remain uncommitted and excluded.
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
- **Economic configuration:** 1 vCPU/1 GiB, minimum zero, one serving revision with
  maximum one instance, concurrency eight, one worker and ten-minute relay grace
  are preserved. Configuration is not evidence of scale-down or sustainable load.
- **Schema and rollout:** pre/post-deploy guards passed at integrated version 262.
  Ledger 249 is the public-profile bridge; destructive legacy-history cleanup
  remains deferred. RIA is `ria_stage1_query_only` degraded. Payments, production
  pod migrations and stable publication remain operationally unaccepted.

## Files-led acceptance

| Journey | Verified | Remaining gate / owner |
| --- | --- | --- |
| **Files setup** | Prior personal exact-plan approval, same-operation queue continuation, installed capability and encrypted continuity. | BYOC: verify configuration survives the new image update. |
| **Files explorer and transfer** | Prior live 5 MiB interrupted/resumed upload, byte-exact download, folders, rename/move undo, trash/restore and same-session continuity. Local mobile/paginated move checks pass. | Files: affected recheck; trash retains billed objects. |
| **Files Agent and jobs** | Explicit opt-in/exclusions and originals surviving live model failure. Revised instructions pass isolated organization, malicious-content and unsupported-content Gemini 3.6 cases within six calls. | Files: install `.4`; prove authenticated owner-cloud terminal organization and cancellation. |
| **Chat and recovery** | Prior fresh unlock, signed admission, private response, exact encrypted history and pod-side revocation. Startup repair restores authenticated service. | Runtime: normal update continuity; cold/warm/provider timings and replay cost. |
| **Commands and connectors** | Exact approval-ledger and completion-recovery source checks pass. | Runtime: recorded command and eligible connector review/resume. This owner's connector inventory has no eligible saved review-required read-only fixture. |
| **Puppy and machine** | Prior direct reply, grant withdrawal, new-binding refusal and existing pod-session revocation; original identity retained and grant restored. | Device/runtime: `.4` explicit stop with Mac acknowledgement, reconnect, independent active internet and idle wake. |
| **Updates and runtime** | Prior exact active-chat approval, drain, one operation, restart, digest/key/configuration readback and Settings completion. Current `.4` offer is installable. | Release/runtime: install `.4`; Settings/Feed agreement, bounded overlap and measured idle scale-down. |
| **Production** | No main, UAT, production or stable-channel promotion. | Release/security: complete dev acceptance, graduate migrations/channels, prove production IAM/billing and UAT recovery/rollback. |

## Verification and measured debt

The bounded Files/Puppy corrections passed focused checks, typecheck and full
hosted CI. The qualification's core mirror exposed an erasure fixture leaking
its fence and two unauthored child-model defaults. Owning fixes passed 12,052
parallel and 149 serial protocol tests, 246 declared skips, import collection,
MCP package checks and the 94-check PKM lane. Original failures are retained.
Exact-SHA hosted CI subsequently passed at `deab16040b8a`.

The fitness baseline remains bound to `785019eb2`, with budgets 500/250/80 and
all existing findings retained. Only the reviewed generated workflow catalog's
1408 → 1409 line change was accepted. The exact image ancestor's graph revision
is admitted only after generated checks prove unchanged workflow semantics.
The Puppy stop uses the existing producer and authority, not a second turn ledger;
a stopped pod producer alone does not prove device acknowledgement.

The newly demonstrated startup correction passes 134 focused backend/upgrade
checks. Provisioning allows a bounded 240-second HTTP startup window; image-only
updates preserve observed HTTP health and liveness probes and refuse TCP startup
readiness. Custody and replay latency still need optimization. The existing
150-second update observation window can leave slower starts unconfirmed until
reconciliation; success still requires actual digest/recovery verification.

## Next gate and board alignment

1. Verify and deploy the narrow startup/upgrade configuration correction through
   the governed dev branch workflow. Preserve the qualified pod image and offer.
2. Rebaseline the repaired pod, approve its exact release in Settings during
   active synthetic chat, then prove Files organization and Puppy stopping.
3. Complete remaining commands, eligible connector, billing and bounded runtime
   journeys. Independent-network acceptance remains unverified until exercised.
4. [#5507 Personal GCP Pod simulation](https://github.com/hushh-labs/hushh-research/issues/5507)
   remains **In Progress**. [#6790 ADK migration](https://github.com/hushh-labs/hushh-research/issues/6790)
   is closed for its source scope; historical Puppy Done cards do not close this acceptance.

Affected private Wiki sections require reconciliation and readback for these new
receipts. The older [Plaid contract](../kai/plaid-vault-passthrough.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md) retain
separate rollout and exchange/cache gates.

## GCP-only pod deployment correction — 2026-09-25

Historical anchor: Anypoint pod deployment was removed; `gcp` / `user_gcp` remain.
The separate CRM connector is retained. Current guidance lives in the deployment
standard and dev runbook.

## Files continuation evidence — 2026-09-25

Historical anchor: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own subsequent decisions.
