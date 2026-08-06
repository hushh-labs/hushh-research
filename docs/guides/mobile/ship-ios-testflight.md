# Ship iOS to TestFlight (one click)

Release authority, exact-SHA proof, branch restoration, and terminal monitoring follow the
[canonical Admin release SOP](../../../.codex/skills/repo-operations/references/admin-release-sop.md).
This guide adds TestFlight-specific build and verification detail only.

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One click cuts a Hussh One iOS build from an explicitly selected green `main` SHA, builds the Capacitor app against the
**UAT backend + UAT Firebase**, signs it with **Apple-managed signing via an App Store Connect
API key**, and **uploads it to TestFlight**. No manual "Missing Compliance" click, no public App
Store submission.

- **Workflow:** `.github/workflows/ship-ios-testflight.yml` (`workflow_dispatch`).
- **Skill:** say `ship ios` (see `.claude/skills/ship-ios-testflight/SKILL.md`).
- **Runner:** GitHub-hosted `macos-15` (GCP has no macOS instances; only the *dispatch* is local).
- **Target:** bundle `com.hushh.app`, the repository's current `MARKETING_VERSION`, TestFlight
  internal testers (no Beta App Review), UAT backend + Firebase `hushh-pda-uat`.

### Version Cadence & Closed Pre-Release Trains

1. **Closed Train Rule:** App Store Connect permanently closes a `MARKETING_VERSION` train (e.g. `1.3.6`) once that version is approved and released on the App Store. Apple's upload API rejects any new build targeting a closed train with `Invalid Pre-Release Train. The train version '1.3.6' is closed for new build submissions`.
2. **Version Bump Cadence:** When an App Store release closes a train, bump `MARKETING_VERSION` (Patch increment, e.g., `1.3.6` → `1.3.7`) in `hushh-webapp/ios/App/App.xcodeproj/project.pbxproj` (Debug and Release targets) and land on `main`.
3. **Monotonic Build Numbers:** For an open train (e.g., `1.3.7`), TestFlight iterations increment `CURRENT_PROJECT_VERSION` (`CFBundleVersion`) monotonically (`57`, `58`, `59`...). The build-number resolver (`scripts/ci/resolve-ios-build-number.py`) computes `max(asc_latest, pbxproj_current) + 1`.
4. **Automated Export Compliance Questionnaire:** `ITSAppUsesNonExemptEncryption = false` in `Info.plist` automatically fulfills App Store Connect's encryption questionnaire upon upload. When processing completes (`processingState = VALID`), the build immediately enters `IN_BETA_TESTING` for internal testers with zero manual forms or clicks.

## How it works (what the workflow runs)

```
npm ci --prefix hushh-webapp                    # MUST precede SPM (Package.swift → ../../node_modules)
# materialize UAT NEXT_PUBLIC_* contract + native GoogleService-Info.plist from GCP Secret Manager
NODE_OPTIONS=--max-old-space-size=8192 npm run ios:prepare:uat   # cap:build + cap:sync:ios + verify backend
NEXT_BUILD = max(asc_latest_build(MARKETING_VERSION), pbxproj CURRENT_PROJECT_VERSION) + 1

xcodebuild -resolvePackageDependencies -project ios/App/App.xcodeproj -scheme App -clonedSourcePackagesDirPath …
xcodebuild archive        -allowProvisioningUpdates -authenticationKey{Path,ID,IssuerID} CURRENT_PROJECT_VERSION=$NEXT_BUILD
xcodebuild -exportArchive -exportOptionsPlist ios/ExportOptions/AppStoreConnect.plist  # destination=upload → TestFlight
```

Signing needs no build-setting overrides — `CODE_SIGN_STYLE=Automatic`,
`DEVELOPMENT_TEAM=WVDK9JW99C`, empty `PROVISIONING_PROFILE_SPECIFIER` are already in
`project.pbxproj`. `CURRENT_PROJECT_VERSION` is the only override; `Info.plist` maps
`CFBundleVersion=$(CURRENT_PROJECT_VERSION)`, so the resolved build number bakes in with no
`agvtool`/pbxproj edit. `ITSAppUsesNonExemptEncryption=false` in `Info.plist` is what keeps the
upload out of "Missing Compliance".

## One-time setup (secret-touching — the operator does this)

All signing + Firebase material lives in **GCP Secret Manager**, project **`hushh-pda-uat`** (the
store `deploy/README.md` already designates for native signing assets). Nothing App Store-related
is a GitHub secret. The workflow reads these with the existing `GCP_SA_KEY_UAT` service account.

### 1. App Store Connect API key

App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API** →
generate a **Team key** with role **Admin** (needed: archive creates a dev asset, export a
distribution asset, both via `-allowProvisioningUpdates`). Download the `.p8` **once**; note the
**Key ID** and **Issuer ID**. Then store all three in Secret Manager:

```bash
# .p8 (base64, single line)
base64 -i AuthKey_XXXXXXXXXX.p8 \
  | gcloud secrets create APPSTORE_CONNECT_API_KEY_P8_B64 --data-file=- --project=hushh-pda-uat
printf '%s' 'XXXXXXXXXX' \
  | gcloud secrets create APPSTORE_CONNECT_KEY_ID --data-file=- --project=hushh-pda-uat
printf '%s' '00000000-0000-0000-0000-000000000000' \
  | gcloud secrets create APPSTORE_CONNECT_ISSUER_ID --data-file=- --project=hushh-pda-uat
```

(Use `gcloud secrets versions add <name> --data-file=-` instead of `create` if the reserved
secret already exists.)

### 2. Apple Distribution Certificate (.p12)

To prevent `xcodebuild -allowProvisioningUpdates` from hitting Apple's 30-development-certificate limit on ephemeral GitHub runners, export the team distribution certificate and private key as a base64 `.p12` into Secret Manager:

```bash
security export -k login.keychain-db -t identities -f pkcs12 -o /tmp/dist_cert.p12 -P ""
base64 -i /tmp/dist_cert.p12 | gcloud secrets create APPSTORE_DISTRIBUTION_CERT_P12_B64 --data-file=- --project=hushh-pda-uat
rm -f /tmp/dist_cert.p12
```

The workflow decodes and imports `APPSTORE_DISTRIBUTION_CERT_P12_B64` directly into the runner's isolated keychain before `xcodebuild archive`.

### 3. Native iOS Firebase config

The workflow decodes `IOS_GOOGLESERVICE_INFO_PLIST_B64` into `ios/App/App/GoogleService-Info.plist`
(it does **not** run `sync:native-firebase-configs`, which hard-requires the Android
`google-services.json`). If not already present:

```bash
base64 -i GoogleService-Info.plist \
  | gcloud secrets create IOS_GOOGLESERVICE_INFO_PLIST_B64 --data-file=- --project=hushh-pda-uat
```

### 3. IAM

Ensure the `GCP_SA_KEY_UAT` service account has `roles/secretmanager.secretAccessor` on the
secrets above **and** on the UAT frontend contract (`BACKEND_URL`, `APP_FRONTEND_ORIGIN`, the
`NEXT_PUBLIC_FIREBASE_*` set). No new GitHub secret is required for any of this.

### 4. Apple agreements

Accept any pending Apple **Program License Agreement** in App Store Connect. An unsigned/expired
agreement silently blocks uploads and processing — this is an operator action, not a CI step.

## How to run

### GitHub UI

Actions → **Ship iOS to TestFlight** → **Run workflow** (from `main`). Inputs:

| Input | Meaning |
| --- | --- |
| `sha` | Exact green `main` SHA to ship. Blank → latest `origin/main`. |
| `dry_run` | `true` = archive + sign but **do not** upload (isolates signing). |
| `notes` | Free text shown in the run summary. |

### Skill

Say **`ship ios`** (or "ship to testflight", "cut an ios build"). The skill runs preflight, picks
the green `main` SHA, **pauses for one explicit confirmation**, then dispatches and watches the run.

Only operators in `config/ci-governance.json` → `uat.manual_dispatch_users` can dispatch;
`assert-governed-actor.py --surface uat` enforces the current list. Never transcribe operator
names into this runbook, and never infer production authority from UAT authorization.

## Verify (don't stop at "workflow green")

1. Read the run's job summary: SHA, resolved marketing version and build number, upload vs dry run.
2. For a real run, confirm the resolved version/build appears in **TestFlight** for internal
   testers after Apple finishes processing (a few minutes), already compliant.
3. On device: the TestFlight build boots against **UAT** backend — asserted by
   `verify-ios-bundled-backend.sh` during prep.

Recommended the first time after any signing/secret change: dispatch with `dry_run: true` to prove
the web build, cap sync, SPM resolve, archive, and **signing** all succeed before a real upload.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Missing GCP secret APPSTORE_CONNECT_*` / `IOS_GOOGLESERVICE_INFO_PLIST_B64` | Secret not created or SA lacks `secretAccessor`. See setup above. |
| Export/upload fails with an agreement error | Accept the Apple Program License Agreement in ASC. |
| Cloud-signing authorization error | API key role too low — regenerate as **Admin**. |
| Duplicate build number rejected | `resolve-ios-build-number.py` should prevent it; check its stderr in the archive log artifact. |
| `cap:build` OOM-killed | Bump `runs-on` to `macos-15-xlarge` and `NODE_OPTIONS` to `--max-old-space-size=12288`. |
| Cold SPM graph slow (firebase/grpc/facebook) | Expected ~15–35 min; `timeout-minutes: 40`. The SPM cache warms subsequent runs. |

## Scope / deferred

Public App Store submission is a separate, explicitly authorized milestone. Its durable safety
checklist is the **Publish-safety blockers** section of
[`release-ios-appstore.md`](./release-ios-appstore.md). None of those public-submission steps are
implied by a TestFlight upload.
