# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime boundaries: [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-07, 17:07 UTC

**The application release is verified on dev. Owner-pod journey acceptance and
production readiness remain held. Computer Use stays disabled in both clouds.**
The interrupted BYOC handoff, release experience and confirmed integration defects
are implemented and validated. Existing owner resources, hosting selections,
trusted identities and concurrent work are preserved. No owner image was installed.

## Exact release evidence

| Surface | Verified result | Boundary |
| --- | --- | --- |
| Source | `d496e5ce80d0021ec157844786c4c7aa836c6588`; integrated main `1de271b46fa7`, frozen local ADK `eb76e00af60a`. [Hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/37632160188) passed: 18 jobs, four expected PR-only skips. Supplemental DCO passed. | Later main/ADK and 338 independent dirty leaves are outside this frozen release. Draft PR 7555 conflicts with newer main; no merge occurred. |
| Dev application | [Governed deployment 37654169081](https://github.com/hushh-labs/hushh-research/actions/runs/37654169081) succeeded. Independent readback: backend `consent-protocol-00146-mld`, frontend `hushh-webapp-00124-lp8`, both exact source/run and 100% traffic. Health, provenance, parity and schema passed. | RIA stage-one provider is degraded. Canonical private-placement refusal is verified; it is not command recovery on a pod. |
| Schema / recovery | All 54 dev-manifest migrations, including 944/955/956, are applied with matching checksums; no required schema gap. Isolated restoration preserved retained ciphertext through two schema replays. | Database recovery does not qualify owner-image recovery or production migrations. |
| Pod offer | Serving Dev 9: `2026.10-dev.9+d496e5ce80d0.4c16f7d9`; immutable digest `sha256:4c16f7d941c62c8db17b63c0e7929efa30a4661512d427519681760ec7089783`; exact source and publishing run verified. | Zero qualified predecessor digests. Publication does not install; exact image-pair recovery and normal Settings approval remain mandatory. |

Application digests: backend
`sha256:7d18b84b1881d3e9c02ea914cd0109437665072e90759316ba917812859cd754`;
frontend `sha256:b643c857b276d07e6a8b028db401901b693c6ef6e5dd483f493a302fd8e92ae9`.
Captured rollback revisions remain backend `00144-rs9` and frontend `00123-f6c`.
The [previous failed deployment](https://github.com/hushh-labs/hushh-research/actions/runs/37607407334)
and its mixed serving pair remain historical evidence.

## Journey matrix

| Journey | Source / local evidence | Live gate still open |
| --- | --- | --- |
| Placement / setup | Explicit Shared and `unplaced`; assigned/pending modes preserved. Automatic direct setup checks identity, IAM, exact routes, CORS and admission. | New/existing setup; billing/policy retry without duplicate resources. |
| Private connectors | Sealed native PKCE, credential hydration, declared pod routes and exact approval/resume. Refresh/CAS and account/project transitions fence old readers. | Real provider sign-in, scope upgrade, restart and verified removal of unchanged legacy credentials/readers. |
| Notifications / consent | OAuth-project topic, owner-project authenticated subscription, durable coalescing/checkpoints, incarnation-bound revocations and signed metadata feeds. Nav receives owner authority. | Cloud provisioning, duplicate/lost delivery, renewal, queue drain and idle return. Reserved/commercial scopes retain canonical authority. |
| Files | Dedicated `agent_files` and `/one/files` explorer. Earlier installed-image receipts cover resumed transfer, byte integrity, undo, trash/restore and organization consent. | New-image regression and authenticated background completion after a qualified installation. Earlier receipts are dated. |
| Puppy | Existing trusted identity and signed direct stream retained; prior response/cancellation/withdrawal receipts. The existing Hermes relay is running in metadata-only activation wait. | Fresh binding/response, independent active internet, acceptable cold latency and bounded overlap. A waiting process or heartbeat is not inference acceptance. |
| Updates / recovery | Exact owner approval, durable operation, authenticated drain and shared Settings/Feed state. | Actual predecessor pair, active-work handoff, one restart, digest/recovery verification and continuation. Historical Dev 4/5 success does not qualify Dev 9. |
| Release experience | Existing dev accounts receive concise notes after unlock/setup; new/unknown accounts skip catch-up. Installed-pod notes require exact retained completion receipts. Hosting is untouched. | Actual owner-update receipt and production announcement/cohort qualification. Acknowledgement is per owner/installation, not a global cross-device receipt. |
| Computer Use | Pod task runtime, scoped PKM, separate processing/disclosure reviews, preview/takeover and encrypted origin-bound remembered sessions with race-safe Forget. | Both execution gates remain closed. No real owner information or remembered login was admitted. |

## Blockers and next evidence

| Owner | Required next evidence |
| --- | --- |
| Release / recovery | Normally admitted disposable owner; actual predecessor/target images, encrypted continuity, cold recovery and revocation. Qualify only that digest, then exact Settings approval. |
| Owner / device | Normal Google-authenticated browser and unlocked vault; native provider flow and a second independent internet path. Reviewer-minted sessions and cloud CLI access cannot substitute. The existing Hermes relay is available without re-enrollment. |
| Native / provider | Live iOS authorization and qualified Android public-client registration. Android live opt-in remains false; no client-secret fallback. |
| GCP / browser | Supported non-root worker identity, Chromium sandbox, private broker bridge, denied egress and lifecycle evidence. Required identity switch currently refuses; no unsandboxed fallback. |
| Azure / browser | Qualified Deny/Full policy schema, private bridge, Chromium, isolation and teardown. General availability and group membership do not establish these. |
| Production / placement | Qualify the actual legacy Shared cohort against 955's predicates, then graduate its migration and release channels. Repeat IAM, billing, recovery and product acceptance in UAT. Publish separately reviewed production notes. |

## Existing-user transition

Migration 955 preserves the evidenced legacy Shared cohort only when its `cloud`
setup marker exists and there is no recorded choice, deployment target, detach
history or setup job. Production has not qualified that cohort or graduated 955.
Missing placement alone must not become Shared. Without the migration, unassigned
choice-dependent resolution is unknown; existing assignments remain authoritative.

Preserve assigned pods and pending setup. Existing-account app notes follow normal
unlock and resolved setup; new accounts receive no historical catch-up. Pod notes
follow the exact successful operation, current incarnation and verified installed
digest, independently of a newer offer. Neither notice changes hosting, grants
access or starts an update. The current announcement catalog is dev-only.

## Verification and performance

- Exact application local core passed in **438 seconds**: 16,094 protocol,
  572 isolated PostgreSQL and 380 integration checks, plus web, governance,
  secrets and MCP. Hosted validation took **26m16s**, led by iOS at **24m21s**.
  Four manual-run PR-only jobs were intentionally skipped; DCO passed separately.
- Dev's active deployment job took **16m54s**; created-to-terminal was **18m23s**.
  Backend Cloud Build took 318 seconds; frontend took 143 seconds. These measure
  deployment, separately from source CI and owner installation.
- The corrected semantic verifier passes 16 nearest cases; its old predicate
  fails four private-mode controls. HTTP 401/503 and unrelated/contradictory 409s
  still block. The live private refusal explicitly reports recovery unverified.
  The new Drive recheck is fenced before shared exchange: 10 focused cases pass;
  removing the guard fails the existing private-placement control.
- Release notices pass 56 frontend and 74 backend checks, four broken boundary
  controls, 24 Chromium/WebKit responsive/theme states and two-tab behavior.
  These are synthetic UI checks, not owner-cloud or production acceptance.
- The bounded dev/UAT timing review supports scope-aware comparison. Only proven
  duplicate targeted selection was consolidated; security, browser, native,
  migration and provenance gates remain. See [dev timing](../operations/dev-fast-lane.md#deployment-duration-and-independent-work).

### Reviewed integration debt

The reviewed baseline adjusts only 25 measured findings on 18 paths: 19 match
incoming main; six combine incoming behavior with owner/admission fences.
Direct-message negative controls cover stale authorization, success and failure.
Generated contracts and workflow compatibility aliases come from their owners.
All other debt and 500/250/80 budgets remain; new or worsened debt still blocks.
Prior source rendered 181 Mermaid figures; that dated result is not cloud acceptance.

## Next gate and historical boundaries

One normal-owner window must prove setup/provider transitions, Files, direct
Puppy, exact update/recovery and bounded wake/idle behavior on the qualified image.
Computer Use acceptance remains separate for each cloud. Source and dev release
verification are complete for the named candidate; the journey matrix is not.
The isolated restore target is removed. Its restricted recovery point is retained
only until a successful routine backup newer than this release is verified; the
operations owner then deletes that exact rehearsal copy. Existing backups remain.
No main merge, UAT/production deployment, stable publication or automatic upgrade.

Operational owners: [Files contract](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md) and
[Mail/Drive acceptance](../operations/mail-drive-uat-acceptance.md).

Dev history cleanup 944 completed on 2026-09-28 under
[run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630).
Migration 249 is the public-profile bridge. No repeated deletion; a no-op SQL
rollback is not recovery. Earlier cold Puppy and mixed-work failures remain
usability/capacity evidence. Missing measurements are not zero; spending warnings
never stop service.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and their gates belong to the deployment standard.

## Files continuation evidence — 2026-09-25

Historical pointer: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own later acceptance.
