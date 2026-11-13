# Private-agent acceptance

[Acceptance](README.md)

[Operations](../README.md) · [Capabilities](../../product/capabilities.md)

**Evidence review: 12 November 2026.** This page separates source functionality,
application release acceptance and installed-owner verification. It does not
certify the currently serving image or replace the original operation receipts.

## Visual Context

Use the [hosting module](../../architecture/modules/hosting.md) and
[Browser module](../../architecture/modules/browser.md) for system boundaries.

## What the retained evidence establishes

| Boundary | Evidence established | Still requires its own proof |
| --- | --- | --- |
| Browser | Both clouds have controlled component, login-suppression, remembered-session and Stop evidence | Exact installed owner image, native model access, takeover, reconnect and signed-in journeys |
| Recovery and Files | Synthetic predecessor recovery and exact-byte checks | Current installed active-work drain, recovery and Files organization |
| Puppy | A retained Azure Gemma 12B answer and prior exact update | Current-image answer, cancellation and reconnect through the owner binding |
| Account continuity | Isolated generation and retained-UID controls | Installed migrations, consumer drain and authorized provider acceptance before public activation |
| Application release | [Recorded UAT acceptance](https://github.com/hushh-labs/hushh-research/actions/runs/42645497579) passed | Later source or installed pod changes are not covered by that receipt |

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
