# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries live in the [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-07

**Hold dev acceptance: the exact-SHA release reached traffic, but the semantic
verifier falsely rejected a canonical private-placement refusal. Backend rollback
completed; the candidate frontend remains. The corrective candidate needs hosted
CI and a terminal governed deployment. Owner installation and Computer Use stay gated.**
The interrupted BYOC handoff is integrated, including the confirmed authority,
recovery and UI corrections.
Source implementation does not establish owner-cloud acceptance. Existing owner
resources, selected hosting, trusted identities and concurrent work are preserved.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Application | `efd2324d5b99cf55e67584bf546f17a29df45920` passed all 22 [hosted jobs](https://github.com/hushh-labs/hushh-research/actions/runs/37600364587). The correction integrates main `1de271b46fa7`; frozen ADK `eb76e00af60a` remains included. | Later ADK and unrelated commerce/native/PDF work stay outside this candidate. Previous promotion preserved 338 concurrent leaves byte-for-byte. |
| Dev services | 2026-10-07 10:50 UTC: backend `consent-protocol-00144-rs9` / source `2d965641308d`, frontend `hushh-webapp-00123-f6c` / source `efd2324d5b99`, each 100%. [Deployment 37607407334](https://github.com/hushh-labs/hushh-research/actions/runs/37607407334) failed semantic verification and rolled back the backend. | Mixed serving revisions are not final dev acceptance. Health, provenance, bootstrap and schema passed; owner journeys remain separate. |
| Schema | Fresh predeploy readback: 57 dev ledger rows, including 944/955/956, unchanged; required schema is present, no checksum mismatch. Isolated restoration previously preserved retained ciphertext. | Dev-only registration remains; no UAT/production schema or owner-image recovery claim. |
| Pod release | Serving backend readback 11:01 UTC: Dev 8 / source `2d965641308d`, digest `sha256:8d49af56df8efd8911ce241e05637941e10dce6e8662e3fa3df81569a1672cca`, no admitted predecessors. The latest service template contains Dev 9 but is not the serving revision. | Publication and template configuration never establish an installation or a serving offer. Exact predecessor recovery and normal owner approval remain mandatory. |
| Owner pods | No owner image, assignment, device or resource changed in this continuation. | Hub revisions and installed pod digests are separate authorities. |

## Acceptance matrix

| Journey | Source / local result | Dev acceptance still required |
| --- | --- | --- |
| Placement / setup | Explicit Shared and `unplaced`; assigned/pending modes preserved. Direct setup validates identity, IAM, exact routes, CORS and admission. | New/existing setup, billing/policy retry and no duplicate project or assignment. |
| Private connectors | Sealed native PKCE, pre-admission credential hydration, declared connector routes, exact review/resume and explicit unavailable states. | Real provider authorization, scope upgrade, restart and exact approval. Android opt-in is corrected locally; live provider qualification is absent. |
| Google transition | Project/account grouping, owner-confirmed old-grant revocation, signed current-pod receipt and refresh/CAS fencing. | Provider-confirmed transition and removal of unchanged legacy credentials/readers without revoking the fresh grant. |
| Notifications / consent | Exact OAuth-project topic and owner-project OIDC subscription; durable coalescing/checkpoints; incarnation-bound revocations and metadata feeds; Nav receives owner authority. | Owner-cloud provisioning, duplicate/lost notification, queue drain, watch renewal and idle return. Reserved/commercial scopes retain canonical authority. |
| Files | Dedicated `agent_files` and `/one/files` explorer retained. Earlier installed-image receipts cover resumed transfer, exact download, undo, trash/restore and organization consent. | Regression, authenticated background completion and overlapping work on the newly installed candidate. Earlier receipts are dated, not transferable proof. |
| Puppy | Existing trusted identity, owner grant and direct stream retained; earlier response/cancellation/withdrawal receipts remain. | Fresh binding and response after approved update, independent active internet, usable cold latency and bounded overlap. |
| Updates / recovery | Exact-release owner approval, durable operation, drain and Settings/Feed state retained. | Actual predecessor pair, active-work handoff, one installation, restart, digest/recovery verification and continuation. Historical Dev 4/5 success does not qualify Dev 8. |
| Release experience | Concise existing-account announcement; new/unknown accounts receive no catch-up. Installed pod notes use exact retained completion receipts, independently of a newer offer. Hosting is untouched. | Corrective exact-SHA CI, dev serving/UX readback and actual owner-update receipt. UAT/production announcement activation and actual legacy Shared cohort qualification remain separate gates. |
| Computer Use | Authenticated task runtime, isolated ADK runner, scoped PKM, exact reviews, private preview/takeover and encrypted origin-bound remembered sessions with race-safe Forget. One receives metadata only. | Both cloud execution gates are closed. No real owner information or remembered login was admitted. |

## Blockers with owners

| Owner | Remaining gap | Next required evidence |
| --- | --- | --- |
| CI / release | Canonical 409 carries `code`, `hostingMode` and `message`; the verifier expected exactly one field. Candidate request logs and live readback confirm 409. | Correct code/status/private-mode recognition; preserve 401/503/unrelated/contradictory refusals. Obtain exact-SHA hosted and governed dev success. |
| Release / recovery | Dev 8 admits no predecessor digest. No reusable original exact-image-pair receipt was found. | Normally admitted disposable owner pod; actual old/new images, encrypted continuity, cold recovery and revocation. Then qualify only that digest and use normal Settings approval. |
| Native / provider | iOS client is configured but live authorization is unproved. The correction accepts governed dev's `uat` runtime identity only with explicit Android opt-in; production/unknown labels still refuse. Live flag remains false. | Qualify Android registration, then normal iOS/Android sign-in. No client-secret fallback. |
| GCP / browser | Native worker UID/GID zero; required non-root switch fails `EPERM`. No supported provider identity selector is established. | Supported provider identity control, Chromium sandbox, private broker bridge, denied-egress and lifecycle probes. Preserve refusal; no unsandboxed fallback. |
| Azure / browser | Native service is generally available; the synthetic Deny/Full policy included two unqualified authority fields and execution was refused. | Qualify the current policy schema and private bridge, then Chromium, isolation and teardown. Group membership alone is not private transport. |
| Owner acceptance | Normal Google-authenticated owner browser, unlocked vault, native device/provider flow and awake Hermes are not established by reviewer-minted sessions or cloud CLI access. | One normal owner acceptance window. Preserve enrollment/consent and distinguish reviewer, personal and repaired-billing owners. |

## Verification and measured cost

- `efd2324d5b99` passed the completed local core mirror in **713 seconds**:
  16,046 protocol, 572 isolated PostgreSQL and 380 integration checks, plus web,
  governance, secrets and MCP. All 22 hosted jobs passed in **27m40s**; iOS led at
  **25m15s**. Source CI and deployment duration are separate measurements.
- The verifier correction passes 16 nearest cases. Its old predicate fails four
  canonical private modes; authentication, unknown/shared mode, unavailable state
  and unrelated conflicts still block. The corrected live verifier passed twice,
  with the RIA provider explicitly degraded. A hub refusal is not pod recovery.
- Fresh-main integration passes 471 focused voice/protocol and 77 affected web
  checks. Conflict resolution keeps owner/operation fences and reply focus while
  adopting inline errors; stale rejected actions cannot paint another owner's UI.
  Generated projections come from their owners, not hand-selected merge sides.
- Corrective source `43df78dfd35f` passed completed local core: 16,094 protocol,
  572 isolated PostgreSQL and 380 integration checks. Wall elapsed was 8,105
  seconds; protocol execution reported 469 seconds. This is not a pipeline speed
  claim. A stale voice-budget negative fixture now crosses the actual approved
  cap; the checker and budget are unchanged. Final review also fenced the new
  Drive recheck before a private owner can reach the shared hub: 10 focused cases
  pass, and removing that guard fails the existing private-placement case.
- Release notices passed 56 frontend and 74 backend checks. Four broken account,
  cohort, verification and incarnation controls are refused. Chromium/WebKit cover
  24 responsive/theme states and real two-tab claim/refresh behavior. These are
  synthetic local checks, not owner-cloud or production acceptance.
- Restored dev backup passed two canonical replays and both schema guards:
  230 retained tables, 53 ciphertext/key projections and 25 key/PKM tables remained
  intact. Only 955/956 were added. The isolated target was deleted; the restricted
  recovery point is bounded through dev revalidation. This proves database
  recovery, not owner-image or production recovery.
- Prior source rendered all **181 Mermaid figures**. New or worsened architecture
  debt still fails against a reviewed integrated baseline; budgets remain
  500/250/80. Current corrections must pass their own completed-candidate checks.

### Reviewed integration debt

The fresh-main review updates only 25 measured findings on 18 paths: 19 match
incoming main byte-for-byte; six modules combine incoming behavior and coverage
with existing admission/owner fences. Direct-message negative controls cover late
authorization, late success and late failure after an owner change. The verifier's
small response classifier reduces its existing main function. The baseline retains
all other debt and unchanged 500/250/80 budgets; future worsening still blocks.
The owning generator additionally retains two workflow compatibility revisions
(1,431 → 1,433 lines); authored semantics and alias preservation are unchanged.
The Drive refusal uses the existing placement owner and a flat request/parse flow;
its module span and all debt ceilings remain unchanged.

### CI and deployment performance

The bounded Actions review sampled two successful dev and three UAT deployments.
Dev backend/frontend plus pod image took **14m21s / 14m54s**. UAT frontend-only
execution took **14m11s**, with a separate 14m53s wait before its job; UAT with
backend/frontend/Drive worker took **21m55s / 29m34s**. Scope and queue delay matter.
Source validation is separate: `2d965641308d` took **22m20s** created-to-terminal,
led by the browser lane. It is not the deployment duration.

Full-suite jobs already own duplicate targeted unit/static checks. The measured
34-case agent browser overlap cost 15.6 seconds; its selector now consolidates
only when the broad two-engine pack is selected. Six nearest selector checks
and old-selector/missing-WebKit negative controls pass; narrow coverage remains. Earlier long runs retried broken fixtures. The earlier bootstrap-failed
deployment took about **17m17s**. Its backend image reuse
step took one second; the new pod image took about 173 seconds. No disconnected
gate, same-image rebuild or runner/cache cause was proved by this sample. Keep native,
security, PKM, migration, browser and provenance checks. See the
[dev timing procedure](../operations/dev-fast-lane.md#deployment-duration-and-independent-work).

## Next gate and historical boundaries

Freeze the correction, run the completed local core mirror once, obtain hosted
CI on that exact SHA, then dispatch the main-owned dev workflow from this branch.
Verify terminal status and serving/schema/release readback before owner acceptance.
The failed release and its receipts remain evidence. No application merge to main,
UAT/production deployment, stable publication or owner installation is authorized
by source validation or a published offer.

The affected One hosting, private ADK and private-agent Wiki sections were
corrected and read back. Dated historical evidence stays separate from the current
matrix. Operational procedures remain in the [Files contract](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md).

- Dev cleanup **944 completed on 2026-09-28** under
  [governed run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630).
  Migration 249 is the public-profile bridge. No repeated history deletion;
  a no-op SQL rollback is not recovery. Retained-backup erasure and production
  cutover remain separate.
- Earlier cold Puppy and mixed-work samples failed usability budgets. These
  failures remain valid; green CI does not establish acceptable cold latency,
  sustained capacity or scale-to-zero. Measure wake/admission/relay/model stages;
  missing measurements are not zero. Spending thresholds warn without stopping service.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and their gates belong to the deployment standard.

## Files continuation evidence — 2026-09-25

Historical pointer: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own later acceptance.
