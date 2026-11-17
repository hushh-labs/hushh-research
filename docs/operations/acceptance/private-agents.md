# Private-agent acceptance

[Acceptance](README.md)

[Operations](../README.md) · [Capabilities](../../product/capabilities.md)

**Evidence review: 16 November 2026.** This page separates source functionality,
application release acceptance and installed-owner verification. It does not
certify the currently serving image or replace the original operation receipts.

## Visual Context

Use the [hosting module](../../architecture/modules/hosting.md) and
[Browser module](../../architecture/modules/browser.md) for system boundaries.

## Current Dev sharing checkpoint — 16 November 2026

Real Stripe Sandbox funding credited 100 coins once. A 24-coin Profile request,
owner approval, direct encrypted information delivery and fresh authenticated
recovery passed. The retained fixture was synthetic; it does not establish the
requested two-Chat demonstration with a saved human preference. Profile withdrawal
released the second reservation once, while payment-review cancellation failed.
Its correction [#9630](https://github.com/hushh-labs/hushh-research/pull/9630) is
merged but not yet deployed. The Memory sharing-impact correction
[#9634](https://github.com/hushh-labs/hushh-research/pull/9634) has exact-source CI
and awaits Dev queue acceptance and deployment.

Normal signed-in Chrome earlier identified two Chat blockers: Azure's installed predecessor
required the old discovery confirmation, while GCP wake marked
a still-present managed host for reinitialization after reading the fleet project.
Same-host recovery and guarded UI controls landed on `dev` ([#9638](https://github.com/hushh-labs/hushh-research/pull/9638), [#9641](https://github.com/hushh-labs/hushh-research/pull/9641)), preserving the original placement and keys (a replacement pod is not recovery). On 16 November in silent background Chrome on `dev`: (1) **Sovereign Azure BYOC (`user_azure`, `Dev 38`)** confirmed `installedVerified: true` and completed live streaming chat against configured Azure OpenAI; and (2) **Hussh-Hosted GCP Slot #3 (`hussh_pods` / `gcp`, `Dev 39`)** — admitted under the governed Dev-only extension (`consent-protocol/config/dev-hosted-pilot-extension.json`, US$200 work / US$50 cleanup ceiling via [#9609](https://github.com/hushh-labs/hushh-research/pull/9609), [#9611](https://github.com/hushh-labs/hushh-research/pull/9611), [#9627](https://github.com/hushh-labs/hushh-research/pull/9627)) with Cloud Run gVisor `prctl(PR_GET_DUMPABLE) == 0` hardening ([#9618](https://github.com/hushh-labs/hushh-research/pull/9618)) — completed isolated GCP project bootstrap (`18/18` steps + `5/5` hosted model preparation), direct-ingress readiness (`has_direct_readiness: true`), live browser-to-pod streaming chat, and compounding memory rewrite (`HTTP 200`). The original synthetic two-owner managed Cohort-1 remains **0/2 and paused**, and Tier-1.5 [Floci multi-cloud wire verification](../../development/quality/floci-multicloud-wire-verification.md) ([#9629](https://github.com/hushh-labs/hushh-research/pull/9629)) stays strictly separated from live cloud qualification.

Current acceptance and next actions stay in the existing tasks:
[#7587 Consumer-controlled paid scope access and Stripe sandbox acceptance](https://github.com/hushh-labs/hushh-research/issues/7587)
and [#5507 Owner-controlled GCP and Azure private pods — dev readiness](https://github.com/hushh-labs/hushh-research/issues/5507).

## What the retained evidence establishes

| Boundary            | Evidence established                                                                                    | Still requires its own proof                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Browser             | Both clouds have controlled component, login-suppression, remembered-session and Stop evidence          | Exact installed owner image, native model access, takeover, reconnect and signed-in journeys     |
| Recovery and Files  | Synthetic predecessor recovery and exact-byte checks                                                    | Current installed active-work drain, recovery and Files organization                             |
| Puppy               | A retained Azure Gemma 12B answer and prior exact update                                                | Current-image answer, cancellation and reconnect through the owner binding                       |
| Account continuity  | Isolated generation and retained-UID controls                                                           | Installed migrations, consumer drain and authorized provider acceptance before public activation |
| Application release | [Recorded UAT acceptance](https://github.com/hushh-labs/hushh-research/actions/runs/42645497579) passed | Later source or installed pod changes are not covered by that receipt                            |

Source implementation, application deployment and owner installation are separate
transitions. Reuse an unchanged receipt only within its source, image, authority
and lifecycle bounds. Historical versions are in Git; they are not a current fleet inventory.

## Open operational obligations

- Installed-owner Browser acceptance remains distinct from synthetic qualification.
- Account-generation activation remains staged until its deployment prerequisites settle.
- Original exposed-token revocation was not proven merely by repository-secret isolation.
- A monorepo mail dependency patch does not prove deployment of the separate mail service.
- Retained synthetic Cloudflare-site cleanup requires reconnection and provider absence verification.
- The GCP model path must respect the recorded organization/provider restriction and configured bridge; extra IAM is not a substitute for billing eligibility.
- The hosted pilot retains its recorded $500 ceiling and $100 cleanup reserve until separately authorized changes. General hosted provisioning remains unavailable.

These are retained unresolved facts, not permission to retry uncertain effects or
expand this documentation work into a rollout. Inspect the original operation
and provider outcome before acting.

## Operating references

- [Private-agent update and installation](../hosting/dev-pod-first-light-runbook.md)
- [Files custody and integrity](../hosting/private-files-library.md)
- [Cleanup and account deletion](../identity/account-deletion-rollout.md)
- [Backup and recovery](../hosting/pod-backup-and-recovery.md)
- [Browser execution and qualification](../../../consent-protocol/docs/reference/private-browser-runtime.md)
- [Remaining private-agent delivery plan](../../roadmap/personal-agent/normal-release-transition.md)

## Dev evidence and unresolved recovery — 13 November 2026

These retained observations supplement Main's evidence above. They are not fresh
provider readback. The [original Dev record](https://github.com/hushh-labs/hushh-research/blob/2223ec5a59/docs/reference/quality/adk-orchestration-docs-audit.md)
preserves exact operations and recovery coordinates. Inspect the current journal
before acting; an elapsed retention date is not a cleanup receipt.

| Area                | Established                                                                                                                                           | Remaining acceptance or recovery                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKM paid answers    | The private writer and migration 989 were deployed in a [backend-only release](https://github.com/hushh-labs/hushh-research/actions/runs/43217475937) | Payments stayed disabled. Actual preparation, checkout, signed settlement, requester-only decryption and cold recovery were not accepted.                                                                                                          |
| Owner-cloud runtime | Retained GCP/Azure installation, chat and reload/history passed on 2 November                                                                         | Process replacement, stale-writer refusal, active-work drain, installed Browser and current Puppy cancellation/reconnect remain separate.                                                                                                          |
| GCP removal         | Compute and native Memory removed; recorded provider dispatches acknowledged and executor exits retained                                              | Cleanup remained 10/17 with 144 retained object generations. The earliest observation was 13 November, not completion. The enabled KMS version's 30-day destruction period had not started; full account deletion remained unadmitted.             |
| Dev authentication  | 156 original UIDs were staged and activated in isolated Dev Auth                                                                                      | Fresh vault/history, native/provider acceptance, credential containment and retirement of rollback credentials/revisions remain open. This does not activate isolated UAT Auth.                                                                    |
| Managed pilot       | Two services operational; general creation still refused                                                                                              | Lifecycle acceptance remained 0/2. Current billing, Engine inventory/location and spend were unknown; 44 soft-deleted generations and scheduled KMS destruction lacked physical-absence proof. Preserve the $500 ceiling and $100 cleanup reserve. |

The older migration-988 candidate note is historical after the recorded
migration-989 release. Neither statement replaces installed-ledger readback.
