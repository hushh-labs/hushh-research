# Explicit Reviewer Authentication

An isolated preview may select `REVIEWER_AUTH_MODE=human_authenticated` before
preflight when reviewer mint credentials are deliberately absent. This is an
explicit operator choice, never a fallback after automated authentication fails.
Provide the canonical `REVIEWER_UID` (and `REVIEWER_COUNTERPART_UID` for commerce)
and an exact HTTPS origin. UID-only resolution does not authorize another owner.
No passphrase or custom token is injected or fetched from Secret Manager in this mode.
The operator signs in through the ordinary provider UI and manually unlocks the vault.
The harness observes a visible locked-vault challenge for the exact authenticated
owner before accepting unlock; missing, foreign or lost identity, reauthentication,
and vault relocking invalidate continuity. Cold recovery uses a separate context
and another visible challenge. Credentials, vault keys and decrypted information
remain in browser/process memory; no storage-state export or protected capture is allowed.
Normal reviewer mode keeps its existing credential-pair preflight and mint contract.
The mutation guard admits only the narrow human provider exchanges; financial
writes still require the existing exact human-confirmed action admission.


## Headless operator admission for an isolated preview

When explicitly selected before preflight, `REVIEWER_AUTH_MODE=operator_issued_token`
uses the canonical harness with a supplied `reviewerTokenProvider`. This is not a
fallback after failed authentication. The dedicated preview has no stored reviewer
passphrases and both approved reviewers use Google identities, so the vault
passphrase cannot be used as a Firebase password.

`createOperatorReviewerTokenProvider` invokes the private pipe-only
`reviewer_operator_token.py` adapter. It verifies the approved ADC principal,
dedicated prefixed secrets, canonical fixed-target runtime policy, exact HTTPS
origin and UID-only reviewer pair before minting. Both Firebase subjects must
exist and be enabled. The real Firebase Admin token carries `hushh_review_mint=uat`;
this is environment containment, not proof of service-level isolation. No backend
mint response is intercepted or manufactured.

The private pipe adapter defaults to a 55-second issuance budget. Operators may
select an explicit `timeoutMs` up to 180 seconds when measured local or provider
latency requires it; it remains a finite deadline with no retry or authentication
fallback. The 2026-10-09 dedicated-preview timing probe passed the canonical
checks in 88 seconds, so that headless rehearsal uses a 120-second budget and a
longer matching browser admission deadline. The separate cold-visible-challenge
check uses that operator admission budget, capped at 180 seconds; other modes
retain their existing 60-second challenge budget. Tokens and provider diagnostics
stay in memory. Failure retires partial output and terminates the owned issuer,
with a one-second graceful window before escalation; the adapter rejects only
after its pipes close. Timeout does not grant admission.

One main frame at the exact origin may request one token for its expected UID.
Firebase uses in-memory persistence before exchange. The browser helper refuses
production and native execution. Failed issuance or subsequent canonical identity
loss/mismatch retires admission; it cannot remint or retain an unlocked proof.
A fresh cold context needs its own real token and visible locked-vault challenge.
The passphrase stays in the operator process until the expected authenticated
owner's normal challenge is visible, then enters the ordinary browser form.
Neither the initialization bridge nor Secret Manager stores it.

First-run authenticated reads may capture the Firebase identity token observed
on the normal `/api/vault/bootstrap-state` request. The memory-only capture
accepts only the exact application origin and keeps that identity token separate
from the PKM vault-owner token. Foreign requests and responses cannot replace
tokens or the observed vault commitment. Captured values remain observations;
the expected-owner continuity and authoritative server checks still prove access.

Supply secrets through private process input; never place them in CLI arguments,
files, traces, environment dumps or retained browser state. This mode remains
subject to the canonical mutation guard and exact human financial confirmation.
It does not create a vault or waive first-run, legal, phone, cloud or consent gates.
For the schema-only preview, authorized synthetic preparation must use ordinary
browser encryption and narrowly admitted fixture writes. Physical iOS uses the
existing native reviewer flow; this web-only provider is not native admission.

For a new isolated owner, normal post-auth routing may choose the setup hub or
Connections instead of the requested setup entry. `openSession` accepts explicit
`allowFirstRunSetupRedirect:true` only for those setup entries with
`requireVaultUnlocked:false`. It still requires the exact authenticated owner,
exact origin and loaded authenticated route marker; it never navigates or records
completion. Ordinary protected-route arrival remains exact. After admission, use
same-session Next navigation through the normal setup surfaces. An explicit
`/register-phone` visit disables only the route-audit phone shortcut and verifies
the real account requirement; known verified or established owners still leave
that form. For a new reviewer, choose Shared, verify phone, choose managed AI,
then Finish setup to create the vault and acknowledge recovery. Account details
open in the existing profile pane after unlock; a legacy Profile URL redirects
to the pane on `/one`, and cannot stand in for first-run phone verification.
