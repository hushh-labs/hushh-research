# Release iOS to the App Store (production, one command)

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One command builds a **production** Hussh One iOS release from an exact green `main` SHA, wires it
to the **production backend + production Firebase** (`hushh-pda`), signs it with the **production
APNs entitlement** via Apple-managed signing, uploads it to **App Store Connect**, and then
completes every automatable App Store step **up to — but not including — the final, irreversible
"Submit for App Store Review" action** (which stays behind an explicit double opt-in).

This is **not** a TestFlight-only command. TestFlight and the App Store share the same
archive/export/upload; the difference lives entirely in the App Store version + submission layer
this pipeline drives. For an internal TestFlight build against UAT, use the sibling pipeline
instead: `ship-ios-testflight` (runbook: [ship-ios-testflight.md](./ship-ios-testflight.md)).

- **Command:** `npm run --prefix hushh-webapp ios:release:prod` **or** `make ios-prod-release`.
- **Workflow:** `.github/workflows/release-ios-appstore.yml` (`workflow_dispatch`, `environment: production`).
- **Dispatcher:** `scripts/release/dispatch-ios-appstore.mjs` (resolves SHA, confirms, dispatches, watches).
- **Runner:** GitHub-hosted `macos-15` — GCP has no macOS instances and local builds hang inside
  iCloud Drive, so only the *dispatch* runs on your machine; the Apple build runs in CI.
- **Target:** bundle `com.hushh.app`, version `1.3.5`, production backend `https://api.hushh.ai`,
  Firebase project `hushh-pda`.

## The final command

```bash
# Prepare-only (default): build → sign → upload → attach build to a MANUAL App Store
# version. Stops before the irreversible public-review submission. SHA = origin/main.
make ios-prod-release
# equivalently:
npm run --prefix hushh-webapp ios:release:prod
```

```bash
# Isolate signing: archive + sign on the runner, NO upload, NO App Store Connect changes.
make ios-prod-release ARGS="--dry-run"
```

```bash
# Pin an explicit green SHA instead of origin/main.
make ios-prod-release ARGS="--sha 1a2b3c4d"
```

```bash
# IRREVERSIBLE: also submit the build for public App Store review. Requires BOTH flags,
# and only after every publish-safety blocker below is cleared.
make ios-prod-release ARGS="--submit --ack-blockers"
```

The dispatcher prints the workflow, ref, SHA, backend, and mode, then **pauses for one explicit
confirmation** (`--yes` skips it in trusted automation; a non-TTY shell requires `--yes`). For a
public submit it demands you type `submit`, not just `yes`.

You can also dispatch from the GitHub UI: **Actions → Release iOS to App Store → Run workflow**
(from `main`), with inputs `sha` (required), `dry_run`, `submit_for_review`, `ack_publish_blockers`,
`notes`.

## Every step the pipeline performs

The workflow runs these in order and **fails immediately with a clear error** at the first problem
(dispatch origin, actor policy, SHA validity, WIF config, missing secret, non-production backend,
signing, archive, export/upload, or version/build validation):

1. **Assert dispatch origin.** Refuses to run unless triggered from `main`.
2. **Checkout + actor policy.** `assert-governed-actor.py --surface production` — only operators in
   `config/ci-governance.json` → `production.manual_dispatch_users` may dispatch.
3. **Validate the release SHA.** `require-deploy-sha-on-main.sh` confirms the SHA is on `main` and
   passed the required check (`Main Post-Merge Smoke Gate`), then checks it out detached.
4. **Validate WIF config.** Fails fast if the `GCP_WORKLOAD_IDENTITY_PROVIDER` /
   `GCP_DEPLOY_SERVICE_ACCOUNT` repository variables are missing.
5. **Toolchain.** Xcode 16.2; Node 22; `npm ci --prefix hushh-webapp` — this must precede any Swift
   Package step because `CapApp-SPM/Package.swift` resolves its dependencies from the hoisted
   `node_modules` three directory levels up.
6. **Authenticate to Google Cloud via Workload Identity Federation** (no JSON key), then assert the
   active project is exactly `hushh-pda`.
7. **Materialize the production web contract + native Firebase config.** Reads each
   `NEXT_PUBLIC_*` value and the native `GoogleService-Info.plist` from `hushh-pda` Secret Manager;
   sets `APP_RUNTIME_PROFILE=prod`, `NEXT_PUBLIC_APP_ENV=production`,
   `NEXT_PUBLIC_BACKEND_URL=https://api.hushh.ai`, `NEXT_PUBLIC_APP_URL=https://one.hushh.ai`,
   `NEXT_PUBLIC_PASSKEY_RP_ID=one.hushh.ai`. **Refuses to continue on a UAT or localhost backend**
   (belt-and-braces on top of the guard inside `prepare-ios-prod-archive.mjs`).
8. **Decode the App Store Connect API key** (`.p8` + Key ID + Issuer ID) from `hushh-pda` Secret
   Manager into a `chmod 600` temp file; validates it is a real PEM; masks the identifiers.
9. **Create + unlock a dedicated signing keychain** (Apple-managed cloud signing needs one).
10. **Prepare the iOS project against production.** `ios:prepare:prod` runs `cap:build` +
    `cap:sync:ios` and asserts the bundled backend host is the production host.
11. **Resolve the next build number.** `resolve-ios-build-number.py` mints an ES256 JWT and returns
    `max(latest ASC build for 1.3.5, pbxproj CURRENT_PROJECT_VERSION) + 1` — monotonic against both
    App Store history and the committed value.
12. **Resolve Swift packages** (cached), then **archive** in Release with the **production
    entitlement override** `CODE_SIGN_ENTITLEMENTS=App/AppRelease.entitlements` (flips
    `aps-environment` development → production for the released binary only; the committed pbxproj
    stays on `App/App.entitlements`, so local/dev/TestFlight builds are unaffected). Signs with
    `-allowProvisioningUpdates` + the ASC API key; injects the resolved `CURRENT_PROJECT_VERSION`.
13. **Export + upload to App Store Connect** via `ios/ExportOptions/AppStoreConnect.plist`
    (`destination=upload`). On `--dry-run`, PlistBuddy rewrites `destination` to `export` so the
    step signs and produces the `.ipa` without uploading.
14. **Prepare the App Store version (gated submit).** `submit-appstore-version.py` finds/creates an
    **editable App Store version with `releaseType=MANUAL`** (so it never auto-releases to the
    public), waits for the uploaded build to reach `processingState=VALID`, and **attaches** it.
    This is the last automatable step before Apple review. It is skipped entirely on `--dry-run`.
    Only when **both** `submit_for_review=true` **and** `ack_publish_blockers=true` does it add
    `--submit`, which creates a review submission and marks it submitted (**irreversible**).
15. **Upload artifacts + job summary.** `.ipa`, dSYMs, and `xcodebuild` logs are archived; the
    summary reports SHA, version, build number, backend, and mode.

## Required secrets and permissions

> **You (the operator) add every secret yourself.** These instructions never ask anyone else to
> paste a `.p8`, key, certificate, or token. All secrets live in **GCP Secret Manager, project
> `hushh-pda`** (production); nothing App Store-related is a GitHub secret.

### GCP Secret Manager (`hushh-pda`)

| Secret | Purpose |
| --- | --- |
| `APPSTORE_CONNECT_API_KEY_P8_B64` | Base64 of the ASC API key `.p8` (role **App Manager**). |
| `APPSTORE_CONNECT_KEY_ID` | ASC API Key ID. |
| `APPSTORE_CONNECT_ISSUER_ID` | ASC API Issuer ID. |
| `IOS_GOOGLESERVICE_INFO_PLIST_B64` | Base64 of the **production** iOS `GoogleService-Info.plist`. |
| `BACKEND_URL` | Production backend origin (`https://api.hushh.ai`). |
| `APP_FRONTEND_ORIGIN` | Production app origin (`https://one.hushh.ai`). |
| `NEXT_PUBLIC_FIREBASE_API_KEY` … `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | Production Firebase web contract (see the workflow's `require` list). |

Create each once (use `versions add` instead of `create` if it already exists):

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 \
  | gcloud secrets create APPSTORE_CONNECT_API_KEY_P8_B64 --data-file=- --project=hushh-pda
printf '%s' 'XXXXXXXXXX'   | gcloud secrets create APPSTORE_CONNECT_KEY_ID    --data-file=- --project=hushh-pda
printf '%s' '00000000-0000-0000-0000-000000000000' \
  | gcloud secrets create APPSTORE_CONNECT_ISSUER_ID --data-file=- --project=hushh-pda
base64 -i GoogleService-Info.plist \
  | gcloud secrets create IOS_GOOGLESERVICE_INFO_PLIST_B64 --data-file=- --project=hushh-pda
```

### GitHub repository variables (production environment)

`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_DEPLOY_SERVICE_ACCOUNT` — the same WIF pair
`deploy-production.yml` uses. No GCP JSON key is involved.

### IAM precondition

The deploy service account (`GCP_DEPLOY_SERVICE_ACCOUNT`) must hold
`roles/secretmanager.secretAccessor` on **every** secret above, in `hushh-pda`. Missing access
surfaces as a `Missing GCP secret …` failure in the materialize/decode steps.

### Actor authorization

`config/ci-governance.json` → `production.manual_dispatch_users` currently authorizes
`kushaltrivedi5` and `ankitkumarsingh1702` for production dispatch.

### Apple account

Accept any pending Apple **Program License Agreement** in App Store Connect. An unsigned/expired
agreement silently blocks uploads and processing. This is an operator action, never a CI step, and
the password is never entered by tooling.

## What Apple does not let us automate

The pipeline automates build → sign → archive → validate → upload → attach → (optional) submit. The
following must be done **once per version in App Store Connect by a human** and are **not**
automatable through this pipeline:

- Store **metadata**: name, subtitle, description, keywords, promotional text, support/marketing URLs.
- **Screenshots** and app previews for every required device class.
- **App Privacy** "nutrition labels" (the ASC questionnaire — distinct from the in-bundle
  `PrivacyInfo.xcprivacy`; both must agree).
- **Age rating** questionnaire.
- **Pricing and availability**.
- **Export-compliance** beyond the bundled `ITSAppUsesNonExemptEncryption=false` attestation, if
  the app ever adds non-exempt cryptography.
- Accepting Apple **agreements** (above).
- The **final human review** of all of the above. `--submit` can programmatically press "Submit for
  Review", but doing so with incomplete/incorrect metadata will draw an Apple rejection — so treat
  the human metadata pass as a hard prerequisite for `--submit`.

## Publish-safety blockers (preconditions for `--submit`)

`--submit` is deliberately double-gated (`--submit --ack-blockers`, and the workflow re-checks
`ack_publish_blockers`) because a public submission is irreversible and exposes real users. Before
setting those flags, clear the full publish-safety audit — summarized in
`KT/hushh-one-publish-safety-audit.md` (~17 items; that file may live outside this branch). The
non-negotiable ones:

1. **`PrivacyInfo.xcprivacy` reconciliation.** `hushh-webapp/ios/App/App/PrivacyInfo.xcprivacy` in
   this branch is a best-effort declaration (collected data types, tracking=false, required-reason
   APIs). A human must reconcile it against the app's *actual* data flows **and** the ASC privacy
   nutrition labels before submission. This is publish blocker #1.
2. **Android analytics / `AD_ID`, ZK truth-in-advertising, and managed-Gemini / Gmail-sweep
   consent** items from the audit (these gate a truthful store listing).
3. Everything else enumerated in the audit.

Prepare-only mode (the default) requires none of this — it is safe to run repeatedly to stage a
build for review.

## Verify (don't stop at "workflow green")

1. Read the run's **job summary**: SHA, version `1.3.5`, resolved build number, backend
   `PRODUCTION (hushh-pda)`, and mode.
2. **First run after any signing/secret change:** dispatch with `--dry-run` to prove web build,
   cap sync, SPM resolve, **archive, and signing** all succeed before any upload.
3. For a real prepare-only run: confirm in App Store Connect that version `1.3.5` shows the new
   build attached, release type **Manual**, state still editable (not submitted).
4. On device (optional): a TestFlight copy of the same archive boots against the production backend.

## Verification status of this pipeline (honest boundary)

What has been verified statically and offline in this branch:

- The dispatcher parses (`node --check`), its `--help` and arg-gating work, and `--submit` without
  `--ack-blockers` **fails fast** (exit 1).
- `submit-appstore-version.py` compiles and its offline `--self-test` passes (JWT mint/verify +
  argument parsing, no network, no real key).
- `resolve-ios-build-number.py`, the ExportOptions plist, `AppRelease.entitlements`, and the
  `PrivacyInfo.xcprivacy` pbxproj wiring all lint clean.
- The workflow reuses the exact governance gates and the proven archive/export/upload path from the
  green TestFlight pipeline, adding only the production project, WIF auth, the production entitlement
  override, and the version/submit layer.

What has **not** been executed here, and why:

- A **live archive/upload/submission** cannot run on this machine (no non-iCloud macOS build host
  wired for CI locally) and must run on the `macos-15` runner with the operator's secrets in place.
- **No public App Store submission has been performed.** `--submit` is off by default and was never
  fired. The final review submission — and all the human ASC steps above — remain the operator's
  explicit, gated actions.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Missing GCP secret …` | Secret absent in `hushh-pda`, or the deploy SA lacks `secretAccessor`. See setup. |
| `resolves to non-production host` | `BACKEND_URL` points at UAT/localhost. Fix the production secret. |
| `requires App Manager` / authz error | ASC API key role too low — regenerate as **App Manager**. |
| Export/upload agreement error | Accept the Apple Program License Agreement in App Store Connect. |
| Duplicate build number rejected | Check `resolve-ios-build-number.py` stderr in the archive log artifact. |
| Build stuck `PROCESSING` past the timeout | Apple-side processing delay; re-run prepare-only once the build shows in ASC. |
| `submit_for_review=true requires ack_publish_blockers=true` | Intentional gate. Clear the blockers, then pass both. |
