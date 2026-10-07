# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries live in the [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-07

**Hold dev acceptance: strict verifier bootstrap failed after traffic promotion.
The narrow environment/native-gate correction requires new exact-SHA CI and a
terminal governed deployment. Owner installation and Computer Use remain gated.**
The interrupted BYOC handoff is integrated, including the confirmed authority,
recovery and UI corrections.
Source implementation does not establish owner-cloud acceptance. Existing owner
resources, selected hosting, trusted identities and concurrent work are preserved.

## Source and serving evidence

| Surface | Verified evidence | Limit |
| --- | --- | --- |
| Application | `2d965641308dab5f8b1f8196ddd99e782963c573`; main `be8d4e014b34` and frozen local ADK `eb76e00af60a` included. [Hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/37572520334) passed all required jobs. | Later ADK and unrelated commerce/native/PDF work stay outside this frozen candidate. Promotion preserved 270 concurrent dirty/untracked leaves byte-for-byte. |
| Dev services | 2026-10-07 05:21 UTC: backend `consent-protocol-00144-rs9`, frontend `hushh-webapp-00122-th9`, both source `2d965641308d` at 100% traffic. [Deployment 37574435209](https://github.com/hushh-labs/hushh-research/actions/runs/37574435209) failed before semantic smoke; no rollback occurred. | Health, provenance and schema acceptance do not prove owner-pod journeys. |
| Schema | Readback at 2026-10-07 05:11 UTC: dev 955/956 applied; all 55 prior ledger rows unchanged, including 944. Required tables, columns and functions are present; no dev checksum mismatch. | Dev-only registration remains; ledger deploy-SHA fields are unset, so exact-source attribution comes from the governed workflow and matching SQL checksums. No UAT/production schema claim. |
| Pod release | Dev `2026.10-dev.8`, source `2d965641308d`, immutable digest `sha256:8d49af56df8efd8911ce241e05637941e10dce6e8662e3fa3df81569a1672cca`; validated readback 05:31 UTC. No admitted predecessors. Correction descriptor Dev 9 is prepared, not published. | Publication never installs an image. Exact predecessor recovery and normal owner approval remain mandatory. |
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
| Computer Use | Authenticated task runtime, isolated ADK runner, scoped PKM, exact reviews, private preview/takeover and encrypted origin-bound remembered sessions with race-safe Forget. One receives metadata only. | Both cloud execution gates are closed. No real owner information or remembered login was admitted. |

## Blockers with owners

| Owner | Remaining gap | Next required evidence |
| --- | --- | --- |
| CI / release | Bootstrap rejected a configured native public-client key absent from all four profile templates. Semantic smoke never ran; classifier blocked without rollback. | Correct the templates, preserve unknown-key refusal and obtain exact-SHA hosted/terminal dev success. |
| Release / recovery | Dev 8 admits no predecessor digest. No reusable original exact-image-pair receipt was found. | Normally admitted disposable owner pod; actual old/new images, encrypted continuity, cold recovery and revocation. Then qualify only that digest and use normal Settings approval. |
| Native / provider | iOS client is configured but live authorization is unproved. The correction accepts governed dev's `uat` runtime identity only with explicit Android opt-in; production/unknown labels still refuse. Live flag remains false. | Qualify Android registration, then normal iOS/Android sign-in. No client-secret fallback. |
| GCP / browser | Native worker UID/GID zero; required non-root switch fails `EPERM`. No supported provider identity selector is established. | Supported provider identity control, Chromium sandbox, private broker bridge, denied-egress and lifecycle probes. Preserve refusal; no unsandboxed fallback. |
| Azure / browser | Native service is generally available; the synthetic Deny/Full policy included two unqualified authority fields and execution was refused. | Qualify the current policy schema and private bridge, then Chromium, isolation and teardown. Group membership alone is not private transport. |
| Owner acceptance | Normal Google-authenticated owner browser, unlocked vault, native device/provider flow and awake Hermes are not established by reviewer-minted sessions or cloud CLI access. | One normal owner acceptance window. Preserve enrollment/consent and distinguish reviewer, personal and repaired-billing owners. |

## Verification and measured cost

- Source `2d965641308d` passed local core in **495 seconds**, including 16,036 parallel protocol checks,
  572 isolated PostgreSQL checks, web build/type/lint, governance, secrets, MCP and
  380 integration checks. Owned loopback PostgreSQL was removed; the existing
  local service was untouched. Hosted CI independently passed on the exact SHA.
- Hosted browser: **19m58s**; Chromium 549 passes and WebKit 475 passes, with ten
  existing skips each. Tablet recovery passed in both engines. The Reply focus
  race and divergent popup notice were fixed; old-source controls fail. One
  Connections fixture mount flaked and passed on retry; retain it as a fixture
  follow-up, not evidence of a CSS defect or permission to remove the gate.
- Recovery: restored dev backup passed two canonical replays and both schema
  guards. All 230 retained tables, 53 ciphertext/key projections and 25 key/PKM
  tables stayed intact. Only 955/956 were added; old receipts and orphan counts
  remained unchanged. The original destructive seed replay was repaired at
  `590fdbb893c6`, with six focused checks and failing old-code controls. The
  isolated restoration target was deleted; the restricted recovery point remains
  bounded through dev revalidation.
  This is database recovery, not owner-image or production recovery.
- The narrow correction passes **63** nearest environment/build cases and **15**
  native authorization cases. Old-template and both old Android gate controls
  fail. Strict unknown-key refusal remains; no configured secret was removed.
- The correction's first complete core attempt recorded 20 failures: two clock
  fixtures and existing execution deadlines. The two fixture corrections preserve
  correlation, secret cleanup and refusal assertions. A two-worker focused run
  passed 196 checks; four unchanged elapsed/CLI limits still require isolated
  recheck and exact-SHA hosted proof. No deadline or security gate was widened.
- All **181 Mermaid figures** rendered. The reviewed fitness baseline retains
  2,209 findings and budgets 500/250/80; future new or worsened debt still fails.
  The environment-test module is reviewed from 572 to 634 lines for the runtime
  regression proof; its new helper/test remain 23/34 lines. The existing voice
  fixture adds one injected clock line (4,358 to 4,359); all timing/privacy
  assertions remain. No mass splitting or structural exemption was introduced.

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
and old-selector/missing-WebKit negative controls pass; narrow coverage remains. Earlier long runs retried broken fixtures. The failed current
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
