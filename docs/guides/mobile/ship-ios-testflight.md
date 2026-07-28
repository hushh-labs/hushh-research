# Ship iOS to TestFlight (one click)

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One click cuts a Hushh One iOS build from **whatever is live on UAT** (the latest green `main`
SHA — the same source `deploy .uat` ships to the website), builds the Capacitor app against the
**UAT backend + UAT Firebase**, signs it with **Apple-managed signing via an App Store Connect
API key**, and **uploads it to TestFlight**. No manual "Missing Compliance" click, no public App
Store submission.

- **Workflow:** `.github/workflows/ship-ios-testflight.yml` (`workflow_dispatch`).
- **Skill:** say `ship ios` (see `.claude/skills/ship-ios-testflight/SKILL.md`).
- **Runner:** GitHub-hosted `macos-15` (GCP has no macOS instances; only the *dispatch* is local).
- **Target:** bundle `com.hushh.app`, version `1.3.5`, TestFlight internal testers (no Beta App
  Review), UAT backend + Firebase `hushh-pda-uat`.

This does **not** ship the `mobile`-branch iOS redesign (that never merges to `main`), does not
touch prod backend/Firebase, and does not submit for App Store review.

## How it works (what the workflow runs)

```
npm ci --prefix hushh-webapp                    # MUST precede SPM (Package.swift → ../../node_modules)
# materialize UAT NEXT_PUBLIC_* contract + native GoogleService-Info.plist from GCP Secret Manager
NODE_OPTIONS=--max-old-space-size=8192 npm run ios:prepare:uat   # cap:build + cap:sync:ios + verify backend
NEXT_BUILD = max(asc_latest_build(1.3.5), pbxproj CURRENT_PROJECT_VERSION) + 1

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
generate a **Team key** with role **App Manager** (needed: archive creates a dev asset, export a
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

### 2. Native iOS Firebase config

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
`assert-governed-actor.py --surface uat` enforces it. This operator (`ankitkumarsingh1702`) can
dispatch UAT/iOS, **not** production.

## Verify (don't stop at "workflow green")

1. Read the run's job summary: SHA, version `1.3.5`, resolved build number, upload vs dry run.
2. For a real run, confirm the build appears in **TestFlight → 1.3.5 (build N)** for internal
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
| `... requires App Manager` / authz error | API key role too low — regenerate as **App Manager**. |
| Duplicate build number rejected | `resolve-ios-build-number.py` should prevent it; check its stderr in the archive log artifact. |
| `cap:build` OOM-killed | Bump `runs-on` to `macos-15-xlarge` and `NODE_OPTIONS` to `--max-old-space-size=12288`. |
| Cold SPM graph slow (firebase/grpc/facebook) | Expected ~15–35 min; `timeout-minutes: 40`. The SPM cache warms subsequent runs. |

## Scope / deferred

Public App Store submission is a separate, larger milestone (privacy manifest, `aps-environment`
production, prod GA4, store metadata/screenshots) — see `KT/hushh-one-publish-safety-audit.md`.
None of those block a TestFlight upload.
