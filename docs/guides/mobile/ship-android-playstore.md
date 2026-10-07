# Ship Android to Google Play production

Release authority, exact-SHA proof, branch restoration, and terminal monitoring follow the
[canonical Admin release SOP](../../../.codex/skills/repo-operations/references/admin-release-sop.md).
This guide adds Android Play Store-specific build and verification detail only.

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One manual dispatch cuts a Hussh One Android App Bundle (`.aab`) from an explicitly selected green
`main` SHA, builds the Capacitor app against the **UAT backend + shared Firebase authority**,
signs it with the **existing Android Release Upload Keystore**, and uploads it directly to the
**Google Play production track**.

- **Workflow:** `.github/workflows/ship-android-playstore-v1.yml` (`workflow_dispatch`).
- **CLI Dispatcher:** `node scripts/release/dispatch-android-playstore.mjs` (or `npm run android:release:playstore`).
- **Runner:** GitHub-hosted `ubuntu-latest`.
- **Target:** package `com.hussh.app` (Android only — iOS remains `com.hushh.app`), Google Play production track. The binary talks to the **UAT backend** (`hushh-pda-uat`); the production backend (`hushh-pda`) is never read or targeted by this lane.
- **Secret custody:** routing, signing, Play service-account, and native/shared Firebase material all live in `hushh-pda-uat` Secret Manager. The native `google-services.json` is cross-checked against the web Firebase identity before the build.
- **Cadence:** operator-initiated, roughly twice per week when a release is warranted. There is no cron trigger and no internal, closed, open, alpha, or beta upload mode in this workflow.

This is the Android equivalent of the iOS App Store workflow with `backend_target=uat` (latest
frontend + latest backend, matching UAT). A store binary that talks to UAT is an intentional product
contract, not credential reuse: the Play production track is the upload target, UAT is the runtime.
The job runs in the `uat` GitHub environment because that environment carries the UAT workload
identity needed to read the UAT backend revision and secrets; dispatch authority is still the
stricter `production.manual_dispatch_users` list.

## Version Cadence & Monotonic versionCode

1. **Monotonic Version Code:** Google Play Console requires every uploaded `.aab` to have a `versionCode` strictly greater than any previously uploaded build.
2. **Automated Version Resolution:** The resolver `scripts/ci/resolve-android-build-number.py` queries Google Play's current bundles, APKs, and every active track release, finds the highest existing `versionCode`, and increments it automatically (`max(play_latest, gradle_current) + 1`). Both dry runs and live releases require that query; authorization/package lookup failures stop the run instead of pretending Play has no history.
3. **Marketing VersionName:** Set `versionName "1.x.y"` in `hushh-webapp/android/app/build.gradle` to match the current marketing release.

## How it works (what the workflow runs)

```bash
cd hushh-webapp
npm ci
npm run sync:native-firebase-configs -- --platform android
# UAT env is supplied by the workflow; the Android wrapper isolates the export.
node ./scripts/native/with-android-native-env.mjs ... next build
node ./scripts/native/with-android-native-env.mjs ... cap sync android
cd android && ./gradlew bundleRelease
```

Before compilation, the workflow verifies that every generated Capacitor plugin backend URL and
the bundled native runtime contract point to the UAT backend (UAT host, `app_env=uat`, valid
attestation). After compilation, it runs
`jarsigner` verification and refuses to retain or upload a missing/unsigned AAB.

Signing reads from `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` supplied by Secret Manager / GitHub secrets.
The signed AAB is retained for 14 live days in the dedicated `hushh-native-uat`
project's private `hushh-native-uat-artifacts` bucket after bucket-policy and upload-integrity
checks. GitHub Actions keeps only a redacted receipt, not the AAB. The bucket
has a separate 7-day private soft-delete recovery window after lifecycle
deletion. The project-attached deny policy blocks inherited organization-level
object reads and developer-group mutations; the workflow checks it before and
after upload. A dry run does not upload to Google Play.

## Release gates

Every run must prove all of the following before a live upload:

1. The workflow was manually dispatched from `main` by an authorized production actor.
2. The selected full SHA is on `main` and has a successful `Main Post-Merge Smoke Gate`.
3. The serving UAT backend revision was deployed by `deploy-uat` from that exact SHA
   (`verify-cloudrun-revision-provenance.py --expected-env uat --expected-source deploy-uat`). If UAT is
   not yet serving the SHA, the run stops: deploy that SHA to UAT first. This workflow never deploys.
4. UAT routing is HTTPS and resolves to the UAT backend host; any production, localhost, or emulator
   URL is refused before the web build starts.
5. The native `google-services.json` project matches the web Firebase identity and contains `com.hussh.app`.
6. Play is reachable with the existing release service account and supplies the authoritative version floor.
7. The generated UAT runtime contract, Capacitor plugin routes, release signing, and AAB signature all verify.

Play Console policy declarations, production availability, store listing, Data safety answers, and
any Console-side blocking warnings remain human-owned preconditions. A green dry run does not prove
those Console forms are complete.

## One-time setup (secret-touching — the operator does this)

All signing + Google Play Developer API material lives in **GCP Secret Manager**, project **`hushh-pda-uat`** (or GitHub secrets).

### 1. Android Release Upload Keystore (.jks)

Generate or locate the release upload keystore for `com.hussh.app` (the same keystore/alias is reused across the package rename — a keystore is not tied to a package name):

```bash
# Generate upload keystore if not already created:
keytool -genkeypair -v -keystore release-upload-key.jks -alias hushh-upload-key \
  -keyalg RSA -keysize 2048 -validity 10000

# Base64 encode and upload to GCP Secret Manager:
base64 -i release-upload-key.jks \
  | gcloud secrets create ANDROID_RELEASE_KEYSTORE_B64 --data-file=- --project=hushh-pda-uat
printf '%s' '<keystore_password>' \
  | gcloud secrets create ANDROID_KEYSTORE_PASSWORD --data-file=- --project=hushh-pda-uat
printf '%s' 'hushh-upload-key' \
  | gcloud secrets create ANDROID_KEY_ALIAS --data-file=- --project=hushh-pda-uat
printf '%s' '<key_password>' \
  | gcloud secrets create ANDROID_KEY_PASSWORD --data-file=- --project=hushh-pda-uat
```

### 2. Google Play Developer API Service Account

1. Open [Google Cloud Console](https://console.cloud.google.com/) $\rightarrow$ IAM & Admin $\rightarrow$ Service Accounts.
2. Create service account `play-store-releaser@hushh-pda-uat.iam.gserviceaccount.com`.
3. Open [Google Play Console](https://play.google.com/console) $\rightarrow$ **Users and Permissions** $\rightarrow$ **Invite new user** $\rightarrow$ add service account email with **Release manager** permissions.
4. Download service account JSON key, base64-encode it, and upload to Secret Manager:

```bash
base64 -i service-account-key.json \
  | gcloud secrets create GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_B64 --data-file=- --project=hushh-pda-uat
```

## Running a release

### Option A: One-click CLI Dispatcher

```bash
npm run android:release:playstore -- --dry-run  # query Play + build/sign/verify; no upload
npm run android:release:playstore                # live upload to the Play production track
```

The dispatcher refreshes `origin/main`, shows the exact SHA/environment/package/track, and requires
typing `dry run` or `release production`. Live confirmation cannot be bypassed with a non-interactive
flag. It watches and verifies the exact run ID returned by GitHub.

### Option B: GitHub Actions UI

1. Open repository on GitHub $\rightarrow$ **Actions** $\rightarrow$ **Ship Android to Google Play Store**.
2. First run with **dry_run** enabled and inspect every gate.
3. For a live release, re-run the exact green SHA with **dry_run** disabled. The upload target is always the Play production track; the runtime is always UAT.

## Contacts: the Data safety declaration, and the April 2026 policy

`READ_CONTACTS` is declared in `hushh-webapp/android/app/src/main/AndroidManifest.xml`
and read by the first-party `HushhContacts` plugin, so this app is in scope for
Google Play's **Contact Permissions policy**, announced 15 April 2026. Nothing in
this repo covered it before, and the declaration is a human, one-time Play Console
action that cannot be automated.

### What the policy requires

Apps targeting **Android 17+ (API 37+)** may request `READ_CONTACTS` only when
*"the Android Contact Picker is not sufficient for your app to provide core
functionality."* It is now a **restricted permission**, gated on a declaration.

**Our use case is on the approved list.** Google names *"friend matching with
server-side processing"* explicitly, and that is exactly what contact sync does:
the device normalizes each number to E.164 and hashes it, the server matches the
digests against the user directory, and the match feeds the One Location People
list and Connect. Read the declaration from that sentence, not from "we sync
contacts".

What does **not** justify it: inviting or referring. That must use the system
picker. Our invite path is picker-driven for exactly this reason — the share
offered after a scan carries no contact data, only the sender's referral link.

### Timeline

| When | What |
|---|---|
| 15 April 2026 | Policy announced |
| **September 2026** | Play Console prompts developers to submit declarations |
| **January 2027** | Mandatory compliance; non-compliant apps are subject to removal |

### The Data safety form must match the code

A mismatch between the declared behaviour and the actual behaviour is a primary
removal trigger, so declare what is true:

- **Collected:** phone numbers, in the form of **unsalted SHA-256 digests plus
  the last four digits**, transmitted to `POST /api/marketplace/contacts/match`.
  Raw phone numbers and contact names **never leave the device** — see
  `hushh-webapp/lib/marketplace/contact-matching.ts`.
- **Stored:** nothing. `RIAIAMService.match_marketplace_contacts` performs zero
  writes; the request body is consumed in memory and discarded, so a contact who
  is not a Hussh user leaves no trace on any server.
- **Shared with third parties:** no.
- **Purpose:** app functionality (finding people you already know).
- **Optional:** yes. The flow works fully for someone who grants nothing, and the
  onboarding step removes itself when contacts are unavailable.

### Prominent disclosure

Play requires an in-app disclosure **before** the permission prompt, inside the
app rather than only in the listing, and not buried in a menu. Two layers
satisfy it:

1. The One Location onboarding contacts screen renders the privacy line
   (`CONTACTS_PRIVACY_DISCLOSURE`) *above* the button that triggers the OS
   prompt, and the prompt fires on tap rather than on mount.
2. On Android, `HushhContactsPlugin` shows the same statement in a dialog
   (`contacts_disclosure_message`) before every `READ_CONTACTS` request, so the
   People tab, Connect, and voice paths are covered too. It is skipped only when
   the permission is already granted (Capacitor's cached DENIED state can go
   stale after a Settings revoke, so it is not trusted to mean "no prompt").

> Phone numbers are standardized on your device and turned into one-way codes.
> Only those codes and the last four digits are checked for matches. One never
> stores your contacts' names or numbers, and nobody is contacted for you.

Anyone moving that line below the button, making the prompt fire on screen
entry, or requesting `READ_CONTACTS` outside the plugin's disclosure gate breaks
the disclosure requirement. `__tests__/app/delete-account-page.test.tsx` pins
the copy parity and the gate.

## Privacy policy and terms URLs

Use `https://one.hushh.ai/privacy` for the Play privacy policy URL and
`https://one.hushh.ai/terms` for terms. Both are public, static pages rendered
from `hushh-webapp/lib/legal/legal-documents.ts`, the same text the sign-in
sheet shows, and `__tests__/app/legal-pages.test.tsx` pins that they stay public
and linked. Keep the Data safety answers consistent with that text.

## Account deletion (Data safety "Delete account URL")

Use `https://one.hushh.ai/delete-account`. The page is public and static: it
gives the in-app steps (Profile → Delete account) and a request path by email to
`support@hushh.ai` that is acted on only after the requester proves ownership
from the email or phone already on the account. It never deletes anything
itself. Support must own that verification step before this URL is submitted.

### iOS counterpart

`PrivacyInfo.xcprivacy` currently declares `PhoneNumber` and `Name` but **not**
`NSPrivacyCollectedDataTypeContacts`. Whether hashes-only egress counts as
"collecting contacts" is the open question; either add the entry or record the
written decision. `release-ios-appstore.md` already lists the privacy-manifest
reconciliation as publish blocker #1, and this is part of it.
