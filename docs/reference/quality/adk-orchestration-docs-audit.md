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
| Last complete CI evidence | `22e9146432a5`, including main `a7a4439a8e2b`, the reviewed ADK presentation delta and concurrent committed work | The combined candidate requires exact-SHA hosted validation. Concurrent PDF, configuration, native package and shareable-report edits remain outside the release. |
| Local setup correction — Oct 11 PDT | Commit `d18b5714d3`: organic unfinished login enters hosting first. Hosting and AI share one wizard; the duplicate hub AI row is removed. Durable markers, pending setup and owner-generation fences remain. 166 focused cases, 18 graph cases and eight setup-hub responsive checks pass; types, lint and generated UI checks pass. | Local source only; not included in the serving release. The responsive evidence covers the setup hub. Existing authorized browser/debugging sessions are preserved. |
| Local Files/Puppy corrections — Oct 12 UTC | `ce3331cb21` clarifies immutable original-name provenance versus reversible display names; 102 focused cases and the broken-code negative control pass. Puppy preserves terminal model reports and distinguishes device timeout, agent deadline and unconfirmed cleanup; 210 focused cases plus 90 affected boundary cases pass, with independent review. | Source corrections require exact-SHA CI and an owner-approved image before being described as installed. Timeout limits, consent and provider selection are unchanged. |
| Combined intake — Oct 12 UTC | Candidate parent `7ed9f11e88` preserves the other agent’s completed main/ADK union and reviewed Files/Puppy corrections. Frozen main `2460f8524f` is included. Independent authority review confirms encrypted sessions, Soul bounds, private memory, fresh execution catalogs and update-permit settlement. | The local ADK’s ongoing dirty work is preserved. Later unrelated changes belong to the next cycle. Current candidate core and exact-SHA hosted CI are required before deployment. |
| Completed local core | Candidate `656e666310`: 18,084 backend unit cases and 860 PostgreSQL cases pass; web build, types, lint, generated UI, governance, secrets, MCP and integration pass. Preservation: 164 web and 388 protocol cases pass. | Backend proof was reused only across byte-identical backend trees. The original failed strict-lint receipt and two-dependency repair are retained. This receipt does not cover the newer main union. |
| Hosted CI | All 23 lanes passed on `22e9146432a5`: [run 38189857891](https://github.com/hushh-labs/hushh-research/actions/runs/38189857891). Browser lane: 28 min 01 s; complete hosted run: 30 min 37 s. | Required native, browser and full web gates remain intact. |
| Latest rejected CI | [Run 38211634206](https://github.com/hushh-labs/hushh-research/actions/runs/38211634206) failed on `a0c76dccb3f9`: stale hosting fixtures, an omitted hidden-route prerequisite and a SwiftPM binary-cache collision before native compilation. Source/fixture corrections are in the isolated candidate; the unchanged native dependencies need a fresh-runner retry. | This failure is retained. No gate is skipped and no native compile success is inferred from local source checks. |
| Governed pipeline | Pipeline-only [PR 7785](https://github.com/hushh-labs/hushh-research/pull/7785) landed through the approved Admin procedure; exact main `a7a4439a8e2b` post-merge smoke passed | GitHub Actions governs; Cloud Build builds. Dev/UAT share the canonical changed-SHA selector and independently selected preservation. This does not merge the application. |
| Dev application — Oct 12, 04:36 UTC readback | Backend `00164-r2w` / digest `1fe81b050a92` serves source `22e9146432a5`; frontend `00140-kc6` / digest `cd96c88055b3` serves source `1aeb1b4e83b6`. Both have 100% traffic. Governed backend [run 38194634611](https://github.com/hushh-labs/hushh-research/actions/runs/38194634611) and frontend [run 38199862501](https://github.com/hushh-labs/hushh-research/actions/runs/38199862501) ended successfully. | Revisions are read from nonzero serving traffic. The original combined [run 38191971231](https://github.com/hushh-labs/hushh-research/actions/runs/38191971231) retains its preservation and reviewer evidence; later scoped deployments do not repeat every journey. Local setup and domain corrections are not serving. |
| Schema | Pre/post dev schema guards passed with no violations or missing required tables, columns or functions; selected canonical head 320. This is dev evidence, not production migration acceptance. | Destructive history cleanup 249 remains deferred. No production schema mutation or SQL rollback recovery is claimed. |
| Pod release | Immutable Dev 15 `sha256:cdcf8dc27204c1386fa5cec076df81c7ffded8fbb953c8f5345faa510ed24839`, image source `1d88a25b7e47` | This is the installed predecessor. Dev 16 builds new immutable bytes; source hardening is not yet installed on owner pods. Publishing never installs. |
| Next pod offer | Dev 16 descriptor contains the Files/Puppy corrections; the Dev 15 reuse pin is removed so the governed build creates an image from the frozen candidate. | No predecessor is admitted before target-image recovery qualification. Dev 15 stays installed on the owner pod until a qualified exact-release Settings approval. |
| Personal pod installation | Normal Settings approval completed operation `op_00cc5a864dd045c095fa998339d5073d`, with restart/recovery and installed-digest readback | Same identity, keys, secret references and ingress; min 0/max 1, one worker, 0.5 vCPU/1 GiB, HTTP threshold 8 and queue scaler preserved. Active-work drain is unverified. |

The rejected [dev run 38187423540](https://github.com/hushh-labs/hushh-research/actions/runs/38187423540)
passed preservation, schema, health, provenance, parity and semantic checks, then
rolled both services back because the read-only reviewer correctly refused
ambient profile research. The correction uses the existing reviewer policy;
27 focused cases pass and old behavior fails the same zero-request assertion.
The original failed workflow and harness receipts remain retained.

## Acceptance matrix

| Journey | Demonstrated | Required before production |
| --- | --- | --- |
| Files workspace | Dedicated `agent_files` explorer. Normal owner on Azure Dev 15: interrupted/resumed upload and download, byte-exact integrity, folders, inline rename/undo, move/undo, trash/restore and same-session continuity | Repeat new/existing setup and owner-cloud storage/IAM acceptance in UAT. Local UI checks do not prove cloud custody. |
| Files organization | Oct 12 normal owner on Azure Dev 15: queue completed, synthetic receipt moved to the test folder, original name and byte-exact 189-byte download preserved; undo returned it to its original folder. Original analysis/automatic settings restored; rehearsal file/folder moved to Trash. Earlier Azure cancellation/exclusions and GCP isolated authenticated Cloud Tasks receipts remain. | Current-image GCP organization and UAT acceptance remain separate. Trash cleanup does not claim physical deletion. Unsupported or unchanged outcomes are not evidence of a semantic move. |
| Updates | Earlier exact predecessor recovery and normal Dev 12/15 owner-approved installations pass. Fresh Dev 15 fixtures are qualifying the new target; no new compatibility is admitted yet | Active-work drain, interruption/reconnect consistency and production image provenance/compatibility; destructive rollback faults stay isolated. |
| Private chat | 20 cold and 20 warm synthetic turns per cloud; bounded overlap and soak pass. Dev 15 normal-browser warm response completed in 6.876 s | Recorded voice and complete connector approval/resume, plus the failed cold-start target. |
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
| Engineering / release | Active-work update drain, native connectors, current-image GCP organization and cold-start improvement; retain exact image compatibility. |
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

The Oct 12 scope-commerce reconciliation reviews exactly 45 finding slots:
14 unchanged incoming-main spans, 27 compatibility compositions, three private
`one_memory` guards and the nearest provider-intent regression test extension.
Independent review found and repaired a lost main session-persistence timing
wrapper before accepting its revised module/class spans. The real repository
test fails on frozen `02989d1c2fc4` and passes after repair, including failure
timing, owner binding and ciphertext assertions. Exact hashes, both parents,
before/after values and qualifications are retained in the baseline's
`scope_main_and_hosted_return_20261012` entry. Every other finding slot and all
future-growth enforcement remain unchanged; full core and hosted CI are still
release gates.

The subsequent fake-provider recovery test isolates configuration explicitly,
adding two lines to its existing module span (530 to 532). Independent backend
review qualifies only that finding; the baseline records its source hash and
focused verification under `scope_commerce_recovery_test_isolation_20261012`.
Invalid ambient provider configuration cannot affect this fake-adapter test.
Production configuration validation, immutable provider requests and all other
finding slots remain unchanged.

The latest main sync at `9c4e1cb045` adds nine notification size findings:
eight spans are byte-identical incoming source, and the Capacitor index retains
root registration/listener contracts while adding three emergency-cue lines.
Backend and frontend review qualify only those spans, with hashes and provenance
in `scope_commerce_latest_main_notifications_20261012`. Finite-lived SMS delivery
does not change scope-commerce authority or strict hosted-return admission.
This is source qualification; audible cues and physical delivery remain separate
acceptance work. Every other finding and future-growth enforcement is preserved.

The main `1056ed5652` union qualifies exactly 41 additional size slots through
independent backend, frontend and operations review. It preserves lazy pod
imports, recipient/owner admission and extracted deployment packaging. Review
found a shared specialist still selecting the legacy client; default turns now
use per-turn ADK project routing while injected owner models and explicit legacy
callbacks retain their contracts. Actual `handle_turn` tests cover both caller
orders and the callback negative control. The Information class remains 337;
its ceiling is unchanged. Exact hashes and parent revisions are retained in
`scope_commerce_main_project_and_location_20261012`. Budgets, scanner, exclusions
and every unrelated finding remain unchanged. Source qualification does not
establish deployed behavior or successful provider-job cleanup.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and cloud-specific gates belong to the deployment standard.
