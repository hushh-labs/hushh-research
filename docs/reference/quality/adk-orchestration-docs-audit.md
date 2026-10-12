# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-12 UTC

**Hold the application merge and production BYOC rollout.** Source, deployment,
owner installation and production acceptance have separate evidence. The existing
personal Azure pod runs the owner-approved Dev 15 image; its Files transfers,
private chat and Puppy response/cancellation pass. Active-work update draining,
native connector journeys, cold-start performance and environment-specific
production controls remain unqualified. Computer Use and cross-cloud moves stay
disabled. Existing owners retain their resources and selected configuration.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Frozen implementation | `535e3351b95a` contains the reviewed main/ADK union, setup simplification, Files/Puppy corrections and retained-stream fix | Concurrent root/ADK/PDF edits remain preserved outside this frozen release. |
| Exact-SHA CI | [Run 38252668481](https://github.com/hushh-labs/hushh-research/actions/runs/38252668481) passed the complete hosted pipeline, including native compilation, browser coverage, full web and protocol lanes | Prior failed runs remain retained. The bounded Swift package retry does not bypass checksum, compilation or test checks; this run succeeded on its first resolution attempt. |
| Local verification | Composite core retains the full backend pass, focused repairs, PostgreSQL cases and remaining canonical stages; byte-identical runtime proof was reused. Release metadata receives its nearest contract checks | No repeated full local suite or fixture evidence is presented as owner acceptance. |
| Governed dev deployment | [Run 38257902102](https://github.com/hushh-labs/hushh-research/actions/runs/38257902102) passed schema, preservation, candidate health, provenance, parity, semantic checks and reviewer navigation/cold unlock | GitHub Actions governs; Cloud Build builds. The application remains unmerged. |
| Actual serving state — Oct 12, 14:55 UTC | Backend `00166-gk9`, digest `c7749c998f59`; frontend `00142-jtt`, digest `3366ba1ea033`. Both serve `535e3351b95a` at 100% traffic | Independent ADC readback confirms revisions, immutable images and deployment labels. Rollback targets remain `00165-92f` and `00141-7h9`. |
| Dev access repair | Request-slot exhaustion was measured independently of CPU, RAM and database load. Messages cancels open and late stream bodies; both old-code negative controls fail. Serving concurrency is now 40, with the same maximum three instances, worker and pools. The normal owner session is reachable and unlocked | This is a bounded mitigation, not a sustainable capacity or production-load claim. Owner-pod resources are unchanged. |
| Schema | Governed pre/post schema guards pass without missing required tables, columns or functions; selected canonical head 320 | Destructive history cleanup 249 remains deferred. No production schema acceptance or SQL rollback recovery claim. |
| Exact target recovery | Dev 16 image `47bb9a718063`, source `535e3351b95a`, passed actual Dev 15 → target recovery on disposable GCP and Azure pods. Keys, encrypted history, byte-exact Files, metadata, preferences and configuration are preserved. The same target also recovered at the personal Azure size, 0.5 vCPU/1 GiB; chat and authenticated organization completed with originals intact | The smaller-size test changes only a disposable service. Genuine idle/wake and exact personal Settings approval remain separate acceptance. |
| Qualified offer | Dev 17 metadata pins the same Dev 16 executable bytes and only the exact qualified Dev 15 predecessor | The metadata offer requires its own governed publication. No additional pod image is built; publishing never installs. |
| Personal pod | The earlier normal Settings operation verified Dev 15 restart, recovery and installed digest | The selected min 0/max 1, single worker, 0.5 vCPU/1 GiB, HTTP threshold eight and queue scaler are preserved. The new active-work update has not yet occurred. |

The original failed deployment and CI receipts remain available in GitHub and
private operational evidence. Private owner identifiers, cloud receipts and
credentials remain outside this memo.

## Acceptance matrix

| Journey | Demonstrated | Required before production |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer. Normal owner on Azure Dev 15: interrupted/resumed upload and download, byte-exact integrity, folders, inline rename/undo, move/undo, trash/restore and same-session continuity | Repeat new/existing setup and owner-cloud storage/IAM acceptance in UAT. Local UI checks do not prove cloud custody. |
| Files organization | Normal owner Azure Dev 15 semantic move/undo passed. On the exact Dev 16 target, GCP Cloud Tasks and Azure managed-identity Storage Queue completed automatic synthetic organization in 45.198 s and 51.24 s; originals remained byte-exact and analysis/automatic settings were restored | These disposable fixtures do not establish fresh owner provisioning or UAT acceptance. Trash does not claim physical deletion; unchanged results do not prove a semantic move. |
| Updates | Exact Dev 15 → Dev 16 recovery passed on both clouds. Earlier normal Dev 12/15 owner-approved installations pass; Dev 17 pins the qualified executable and predecessor without rebuilding it | New exact Settings approval with active-work drain, interruption/reconnect consistency and personal-profile acceptance remain required. Production provenance and destructive rollback faults are separate gates. |
| Private chat | Earlier 20 cold and 20 warm synthetic turns per cloud and bounded soak pass. Exact Dev 16 target chat completed: GCP first text 16.351 s/total 21.664 s; Azure 21.82 s/29.47 s | These individual target samples are not cold p95. Recorded voice, complete connector approval/resume and the failed cold-start target remain separate. |
| Puppy / phone | Physical S24 Ultra has dated signed-admission, direct stream and same-turn Stop receipts. After the Mac reboot, the existing Hermes identity reconnected: first browser turn failed at 93.1 s; warm retry streamed first text at 17.667 s and completed at 18.345 s. Existing grant withdrawal, reconnect and idle/wake receipts remain. | The failed first attempt is retained. Independent internet paths and the repaired model footer need current-image acceptance. Restored wireless pairing does not prove the currently intermittent phone browser-debug transport. |
| Setup / billing | Durable retry, recovery links, explicit Shared/unplaced authority and assignment preservation exist | Fresh setup and missing-billing/policy return on both clouds without duplicate resources. |
| Google connectors | Sealed native authorization, refresh/restart fences, exact reviews and direct notification coalescing exist | Native iOS/Android authorization, scope upgrades, direct delivery and approved legacy hub credential removal. |
| Existing users | Explicit Shared choice and strictly evidenced legacy cohort; assigned/pending/unresolved pods cannot silently become Shared. Existing-user changelog admission exists; new users are excluded | Graduate schema/backfill and configure reviewed environment-specific changelog content before rollout. Actual UAT/production cohort adoption needs readback. |
| Resource lifecycle | Oct 12 Azure inventory classified active, shared recovery, pending setup and obsolete synthetic resources. Two obsolete test apps, one temporary registry and its exact pull grant were deleted and absence verified. Personal pod configuration is unchanged; shared storage, keys, identities and environment were retained | GCP retained object versions still require custody/retention reconciliation; Azure fixture prefix access is refused. No complete physical erasure claim. |
| Native security | Exact Capacitor 8.4.3 pins and reserved-proxy chat refusal; old-code negative control fails | Rebuilt native binaries and their independent distribution/acceptance. Web deployment is not a native release. |
| Cloud moves / Computer Use | Source foundations refuse unqualified custody and execution | Neither capability is offered until its transfer/recovery or per-cloud sandbox/privacy gates pass. |

Puppy requires a registry-confirmed owner-cloud assignment, active device and
owner grant bound to the current pod incarnation. Shared and Hussh-hosted pod
modes refuse inference. Phone browser HTTP/SSE and Mac sealed WSS are separate
transports; a successful health check proves neither a device response nor
independent-network access.

## Performance and economics

| Measurement | Result | Interpretation |
| --- | --- | --- |
| Matched GCP first text | 20 cold: p95 71.721 s; 20 warm: p95 7.700 s | Cold target ≤30 s fails. Operator admission is included. |
| Matched Azure first text | 20 cold: p95 71.304 s; 20 warm: p95 13.389 s | Cold target fails; image pull 26.048 s and recovery 3.251 s were separately observed. |
| Dev 15 Puppy wake | Confirmed post-zero first token 65.836 s; completion 66.150 s | One cold sample, not p95. Idle closure and zero replicas were observed separately. |
| Physical S24 Puppy | First text 30.658 s; completion 30.974 s; activation 14.343 s and device dispatch-to-text 15.866 s | One foreground Wi-Fi sample, not cold p95. The original missing-footer harness timeout and independent terminal readback are retained; no resend hid the failure. |
| Bounded runtime | Ten-minute soak settled 20 synthetic operations/cloud | Different CPU/memory aggregations cannot establish comparable peak capacity or real Puppy overlap. |
| Model qualification | Gemini 3.8 tools 2/3; 3.5 Flash LOW and Flash-Lite LOW 3/3 tools + 5/6 first-tool; Azure Luna 3/3 + 6/6 | Small bounded sample; defaults unchanged. Observed provider failures/429s remain recorded. Estimated qualification charge $1.96791915 of the $2 ceiling. |
| Monthly package | 30 billable hours, 50 GiB, 1,500 modeled calls + $5 reserve: Google/3.8 $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32 | Dated planning estimates, not equivalent quality, invoices or quotas. |

Qualification uses **1 vCPU, 2 GiB RAM, min 0/max 1 and one worker**. Existing
owners retain their selected configuration. GCP concurrency is eight; Azure's
HTTP threshold eight is not a request cap. Status polling must not wake compute;
direct relay grace remains ten minutes. Open sockets and scale-down tails extend
paid time. Spending thresholds warn without stopping service.

See [whole-package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget).
Matched comparisons include disk, secure ingress, wake control, storage, custody,
maintenance and model calls; equal vCPU labels do not prove equal performance.

## Owners and next gate

| Owner | Required decision or receipt |
| --- | --- |
| Engineering / release | Personal-profile idle/wake, exact Settings-approved active-work update, native connectors and cold-start improvement; retain exact image compatibility. |
| Production / operations | Migration/release graduation, legacy cohort continuity, IAM, billing, erasure/retention, recovery, hub capacity and independent UAT acceptance. |
| Owner / device | Independent internet Puppy check; preserve the existing identity, assignment and grant. No re-registration or reset. |
| Documentation / Wiki | Keyless Drive renewal repaired in the Wiki repository: [PR 6](https://github.com/kushaltrivedi5/Hussh/pull/6), 73 MCP cases, old-code negative control and independent review. `hussh-mcp-00329-xub` serves exact source `602b6e31dc83`, digest `b12b4fd8d9f0`, with unchanged configuration. Private affected article patch passed immediate and delayed readback. No universal Wiki freshness claim. |

[Application PR 7555](https://github.com/hushh-labs/hushh-research/pull/7555)
remains draft. No application merge, UAT/production deployment, stable-channel
publication or automatic owner upgrade is authorized by this readiness result.

Operational owners: [Files](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md),
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md),
[cloud-move contract](../architecture/pod-migration.md).

## Reviewed integration debt

The [architecture baseline](./architecture-fitness-baseline.json) retains exact
reviewed spans, source hashes, parent revisions and rationale. Budgets
500/250/80, scanner and exclusions remain unchanged. Reviewed inherited debt is
not deployment acceptance; chronology remains in Git history.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and cloud-specific gates belong to the deployment standard.
