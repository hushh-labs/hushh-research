# ADK and owner-pod integration: decision memo

## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md).
Runtime diagrams and contracts live in the [private-agent north star](../architecture/private-agent-north-star.md)
and [private browser runtime](../../../consent-protocol/docs/reference/private-browser-runtime.md).

## Decision — 2026-10-07

**Hold the new dev release until exact-SHA hosted CI passes. Isolated migration
recovery passed; keep Computer Use unavailable on both clouds.** The interrupted
BYOC handoff has been integrated. Hosted validation found two recovery UX
regressions and two asynchronous fixture defects; the narrow corrections pass
their nearest checks and require another exact-SHA hosted run.
Local implementation and focused checks do not establish deployed acceptance.
Existing owners, selected hosting, trusted devices and encrypted information are
preserved. No application merge to main, UAT/production deployment, stable
publication or owner-pod installation occurred in this continuation.

## Source and serving evidence

| Surface | Dated evidence | Boundary |
| --- | --- | --- |
| Working source | Integrated candidate `292775974f99`; replay preservation repair `590fdbb893c6`; subsequent bounded UI corrections. | Main `be8d4e014b34` and frozen local ADK `eb76e00af60a` are included. The grouped correction candidate passed local core in 495 seconds. Hosted validation of `292775974f99` failed at the UI boundaries below; its fixes require exact-SHA hosted success. Concurrent commerce/PDF/native work and unrelated repositories remain preserved. |
| Dev backend | Readback at 2026-10-07 00:22 UTC: `consent-protocol-00143-mbc`, source `9a3d5f043469`, digest `sha256:9b868c12cf7776ab62ec0c5f759fd993fa675eddd7dbedfe8441d095dd8ad655`, 100% traffic. | Serving baseline predates this continuation. |
| Dev frontend | Same readback: `hushh-webapp-00121-d9g`, source `9a3d5f043469`, digest `sha256:8174fc29ce435ff08b497a456079efad32318a05c6cebd61a0d5d352ed1e7e2b`, 100% traffic. | Native connector configuration and new browser UI are not inferred from this image. |
| Owner pods | No owner service/image changed in this continuation. | Hub deployment, pod publication and exact owner-approved installation are separate receipts. |
| Schema | Hosting 955 and notification checkpoint 956 are registered in the dev manifest only. | Local registration is not an applied migration. Compatibility, ledger/checksum readback and release guards remain required. |

The baseline's [hosted CI](https://github.com/hushh-labs/hushh-research/actions/runs/37461110037)
and [governed deployment](https://github.com/hushh-labs/hushh-research/actions/runs/37464072047)
passed. These receipts do not validate the newly integrated candidate. Previous ready
revisions are recorded as metadata rollback candidates; their compatibility has
not been rehearsed in this continuation. [Candidate validation](https://github.com/hushh-labs/hushh-research/actions/runs/37561159718)
failed; its receipt remains failure evidence, not release authorization.
[Validation of `292775974f99`](https://github.com/hushh-labs/hushh-research/actions/runs/37567472152)
also failed. Both native lanes, protocol, build, integration and MCP passed;
the aggregate correctly refused release on the remaining UI failures.

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
  qualified data-plane read access and created a synthetic sandbox. Its policy
  reported Deny/Full but included two unqualified fields, so execution was refused.
  The newer public schema includes additional authority-bearing policy sections;
  ignoring unknown fields is unsafe. Sandbox, scoped-role and resource-group
  deletion were confirmed. No owner resource changed. The private task bridge,
  Chromium, network isolation and lifecycle remain unqualified.
- **Privacy:** credential entry suppresses model observations; handback requires a
  fresh observation. Remembered state is encrypted, origin bounded and capped at
  1 MiB; Forget races cannot restore an older generation. Cloud retention and remote
  website logout remain separate from logical Forget. No password injection or
  generic Secrets export is offered.

## Blockers and next gate

| Owner | Blocking evidence | Required resolution |
| --- | --- | --- |
| Backend / release | The restored dev backup exposed destructive replay of public investor seeds. Repair `590fdbb893c6` passes retained-information and idempotent replay proof; six focused tests pass. The new image has no admitted predecessor. | Qualify the exact image pair before owner-approved installation. Historical checksum adoption in environments with accepted canonical receipts requires its own governed review. |
| Integration / CI | Hosted fixtures, generated mirrors and native splash continuity required corrections; authority gates remain intact. | Preserve residual work, freeze the repaired candidate and obtain exact-SHA hosted success. |
| Native / provider | Registered iOS client verified; dev public-client configuration and feed keys prepared. Android public-client PKCE is not provider qualified. | Supported Android registration/authorization and live iOS acceptance; no server client-secret fallback. |
| Cloud / browser | GCP identity and Azure policy/private bridge gates fail or remain unverified. | Qualify each substrate independently. Keep Computer Use disabled until its isolation, privacy and lifecycle receipts pass. |
| Dev acceptance | No new candidate deployment or owner installation receipt. | Main-owned dev workflow for the exact green branch SHA, terminal/readback proof, then exact owner-approved pod release and one acceptance window. |

## Verification and measured debt

### Reviewed integration debt

Local evidence covers native sealing, owner/epoch fencing, Google grant races,
exact connector review, route closure, notification checkpoints, browser takeover
and Forget. The 150-check notification pack includes real PostgreSQL lifecycle
and erasure checks. These fixtures do not establish provider or owner-cloud acceptance.
All 181 Mermaid figures rendered after the affected documentation corrections.
Web-core, secret, governance and MCP package lanes passed
locally. Integration passes 380 checks. These checks do not replace hosted CI.

The final local core mirror passed in 495 seconds: 16,036 parallel protocol
checks, 572 isolated PostgreSQL checks, web build/type/lint, governance, secrets,
MCP and integration. The owned loopback database was removed afterward;
the existing local PostgreSQL service was untouched.

Hosted `292775974f99` exposed a real Reply focus race with Radix and divergent
blocked-popup recovery copy. The reply now transfers focus at menu closure
through a one-shot generation-bound intent; connections reuse the existing
canonical recovery notice. The nearest 13 message, 15 connector and 24 adapter
checks pass; old-source or broken-fence controls fail. The connector fixture now
waits for the old owner's actual request before switching owner. Tablet recovery
polls the unchanged containment geometry after native scrolling: both engines
pass, while permanently hidden controls still fail. Linux WebKit confirmation
remains with hosted CI; no production CSS defect is inferred from the Mac run.

Hosted failure review found an actual Location cancellation/lock race across a
placement await; the existing generation fence now runs before dispatch. The
nearest 17 checks pass and both old-source controls fail. Scheduled-mail tests now
use the real isolated placement database: 16 PostgreSQL checks pass. Generated
route/agent mirrors and the native Google bridge are corrected from their owners.
Drive's 48 failing browser cases now pass in about 50 seconds; Connections' 14
affected cases pass. The broad layout run passes 549 Chromium, 473 WebKit and
112 mobile Chrome cases, with two native splash failures. The splash correction
passes all 30 nearest two-engine checks, with two existing evidence-only skips;
old CSS fails both continuity controls. Pixel tolerances remain unchanged.

CI performance is measured by stage. The earlier PR browser lane spent about
26 minutes retrying broken Drive fixtures. The latest dev deployment job took
14m21s; UAT took 29m34s for different work. Full-suite targeted checks are already
deduplicated. The remaining roughly 12-second browser overlap does not justify
new selector coordination in this release. No security, native, PKM, recovery or
browser gate was removed. See the [dev timing review](../operations/dev-fast-lane.md#deployment-duration-and-independent-work).
The next hosted iOS run took 29m30s versus 16m38s previously with the same
native source, package versions and test counts. Resolution, compilation,
web export and simulator startup all increased; no duplicate test execution
was found. Network versus runner contention is unproven. This is a validation
duration, separate from application deployment; it does not justify removing
native gates or speculative cache changes.

The restored dev backup passed two canonical migration runs and both schema
guards at `590fdbb893c6`. Comparison preserved 230 retained tables, 53
ciphertext/key projections and 25 key/PKM tables; existing orphan counts did not
change and added constraints have no orphans. Only 955/956 were added to the
ledger; all old receipts, including 944, remained unchanged. Replay changed no
records or receipts. Normalization excludes only nine independently reviewed
`updated_at` fields; every investor information field remains strict. This proves
dev database recovery, not owner-image continuity or UAT/production readiness.
The original failed conservation receipt remains evidence of the repaired defect.

Earlier integration corrected eager Shared-store construction on pod import and
late disclosure after owner placement changed. The post-read fence passes 55
checks; eight old-source race controls fail. Failed receipts remain in the original
evidence; no test or authority gate is waived.

The [fitness baseline](./architecture-fitness-baseline.json) attributes incoming
main, ADK and local debt separately. Hosted corrections add one reviewed module
finding and update six existing module values for authority fixtures, relative
fixture aliases and native splash measurement. The final UI corrections review
three further existing module values; budgets, non-size findings and future-growth
refusals remain unchanged. Total retained findings are 2,209.
Budgets remain 500/250/80; future new or worsened findings still fail. Debt owners
remain recorded. Size review does not qualify cloud execution or an image upgrade.

The new `2026.10-dev.8` descriptor has no admitted predecessor digests. The old
image reuse pin was removed so the next governed build uses this source. Exact
old-image/new-image recovery proof is required before offering installation.

The [One Wiki hosting section](https://wiki.hushh.ai/wiki/products/one#hosting-choices)
was corrected and read back. The private ADK and private-agent records now carry
the same placement and disabled-browser boundaries, with dated historical evidence
preserved. All edited sections passed readback; operational details remain private.

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
