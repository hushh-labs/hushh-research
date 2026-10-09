# Private-pod readiness: CTO decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-09

**Production rollout is withheld.** Both clouds have passed isolated Files,
recovery and bounded runtime qualification. Normal owner-approved installation,
provider/native journeys and the cold-response target still require evidence.
Green CI, a healthy endpoint or a published image cannot replace those receipts.

Finish one integrated candidate on the existing infrastructure branch. Keep
owner resources, selected configurations and trusted identities. No application
merge to main, UAT/production deployment or stable-channel publication is included.
Computer Use and cross-cloud moves remain disabled.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Integrated source | Frozen candidate `6d64de03b78e`, reviewed main `c9168bb1debb`, frozen local ADK `64c2739df301`; missing canonical migrations and concurrent account-erasure fixes integrated | Exact candidate core passes in 9m18s: 16,794 parallel backend, 464 PostgreSQL and 380 PKM cases. A separate affected PostgreSQL run passes 769 cases; 38 restored-schema cutover cases are explicitly unperformed. Later root/operator and ADK work remain outside this release. |
| Hosted CI | [Exact candidate CI 37999315600](https://github.com/hushh-labs/hushh-research/actions/runs/37999315600) succeeds October 9, 22:42 UTC: backend, migration, security, governance, contracts and integration | Frontend, browser, native and CI-definition trees are byte-identical to the [full successful 890 candidate](https://github.com/hushh-labs/hushh-research/actions/runs/37996020710). Retain both receipts and the two cancelled coordination-race runs; no gate was weakened. |
| Integration corrections | Private email receipts stay on the sealed pod ledger. Partial/uncertain Gmail changes expose confirmed progress and cannot be replayed. Native composer/panel improvements retain pod status, Files, Hosting and Updates | 128 focused backend and 157 frontend checks pass; TypeScript and changed Swift syntax pass. Mail account/session fences pass 43 nearest cases and the broken callbacks fail a negative control. No new cloud behavior is claimed. |
| Azure Files repair | Canonical subscription role IDs qualify only for the approved subscription/GUID, exact permissions and resource-group scope. Fresh owner authorization and strict metadata CAS retain the same approval, lease and failed receipt; executor runs only remaining grants | 110 nearest Azure checks pass, including suffix execution and migration 957 late-erasure validation. Source repair is not live acceptance. All four resource receipts completed live. Azure then failed before replacement because default scaler rules are null. A bounded source repair journals replacement intent and permits one readback-qualified continuation of that legacy failure; generic crash recovery remains refused. |
| Owner interface correction | Compact profile entry opens the existing consent surface; empty business discovery stays quiet; the unqualified Browser entry is removed. A blocked update displays attention instead of Online and prevents proactive wake. Settings retains Microsoft continuation for the existing operation after refresh or popup closure | Nearest interface, presence, admission and update cases pass; false-completion negative controls fail on the original predicates. Normal Google owner identity and cold passphrase unlock were verified October 9. The new application serves; held owner-pod installation and live acceptance remain. |
| Verified update completion | Authorization completion carries the existing operation/release tuple. Settings, Feed and the standalone return page require its matching server-verified receipt and installed digest; completed jobs and version labels cannot establish success | 76 nearest frontend and 37 backend cases pass; original source fails the false-completion negative controls. Feed and return-page fixtures now require the same exact receipt and preserve label-only and job-only refusal coverage. TypeScript and focused lint pass. No live installation or recovery is inferred. |
| Startup correction | Pinned semantic model assets and action vectors are packaged offline in the candidate pod image; lazy hub imports preserve route contracts and semantic loading remains on demand | Nearest cases pass and the original warmup predicate fails its pod regression. The governed pod build passed; no cold-latency improvement is inferred. |
| Dev application | [Main-owned dev run 38000722312](https://github.com/hushh-labs/hushh-research/actions/runs/38000722312) completed successfully: exact `6d64de03b78e`, both services, pod-image building | Approved-ADC readback October 9, 23:10 UTC confirms backend `00152-x5w` and frontend `00130-dzb`, 100% traffic, matching source/run provenance. Parity, schema and semantic checks passed. Prior `00151-9x6` / `00129-bn5` remain rollback targets. |
| Serving image digests | Backend `95f19ee11eb0f2fc9c79bfe604affa943e0b2908d41627d1c2ae3aa387c67c00`; frontend `4e4299a9476f5bd89f3a98318ae5b4629e86d4fdd01f2750c7fb37bd1ab06b36` | GitHub Actions governs; Cloud Build builds immutable images. |
| Pod offers and installation | Dev-only release 13 built and published; its publication did not install or retarget the already approved release 12 (`e213acf2468179177371709fb2651eb622439ec8c2a2df3d11394d23867ffa1e`) | Exact predecessor `ace34069` qualified on both clouds. Fresh normal owner authorization retained the original operation and all four Files resources. The October 9, 23:19 UTC null-scaler failure occurred before image replacement; installed `.7`, storage, keys and selected configuration remain intact. Installation is not accepted. |
| Migration lineage | Reviewed main `c9168bb1debb`; repair `3cab2bf2c201` preserves canonical 249/289–291 and registers commerce 292, Shared 293 and profile bridge 294; historical preview SQL remains retained | Shared-dev replay ignores baselines and writes no release receipts. Exact dev-only deferral prevents canonical 249 cleanup during this compatibility deployment; checksum drift and ledger mode refuse. Prior parked 944 cutover evidence is separate. Existing preview stays on its own lineage; no database mutation is inferred. |

## Acceptance matrix

| Journey | Source / isolated evidence | Required live acceptance |
| --- | --- | --- |
| Files workspace | `agent_files`, dedicated explorer; both clouds pass resumable 4 MiB + 1 KiB transfers, duplicate chunks, byte-exact download, folder move/rename/undo and trash/restore | Normal owner Edge session, exact four-change approval and fresh Microsoft authorization completed. Role readback now qualifies; all four resource receipts completed. Null scaler configuration then stopped replacement. Installed `.7` remains unchanged, Files disabled. Installation and live transfer acceptance remain. |
| Files organization | GCP authenticated Cloud Tasks and Azure managed-identity Storage Queue complete opted-in synthetic jobs; exclusions and cancellation preserve originals | Owner opt-in/UI, provider IAM and actual queue delivery |
| Software updates | Exact `ace34069` → `e213acf2` recovery passes on both clouds: identity, keys, selected configuration and encrypted information retained | Settings approval and Microsoft handoff began while synthetic chat was active; this alone does not prove authenticated drain. Installation failed before image replacement. The same held operation requires verified continuation, restart, installed digest and Files bytes. |
| Private chat | Current image completes 20 cold + 20 warm turns per cloud; bounded one/two/four chat–Files–status overlap and ten-minute soak pass | Normal-browser first-token timing, recorded voice and complete connector approval/resume |
| Puppy | Existing Hermes identity/grant; signed Azure endpoint and inference-only binding; post-zero sealed admission in one attempt; idle release and owner-triggered wake pass | Browser inference, server-side cancellation, withdrawal/re-enable and independent active internet paths |
| Setup / billing | Durable retries preserve assignments/pending state; missing billing has recovery links; explicit Shared/unplaced authority is retained | Fresh setup and billing/policy return without duplicate resources on both clouds; Azure subscription eligibility |
| Google connectors | Sealed native authorization, refresh/restart fences, exact reviews, direct notification coalescing and bounded durable jobs | Native iOS/Android sign-in, provider scope upgrades, notifications and approved legacy hub custody removal |
| Existing Shared users | Actual UAT/production cohort inspected; parked 958 captures only eligible legacy users once, excluding assignments, provisioning and prior choices | Additive schema/backfill graduation before production traffic; no production schema mutation occurred |
| Cloud migration | Record-only prototype refuses source-custody memory and retains unresolved recovery/cleanup receipts | Full private key/object transfer, Files/session readability and provider-resource reconstruction are missing; no cloud move is offered |
| Computer Use | Task/preview/takeover, consented PKM ports and encrypted opt-in remembered sessions are source-backed | Separate cloud sandbox/privacy/lifecycle qualification; capability remains disabled |

Qualification configuration: **1 vCPU, 2 GiB RAM, minimum zero, maximum one
instance, one worker**. GCP request concurrency is eight. Azure's HTTP scaler
threshold of eight is not a request cap. Existing owners retain their selected
settings; the personal Azure pod remains **0.5 vCPU / 1 GiB**. Status polling must
not wake compute; the direct relay idle grace is ten minutes.

## Performance and economics

| Measurement | Result | Decision |
| --- | --- | --- |
| GCP cold / warm first text | Cold 20/20, p95 **71.721 s**; warm 20/20, p95 **7.700 s** | Cold p95 ≤30 s target fails; operator admission included, not browser timing |
| Azure cold / warm first text | Cold 20/20, p95 **71.304 s**; warm 20/20, p95 **13.389 s** | Cold target fails; image pull 26.048 s and recovery 3.251 s measured separately |
| Hermes post-zero admission | Challenge **45.532 s**, admission **46.366 s**, sealed WSS **0.532 s**; total owner preflight/control **57.125 s** | Finite challenge wait fixed the observed 30.212 s timeout; this is not first-token or full browser acceptance |
| Bounded runtime | Ten-minute soak settles 20 synthetic operations/cloud; Azure sampled memory 0.500 GiB/CPU 0.092 cores; GCP one-minute p95 memory 20.95% of 2 GiB/CPU 31.95% | Different aggregations; not comparable peak capacity or real Puppy overlap |
| Model qualification | Gemini 3.8 tools 2/3 (504); 3.5 Flash LOW 3/3 tools + 5/6 first-tool; Flash-Lite LOW 3/3 + 5/6 (Drive refusal); Azure Luna 3/3 + 6/6 | Small bounded sample. Governed defaults unchanged. Preserve observed 429/retry failures; qualification estimate $1.96791915 of $2 ceiling |
| Monthly package | 30 billable hours, 50 GiB, 1,500 modeled calls + $5 reserve: **Google/3.8 Flash $38.69; Azure/Luna $18.74; Google/Flash-Lite $23.32** | Dated planning estimates, not equivalent quality, invoice or quota. Infrastructure/model rates retain their verified dates and exclusions |

See [whole-package assumptions and VM comparison](../operations/private-files-library.md#whole-package-planning-budget).
VM comparisons include disk, IP, image custody, hypothetical wake control and AI.
Equal vCPU labels do not prove equal performance. Open sockets and scale-down
tails extend paid time. Spending thresholds warn without stopping service.

## Reviewed integration debt

At `eb3402499`, 104 exact upstream finding slots and 46 independently reviewed
merge slots were reconciled against frozen source revisions and file hashes.
Budgets (500/250/80), scanner, exclusions and future regression enforcement remain
unchanged. Review found and fixed a Mail account/session race; 43 nearest cases
pass and the original callbacks fail the behavioral negative control. This is a
measured structural-debt baseline, not a readiness or live acceptance receipt.

## Owners and next gate

| Owner | Required receipt |
| --- | --- |
| Engineering / release | Exact local core, affected PostgreSQL, docs and hosted CI pass. Governed run 38000722312 and serving readback pass. Validate/deploy the bounded null-scaler repair, then continue the same held owner operation and verify its installed digest/recovery. Canonical 249 stays deferred. |
| Owner / device | Normal Google-authenticated owner browser, memory-only unlock, exact approval; device-session or admin credentials cannot substitute for browser authority |
| Azure subscription | Eligible fresh environment/model resources; existing-environment qualification is narrower |
| Production | Migration/release graduation, actual legacy cohort continuity, IAM, erasure, recovery, hub capacity and independent UAT acceptance |
| Documentation / Wiki | Refresh report using measured results, source/serving distinction and current private Wiki readback; preserve concurrent PDF governance edits |

Operational owners: [Files](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md),
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md),
[cloud-move contract](../architecture/pod-migration.md).

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; CRM remains. Current
Google/Azure choices and cloud-specific gates belong to the deployment standard.

## Files continuation evidence — 2026-09-25

Historical pointer: early source checks were not owner-cloud activation receipts.
Dev history cleanup 944 completed September 28 under
[run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630).
The former branch-only profile bridge is now canonical 294; canonical 249 remains
deferred in shared-dev pending separate cutover evidence. Current acceptance belongs to the
matrix above; Git history retains the chronology.
