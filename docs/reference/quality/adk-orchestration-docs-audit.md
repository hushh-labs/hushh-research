# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime diagrams and contracts live in the [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-06

**Hold the new dev release until integration and core CI pass. Keep Computer Use
unavailable on both clouds.** The interrupted BYOC handoff has been resumed;
local implementation and focused checks do not establish deployed acceptance.
Existing owners, selected hosting, trusted devices and encrypted information are
preserved. No application merge to main, UAT/production deployment, stable
publication or owner-pod installation occurred in this continuation.

## Source and serving evidence

| Surface | Dated evidence | Boundary |
| --- | --- | --- |
| Working source | Infrastructure base `f407f849b281`; BYOC and browser changes remain under local review. | Concurrent commerce/PDF work, local ADK and consumer repository are preserved; no combined green SHA yet. |
| Dev backend | Readback at 2026-10-07 00:22 UTC: `consent-protocol-00143-mbc`, source `9a3d5f043469`, digest `sha256:9b868c12cf7776ab62ec0c5f759fd993fa675eddd7dbedfe8441d095dd8ad655`, 100% traffic. | Serving baseline predates this continuation. |
| Dev frontend | Same readback: `hushh-webapp-00121-d9g`, source `9a3d5f043469`, digest `sha256:8174fc29ce435ff08b497a456079efad32318a05c6cebd61a0d5d352ed1e7e2b`, 100% traffic. | Native connector configuration and new browser UI are not inferred from this image. |
| Owner pods | No owner service/image changed in this continuation. | Hub deployment, pod publication and exact owner-approved installation are separate receipts. |
| Schema | Hosting 955 and notification checkpoint 956 are registered in the dev manifest only. | Local registration is not an applied migration. Compatibility, ledger/checksum readback and release guards remain required. |

The baseline's [hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/37461110037)
and [governed deployment](https://github.com/hushh-labs/hushh-research/actions/runs/37464072047)
passed. These receipts do not validate the uncommitted candidate. Previous ready
revisions are recorded as metadata rollback candidates; their compatibility has
not been rehearsed in this continuation.

## Files-led acceptance

| Journey | Source / local evidence | Dev gate |
| --- | --- | --- |
| Placement and setup | Explicit Shared selection and `unplaced`; pending/assigned modes preserved. Automatic attach/direct setup checks identity, IAM, exact route wall, CORS and owner admission. | New/existing setup, billing return and policy-blocked retry without a second project or assignment. |
| Private connectors | Sealed native PKCE, credential hydration before admission, Gmail/Calendar/Drive/Contacts and curated MCP routes. Owner review is bound to exact action; missing capabilities refuse. | iOS and Android provider authorization, declared scope upgrades, exact review/resume and restart recovery. |
| Google transition | Owner-confirmed project-wide old-grant revocation precedes fresh authorization. A signed current-pod receipt gates redemption; exact provider refresh/CAS distinguishes revoked from fresh sibling grants. | Provider-confirmed transition, fenced legacy callbacks/jobs and cleanup of unchanged legacy rows without revoking the new grant. |
| Notifications | OAuth-project topic, owner-project OIDC push subscription, exact route/audience/service binding, durable coalescing and bounded cursor checkpoints. No model inference from a doorbell. | Provision/upgrade receipts, duplicate/lost delivery, queue drain, watch renewal and minimum-zero idle return. Multiple subscriptions require independently qualified erasure receipts. |
| Consent and hub closure | Current-incarnation signed revocations and metadata-only feeds; real tools, including Nav, receive owner authority. Reserved/commercial policy stays canonical. Hub content refuses BYOC. | Revocation delivery, route closure and absence of migrated hub readers, credentials and caches. Sealing plaintext never proves private custody. |
| Files | Dedicated ADK specialist and `/one/files` explorer retained. Dated earlier acceptance covered resumed transfer, byte-exact download, reversible organization and explicit analysis consent. | Regression on the final installed candidate, authenticated background completion and overlapping activity. |
| Puppy | Existing identity/grant and direct transport retained; prior responses, cancellation and withdrawal have dated receipts. | Reconnect and same-owner/pod proof after the approved image update; independent active internet, usable cold latency and bounded overlap remain unverified. |
| Updates/recovery | Existing exact-release approval and durable operation retained. Earlier Dev 4 receipts prove a normal restart and encrypted continuity on that image pair. | Exact predecessor compatibility, active-work drain, one installation, Settings/Feed agreement and installed-digest/recovery readback. No automatic upgrade. |
| Computer Use | Authenticated task runtime, isolated ADK runner, selected PKM ports, exact reviews, preview/takeover, opt-in encrypted sessions and generation-fenced Forget have focused local coverage. The browser hand returns metadata only to One. | Both cloud execution gates remain closed; no real owner information admitted. |

## Computer Use qualification

- **GCP:** the earlier native probe ran as UID/GID zero; switching to the fixed
  non-root identity failed with `EPERM`. No supported provider identity mechanism,
  sandbox Chromium, broker bridge or denied-egress proof is qualified. Keep refusal.
- **Azure:** Early Access enrollment is an obsolete blocker: SandboxGroups is now
  generally available. The new bounded dev probe created the native group,
  qualified data-plane read access and created a synthetic sandbox. Its exact
  egress-policy readback was refused before execution. Sandbox deletion and resource
  group deletion were confirmed. No owner resource changed. The private task bridge,
  Chromium, network isolation and lifecycle remain unqualified.
- **Privacy:** credential entry suppresses model observations; handback requires a
  fresh observation. Remembered state is encrypted, origin bounded and capped at
  1 MiB; Forget races cannot restore an older generation. Cloud retention and remote
  website logout remain separate from logical Forget. No password injection or
  generic Secrets export is offered.

## Blockers and next gate

| Owner | Blocking evidence | Required resolution |
| --- | --- | --- |
| Backend / release | Notification custody and multi-resource erasure corrections pass focused PostgreSQL checks; the combined candidate remains unverified. | Preserve exact receipts through integration and pass the complete release gates before deployment. |
| Integration | Current main/local ADK authority delta has not been frozen and reconciled. | Preserve pod identity/custody and injected authority; regenerate from authored owners, then one local core mirror and exact-SHA hosted CI. |
| Native / provider | Registered iOS client verified; dev public-client configuration and feed keys prepared. Android public-client PKCE is not provider qualified. | Supported Android registration/authorization and live iOS acceptance; no server client-secret fallback. |
| Cloud / browser | GCP identity and Azure policy/private bridge gates fail or remain unverified. | Qualify each substrate independently. Keep Computer Use disabled until its isolation, privacy and lifecycle receipts pass. |
| Dev acceptance | No new candidate deployment or owner installation receipt. | Main-owned dev workflow for the exact green branch SHA, terminal/readback proof, then exact owner-approved pod release and one acceptance window. |

## Verification and measured debt

### Reviewed integration debt

Focused local checks cover native sealing, owner/epoch fencing, Google grant
races, connector actions, route closure, notification checkpoints and browser
control/session boundaries. Frontend typecheck and design checks pass; all 181
Mermaid figures render. Check counts overlap and are not an end-to-end acceptance
total. The full docs gate currently identifies an unrelated ignored PR snapshot's
11 shareability violations; authored documentation checks pass.

The final notification/lifecycle check passed 150 tests, including real PostgreSQL
standby removal, detached-custody retention and qualified erasure completion.
The connector pack passed 587 tests before the last strict provider-status
correction; its redirect/server-failure negative controls are checked separately.
Neither result proves a deployed provider transition or owner-cloud cleanup.

The prior combined core run reported 75 protocol and four integration failures.
It is historical evidence of the interrupted handoff, not a result for the current
candidate. The final dependency-complete source must pass the current gates;
no tests, security checks or ratchet budgets are waived. The [fitness baseline](architecture-fitness-baseline.json)
remains measured debt, not a line-count target.

The [One Wiki hosting section](https://wiki.hushh.ai/wiki/products/one#hosting-choices)
was corrected and read back: Shared is explicit, detached accounts return to the
chooser, existing setup/assignments are preserved, and cloud rollout remains
qualified. Public prose contains no owner or operational credentials.

## Historical receipts and boundaries

- Dev history cleanup **944 completed on 2026-09-28**, under
  [governed run 36392414630](https://github.com/hushh-labs/hushh-research/actions/runs/36392414630).
  Migration 249 is the public-profile bridge. Do not repeat deletion or treat a
  no-op SQL rollback as recovery. Retained-backup erasure and production cutover
  are not established.
- Earlier cold Puppy and mixed-work samples failed usability budgets. Those failed
  receipts remain valid; green CI and restored deadlines do not prove acceptable
  cold latency or sustained capacity. Measure wake, admission, recovery, relay,
  first token and completion separately; empty metrics are not zero.
- Sustainable hub/pod capacity, native live journeys, physical-device acceptance,
  release/migration graduation and UAT recovery/IAM remain independent gates.
  Spending thresholds warn; they never stop service.

Operating procedures remain in the [Files contract](../operations/private-files-library.md),
[dev pod runbook](../operations/dev-pod-first-light-runbook.md),
[deployment standard](../architecture/deployment-standard.md),
[Plaid contract](../kai/plaid-vault-passthrough.md) and
[Mail/Drive acceptance record](../operations/mail-drive-uat-acceptance.md).
Git history retains the earlier chronology; this memo carries the current decision.

## GCP-only pod deployment correction — 2026-09-25

Historical pointer: Anypoint pod deployment was removed; the CRM connector remains.
Current Google/Azure choices and their gates belong to the deployment standard.

## Files continuation evidence — 2026-09-25

Historical pointer: source checks were not owner-cloud activation receipts.
The Files contract and current matrix above own later acceptance.
