# Initial signup Contacts welcome

The initial signup journey can find familiar people before a new user opens an
agent. The feature uses the existing contact matcher, Connections, named Circles,
profile avatars, member picker, contact invitations and referral share flows.
Existing Connect and Location contact acquisition stays unchanged.

## Visual Context

The [One setup architecture](../reference/quality/one-onboarding-architecture.md)
owns admission and Finance/invitation continuity. The [design system](../reference/quality/README.md)
owns the page shell, typography, person avatars, grouped rows, buttons and sheets.
The welcome shows up to three confirmed One profiles with their One photos and
names, then Contacts management, manual Trusted selection and invitations.
“See Contacts” opens the paginated shared roster. Missing photos use the same
initials fallback as Connect. No invented people or inferred trust appears.

## Provider and platform decisions

| Signup | Initial source | Consent/recovery |
| --- | --- | --- |
| Google, web | Saved Google Contacts | Development/UAT signup uses one GIS consent for identity and optional `contacts.readonly`, then directly exchanges that token for a Firebase credential |
| Google, iOS | Saved Google Contacts | Development/UAT sign-in requests the scope; the native bridge captures a fresh, owner-bound SDK grant |
| Google, Android | Saved Google Contacts | Development/UAT uses the same selected signup account through `AuthorizationClient`; no account reconnection |
| Apple, iOS/Android | Device address book | Optional permission/read action after phone verification; limited iOS access works |
| Apple, web | Saved Google Contacts | Optional explicit Google Contacts action after phone verification |
| Established returning account | Existing behavior | No new enrollment or automatic Circle fill |

New-account welcome enrollment is always active and has no rollout input. While
Contacts awaits public OAuth verification, the canonical production environment
uses authentication-only Google sign-in on all platforms and hides the inline
Contacts checkbox. The new account still enrolls with Google as its deferred
source and can choose the optional existing Contacts authorization after phone
verification. Apple routing is unchanged. The central AuthService readiness
boundary must be updated only after Google approves public use and the live
production client is verified; this is not a per-deployment onboarding toggle.
The live production project (`hushh-pda`) was checked on 2026-10-14: Contacts
is listed as not yet verified, and branding/data access review is in progress.

First enrollment requires positive Firebase new-user metadata and explicitly incomplete One setup. Unknown metadata and nullable legacy setup remain on the existing flow. Only an already enrolled, unfinished signup may resume. The explicit returning Sign in action requests authentication scopes only; if it creates a genuinely new account, that account still enrolls and can optionally find contacts after verification. Signup consent is requested before Google returns the selected account's new-user status, and established accounts never start a contact read, Circle fill or welcome enrollment from that result.

On Android, Google identity authentication and the platform's resource
authorization are separate SDK operations in the same signup journey. First-time
Contacts permission can therefore require Google's additional consent UI. This
does not require the user to reconnect or choose their account again.

The signup screen offers “Find people I know” and explains the shared roster.
Turning it off omits the signup Contacts scope. Contact denial, cancellation,
an older bridge, unavailable service, or no matches never prevents signup,
phone verification, setup completion or Continue.

The login screen's web Google sign-in preloads the existing GIS script before the tap, so the
consent popup opens within the browser gesture. Firebase authenticates the
returned Google credential and determines account newness; only a confirmed
Contacts grant reaches the memory-only reader. Declining Contacts while granting
identity completes authentication. Replacing an attempt aborts its pending grant
before credential exchange, and the provider controls stay busy during exchange.
Once Firebase exchange begins, cancellation cannot undo its committed session.
Legal recording and initial Contacts enrollment finish for that current Firebase
owner even after the login screen closes, without redirecting the departed screen.
Returning web sign-in uses the same Firebase credential handoff with identity
scopes only; native providers and callers without an explicit sign-in purpose
retain their existing SDK flows.
An unfinished popup now leaves an explicit retry message on the login screen.

`NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID` identifies the Firebase-trusted Google
identity client. It is separate from the Contacts-only
`NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`; one must never substitute for the other.
Builds resolve the optional identity client through an ephemeral artifact. Only
a missing value retains the existing Firebase SDK path; invalid values or access
failures stop the build. Verify the client's authorized JavaScript origins and
Firebase credential compatibility before configuring it. This is public OAuth
client configuration, not a welcome-enrollment flag.

## Processing and authority

1. Accepted Google signup can read saved contacts while phone verification runs.
   Captured Contacts grants and address books remain in process memory. No
   People API request runs on the backend. One does not export or add a Contacts
   refresh-token store; the native Google SDK retains its existing sign-in
   session independently. Calendar guest photos are a separate, optional
   Calendar OAuth permission and do not change signup contact matching.
2. Matching starts only after verified phone identity. Existing on-device
   normalization, self exclusion, deduplication, hashes, batches, lookup budgets
   and partial/unknown classifications remain authoritative. Source permission
   never enables discoverability on One.
3. Signup matching uses `context: signup`, which cannot reconnect a revoked
   relationship. Explicit Connect/Location resync retains its existing behavior.
4. Root setup and vault creation finish through the existing encrypted boundary.
   The optional welcome then precedes agents. Finance import/preferences and
   invitation destinations survive the welcome. The chat entry marker is queued
   on Continue, after acknowledgment settlement.
5. The Firebase-only bootstrap can create an empty ordinary shared Circle named
   Contacts and its owner/code. A transaction stores its exact reference in
   `vault_keys`; concurrent retries reuse that reference. Renaming is respected;
   deleting the referenced Circle does not create a replacement.
6. Only confirmed active Connections with viewer-relative Contacts provenance
   and successful match outcomes qualify for automatic membership. Membership
   still uses the existing vault-owner route, at most 20 people per batch and
   99 peers plus the owner. Overflow stays in Connections.
7. Initial fill is insert-only on the server. Existing active, removed or left
   memberships are skipped across retries and reloads. Normal explicit owner
   adds retain their current behavior. Shared deletion barriers precede domain
   locks; profile locks precede the pending lifecycle row, which serializes fill
   against Continue without reversing existing Circle writers' lock order.
8. Normal shared-Circle membership notifications and roster visibility apply.
   Trusted membership, location grants and other private sharing are separate
   user choices. Invitations are explicit: Circle code/link joins Contacts;
   personal referral/generic link invites to One; individual contact invitations
   reuse the existing review/share flow. A full Circle disables its join CTA.
   Removing someone uses the shared confirmation dialog and branded promise
   feedback. Cancelling or Back keeps the roster open and makes no mutation;
   Trusted selection remains a separate explicit action.

Only sparse lifecycle facts persist: selected source, nullable welcome
acknowledgment, and a server-owned Circle reference. NULL acknowledgment means
unenrolled, false pending, true complete. Existing rows are not backfilled.
Fresh placeholder inserts explicitly initialize incomplete root setup;
enrollment uses a compare-and-set so it cannot undo concurrent Finish.
Acknowledgment is monotonic. Raw contacts, candidates, provider grants and
profile previews are not persisted by the initial-flow store. Account/session
generation changes suppress late reads, matches, mutations and UI callbacks.

## Recovery cases

- Cold restart restores only lifecycle facts; new contact access requires an
  explicit action. Android recovers only the Google SDK's cached account;
  iOS reserves a Contacts operation while the Google SDK restores its previous
  session. Both require its Google subject to match the current Firebase owner
  before reading Contacts; neither replaces Firebase identity. Scope consent,
  restore and token-refresh callbacks remain reserved until they drain after a
  timeout or sign-out. Native Apple restores its device source from live sign-in
  provider evidence even if another device saved Google as the source.
- Empty contacts, email-only/uncheckable contacts, hidden users, self matches,
  large books, lost responses and partial matching use existing classifications.
  Unknown/unchecked contacts are not labeled unmatched or offered invitations.
- Circle setup errors offer a separate retry and Continue. Confirmed profile
  previews can remain visible even when Circle creation fails. A definitive or
  ambiguous failed add is safe to retry because insertion cannot restore a
  membership tombstone.
- Contacts finishing while empty-Circle creation awaits trigger another fill;
  an unprocessed result is never marked complete.
- A direct welcome URL remains escapable for an established account or a failed
  transient restore. Safe destinations reject external URLs and setup/self
  loops while retaining canonical Finance continuation routes.
- Failed durable acknowledgment allows the current authenticated session to
  continue; a later session can retry the welcome without restoring removed
  members. Deleted Circles stay deleted.

## Deployment and rollback

Initial Contacts is ordinary new-user onboarding on web, iOS and Android.
There is no environment flag or workflow opt-in. Eligibility remains owned by
positive new-account evidence and server setup/welcome state; existing accounts
are not enrolled. Successfully deleted accounts can enter again through fresh
signup after deletion has finished. Contact permission and Trusted membership
remain optional user choices.

Deploy the reviewed landed SHA through the governed workflow with `scope=auto`.
The scope resolver pairs changes to the initial signup source/enrollment contract
and migration 337 with both runtimes, including when a narrow scope is requested.
Unrelated frontend changes can retain the already compatible backend. Native
assets and binaries must be rebuilt and synced; older installed binaries retain
their compiled behavior. Actor, main-SHA, schema and provenance gates still apply.
Production and TestFlight publishing remain separate authorized releases.

Migration **337 must precede any deployment of this backend**: bootstrap selects
the new columns. All three release schema
contracts and the release/rollback manifest include it. The generated offline
SQLite snapshot must be regenerated from migrated UAT using its canonical
generator; it is not hand edited against unmigrated live state. The SQLite-only
compatibility path projects only existing initial-contact columns and refuses
initial-contact writes while any are absent. Ordinary bootstrap and setup stay
available against older offline snapshots.

Live GCP inspection confirmed People API enabled and `contacts.readonly` already
listed for `hushh-pda-uat` and `hushh-pda`. The Contacts justification was saved in
both projects to describe optional signup on web/iOS/Android, phone-gated hash
matching, shared-Circle behavior and separate Trusted/private sharing choices.
The existing verification requests were updated by those saves. Google still
marks Contacts **not yet verified**; this is configuration, not Google approval.
Use restricted UAT/test accounts for live proof and update the verification demo
to cover the signup clients before public activation. Existing unrelated Drive
and Gmail configuration was preserved.

Isolated PostgreSQL proof uses the actual deletion guards and chat membership
trigger/actor foreign key: the old lock mode reproduces a deadlock; the fixed
service completes reciprocal signup and mixed manual additions. Its CI suite
also verifies migration 337 replay, rollback and reapplication without losing
existing Circles or memberships.

Release proof still needs device consent and Android release-account/signing
validation, UAT migration application and authenticated route verification.
Native iOS compilation is covered by the exact-head Xcode CI lane. Local browser fixtures
prove presentation/interaction, not live OAuth or a real address book.

Rollback restores a reviewed compatible frontend/backend release through the
governed workflow, then optionally applies `337_initial_contacts_onboarding.rollback.sql`. The SQL
rollback removes metadata only. Existing Circles, connections and memberships
are preserved. Do not drop columns while this backend still selects them.

## Focused verification

- Frontend: initial service, auth-service, onboarding guard and welcome-route
  tests; existing Google Contacts session/source and contact-signals suites.
- Browser: `e2e/initial-contacts-welcome.layout.spec.ts` renders real shared
  primitives and the welcome against synthetic API boundaries at 320, 393 and
  1440px on Chromium and WebKit; it exercises profiles, roster scrolling, nested
  Back, full-circle invites and ordered Continue.
- Backend: lifecycle metadata/CAS, insert-only membership, explicit reconnect
  negative control, contact-sync contracts, named-Circle routes and migration
  registration/rollback tests.
- Cross-surface: Back/Search contracts, service boundary, native plugin parity,
  Kotlin compilation, TypeScript and production build.

Local evidence from this implementation includes the focused signup, existing
phone/session and contact-sync regression suites, backend lifecycle/Circle tests,
and six Chromium/WebKit layout cases. The Back
behavior pack passed 442 tests; combined UI-contract verification, service
boundary, native static/plugin parity, TypeScript and Android debug Kotlin
compilation passed. A production web build with the feature enabled compiled
and generated all 173 pages, including `/one/welcome`. Browser screenshots use synthetic names, profiles and
counts; the production component uses confirmed server profile information.
These results do not substitute for the release proof listed above.
