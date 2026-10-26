# Lost vault access: delete and start fresh

Status: P0 product and acceptance contract. Runtime availability is established by a successful release and UAT verification, not by this document alone.

## Visual Map

```mermaid
flowchart LR
  locked["Signed in; vault locked"] --> review["Review permanent deletion"]
  review --> verify["Fresh account verification"]
  verify --> confirm["Confirm deletion"]
  confirm --> blocked["Blocked before erasure"]
  confirm --> pending["Erasing or sign-in cleanup"]
  pending --> done["Old account removed"]
  done --> new["New empty account"]
```

## Product promise

A person may still be signed in to One after losing their vault passphrase, recovery key, passkey, and every unlocked device. The locked-vault screen must give them a visible **Delete account and start fresh** choice. They can remove the old account without a vault secret, then register a new, empty account once deletion and sign-in cleanup are confirmed. This is permanent deletion, not recovery or the existing account reset.

A reported customer experience is the P0 example: a person can sign in, cannot open their vault, and should not need an engineer with admin rights to erase the account. The same journey must work for anyone in that state.

## What the choice means

Deletion removes active One information and access controlled by Hussh: the old vault and unlock wrappers, memories and PKM, chat context, profile, settings, One-side connections, sharing and consent state, trusted devices, and the old sign-in identity. A new account receives a new identity, vault, and recovery methods. No old memory, grant, device authority, or context may reattach.

One cannot promise that every copy everywhere disappears at once. Required evidence follows its retention policy; a one-way tombstone prevents old-account resurrection; backups expire on their schedule; other people's copies and external providers' records are outside One. When a bank connection token is sealed in the inaccessible vault, One cannot use it to revoke the Plaid grant. The person must remove One's access through their bank or Plaid. The [public deletion page](../../../hushh-webapp/app/delete-account/page.tsx) explains these boundaries.

## Journey and states

| Moment | The user sees or does | Product rule |
| --- | --- | --- |
| Locked vault | **Lost access? Delete account** remains reachable next to unlock and sign-out. | The first tap only opens the explanation. |
| Review | One names the information that will go, the permanent loss, retained records, and outside-provider steps. | No vault secret or repeated failed unlock attempts are required. |
| Verify | The person reauthenticates with the Google or Apple account already linked to this One account. If a verified phone is linked, they enter that number with its country code, pass a server-side full-number comparison, and confirm a code sent there. | A stale signed-in session, a phone code alone, or a number submitted to the deletion endpoint cannot authorize deletion. If the linked phone is unavailable, offer the established support verification path. |
| Confirm | The person explicitly chooses **Permanently delete account** after review. | This is the sole destructive action; Back and Cancel remain available until submission. |
| Blocked before erasure | One explains the specific connection or private-agent cleanup that needs attention. | Say **Account not deleted**. Do not erase One-side records and leave an unmanaged external resource. |
| Processing or uncertain | One checks the account lifecycle status after a lost response. | Never automatically submit a second delete. Do not report success from a timeout. |
| Account erased, sign-in cleanup pending | One shows **Finishing account removal**. | Do not offer a new account until the old Firebase identity is removed or a safe, proven new-identity path is available. |
| Complete | One signs the person out and offers **Create a new account**. | Signing in again with the same provider must create a new UID and an empty vault. |

The flow is an escape hatch from the locked gate, not a hidden Profile setting. The ordinary unlocked Profile deletion route remains available.

## Current implementation boundaries

- The [locked-vault UI](../../../hushh-webapp/components/vault/vault-flow.tsx) owns the entry. The frontend must use the existing auth and account-deletion state machinery so sibling tabs, local vault material, and uncertain outcomes are handled consistently.
- The [backend account route](../../../consent-protocol/api/routes/account.py) owns deletion-only identity verification. The existing `VAULT_OWNER` token must not be minted or reused for this path; it would grant broader vault authority.
- The [full erasure service](../../../consent-protocol/hushh_mcp/services/account_service.py) remains the single place that erases account data, enforces its tombstone, and rejects unresolved BYOC or external-resource blockers. The [deletion rollout contract](../operations/account-deletion-rollout.md) owns Firebase cleanup and release fences.
- Browser phone entry remains available if optional identity hydration is missing, fails, or disagrees with the masked hint. A trustworthy resolved number may prefill untouched input; it cannot bypass fresh phone proof. The read-only `POST /api/account/delete-lost-vault/phone` comparison uses the same authoritative binding resolver as final deletion. Number edits, cancellation, session changes and newer verification attempts invalidate earlier results. Browser proofs use memory-only Firebase Auth persistence; deletion-only verification never links or replaces a phone.
- Native phone entry uses the same form and full-number preflight. The `HushhAuth` deletion-only bridge sends verification with the primary Firebase app, then exchanges the credential through the separate named `hushh-deletion-phone-proof` Auth instance. Android supports both manual codes and instant verification. No proof identity is published to the app's session, restored into the primary account, or copied into application storage. The native SDK can temporarily persist its secondary session; the adapter signs it out at startup and on success, failure, cancellation and teardown. An in-flight exchange keeps a process-wide lease until its late callback clears that SDK session again. Cleanup failure or an SDK task that never returns blocks a new attempt; process restart retries startup cleanup. Process death can leave SDK residue until that cleanup runs. Proof tokens and verification handles held by the app stay in memory. A new native binary is required; a UAT web deployment alone does not change an installed app.
- A shared production Firebase identity may be deliberately retained in UAT. Its `identity_retained` result survives central sign-out as a distinct login notice, states that identity removal will not happen automatically, and never offers fresh signup. Temporary cleanup and uncertain outcomes retain their own notices. A fresh-start link requires explicit `ready_to_start_fresh === true`. This repair does not add same-UID re-enrollment or change the environment boundary.
- The [public deletion page](../../../hushh-webapp/app/delete-account/page.tsx) remains the route for someone who cannot sign in at all. Support must verify ownership and record consent before any assisted deletion.

Automated phone-entry and OTP coverage uses synthetic provider and SMS ports. It does not establish real SMS delivery, UAT identity configuration, live erasure, native hardware behavior, or complete fresh signup. A linked-phone proof may use a distinct phone-only Firebase UID; the existing lost-vault route erases the primary owner, so removal of that separate provider identity and subsequent registration remain acceptance gaps. Shared identities deliberately retained across environments continue to prevent fresh registration.

## Occupied-phone entry

The phone-conflict **Delete my previous account** choice resumes this same panel
after independent sign-in to that account. A server-bound opaque continuation
preserves the chosen action through sign-out, account switching and refresh.
It is navigation state, never proof of ownership. The phone link and account
generation must still match when deletion is submitted. An expired request says
**Account not deleted** and asks the person to start again; it cannot silently
sign them out as if erasure succeeded. Recovery and device review use separate
continuations. Moving a phone link preserves the previous files and vault.

Native proof startup has one bounded deadline, distinct from OTP expiry. The
same-user Google/Apple reauthentication and secondary phone-proof adapters retain
owner and attempt fences until their owned SDK callbacks drain. Explicit resend
uses a new local challenge. A startup timeout does not claim that an SMS expired.
A new native binary is required for installed applications to receive these changes.

## Delivery plan and release gates

1. Expose the locked-vault CTA, review, identity verification, irreversible confirmation, and outcome states in the shared web view. Use concise language and semantic destructive styling.
2. Add a purpose-limited backend deletion route that verifies fresh same-account provider reauthentication and any pre-existing verified phone proof. Keep it separate from vault access. Reuse full transactional erasure and Firebase cleanup.
3. Cover rejection of stale, mismatched, unverified, and phone-only proofs; a success path; blocked external resources; and lost-response/pending identity cleanup with focused automated tests. Check the frontend/backend request contract and typecheck. The user will perform manual UAT; no manual browser tour is required for this delivery.
4. Update the public deletion explanation and API contract. Merge only after the exact PR head's required checks pass. Deploy the exact green post-merge `main` SHA to UAT, then verify the workflow's release and runtime evidence.

## Acceptance story for UAT

Given a signed-in person whose vault cannot be unlocked by any method, they find **Delete account and start fresh** on the locked screen. They review what goes away and what One cannot erase outside its control. They verify the existing sign-in account and, when applicable, its previously linked phone. On confirming, they see either a specific **not deleted** blocker, a truthful pending state, or a completed deletion. After completion they sign in with the same Google or Apple account and see a new, empty One with no old vault, memories, chats, connections, shares, or device grants. A stale session or wrong proof cannot delete the account.

## Follow-up beyond P0

Measure locked-gate entry, verification failure, pre-erasure blockers, pending identity cleanup, deletion completion, and fresh-start completion without recording secrets. Review support cases where the linked phone is lost, and add a governed alternate verification mechanism that gives those people a self-service outcome without weakening deletion authority. The current identity cache has no immutable phone-enrollment timestamp, so a future identity migration should record one before treating phone age or a cooling-off period as an enforced guarantee. Review provider-side revocation options that preserve zero knowledge; never pretend the server can decrypt vault-sealed bank tokens.
