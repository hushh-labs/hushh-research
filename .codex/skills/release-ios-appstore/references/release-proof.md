# Release iOS to App Store — Evidence & Anti-Rationalization Contract

Durable detail for the `release-ios-appstore` spoke. The compact kernel (SKILL.md) stays lean;
this reference holds the proof standard, the two-gate rules, and the non-obvious failure modes.
Read alongside `docs/guides/mobile/release-ios-appstore.md` (the full runbook).

## What this pipeline actually ships

- One dispatch of the **"Release iOS to App Store"** workflow
  (`.github/workflows/release-ios-appstore.yml`, `runs-on: macos-15`, Xcode 26.3, Node 22) takes a
  green `main` SHA all the way to the public App Store: web build -> Capacitor sync -> archive ->
  Apple-managed sign -> export/upload to App Store Connect -> set per-version "What's New" ->
  attach the processed build -> (opt-in) submit for public review.
- **Backend is UAT, on purpose.** The public binary is built against the **UAT backend + UAT
  Firebase (`hushh-pda-uat`)** — the same latest frontend+backend that is live on UAT and
  TestFlight. There is no separate production backend for the store binary. It still archives with
  **production APNs** entitlements (correct for any store binary), so the UAT Firebase project must
  hold a production APNs key for push to deliver. This is a deliberate decision, not a leak — state
  it plainly in every report so nobody assumes a prod backend.
- **Bundle** `com.hushh.app`; App Store Connect app id `6757718917`; team `WVDK9JW99C`;
  marketing version comes from `MARKETING_VERSION` in
  `hushh-webapp/ios/App/App.xcodeproj/project.pbxproj` (App target, Debug + Release).

## Two gates — never collapse them into one

- **Gate 1 (every dispatch).** Stop and get an explicit "yes" before dispatching. Restate the
  workflow name, `--ref main`, the short SHA, the mode (dry-run / prepare-only / submit), the
  backend (UAT `hushh-pda-uat`), and the bundle. The dispatcher
  `scripts/release/dispatch-ios-appstore.mjs` also prints this and prompts.
- **Gate 2 (public submission only).** `submit_for_review=true` is **IRREVERSIBLE** — it publishes
  to real users. It maps to `--submit --ack-blockers` on the CLI (a local safety gate the
  dispatcher enforces), and it requires: a separate explicit user instruction, and every
  publish-safety blocker cleared first (see the publish-safety audit note below). Never pass
  `--submit` / set `submit_for_review=true` from an automated or background context, or on
  assumption. The default and near-always-correct mode is **prepare-only**.

## Green-main-only

The build is allowed only from a `main` SHA where **"Main Post-Merge Smoke Gate"** = `success`.
The workflow re-checks with `scripts/ci/require-deploy-sha-on-main.sh` and refuses otherwise; fail
fast locally too. This skill does **not** merge — if the work is not on `main`, tell the user to
merge (and run the web deploy) first, then release. It ships what is already on `main`.

## Identity / governance

The actor must be in `config/ci-governance.json` -> `production.manual_dispatch_users`. If not,
`scripts/ci/assert-governed-actor.py --surface production` rejects the dispatch. Confirm before
Gate 1. Do not weaken branch protection and do not accept Apple Program License Agreements or enter
the Apple ID password — those are the user's to perform.

## Secrets boundary (hard)

The ASC API key (`.p8`, **Admin** role) + Key ID + Issuer ID, and the native
`GoogleService-Info.plist`, live only in **GCP Secret Manager** (`hushh-pda-uat`), added by the
user. The workflow authenticates with the `GCP_SA_KEY_UAT` GitHub secret (same as TestFlight) and
fails fast with a runbook pointer if any of `APPSTORE_CONNECT_API_KEY_P8_B64` / `_KEY_ID` /
`_ISSUER_ID` / `IOS_GOOGLESERVICE_INFO_PLIST_B64` is missing. Never print, paste,
`gcloud secrets versions access`, or ask the user to paste these into chat. If one is missing,
point to the runbook — do not work around it.

## Non-obvious failure modes (each has bitten a real run)

1. **Closed marketing-version train.** App Store Connect rejects an upload whose
   `CFBundleShortVersionString` (= `MARKETING_VERSION`) equals a version already approved/closed:
   "Invalid Pre-Release Train ... is closed for new build submissions" / "must contain a higher
   version than the previously approved version". The build-number resolver
   (`scripts/ci/resolve-ios-build-number.py`) only bumps `CFBundleVersion` (the build number), not
   the marketing version. Fix: bump `MARKETING_VERSION` (both App-target configs) to the next
   patch, land on `main`, re-release. A `--dry-run` will NOT catch this — dry-run skips the
   upload/ASC-validation leg.
2. **ASC key role too low.** Archive creates a dev asset and export creates a distribution asset,
   both via `-allowProvisioningUpdates`. The API key must be **Admin** (App Manager is not enough
   for the managed distribution certificate). Symptom: a cloud-signing permission error at export.
3. **Shared build-number pool.** TestFlight and App Store share one `CFBundleVersion` pool, and the
   ASC builds API lags, so back-to-back runs can collide on a build number. The resolver takes
   `max(ASC history, pbxproj) + 1`; if two dispatches race, re-run once ASC has caught up.
4. **dSYM "Upload Symbols Failed"** for Firebase/Google frameworks is **non-fatal** — it does not
   fail the build or the upload. Do not treat it as a failure.
5. **Unaccepted Program License Agreement** silently blocks upload/processing — a user-only fix.

## Proof standard (report honestly)

"Workflow green" is not "in App Store Connect", and a prepare-only run is **not** "submitted for
review". Before calling a release done, capture:

- SHA released (short) and that "Main Post-Merge Smoke Gate" was `success` on that exact SHA.
- Run URL + final status; mode (dry-run / prepare-only / submitted).
- Version + resolved build number (e.g. `1.3.6 (60)`).
- ASC state from the API or Job summary: uploaded / processing / "What's New" set / build attached
  to the version / review submission created — or, for prepare-only, explicitly "attached, NOT
  submitted for review"; for dry-run, "not uploaded".
- On-device note: the build boots against the **UAT** backend (`hushh-pda-uat`, asserted during
  prep) — the same backend as TestFlight.

Keep merge, smoke, dispatch, upload, and (if any) submission as separate evidence. Never call
queued or processing work "done".

## Anti-rationalization

- "The user said release, so I'll just submit" — no. Release defaults to prepare-only; public
  submission is a distinct Gate 2 with its own explicit yes.
- "Dry-run passed, so the upload is safe" — no. Dry-run does not exercise upload or the
  marketing-version-train check.
- "I'll set the secret to unblock the run" — no. Secrets are user-owned in GCP Secret Manager;
  point to the runbook.
- "Green run means it's on the store" — no. Confirm the ASC version/build/submission state.
- "It's the prod release, so it must hit a prod backend" — no. This binary is intentionally
  UAT-backed; say so.

## Sibling & handoffs

- TestFlight distribution (same UAT-backed binary, no review): the `ship-ios-testflight` skill.
- iOS native/Capacitor/entitlement/plist issues: `mobile-native`.
- UAT/prod Cloud Run + web deploy scope: `uat-scoped-deploy`.
- Publish-safety, consent, or secret-boundary findings: `security-audit`.
- Broad or ambiguous intake: back to `repo-operations`.

The publish-safety blockers that must clear before Gate 2 live in the uncommitted KT audit
(KT/hushh-one-publish-safety-audit.md) — a working doc, not a repo artifact; confirm with the user.
