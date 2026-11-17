# Private-agent acceptance

[Acceptance](README.md)

[Operations](../README.md) · [Capabilities](../../product/capabilities.md)

**Evidence review: 17 November 2026.** This page separates source functionality,
application release acceptance and installed-owner verification. It does not
certify the currently serving image or replace the original operation receipts.

## Visual Context

Use the [hosting module](../../architecture/modules/hosting.md) and
[Browser module](../../architecture/modules/browser.md) for system boundaries.

## Current Dev sharing checkpoint — 17 November 2026

Three Stripe Sandbox cases passed through the private Chats: funding credited
100 coins once; cancelling a 24-coin request returned the full reservation; a
separate 24-coin request received owner approval and delivered encrypted
information for on-device reading. The preference is an owner-authorized
illustration, not a verified biographical claim. Native financial readback at
09:51 UTC retained 76 buyer coins available, zero held, 16.08 owner coins pending
and balanced journals. No second funding or paid approval was submitted during
the update verification.

The requester’s existing managed GCP pod now runs qualified image `9f771f10…`
(source `e323f94ccc17`), preserving its owner, placement, service UID and keys.
Two narrow control-plane fixes, [#9663](https://github.com/hushh-labs/hushh-research/pull/9663)
and [#9666](https://github.com/hushh-labs/hushh-research/pull/9666), corrected managed
image-only admission and execution with the lease-bound backend. The
[backend-only Dev deployment](https://github.com/hushh-labs/hushh-research/actions/runs/44048360525)
passed; native revision `consent-protocol-00415-vmg` serves tested source
`e512cf430aec` at 100%. The same original owner approval settled successfully.
The failed pre-dispatch attempt remains archived; its terminated worker and
native job absence were verified before recovery. The successful worker also
terminated and its temporary job was removed. No new pod image was built for
these hub corrections.

On the installed image, fresh normal Chat turns completed without an error.
A new free request saved and recovered its private Chat receipt, then was
withdrawn. A further **24-coin** Food request saved its receipt with HTTP 200 and
reopened as **Request sent**. The owner’s Details showed that exact request,
price and purpose without approving it. Native accounting proved 52 coins
available and 24 held before normal requester cancellation, then 76 available
and zero held afterward. The original paid grant and owner earnings remained
unchanged. Both the Food bundle and its preference use the owner-confirmed
24-coin daily tariff. No new funding or paid approval was submitted.

That paid cancellation exposed an outcome-projection defect: per-item
`CANCELLED` transitions without whole-bundle retirement fell through to expired.
The aggregate now identifies an entirely cancelled set, preserving mixed-state
precedence; Chat labels it **Request withdrawn**. Financial and approval writers
are unchanged. Verify this status correction on the governed Dev release;
current deployment and human-review results stay in the linked acceptance task.
The new receipt proof does not reconstruct the older paid conversation’s missing
receipt. The original paid grant remains active until its recorded expiry.

Human review remains pending. One earlier post-update turn ended with a generic
execution error; its cause is unproven. A fresh reload and normal unlock then
completed the subsequent turn. Protected decrypted values remain concealed
while Chrome reports the background page hidden; that guard was not bypassed.
Local-only review changes cover compact Hosting and consent sheets, accurate
provider labels and the false cold-wake notice. These density changes remain
local; the functional cancellation label is isolated in this correction.
The local server on port 3001 remains stopped at the owner’s request.

The owner’s Azure pod remains on its identified `da9e0dc9…` image with retained
Azure OpenAI, Memory, approval and export evidence; this is not a new Azure
installation qualification. GCP uses Gemini, Azure its configured OpenAI and
Shared its configured runtime. The original synthetic managed two-owner cohort
remains **0/2 and paused**. The operational third GCP placement does not complete
that cohort. [Floci wire verification](../../development/quality/floci-multicloud-wire-verification.md)
remains separate from native provider acceptance, and installed Browser/Puppy
obligations remain in the existing checklist. Qualification fixture resources
are removed; scheduled key destruction on 18 November is still pending native
readback.

Current acceptance and remaining review stay in the existing tasks:
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
