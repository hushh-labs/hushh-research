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
| Google, web | Saved Google Contacts | Signup-specific Firebase provider requests `contacts.readonly`; explicit retry uses existing browser GIS |
| Google, iOS | Saved Google Contacts | Capawesome Google sign-in requests the scope; the native bridge captures a fresh, owner-bound SDK grant |
| Google, Android | Saved Google Contacts | Same selected signup account authorizes Contacts through `AuthorizationClient`; no account reconnection |
| Apple, iOS/Android | Device address book | Optional permission/read action after phone verification; limited iOS access works |
| Apple, web | Saved Google Contacts | Optional explicit Google Contacts action after phone verification |
| Established returning account | Existing behavior | No new enrollment or automatic Circle fill |

On Android, Google identity authentication and the platform's resource
authorization are separate SDK operations in the same signup journey. First-time
Contacts permission can therefore require Google's additional consent UI. This
does not require the user to reconnect or choose their account again.

The signup screen offers “Find people I know” and explains the shared roster.
Turning it off omits the signup Contacts scope. Contact denial, cancellation,
an older bridge, unavailable service, or no matches never prevents signup,
phone verification, setup completion or Continue.

## Processing and authority

1. Accepted Google signup can read saved contacts while phone verification runs.
   Captured Contacts grants and address books remain in process memory. No
   People API request runs on the backend. One does not export or add a Contacts
   refresh-token store; the native Google SDK retains its existing sign-in
   session independently.
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

## Activation and rollback

`NEXT_PUBLIC_INITIAL_CONTACTS_ONBOARDING_ENABLED` defaults to false. It is a
build-time option in Docker, both frontend Cloud Build lanes and native profile
generation. `_INITIAL_CONTACTS_ONBOARDING_ENABLED=true` opts a reviewed Cloud
Build image in. Runtime-only Cloud Run changes cannot enable compiled UI.
Native assets and binaries must be rebuilt and synced for their new method.

After the reviewed SHA has landed and its required gates pass, the governed
`Deploy to UAT` and `Ship iOS to TestFlight` workflows accept the optional
`initial_contacts_onboarding=true` input. Both default to false. Deploy the exact
landed SHA with `scope=auto`, which includes each service's complete outstanding
changes, and enable the input for the separately authorized TestFlight release.
This passes the flag to the web image and
bundled native assets; existing actor, main-SHA, provenance and release gates
still apply. No workflow is dispatched by creating this PR.

For a local UAT native build, set
`NEXT_PUBLIC_INITIAL_CONTACTS_ONBOARDING_ENABLED=true` in the process or UAT
profile before `npm run ios:prepare:uat`; the generated native environment
preserves the selected value. Production release defaults stay off.

Migration **337 must precede any deployment of this backend**, even with the
UI flag off: bootstrap selects the new columns. All three release schema
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

Rollback first rebuilds with the flag off and restores the compatible backend,
then optionally applies `337_initial_contacts_onboarding.rollback.sql`. The SQL
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
