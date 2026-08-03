# Release iOS to the App Store (public, one command)

Release authority, exact-SHA proof, branch restoration, and terminal monitoring follow the
[canonical Admin release SOP](../../../.codex/skills/repo-operations/references/admin-release-sop.md).
This guide adds App Store-specific build, submission, and verification detail only.

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One command builds a **public App Store** Hussh One iOS release from an exact green `main` SHA,
wires it to the **UAT backend + UAT Firebase** (`hushh-pda-uat`) — the *same* latest
frontend+backend that is live on UAT and ships to TestFlight — signs it with the **production APNs
entitlement** via Apple-managed signing, uploads it to **App Store Connect**, sets the version's
**"What's New"** text, attaches the build, and (opt-in, one click) **submits it for public Apple
review**. By default it stops *before* the final, irreversible "Submit for App Store Review".

> **Why UAT backend on a public build?** This is a deliberate decision: the App Store binary ships
> the same backend+frontend as UAT/TestFlight, so what reviewers and users get is exactly what was
> tested. The binary is *identical* to the TestFlight binary — only the App Store version +
> submission layer differs.

The build still archives with **production APNs** entitlements (correct for *any* App Store binary —
push on a store build routes through Apple's PRODUCTION APNs). That means the **UAT Firebase project
must hold a production APNs key** for push notifications to deliver on the released app.

For an internal TestFlight build (no review), use the sibling pipeline: `ship-ios-testflight`
(runbook: [ship-ios-testflight.md](./ship-ios-testflight.md)).

- **Command:** `npm run --prefix hushh-webapp ios:release:prod` **or** `make ios-prod-release`.
- **Workflow:** `.github/workflows/release-ios-appstore.yml` (`workflow_dispatch`, `environment: production`).
- **Dispatcher:** `scripts/release/dispatch-ios-appstore.mjs` (resolves SHA, confirms, dispatches, watches).
- **Runner:** GitHub-hosted `macos-15`, Xcode 26.3 — GCP has no macOS instances and local builds
  hang inside iCloud Drive, so only the *dispatch* runs on your machine; the Apple build runs in CI.
- **Target:** bundle `com.hushh.app`, version `1.3.6`, **UAT** backend + Firebase (`hushh-pda-uat`),
  ASC app id `6757718917`.

## The final command

```bash
# Prepare-only (default): build → sign → upload → set What's New → attach build to a MANUAL
# App Store version. Stops before the irreversible public-review submission. SHA = origin/main.
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
# Set the App Store "What's New in This Version" text for this release.
make ios-prod-release ARGS="--whats-new 'Faster onboarding and reliability fixes.'"
```

```bash
# IRREVERSIBLE one-click: also submit the build for public App Store review. On this CLI path it
# requires --ack-blockers too, and only after every publish-safety blocker below is cleared.
make ios-prod-release ARGS="--whats-new 'What changed…' --submit --ack-blockers"
```

The dispatcher prints the workflow, ref, SHA, backend, What's New, and mode, then **pauses for one
explicit confirmation** (`--yes` skips it in trusted automation; a non-TTY shell requires `--yes`).
For a public submit it demands you type `submit`, not just `yes`.

### True one-click from the GitHub UI

**Actions → Release iOS to App Store → Run workflow** (from `main`), inputs:

| Input | Meaning |
| --- | --- |
| `sha` (required) | Exact green `main` SHA to release. |
| `dry_run` | Archive + sign only; no upload, no ASC changes. |
| `whats_new` | "What's New in This Version" (defaults to a generic note). |
| `submit_for_review` | **IRREVERSIBLE.** Upload, set What's New, attach, and **SUBMIT** for public review. Unchecked = stop after attaching the build. |
| `notes` | Free-text note for the run summary. |

Checking `submit_for_review` and running is the true one-click straight-to-review path — no
`ack_publish_blockers` input exists anymore; the single toggle is the switch. (The CLI dispatcher
keeps a local `--ack-blockers` gate purely to prevent an accidental submit from a script.)

## Every step the pipeline performs

The workflow runs these in order and **fails immediately with a clear error** at the first problem
(dispatch origin, actor policy, SHA validity, missing secret, non-UAT backend, signing, archive,
export/upload, or version/build validation):

1. **Assert dispatch origin.** Refuses to run unless triggered from `main`.
2. **Checkout + actor policy.** `assert-governed-actor.py --surface production` — only operators in
   `config/ci-governance.json` → `production.manual_dispatch_users` may dispatch. (Public submission
   is a production surface, so the production actor gate stays even though the binary is UAT-backed.)
3. **Validate the release SHA.** `require-deploy-sha-on-main.sh` confirms the SHA is on `main` and
   passed the required check (`Main Post-Merge Smoke Gate`), then checks it out detached.
4. **Toolchain.** Xcode 26.3; Node 22; `npm ci --prefix hushh-webapp` — this must precede any Swift
   Package step because `CapApp-SPM/Package.swift` resolves its dependencies from the hoisted
   `node_modules` three directory levels up.
5. **Authenticate to Google Cloud** with the `GCP_SA_KEY_UAT` service-account key (the same secret
   the TestFlight pipeline uses), then assert the active project is exactly `hushh-pda-uat`.
6. **Materialize the UAT web contract + native Firebase config.** Reads each `NEXT_PUBLIC_*` value
   and the native `GoogleService-Info.plist` from `hushh-pda-uat` Secret Manager; sets
   `APP_RUNTIME_PROFILE=uat`, `NEXT_PUBLIC_APP_ENV=uat`, `NEXT_PUBLIC_BACKEND_URL=<UAT backend>`,
   `NEXT_PUBLIC_APP_URL=https://uat.one.hushh.ai`, `NEXT_PUBLIC_PASSKEY_RP_ID=one.hushh.ai`.
   **Refuses to continue unless the backend host is the UAT host** (`*uat*` / the UAT Cloud Run id) —
   belt-and-braces on top of the guard inside `prepare-ios-uat-archive.mjs`, so a mis-scoped project
   or a prod/localhost URL can never sneak into a store build.
7. **Decode the App Store Connect API key** (`.p8` + Key ID + Issuer ID) from `hushh-pda-uat` Secret
   Manager into a `chmod 600` temp file; validates it is a real PEM; masks the identifiers.
8. **Create + unlock a dedicated signing keychain** (Apple-managed cloud signing needs one).
9. **Prepare the iOS project against UAT.** `ios:prepare:uat` runs `cap:build` + `cap:sync:ios` and
   asserts the bundled backend host is the UAT host.
10. **Resolve the next build number.** `resolve-ios-build-number.py` mints an ES256 JWT and returns
    `max(latest ASC build for 1.3.6, pbxproj CURRENT_PROJECT_VERSION) + 1` — monotonic against both
    App Store history and the committed value. (TestFlight and the App Store share one build-number
    pool per marketing version.)
11. **Resolve Swift packages** (cached), then **archive** in Release with the **production APNs
    entitlement override** `CODE_SIGN_ENTITLEMENTS=App/AppRelease.entitlements` (flips
    `aps-environment` development → production for the released binary only; the committed pbxproj
    stays on `App/App.entitlements`, so local/dev builds are unaffected). Signs with
    `-allowProvisioningUpdates` + the ASC API key; injects the resolved `CURRENT_PROJECT_VERSION`.
12. **Export + upload to App Store Connect** via `ios/ExportOptions/AppStoreConnect.plist`
    (`destination=upload`). On `--dry-run`, PlistBuddy rewrites `destination` to `export` so the
    step signs and produces the `.ipa` without uploading.
13. **Prepare the App Store version (set What's New, attach build, one-click submit).**
    `submit-appstore-version.py` finds/creates an **editable App Store version with
    `releaseType=MANUAL`** (so it never auto-releases to the public), **sets the version's
    `whatsNew`** localization from `--whats-new` (Apple requires this per version — an empty field is
    what blocks "Add for Review"), waits for the uploaded build to reach `processingState=VALID`, and
    **attaches** it. It is skipped entirely on `--dry-run`. When `submit_for_review=true`, it also
    creates/reuses a review submission, adds this version, and marks it submitted (**irreversible**).
14. **Upload artifacts + job summary.** `.ipa`, dSYMs, and `xcodebuild` logs are archived; the
    summary reports SHA, version, build number, backend (`UAT (hushh-pda-uat)`), and mode.

## Required secrets and permissions

> **You (the operator) add every secret yourself.** These instructions never ask anyone else to
> paste a `.p8`, key, certificate, or token. All secrets live in **GCP Secret Manager, project
> `hushh-pda-uat`**; the only GitHub secret involved is `GCP_SA_KEY_UAT` (already present).

### GCP Secret Manager (`hushh-pda-uat`)

| Secret | Purpose |
| --- | --- |
| `APPSTORE_CONNECT_API_KEY_P8_B64` | Base64 of the ASC API key `.p8` (role **Admin** — App Manager cannot mint cloud distribution assets). |
| `APPSTORE_CONNECT_KEY_ID` | ASC API Key ID. |
| `APPSTORE_CONNECT_ISSUER_ID` | ASC API Issuer ID. |
| `IOS_GOOGLESERVICE_INFO_PLIST_B64` | Base64 of the **UAT** iOS `GoogleService-Info.plist`. |
| `BACKEND_URL` | UAT backend origin (the `*uat*` / UAT Cloud Run host). |
| `APP_FRONTEND_ORIGIN` | UAT app origin (`https://uat.one.hushh.ai`). |
| `NEXT_PUBLIC_FIREBASE_API_KEY` … `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | UAT Firebase web contract (see the workflow's `require` list). |

Create each once (use `versions add` instead of `create` if it already exists):

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 \
  | gcloud secrets create APPSTORE_CONNECT_API_KEY_P8_B64 --data-file=- --project=hushh-pda-uat
printf '%s' 'XXXXXXXXXX'   | gcloud secrets create APPSTORE_CONNECT_KEY_ID    --data-file=- --project=hushh-pda-uat
printf '%s' '00000000-0000-0000-0000-000000000000' \
  | gcloud secrets create APPSTORE_CONNECT_ISSUER_ID --data-file=- --project=hushh-pda-uat
base64 -i GoogleService-Info.plist \
  | gcloud secrets create IOS_GOOGLESERVICE_INFO_PLIST_B64 --data-file=- --project=hushh-pda-uat
```

### GitHub secret

`GCP_SA_KEY_UAT` — a service-account JSON key with `secretAccessor` on the secrets above, in
`hushh-pda-uat`. It is a repository-level secret inherited by the `production` environment (same key
the TestFlight pipeline uses). No Workload Identity Federation and no GCP JSON key is needed on the
prod side anymore.

### IAM precondition

The `GCP_SA_KEY_UAT` service account must hold `roles/secretmanager.secretAccessor` on **every**
secret above, in `hushh-pda-uat`. Missing access surfaces as a `Missing GCP secret …` failure in the
materialize/decode steps.

### Actor authorization

`config/ci-governance.json` → `production.manual_dispatch_users` is the sole current actor
allowlist. Never transcribe operator names into this runbook; the workflow enforces the live policy.

### Apple account

Accept any pending Apple **Program License Agreement** in App Store Connect. An unsigned/expired
agreement silently blocks uploads and processing. This is an operator action, never a CI step, and
the password is never entered by tooling.

## What Apple does not let us automate

The pipeline automates build → sign → archive → validate → upload → **set What's New** → attach →
(optional) submit. Everything below must be set up **once in App Store Connect by a human** and is
**stable across versions** — per the product decision, screenshots and metadata do not change for
~2 months, so they only need doing when they actually change, not per release:

- Store **metadata**: name, subtitle, description, keywords, promotional text, support/marketing URLs.
- **Screenshots** and app previews for every required device class.
- **App Privacy** "nutrition labels" (the ASC questionnaire — distinct from the in-bundle
  `PrivacyInfo.xcprivacy`; both must agree).
- **Age rating** questionnaire.
- **Pricing and availability**.
- Accepting Apple **agreements** (above).

The one genuinely per-version field, **"What's New in This Version,"** *is* automated by this
pipeline via `--whats-new` / the `whats_new` input. Submitting with incomplete/incorrect metadata
will draw an Apple rejection, so treat the one-time human metadata pass as a prerequisite for
`--submit`.

## Publish-safety blockers (preconditions for `submit_for_review`)

A public submission is irreversible and exposes real users. Before submitting, clear this durable
publish-safety checklist. External working notes may add evidence but cannot replace or waive these
committed requirements. The non-negotiable items are:

1. **`PrivacyInfo.xcprivacy` reconciliation.** `hushh-webapp/ios/App/App/PrivacyInfo.xcprivacy` in
   this branch is a best-effort declaration (collected data types, tracking=false, required-reason
   APIs). A human must reconcile it against the app's *actual* data flows **and** the ASC privacy
   nutrition labels before submission. This is publish blocker #1.
2. **Android analytics / `AD_ID`, ZK truth-in-advertising, and managed-Gemini / Gmail-sweep
   consent** items from the audit (these gate a truthful store listing).
3. App Store metadata, screenshots, age rating, pricing/availability, agreements, release notes,
   support/privacy URLs, and the exact submitted build have each been reviewed against the live
   product and current legal/privacy claims.

Prepare-only mode (the default) requires none of this — it is safe to run repeatedly to stage a
build, set its release notes, and attach it for review.

## Verify (don't stop at "workflow green")

1. Read the run's **job summary**: SHA, version `1.3.6`, resolved build number, backend
   `UAT (hushh-pda-uat)`, and mode.
2. **First run after any signing/secret change:** dispatch with `--dry-run` to prove web build,
   cap sync, SPM resolve, **archive, and signing** all succeed before any upload.
3. For a real prepare-only run: confirm in App Store Connect that version `1.3.6` shows the new
   build attached, "What's New" populated, release type **Manual**, state still editable (not
   submitted).
4. For a submit run: confirm the review submission appears in ASC and its state moves to
   `WAITING_FOR_REVIEW` / `IN_REVIEW`.
5. On device (optional): a TestFlight copy of the same archive boots against the **UAT** backend.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Missing GCP secret …` | Secret absent in `hushh-pda-uat`, or the `GCP_SA_KEY_UAT` SA lacks `secretAccessor`. See setup. |
| `must ship the UAT backend, but … resolves to '<host>'` | `BACKEND_URL` in `hushh-pda-uat` points at a non-UAT host. Fix the secret. |
| `Cloud signing permission error` / `No signing certificate "iOS Distribution"` | ASC API key role too low — regenerate as **Admin** (App Manager cannot mint cloud distribution assets). |
| `Invalid Pre-Release Train … is closed` / `must contain a higher version` | The marketing version is approved/closed. Bump `MARKETING_VERSION` (App target Debug+Release), land on `main`, re-release. A `--dry-run` will NOT catch this. |
| `This field is required` on Add for Review | Empty "What's New". Re-run with `--whats-new "…"`; the pipeline now sets it automatically. |
| Export/upload agreement error | Accept the Apple Program License Agreement in App Store Connect. |
| Duplicate build number rejected | The ASC builds API lags a just-uploaded build; re-run so the resolver sees the sibling and picks N+1. |
| Build stuck `PROCESSING` past the timeout | Apple-side processing delay; re-run prepare-only once the build shows in ASC. |
| dSYM "Upload Symbols Failed" (Firebase/Google frameworks) | Non-fatal warnings; they do not fail the upload. |
