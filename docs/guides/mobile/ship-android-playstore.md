# Ship Android to Google Play Store (one click)

Release authority, exact-SHA proof, branch restoration, and terminal monitoring follow the
[canonical Admin release SOP](../../../.codex/skills/repo-operations/references/admin-release-sop.md).
This guide adds Android Play Store-specific build and verification detail only.

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One click cuts a Hussh One Android App Bundle (`.aab`) from an explicitly selected green `main` SHA,
builds the Capacitor app against the **UAT backend + shared Firebase authority**, signs it with the
**Android Release Upload Keystore**, and **uploads it to Google Play Console** (internal, alpha,
beta, or production track).

- **Workflow:** `.github/workflows/ship-android-playstore.yml` (`workflow_dispatch`).
- **CLI Dispatcher:** `node scripts/release/dispatch-android-playstore.mjs` (or `npm run android:release:playstore`).
- **Runner:** GitHub-hosted `ubuntu-latest`.
- **Target:** package `com.hussh.app` (Android only — iOS remains `com.hushh.app`), Google Play Console internal track (default), UAT backend + Firebase project `hushh-pda` (the Android Firebase config secret lives in `hushh-pda-uat` Secret Manager but its *content* is the `hushh-pda` project — there is one shared Firebase project across environments, not a separate UAT Firebase project).

## Version Cadence & Monotonic versionCode

1. **Monotonic Version Code:** Google Play Console requires every uploaded `.aab` to have a `versionCode` strictly greater than any previously uploaded build.
2. **Automated Version Resolution:** The resolver `scripts/ci/resolve-android-build-number.py` queries the Google Play Developer API (or local `build.gradle`), finds the highest existing `versionCode`, and increments it by 1 automatically (`max(play_latest, gradle_current) + 1`).
3. **Marketing VersionName:** Set `versionName "1.x.y"` in `hushh-webapp/android/app/build.gradle` to match the current marketing release.

## How it works (what the workflow runs)

```bash
cd hushh-webapp
npm ci
npm run sync:native-firebase-configs
npm run cap:build
npm run cap:sync:android
cd android && ./gradlew bundleRelease
```

Signing reads from `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` supplied by Secret Manager / GitHub secrets.

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
npm run android:release:playstore                  # target internal track
npm run android:release:playstore -- --track alpha # target alpha track
npm run android:release:playstore -- --dry-run     # build & sign only, no upload
```

### Option B: GitHub Actions UI

1. Open repository on GitHub $\rightarrow$ **Actions** $\rightarrow$ **Ship Android to Google Play Store**.
2. Click **Run workflow** $\rightarrow$ select track (`internal`, `alpha`, `beta`, `production`) $\rightarrow$ Click **Run workflow**.

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
app rather than only in the listing, and not buried in a menu. The One Location
onboarding contacts screen already satisfies this — the privacy line renders
*above* the button that triggers the OS prompt, and the prompt fires on tap
rather than on mount:

> Your contacts are checked using a one-way hash. One never stores your contact
> list, and nobody is contacted for you.

Anyone moving that line below the button, or making the prompt fire on screen
entry, breaks the disclosure requirement as well as the UX intent.

### iOS counterpart

`PrivacyInfo.xcprivacy` currently declares `PhoneNumber` and `Name` but **not**
`NSPrivacyCollectedDataTypeContacts`. Whether hashes-only egress counts as
"collecting contacts" is the open question; either add the entry or record the
written decision. `release-ios-appstore.md` already lists the privacy-manifest
reconciliation as publish blocker #1, and this is part of it.
