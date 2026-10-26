# ADR: WorkOS Enterprise SSO Integration

## Visual Context

Canonical visual owner: [Architecture Index](README.md). This ADR adds one federation front door in front of the existing Firebase authority; Firebase remains the token verifier. The local lifecycle retains generation-bound attribution and provider-write receipts.

```mermaid
flowchart LR
  idp["Customer IdP<br/>Okta / Entra"]
  workos["WorkOS<br/>orgs, verified domains,<br/>connections, Directory Sync"]
  web["Web /login<br/>(no secrets)"]
  api["consent-protocol<br/>/api/auth/sso/*"]
  fb["Firebase Auth<br/>token verifier and account store"]
  routes["Existing routes<br/>verify_firebase_bearer"]
  lifecycle["Local lifecycle<br/>immutable membership hashes<br/>generation + mutation receipts"]

  idp --> workos --> web --> api
  api -->|"who owns this domain?"| workos
  api -->|"custom token, minimal claims"| fb
  fb --> routes
  workos -. "dsync.user.* webhook" .-> api
  api --> lifecycle
  lifecycle -. "captured owner / single dispatch" .-> fb
  routes -->|"membership admission"| lifecycle
```

## Status

Baseline integration exists. The 26 October 2026 generation-bound hardening is local and unshipped: migration `426_workos_generation_memberships`, exact directory attribution, journalled provider writes and membership-bound admission. Public replacement admission remains disabled until legacy membership coverage and actual provider behavior are qualified. See the [current readiness memo](../quality/adk-orchestration-docs-audit.md).

## Context

- Baseline authentication uses Firebase ID tokens: `api/utils/firebase_auth.py::verify_firebase_bearer`, enforced by `api/middleware.py::require_firebase_auth`. The WorkOS routes add enterprise federation through that same verifier.
- Authorization is DB-driven (`ria_profiles`, `RIAIAMService.require_ria_verified`). `ria_firms` carries FINRA/SEC identity only and has no tenant or IdP fields.
- Vault keys are client-side BYOK. Possession of an authenticated session never unlocks a vault; the passphrase does.
- The original requirement was enterprise federation alongside existing sign-in methods. Enterprise customers need SAML/OIDC per organization, domain-based org discovery, Directory Sync (SCIM) deprovisioning, and a way to onboard without Hussh staff editing records. This ADR covers that integration only; which roles an enterprise user later holds (for example an advisor actor) is unchanged and out of scope.

## Decision

1. **WorkOS is a federation front door, not an authority over sessions.** Firebase remains the only verifier of session tokens. WorkOS proves "this person authenticated at this org's IdP"; the backend converts that into a Firebase custom token. No route accepts a WorkOS token.
2. **WorkOS is the authority for organizations, domains and connections.** Hussh is the WorkOS customer. Any organization that exists in our WorkOS account, has a DNS-verified domain and has not had its SSO switched off can sign its people in; WorkOS itself refuses anyone without a usable connection. Nobody registers an organization or a domain on the Hussh side.
3. **External identity and application ownership are separate.** Firebase claims preserve sign-in compatibility. The local account-generation authority and immutable membership hashes bind delayed callbacks to their original owner; they never discover a replacement by email.
4. **SSO never grants roles.** A successful exchange establishes identity only. It does not create or advance `ria_profiles.verification_status`, does not mint consent, and does not unlock a vault.
5. **Webhooks are the deprovision channel.** Exact captured directory membership selects the original owner. The existing Firebase mutation journal retains dispatch, settlement and uncertain outcomes before replacement enrollment can proceed.
6. **Feature-flagged, default off.** Rollback is the flag; Firebase sign-in is untouched.

## Organizations and domains

- Discovery: for an email, the backend asks WorkOS for the organization that has **verified** that domain and has not had SSO switched off. If none, or more than one, there is no SSO for that address. The domain states WorkOS reports as verified are `verified` and `legacy_verified`.
- "Switched off" means WorkOS lists connections for the organization and **none is active**. An organization with no *listed* connection is passed on to WorkOS, which decides: a live staging run showed WorkOS keeps its built-in Test Identity Provider (type `TestIdp`, state active) out of the connection listing under every filter, so an empty listing cannot be read as "no SSO". The gate is a courtesy that avoids sending people to a WorkOS error page; it is not a security control, because nobody can authenticate without a usable connection.
- The profile WorkOS returns after sign-in must belong to the organization the attempt started for (the signed `state` carries it), and its email's domain must be one that organization has verified. An org's IdP can therefore only assert addresses its company proved it owns by DNS.
- Free-mail domains (`gmail.com`, `outlook.com` and similar) are refused even if WorkOS were to list one, because email auto-link trusts a verified domain.
- The off switch for an organization is switching its connection off in WorkOS. There is no local suspension. An organization that has verified a domain but has no connection at all would be sent on to a WorkOS error page; that is the one cost of the rule above.
- Each unauthenticated request to `/api/auth/sso/start` calls WorkOS's API, so both SSO routes are rate limited per client IP.

## Account model

| Concept | Where it lives |
|---|---|
| Firebase UID | External Firebase identity; generation-zero application owners preserve that identifier |
| Application owner | Environment-local account generation; retained callbacks never resolve the newest owner |
| Directory attribution | Hash-only `account_workos_memberships` rows, captured by verified SSO exchange |
| WorkOS org id, WorkOS user id | Custom claims `workosOrgId`, `workosUserId` on the Firebase user |
| How the account came to exist | Claim `workosOrigin`: `created` (SSO made it) or `linked` (it already existed) |
| Deprovisioned | Claim `workosDeprovisionedAt`; plus Firebase `disabled` for `created` accounts |
| The person's name | Firebase `displayName`, the same place a Google or Apple sign-in puts it; the identity shadow syncs from there |

Claims are merged into the existing claim object, never written over it (`set_custom_user_claims` replaces the whole object, and `hushhWelcomeMailAt` already lives there).

**What we keep from the IdP profile.** The WorkOS profile id, organization, connection and IdP identifiers, email and name (first and last, or a full name when the IdP sends no split). Groups, roles, raw attributes and the WorkOS access token are not read. The name is written to Firebase `displayName` only when the account has none, so a name the person chose, or one a Google or Apple sign-in already gave the account, is never replaced, and later changes at the IdP do not follow. It passes the same rules as the name editor in the app (2-60 characters, no links or handles); a name that fails them is dropped. Failing to save a name never blocks sign-in.

**Resolving the account on exchange**

1. Derive the UID `sso_<sha256(org, workos user)>`. If that Firebase user exists, use it. It must not be disabled or deprovisioned, and its claims must name this org and this person.
2. Otherwise, if exactly one existing Firebase user has the same email, link to it, but only if that email is **verified** (an unverified one could be a squat of the address) and the account is not claimed by a different org or WorkOS person. This lets an employee with a personal Hussh account keep one vault.
3. Otherwise create the account with the derived UID and the IdP's email, marked verified, and write the claims. If that UID has an account-deletion tombstone, refuse instead of recreating it.

**Why the UID is derived, and unkeyed.** Two simultaneous first sign-ins then create one account, and a work email that changes at the IdP still reaches the same account. It is not keyed with a secret on purpose: rotating a secret must never move people to new, empty accounts. A UID is an identifier, not a credential; signing in still needs a token only this service can mint.

**Custom token claims.** `auth_provider=workos`, `workos_org_id`, captured owner/lane and a profile hash; directory-backed exchanges also carry the exact membership hash. Admission checks retained attribution on every request, including a custom token redeemed after offboarding. SSO-only organizations retain generation-zero support only after a successful complete empty directory listing; errors and unmatched existing directories are refusals. An existing membership fence survives directory removal. The token must **not** carry `hushh_review_mint` (that claim is the review-lane containment marker in `firebase_auth.py`). Roles and entitlements are never claims; they stay DB-driven.

**Email and aliases.** No change to `actor_identity_service.py` is needed: the account is created in Firebase with the IdP-asserted email, and the existing identity sync reads the email from the Firebase user record. The IdP email is never written to the alias tables.

## Minimum retained attribution

WorkOS remains authoritative for organizations, DNS verification and connections.
Migration 426 adds one hash-only membership relation to the existing local lifecycle.
It contains no email, credentials, names or raw provider identifiers. Its immutable
owner/generation attribution survives erasure so an old signed webhook cannot act
on a replacement account with the same Firebase UID.

A verified exchange correlates the profile's connection and organization, then
requires one active Directory Sync user with the exact IdP identifier in a complete
listing. Missing or ambiguous correlation requires review; email never supplies
webhook authority. WorkOS documents this [identity-linking rule](https://workos.com/docs/authkit/identity-linking).
IdPs with inconsistent SSO/SCIM identifiers need their own qualified mapping.

A complete empty directory listing preserves SSO-only organizations and the Test
IdP. These sessions carry a signed profile hash; subsequent captured offboarding
fences held tokens too. Existing attribution is reused only for the same active
owner and origin. Uncaptured historical directory events remain retryable and
require reviewed recovery. Neither an empty current directory nor this schema
establishes historical membership coverage.

No organization/domain mirror or separate webhook event ledger is introduced.
The existing generation and Firebase mutation authorities own retirement and
uncertain dispatch. Replacement enrollment through WorkOS remains unsupported;
Google, Apple, Microsoft and purpose-bound email recovery retain their own proof
contracts. One account belongs to one organization in this version.

## Deprovision semantics

On `dsync.user.deleted`, or `dsync.user.updated` with `state: inactive` (WorkOS has no separate deactivation event; this is how a deactivation arrives):

1. Resolve the signed organization, directory and directory-user identifiers against immutable captured attribution. Event email is ignored. Unknown membership returns a retryable refusal; a retired generation is acknowledged without affecting its replacement.
2. Persist local offboarding before the provider call. Membership-bearing and profile-bearing tokens cannot regain admission by redeeming an earlier custom token.
3. Reserve the existing generation-bound Firebase mutation permit. Recheck provider organization/profile/origin inside that operation. Send one no-retry `accounts:update` containing the deprovision marker and `validSince`; add `disableUser` only for SSO-created identities. Preserve unrelated claims.
4. For `created` identities, revoke active consent grants by the captured application owner. For `linked` personal accounts, preserve independent sign-in, vault and grants. The work sign-in remains refused.
5. Uncertain provider outcomes remain journalled and block replacement enrollment. A generic exception or HTTP status never proves rejection. Closing a request cannot abandon its provider thread.
6. Do not delete an account or its information as an offboarding shortcut. Vault keys remain under their existing custody. Shared-production Firebase mutation restrictions remain mandatory in dev/UAT.

**Timing.** New membership/profile-bearing tokens also check local admission. Legacy tokens without those bindings retain provider revocation and are an explicit rollout-coverage gap. Provider revocation for already-issued tokens is cached for at most a minute: `verify_firebase_bearer` caches a positive revocation check for at most 60 seconds (`_REVOCATION_CACHE_TTL_SECONDS`).

**Known limitations in this version.**

- Reactivation requires reviewed identity-lifecycle recovery. Clearing a Firebase claim alone cannot remove immutable local offboarding evidence.
- `dsync.deleted` (a whole directory removed) is acknowledged and ignored. Removing a directory is not the same as removing its users from the IdP.
- A deprovision event needs a previously captured directory relationship. Historical Firebase claims alone do not establish it; missing evidence must not be backfilled from email.
- A deprovisioned `linked` account keeps working with its personal sign-in methods. That is intended.
- The signed `state` expires and is bound to the org, but it is not bound to a browser. The client must compare the returned `state` with the value it stored before redirecting (login-CSRF defense); the server cannot do that for it.

Anything beyond session and consent revocation (for example suspending downstream relationships) is out of scope for this integration.

Webhook handling: verify the `WorkOS-Signature` HMAC over the **raw body**; enforce a 180-second timestamp window (the WorkOS SDK default); return 2xx only after the state change; acknowledge and ignore unknown event types.

## Web client

- **Entry.** "Continue with SSO" on the sign-in screen (`EnterpriseSsoSection`, rendered by `AuthStep`) opens an inline work-email form. It is shown only when `NEXT_PUBLIC_WORKOS_SSO_ENABLED` is on and the client is web; the backend flag stays the authority.
- **No new route.** The WorkOS redirect URI is `/login`. On return, the section completes the Firebase sign-in with the custom token and `AuthStep`'s existing-session routing takes over, so post-auth routing, onboarding and legal acceptance match Google and Apple. Reusing `/login` avoids a new route and its navigation and Back contracts.
- **Login-CSRF defense.** The client stores the returned `state` in `sessionStorage` before redirecting and honors the callback only when the returned state matches exactly, once. A mismatch never reaches the exchange. The code and state are removed from the address bar immediately.
- **Back.** While the email form is open, Back closes it first (a `useBackLayer` on the login route), then reaches the route's own parent.
- **Voice and Search.** No voice or Search action is added: signing in needs a typed work email, and the login voice playbook still describes Google and Apple only. This is a decision, not an omission.
- **Proxy.** The web app reaches the backend through two thin pass-through handlers, `app/api/auth/sso/start` and `exchange`. The webhook goes from WorkOS straight to the backend.

## Native and web

Web is the v1 surface. Native (system-browser plus deep-link return) is deferred and needs `mobile_native_architect` review before scope is committed.

## Secrets

`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_WEBHOOK_SECRET` live in Secret Manager per [env-and-secrets.md](../operations/env-and-secrets.md). Nothing secret is exposed via `NEXT_PUBLIC_*`. The WorkOS SDK sits behind an adapter so tests and the flag-off path never import it.

## Rationalizations, rebutted

| Rationalization | Reality |
|---|---|
| "SSO proves they work at the customer, so grant them roles" | SSO proves identity only. Roles and verification status stay DB-driven and unchanged by this integration. |
| "Accept the WorkOS token directly and skip Firebase" | Two verifiers means two revocation systems. Firebase stays the single decision-maker. |
| "Match by email, it's the same person" | Fresh sign-in may link a verified account under the verified-domain rules. Delayed webhooks must use immutable directory attribution, never email. |
| "Any organization is welcome, so skip the domain check" | The domain check is what stops one org's IdP from asserting another company's addresses. Open signup keeps it. |
| "Deprovision should disable the account" | Only for accounts SSO created. A personal account that was merely linked is the person's own. |
| "Deprovision should lock the vault" | BYOK: the passphrase is client-held. We revoke sessions and, for created accounts, consent, and say exactly that. |

## Resolved decisions

- **Who runs WorkOS.** Hussh is the WorkOS customer and each enterprise is a WorkOS Organization connected to its own IdP (confirmed by the founder). Customers are not WorkOS tenants of their own, so no foreign OIDC issuer is trusted.
- **Any organization can sign up.** There is no pre-registration. WorkOS's verified domains and connections decide.
- **No organization/domain mirror.** Generation-safe offboarding retains only the attribution and mutation evidence described above.

## Open decisions

1. **Web-only v1 or native too.** Default: web-only.
2. **Cost control for self-serve onboarding.** WorkOS bills per SSO connection. Today organizations are created in WorkOS by us or our customers' admins; fully self-serve onboarding would need a gate before it exists.

## Verification

- Webhook: bad signature rejected, with a negative control proving a good signature passes; the helper's signatures pass the backend's own verifier and the vendor SDK's.
- Exchange refuses a mismatched organization, an organization whose SSO is switched off, an email on a domain the organization has not verified, and a free-mail domain, and creates nothing; refuses to link an unverified existing account or one claimed by a different person.
- Deprovision of a created account disables it, revokes sessions and consent, and blocks later sign-in; deprovision of a linked account revokes sessions only and still blocks sign-in through the organization.
- Each guard was checked by deliberately breaking it and confirming a test fails.
- Reviewer browser proof still to do: SSO login still requires passphrase unlock; same-session navigation intact.
- `scripts/ci/orchestrate.sh core`, focused pytest for the route and service, vitest and UI contracts for web, and an end-to-end run against a WorkOS sandbox org before UAT.
