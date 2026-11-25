# Private-agent acceptance

[Acceptance](README.md)

[Operations](../README.md) · [Capabilities](../../product/capabilities.md)

**Evidence review: 12 November 2026.** This page separates source functionality,
application release acceptance and installed-owner verification. It does not
certify the currently serving image or replace the original operation receipts.

## Visual Context

Use the [hosting module](../../architecture/modules/hosting.md) and
[Browser module](../../architecture/modules/browser.md) for system boundaries.

## Browser chat triggers and UAT handoff

The source contract admits Browser from qualified Dev and UAT private-pod Chat;
production remains unavailable. One chooses explicit website interaction through
its existing hand, clarifies missing terms and uses admitted search/reads for
informational requests. The workspace opens only after processing approval and
verified active work, preserving owner dismissal and reconnect identity.

Focused Browser authority, native ADK, route, manifest and workspace tests cover
these source boundaries. The UAT regression fails with the old Dev-only guards;
the preview regression fails without the approval guard. Synthetic Gemini 4 Hydrogen first-tool probes of Dev and UAT source exercised explicit interaction, informational requests,
missing intent, unavailable Browser and resolved references twice each. It chose
Browser only for explicit interaction. The short request "Pay this bill" first
looked up the existing app-action catalog; this does not prove its later
clarification or payment behavior. No tools executed during this model probe.

This is source and synthetic selection evidence, not installed UAT acceptance.
A Browser-only UAT port reuses the reviewed workspace and wire contracts from
[#9776](https://github.com/hushh-labs/hushh-research/pull/9776), independently of
the broader [sandbox promotion](https://github.com/hushh-labs/hushh-research/pull/9960).
Qualification and deployment must include the actual owner/sandbox image;
a hub deployment alone cannot install this chat fix. Browser qualification
publication remains Dev-only, and the sandbox host remains unqualified. Exact-image Browser
enablement, takeover, Resume, reconnect, Stop and Web/iOS/Android human journeys
remain required. Saved website logins remain the separate Phase 4 in
[#9511](https://github.com/hushh-labs/hushh-research/issues/9511).

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
