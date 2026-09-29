# Release iOS to the App Store (public, one command)

Release authority, exact-SHA proof, branch restoration, and terminal monitoring follow the
[canonical Admin release SOP](../../../.codex/skills/repo-operations/references/admin-release-sop.md).
This guide adds App Store-specific build, submission, and verification detail only.

## Visual Context

Canonical visual owner: [Mobile Guide](../mobile.md).

## What this is

One command builds a **public App Store** Hussh One iOS release from an exact green `main` SHA,
wires it to the **UAT backend + shared Firebase authority** (`hushh-pda`; its config is stored in
`hushh-pda-uat` Secret Manager) — the *same* latest
frontend+backend that is live on UAT and ships to TestFlight — signs it with the **production APNs
entitlement** via Apple-managed signing, uploads it to **App Store Connect**, sets the version's
**"What's New"** text, attaches the build, and (opt-in, one click) **submits it for public Apple
review**. By default it stops *before* the final, irreversible "Submit for App Store Review".

> **Why UAT backend on a public build?** This is a deliberate decision: the App Store binary ships
> the same backend+frontend as UAT/TestFlight, so what reviewers and users get is exactly what was
> tested. The binary is *identical* to the TestFlight binary — only the App Store version +
> submission layer differs.

### Backend target (`backend_target`, added 2026-09-29)

The workflow input `backend_target` (dispatcher flag `--backend`) chooses the backend the binary
talks to. `uat` is the default and is everything described above. `production` builds a binary
for `https://one.hushh.ai` and the production API:

- The production workload identity (`environment: production`, from `main`) reads only the
  routing values from `hushh-pda`: `BACKEND_URL`, `APP_FRONTEND_ORIGIN`,
  `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` (the production
  analytics stream). It also reads `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and
  `NEXT_PUBLIC_FIREBASE_APP_ID`, only to compare them.
- Everything else (ASC key, distribution certificate, `GoogleService-Info.plist`, Firebase web
  identity, Maps keys) still comes from `hushh-pda-uat`, as before. That is valid because both
  projects point at the one shared Firebase app, and the run **refuses** if the two projects'
  Firebase project id or app id differ.
- The run refuses if the production `BACKEND_URL` resolves to a UAT or loopback host, and the
  project is prepared with `ios:prepare:prod`. That ends in `verify-ios-bundled-backend.sh`, which
  requires every native plugin's `backendUrl` to equal the production backend.
- **User impact:** a person's vault and records live in the database of the backend their binary
  talks to. A person who used a UAT-backed App Store build and updates to a production-backed one
  signs in with the same Firebase identity, but reaches the production database. Treat the first
  production-backed release as a decision about those people's information, not only a build flag.
- **TestFlight for the same binary:** every non-dry run also uploads a `testflight-upload-receipt`
  artifact. `gh workflow run resume-ios-testflight.yml --ref main -f upload_run_id=<App Store run id>`
  then distributes that exact build to the internal and external TestFlight groups.
  `ship-ios-testflight.yml` still builds a UAT binary only; do not run it for a
  production-backed release, or testers alternate between two databases.

### App Review sign-in on a production-backed build (added 2026-09-29)

A production-backed binary shows **no reviewer affordance**: production never advertises review
mode and never mints a review session, and a production frontend build never asks
(`consent-protocol/docs/app-review-mode-config.md` § *Production: backend-only review*). Apple
signs in like anyone else, with a dedicated reviewer account.

**One-time setup (a person, not automation).** Google or Apple sign-in and the on-device vault
cannot be completed from a script, so the founder does this once:

1. Create a dedicated Google account that Hussh owns, preferably a Google Workspace user under
   `hushh.ai` with 2-Step Verification not enforced for that user, so Apple's review devices
   are not challenged. Never use a personal account.
2. Generate the vault passphrase straight into production Secret Manager, never on screen:
   `python3 -c 'import secrets; print(secrets.token_urlsafe(24), end="")' | gcloud secrets create REVIEWER_VAULT_PASSPHRASE --project=hushh-pda --replication-policy=automatic --data-file=-`
3. On an iPhone running the production-backed build, sign in with that Google account. At the
   phone step, enter one unused number from `HUSHH_PROD_PHONE_TEST_NUMBERS` and the fixed code
   `HUSHH_PROD_PHONE_TEST_CODE` (no SMS is sent). Create the vault with the passphrase (copy it
   with `gcloud secrets versions access latest --secret=REVIEWER_VAULT_PASSPHRASE --project=hushh-pda | pbcopy`
   and paste over Universal Clipboard), then finish onboarding.
4. Point `REVIEWER_UID` in `hushh-pda` at the new account (look the UID up by the account's
   email with Identity Toolkit `accounts:lookup`, and pipe it into
   `gcloud secrets versions add REVIEWER_UID --project=hushh-pda --data-file=-`).
5. Never configure this UID as `REVIEWER_UID` in UAT or dev. UAT and production share the
   Firebase authority, and UAT mints review sessions with no credential.

**App Store Connect → App Review Information** (entered by hand once; it carries forward to new
versions, and this pipeline does not set it):

- *Sign-in required*: the reviewer Google account's email and password.
- *Notes*: "Sign in with **Continue with Google** using the account above. When the app asks
  for your vault passphrase, enter: `<REVIEWER_VAULT_PASSPHRASE>`. If the app asks you to verify a
  phone number, enter `<the claimed test number>` and code `<HUSHH_PROD_PHONE_TEST_CODE>`; no SMS
  is sent." Fill the placeholders from `hushh-pda` Secret Manager at entry time; never commit or
  paste the values anywhere else.

**iPhone device gate (release journeys).** The journeys section (`HUSHH_PERF_ATTACHED_SECTION=journeys`)
runs on the session already in the app's data container and unlocks the vault with
`REVIEWER_VAULT_PASSPHRASE` from the process environment. Against production, read it from
`hushh-pda`, and leave the session on the gate phone by signing in by hand (step 3).
`hushh-webapp/scripts/perf/ios-reviewer-signin.sh` restores a session through the review-mode mint, so it
cannot sign into production, by design. After a sign-out, sign in by hand again.

The build still archives with **production APNs** entitlements (correct for *any* App Store binary —
push on a store build routes through Apple's PRODUCTION APNs). That means the **shared Firebase project
must hold a production APNs key** for push notifications to deliver on the released app.

For an internal TestFlight build (no review), use the sibling pipeline: `ship-ios-testflight`
(runbook: [ship-ios-testflight.md](./ship-ios-testflight.md)).

- **Command:** `npm run --prefix hushh-webapp ios:release:prod` **or** `make ios-prod-release`.
- **Workflow:** `.github/workflows/release-ios-appstore.yml` (`workflow_dispatch`, `environment: production`).
- **Dispatcher:** `scripts/release/dispatch-ios-appstore.mjs` (resolves SHA, confirms, dispatches, watches).
- **Runner:** GitHub-hosted `macos-15`, Xcode 26.3 — GCP has no macOS instances and local builds
  hang inside iCloud Drive, so only the *dispatch* runs on your machine; the Apple build runs in CI.
- **Target:** bundle `com.hushh.app`, marketing version from `MARKETING_VERSION` in the pbxproj
  (`1.4.0` on 2026-09-29), `backend_target` backend (default **UAT**) + Firebase (`hushh-pda`),
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
   `NEXT_PUBLIC_APP_URL=https://uat.one.hushh.ai`, `NEXT_PUBLIC_PASSKEY_RP_ID=uat.one.hushh.ai`.
   **Refuses to continue unless the backend host is the UAT host** (`*uat*` / the UAT Cloud Run id) —
   belt-and-braces on top of the guard inside `prepare-ios-uat-archive.mjs`, so a mis-scoped project
   or a prod/localhost URL can never sneak into a store build.
7. **Decode the App Store Connect API key** (`.p8` + Key ID + Issuer ID) from `hushh-pda-uat` Secret
   Manager into a `chmod 600` temp file; validates it is a real PEM; masks the identifiers.
8. **Create + unlock a dedicated signing keychain** (Apple-managed cloud signing needs one).
9. **Prepare the iOS project against UAT.** `ios:prepare:uat` runs `cap:build` + `cap:sync:ios`,
   verifies the staged `manifest.webmanifest`, native permission declarations, privacy manifest,
   App Intents registration, and consent-plugin registration, then asserts the bundled backend host
   is the UAT host. The release workflow repeats the generated voice gateway, Siri, native plugin,
   and local voice evaluation checks immediately before archiving.
10. **Resolve the next build number.** `resolve-ios-build-number.py` mints an ES256 JWT and returns
    `max(latest ASC build for 1.3.6, pbxproj CURRENT_PROJECT_VERSION) + 1` — monotonic against both
    App Store history and the committed value. (TestFlight and the App Store share one build-number
    pool per marketing version.)
11. **Resolve Swift packages** (cached), then **archive** in Release with the **production APNs
    entitlement override** `CODE_SIGN_ENTITLEMENTS=App/AppRelease.entitlements` (flips
    `aps-environment` development → production for the released binary only; the committed pbxproj
    stays on `App/App.entitlements`, so local/dev builds are unaffected). Signs with
    `-allowProvisioningUpdates` + the ASC API key; injects the resolved `CURRENT_PROJECT_VERSION`.
12. **Verify the archived product.** The automated product-asset gate reopens the archived
    `App.app` and requires `Info.plist`, `PrivacyInfo.xcprivacy`, `Metadata.appintents`, and
    `public/manifest.webmanifest`. It also requires microphone, speech-recognition, Face ID, and
    location usage declarations, and fails if model weights are embedded in the base bundle.
    Native audio capture permission is an operating-system permission; it is not action consent.
    Action authority remains inside Agent One's generated gateway, consent policy, directive ledger,
    and verified backend settlement.
13. **Export + upload to App Store Connect** via `ios/ExportOptions/AppStoreConnect.plist`
    (`destination=upload`). On `--dry-run`, PlistBuddy rewrites `destination` to `export` so the
    step signs and produces the `.ipa` without uploading.
14. **Prepare the App Store version (set What's New, attach build, one-click submit).**
    `submit-appstore-version.py` finds/creates an **editable App Store version with
    `releaseType=MANUAL`** (so it never auto-releases to the public), **sets the version's
    `whatsNew`** localization from `--whats-new` (Apple requires this per version — an empty field is
    what blocks "Add for Review"), waits for the uploaded build to reach `processingState=VALID`, and
    **attaches** it. It is skipped entirely on `--dry-run`. When `submit_for_review=true`, it also
    creates/reuses a review submission, adds this version, and marks it submitted (**irreversible**).
15. **Upload redacted evidence + job summary.** GitHub Actions archives only a
    small outcome receipt; it never archives the signed `.ipa`, dSYMs, or raw
    `xcodebuild` logs. The summary reports SHA, version, build number, backend
    (`UAT (hushh-pda-uat)`), and mode.

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
| `NEXT_PUBLIC_FIREBASE_API_KEY` … `NEXT_PUBLIC_FIREBASE_VAPID_KEY` | UAT-selected web config for the shared `hushh-pda` Firebase authority (see the workflow's `require` list). |

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
   product and current legal/privacy claims. The privacy policy URL is
   `https://one.hushh.ai/privacy` and the terms URL is `https://one.hushh.ai/terms`, both rendered
   from `hushh-webapp/lib/legal/legal-documents.ts`.

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
| dSYM "Upload Symbols Failed" (Firebase/Google frameworks, Plaid `LinkKit`) | Non-fatal export warnings for closed-source vendor libraries whose upstream publishes no dSYM; frames inside them will not symbolicate. The **Assert the archive ships our own debug symbols** step allow-lists exactly these by name and fails on anything else. |
| `Embedded framework <Name> ships with no dSYM and is not an approved exception` | A new embedded framework has no dSYM in the archive. If it is ours, restore `DEBUG_INFORMATION_FORMAT = dwarf-with-dsym` for Release. If it is a closed-source vendor binary, prove upstream ships no dSYM and that the shipped UUID equals the vendor's prebuilt binary, then add it to `ALLOWED_WITHOUT_DSYM` with that evidence (R29 in `.claude/skills/safe-changes/SKILL.md`). |
