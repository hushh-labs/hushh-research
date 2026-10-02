# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
The Files-led matrix below carries the release decision.

**Decision — 2026-10-02: personal update and Files transfer pass; dev acceptance remains blocked.**
Dev serves `241558e553b6`. The personal owner approved and installed the exact
qualified `.2` image, then completed the separate Files configuration operation.
Encrypted transfer, reversible file actions and exclusions pass. Personal Files
organization exceeded ADK's model-call limit, and Puppy cancellation did not stop
live inference. Focused corrections have local evidence; neither is deployed yet.
Production remains blocked. No main merge or broader rollout occurred.

The [One hierarchy](../one/one-agent-hierarchy.md),
[Files contract](../operations/private-files-library.md),
[dev update runbook](../operations/dev-pod-first-light-runbook.md) and
[deployment standard](../architecture/deployment-standard.md) own reusable guidance.
Git history retains the earlier chronology; this memo records current evidence.

## Source and serving evidence

- **Application:** [full exact-SHA CI](https://github.com/hushh-labs/hushh-research/actions/runs/36948290521)
  and [governed dev deployment](https://github.com/hushh-labs/hushh-research/actions/runs/36950372819)
  succeeded for `241558e553b6`. Independent readback confirmed backend
  `consent-protocol-00124-gf9` and frontend `hushh-webapp-00104-k74` at 100%
  traffic. Deployment took about 15 minutes 39 seconds. GitHub Actions governed
  deployment; Cloud Build built application images and reused the qualified pod image.
  Candidate verification, provenance, schema and runtime parity passed.
  Rollback application revisions are `00123-z2h` / `00103-l8d`.
- **Frozen integration:** main `f5ed2eb82fbe` and local ADK `1b08a07ebe93`
  remain the reviewed inputs. The completed candidate's local core mirror passed
  in 257 seconds. No later unrelated ADK delta is claimed in this release.
- **Release:** dev-only `2026.10-dev.2+be747f06168b.d02509f1` reuses immutable
  digest `sha256:d02509f1…9d23f` and original image source `be747f06168b`.
  Serving release metadata matches its archived descriptor. Only exact predecessor
  `sha256:1054cdf6…f0392` is qualified. Cloud Build `82d767a5` proved actual
  predecessor → exact target → target restart using synthetic encrypted state,
  without source overlays. That isolated evidence does not establish owner-cloud IAM.
- **Personal update:** normal owner approval occurred while a real synthetic pod
  chat was active. Authenticated drain produced a durable idle receipt, and the
  turn completed before image replacement. A repeated exact approval returned
  the same operation. Verification temporarily reported blocked; the existing
  worker reconciled the acknowledged replacement without another installation.
  Registry approval succeeded, acknowledgement is ready and the lease is released.
  Cloud readback confirms the target digest on the same service incarnation.
- **Recovery and configuration:** authenticated machine routes confirm durable
  key continuity and unchanged recovery configuration. CPU/memory remain
  1 vCPU/1 GiB, minimum zero, maximum one, concurrency eight and ten-minute relay
  grace. Fresh owner unlock, direct admission, a completed chat, encrypted history
  readback, and Settings' verified version pass. One earlier browser turn timed out;
  its cause remains unproven. The later successful rehearsal took 74.6 seconds
  including authentication/navigation; this is not a model-only latency measurement.
  Old and new rehearsal subjects were revoked at the pod; a revoked session returns
  403. Synthetic conversations and hub subjects were removed.
- **Files prerequisite repair:** the existing bucket/key had a legacy untyped
  receipt. Original creation records proved the same bootstrap principal and
  current resource identities; a full-snapshot conditional write reconciled only
  that receipt. Public-access prevention changed from inherited to enforced.
  Retention, encryption, IAM bindings and objects were preserved. Normal owner
  review and exact Files-plan approval succeeded. A denied queue-create step
  continued under the same operation after fresh permission, queue-absence and
  worker checks. Its terminal receipt, installed capability, queue and recovery
  passed. This was a same-digest configuration restart, not another image upgrade.
- **Schema:** dev pre/post-deploy gates passed, including migration 262.
  Payments remain disabled and operationally unaccepted. Historical 943–946
  checks do not prove destructive-history recovery; original 249 cleanup remains
  deferred. RIA remains `ria_stage1_query_only` degraded.

## Reviewed integration debt

The fitness baseline remains bound to integrated `785019eb2`: 101 reviewed size
regressions, with no new dependency or import-initialization violations. Stripe,
Drive sharing and voice execution remain measured debt. Budgets remain 500/250/80;
new or worsened findings still fail. The new Puppy stop shares the existing
producer, admission and consent authority; it does not create a turn ledger.
Browser abort now requests an authenticated stop bound to owner, pod incarnation,
originating app subject, device and request ID. An unconfirmed stop remains visible.
Local tests cover a still-connected HTTP upstream, mismatched subjects and duplicate
stops. A settled pod producer is not proof of device acknowledgement.


## Files-led acceptance

| Journey | Verified | Remaining gate / owner |
| --- | --- | --- |
| **Personal Files setup** | Exact image and Files plan approved; same-operation queue continuation, capability, queue, digest and encrypted continuity verified. | BYOC: cold recovery and remaining runtime conditions. |
| **Files explorer and transfer** | Personal live 5 MiB interrupted/resumed upload, byte-exact download, folders, rename/move undo, trash/restore and same-session continuity pass. Local mobile/paginated move checks pass. | Files: affected recheck after the next image; trash retention still applies. |
| **Files Agent and jobs** | Personal explicit opt-in and exclusions pass; original bytes survived live model failure. Revised instructions pass three isolated real-model cases within six calls: organization, malicious content and unsupported content. | Files: deploy the correction; prove personal queue terminal organization and cancellation. Local model evidence is not owner-cloud delivery evidence. |
| **Chat and recovery** | Fresh personal unlock, signed admission, completed private response, encrypted history and pod-side revocation pass after update. | Runtime: explain the preserved timeout; separate cold/warm and provider-stage timings. |
| **Commands and connectors** | Source checks preserve exact approval ledger and completion recovery. | Runtime: recorded command, exact connector review/resume, cancellation and no duplicate effect. |
| **Puppy and machine** | Updated-image direct reply and owner withdrawal pass; fresh binding is refused after withdrawal and the existing pod subject is revoked. Grant is re-enabled; identity is unchanged. | Device/runtime: install and prove explicit stop; reconnect, independent active internet, idle wake and cold latency. |
| **Updates and runtime** | Exact owner approval during active chat, authenticated drain, one operation, restart, digest/key/configuration readback and Settings completion pass. Files configuration restart preserves the target image. | Release/runtime: Feed agreement, bounded overlap and measured idle scale-down. Configuration alone is not capacity proof. |
| **Production** | No main, UAT, production or stable-channel promotion. | Release/security: complete dev acceptance, graduate migrations/channels, prove production IAM/billing and UAT recovery/rollback. |

## Local correction evidence — 2026-10-02

The bounded Files/Puppy corrections pass 94 focused backend and 32 frontend
checks, typecheck, docs verification and the architecture ratchet. The required
core mirror passed secret, governance and web-core. Protocol passed 8,523 tests
but exposed a stale generated catalog and two exact route-wall expectations;
the owning generator and reviewed `/turn/cancel` entry corrected both. The 33
route-wall checks then passed, followed by MCP and the 94-check PKM integration
lane. Original failures remain retained; full hosted CI still gates this candidate.
The next dev-only `.3` offer has no admitted predecessor until exact-image
recovery qualifies it. No owner installation is implied.

## Next gate and board alignment

1. Freeze the completed Files-instruction and Puppy-stop corrections; run the
   local core mirror once and hosted exact-SHA CI, then one governed dev deployment.
2. Publish a dev-only immutable image after exact-predecessor recovery proof;
   install it through the normal owner approval. Repeat personal organization,
   cancellation and affected continuity checks. Preserve earlier failed receipts.
3. Complete the remaining recorded command, connector, billing and bounded runtime
   journeys. Keep physical-device/network prerequisites explicitly unverified.
4. [#5507 Personal GCP Pod simulation](https://github.com/hushh-labs/hushh-research/issues/5507)
   remains **In Progress**. [#6790 ADK migration](https://github.com/hushh-labs/hushh-research/issues/6790)
   is closed for its source scope; historical Puppy Done cards do not close this acceptance.

Affected private Wiki sections are reconciled to the serving revision, approved
release and actual personal outcomes; each edit requires readback. The older [Plaid contract](../kai/plaid-vault-passthrough.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md) retain
separate rollout and exchange/cache gates.

## GCP-only pod deployment correction — 2026-09-25

Historical anchor: Anypoint pod deployment was removed; `gcp` / `user_gcp` remain.
The separate CRM connector is retained. Current guidance lives in the deployment
standard and dev runbook.

## Files continuation evidence — 2026-09-25

Historical anchor: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own subsequent decisions.
