# Ship Android to Google Play Store (one click)

Release authority, exact-SHA proof, branch restoration, and terminal monitoring follow the
[canonical Admin release SOP](../../../.codex/skills/repo-operations/references/admin-release-sop.md).
This guide adds Android Play Store-specific build and verification detail only.

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One click cuts a Hussh One Android App Bundle (`.aab`) from an explicitly selected green `main` SHA,
builds the Capacitor app against the **UAT backend + UAT Firebase**, signs it with the
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
