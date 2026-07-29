---
name: release-ios-appstore
description: Cut a Hushh One iOS build from the latest green main and take it all the way to the public App Store — build against the UAT backend + UAT Firebase (the same latest frontend+backend that ships to TestFlight), sign with Apple-managed signing (Admin ASC API key), upload to App Store Connect, auto-set "What's New", attach the build, and (opt-in) submit for public review in one click. Use when the user says "release ios to app store", "ship ios to production", "cut a prod ios build", "app store release", "prod ios release", or "make ios-prod-release". Default prepares everything up to — but NOT including — the irreversible public "Submit for Review". Orchestrates: preflight → pick green main SHA → (optional dry run) → dispatch the "Release iOS to App Store" workflow → watch to terminal → report the App Store Connect build/version. Pauses for explicit user confirmation before dispatch, and requires a separate explicit acknowledgement before any public submission.
argument-hint: "[sha: <green-main-sha>] [dry_run: true|false] [whats_new: <text>] [submit: true|false] [notes: <text>]"
allowed-tools: Read Grep Glob Bash(make ios-prod-release*) Bash(make ios-prod-release-dry*) Bash(node scripts/release/dispatch-ios-appstore.mjs*) Bash(gh *) Bash(git fetch*) Bash(git status*) Bash(git rev-parse*) Bash(git log*) Bash(git branch*)
paths:
  - .github/workflows/release-ios-appstore.yml
  - scripts/release/dispatch-ios-appstore.mjs
  - scripts/ci/**
  - config/ci-governance.json
  - hushh-webapp/ios/**
  - Makefile
  - docs/guides/mobile/release-ios-appstore.md
  - KT/hushh-one-publish-safety-audit.md
---

# Release iOS to App Store (public)

Orchestrates: **pick the latest green `main` SHA → build the Capacitor iOS app against the
UAT backend + UAT Firebase → sign (Apple-managed, Admin ASC API key) → archive → upload to
App Store Connect → set "What's New" → attach the build → (opt-in) submit for public review →
report.** By default it **stops before** the irreversible public "Submit for Review".

**Backend:** the public App Store build ships the **UAT backend + UAT Firebase (`hushh-pda-uat`)** —
i.e. the *same* latest frontend+backend that is live on UAT and TestFlight, not a separate
production backend. (It still archives with **production APNs** entitlements, correct for any store
binary — so the UAT Firebase project must hold a production APNs key for push to deliver.)

One command drives it:

```bash
make ios-prod-release                      # prepare-only (upload + set What's New + attach build, NO public submit) — SHA=origin/main
make ios-prod-release ARGS="--dry-run"     # archive + sign on the runner, no upload / no ASC changes
make ios-prod-release ARGS="--sha <sha>"   # pin an explicit green SHA
make ios-prod-release ARGS="--whats-new '<release notes>'"   # set the App Store "What's New" text
make ios-prod-release ARGS="--submit --ack-blockers"   # ⛔ IRREVERSIBLE one-click public App Store submission
```

`make ios-prod-release-dry` is shorthand for `ARGS="--dry-run"`. The Makefile target just calls the
auditable dispatcher `scripts/release/dispatch-ios-appstore.mjs`, which resolves the SHA, prints
exactly what will run, asks for confirmation, dispatches `gh workflow run "Release iOS to App
Store"`, and streams the run. The build itself runs **inside a GitHub-hosted macOS runner**
(`macos-15`, Xcode 26.3) — the local machine only dispatches (needs the `workflow` token scope).

Target: bundle `com.hushh.app`, App Store Connect, built against the **UAT** backend + **UAT**
Firebase (`hushh-pda-uat`), GCP auth via the `GCP_SA_KEY_UAT` service-account key (same as
TestFlight). Sibling for testing: the `ship-ios-testflight` skill (UAT backend → TestFlight); the
App Store binary is the same UAT-backed binary, differing only at the submission layer.

## HARD RULES (never violate)

1. **Two gates, not one.**
   - **Gate 1 (every dispatch):** STOP and get an explicit "yes" before dispatching. Show exactly
     what will happen (workflow, `--ref main`, `sha` short, mode = dry-run / prepare-only / submit,
     backend = UAT (`hushh-pda-uat`), bundle `com.hushh.app`). The dispatcher prints this and prompts too.
   - **Gate 2 (public submission only):** one-click submit maps to the workflow input
     `submit_for_review=true`, which is **IRREVERSIBLE** — it publishes to real users. On the CLI
     path it additionally requires `--submit --ack-blockers` (a local safety gate the dispatcher
     enforces), a separate explicit user instruction, and every publish-safety blocker in
     `KT/hushh-one-publish-safety-audit.md` cleared first. **Never** pass `--submit` (or set
     `submit_for_review=true`) from an automated/background context or on assumption. Default and
     near-always correct is **prepare-only**.
2. **Only release a green `main` SHA.** The build is only allowed from a `main` SHA where
   **"Main Post-Merge Smoke Gate"** = `success` (the workflow re-checks via
   `require-deploy-sha-on-main.sh` and refuses otherwise). If it isn't green, stop and report.
3. **This skill does not merge.** If the work isn't on `main` yet, tell the user to merge / run the
   web deploy first, then release. This ships what is already on `main`.
4. **Bump the marketing version when a train is closed.** App Store Connect rejects any upload whose
   `CFBundleShortVersionString` (= `MARKETING_VERSION` in `project.pbxproj`) is a version already
   approved/closed ("Invalid Pre-Release Train … is closed for new build submissions" / "must
   contain a higher version than the previously approved version"). The build-number resolver only
   bumps `CFBundleVersion` (the build number), **not** the marketing version. If a real upload
   fails with that error, bump `MARKETING_VERSION` (both App-target Debug+Release configs) to the
   next patch, land it on `main`, and re-release. A `--dry-run` will NOT catch this (dry-run skips
   the upload/ASC-validation leg).
5. **Never touch secrets.** The ASC API key (`.p8`, Admin role) + Key/Issuer IDs and the native
   `GoogleService-Info.plist` live only in **GCP Secret Manager** (`hushh-pda-uat`), added by the
   **user**. Never print, paste, `gcloud secrets versions access` them, or ask the user to paste
   them into chat. If a required secret is missing, point to the runbook — do not work around it.
6. **Verify identity before acting.** Confirm the `gh` actor is in `config/ci-governance.json` →
   `production.manual_dispatch_users` (`kushaltrivedi5`, `ankitkumarsingh1702`). If not, stop — the
   dispatch is rejected by `assert-governed-actor.py --surface production` anyway.
7. **Never weaken protection or accept Apple agreements.** Do not disable branch protection, and do
   not accept Program License Agreements or enter the Apple ID password — those are the user's to
   do.
8. **Report faithfully.** "Workflow green" ≠ "in App Store Connect". Confirm the build/version
   actually appears in ASC (or the run summary reports the upload + attach) before calling it done.
   A prepare-only run is **not** "submitted for review".

## Phase 0 — Preflight (read-only)

```bash
gh api user --jq '.login'          # must be in production.manual_dispatch_users
gh auth status                     # confirm 'workflow' scope present
git fetch --no-tags origin main
git rev-parse origin/main          # candidate SHA (latest main)
```
- Read `config/ci-governance.json`; confirm the actor ∈ `production.manual_dispatch_users`. If not → STOP.
- Signing + Firebase secrets live in **GCP Secret Manager** (`hushh-pda-uat`), not GitHub — the
  workflow authenticates with the `GCP_SA_KEY_UAT` GitHub secret (same as TestFlight) and fails fast
  with a runbook pointer if any of `APPSTORE_CONNECT_API_KEY_P8_B64` / `_KEY_ID` / `_ISSUER_ID` or
  `IOS_GOOGLESERVICE_INFO_PLIST_B64` is missing. Do not try to list/read them here. A `--dry-run` is
  the safe way to confirm signing works before a real upload (but see HARD RULE 4 — it won't catch a
  closed version train).

## Phase 1 — Choose the SHA (green `main`)

1. SHA = the user-provided `sha`, else latest `origin/main`. It must be an ancestor of `origin/main`.
2. Confirm the smoke gate is green on that exact SHA:
   ```bash
   gh api "repos/{owner}/{repo}/commits/$SHA/check-runs?per_page=100" \
     --jq '.check_runs[] | select(.name=="Main Post-Merge Smoke Gate") | {conclusion,html_url}'
   ```
   If not `success` → STOP, report. (The workflow enforces this too; fail fast here.)

## Phase 2 — (Optional) dry run

Recommend `make ios-prod-release-dry` the first time after any signing/secret change: it archives +
signs with production **APNs** entitlements (correct for any store binary, regardless of the UAT
backend) on the runner **without uploading**, isolating ASC-key / managed signing problems. It does
**not** validate the marketing-version train (that only happens on a real upload). If the user just
wants to prepare the release, skip to Phase 3.

## Phase 3 — Prepare the release  ⛔ CONFIRMATION GATE (Gate 1)

1. **GATE 1 — ask the user to confirm.** Show: workflow **"Release iOS to App Store"**, `--ref main`,
   `sha` (short), mode = **prepare-only** (upload + set What's New + attach build, no public submit),
   backend = UAT (`hushh-pda-uat`), bundle `com.hushh.app`. Wait for an explicit "yes".
2. Dispatch (prepare-only is the default — no `--submit`):
   ```bash
   make ios-prod-release ARGS="--sha $SHA --yes --whats-new '<release notes>' --notes '<what changed, optional>'"
   ```
   (`--yes` skips the dispatcher's own prompt once you've taken Gate 1 in chat. Omit it to keep the
   interactive confirm. `--whats-new` sets the App Store "What's New in This Version" text — Apple
   requires it per version; omit to keep the workflow default / leave existing notes untouched.
   Equivalent raw form: `node scripts/release/dispatch-ios-appstore.mjs --sha $SHA --yes`.)
3. The dispatcher finds and watches the run to terminal. Expect ~15–35 min on a cold SPM graph.
   `timeout-minutes` is set on the job.

## Phase 4 — Verify (do not stop at "workflow green")

- Read the run's **Job summary**: version (e.g. `1.3.6`), resolved build number, upload result, and
  whether the App Store version was prepared / whether submit was gated (prepare-only skips the
  submit sub-step).
- Confirm the build reaches **App Store Connect** (a few minutes for Apple to finish processing);
  it appears under the app record for `com.hushh.app` at the new version, attached to a **manual**
  App Store version (no public review started).
- dSYM "Upload Symbols Failed" warnings for Firebase/Google frameworks are **non-fatal** — they do
  not fail the build or the upload.
- If **Export & upload** failed, report the failing step and the ASC error verbatim. Common causes:
  **closed marketing-version train** (HARD RULE 4 — bump `MARKETING_VERSION`), unaccepted Program
  License Agreement, ASC key role too low (needs **Admin**), or a duplicate build number.

## Phase 5 — (Opt-in, separate) public submission  ⛔ GATE 2

Only if the user **explicitly** asks to submit for public App Store review AND the publish-safety
blockers in `KT/hushh-one-publish-safety-audit.md` are cleared:

1. Restate that this is **IRREVERSIBLE** and publishes to real users. Get a fresh explicit "yes".
2. ```bash
   make ios-prod-release ARGS="--sha $SHA --whats-new '<release notes>' --submit --ack-blockers"
   ```
   (Do not add `--yes`; let the dispatcher require typing `submit`. `--submit` + `--dry-run` are
   mutually exclusive; the dispatcher enforces `--submit` ⇒ `--ack-blockers` as a local safety gate,
   then dispatches the workflow with `submit_for_review=true`.)
3. The workflow uploads, sets What's New, attaches the build, and submits for public review in a
   single run. Screenshots / age rating / pricing are reused from the existing ASC listing (stable
   across versions); only "What's New" is version-specific. Alternatively the user can run the
   workflow straight from the GitHub Actions "Run workflow" button with `submit_for_review` checked —
   that is the true one-click path.

## Phase 6 — Report

Compact, honest summary:
- SHA released (short) + that the smoke gate was green on it.
- Run URL + final status; mode (dry-run / prepare-only / submitted).
- Version / build number (e.g. `1.3.6 (57)`).
- ASC status: uploaded / processing / What's New set / build attached to version / submitted for
  review / (prepare-only — NOT submitted for review), or "dry run — not uploaded".
- On-device note: the build boots against the **UAT** backend (`hushh-pda-uat`, asserted during prep) —
  the same backend as TestFlight.

## Failure handling
- Actor not in `production.manual_dispatch_users` → stop in Phase 0.
- ASC/Firebase secrets missing → stop in Phase 0; link the runbook. Never accept secret values in chat.
- Smoke gate not green on the SHA → stop before Gate 1.
- Closed version train on upload → bump `MARKETING_VERSION`, land on `main`, re-release (HARD RULE 4).
- Build/archive/export fails → report the failing step verbatim; do not re-dispatch without the user's say-so.
- Upload fails on Apple agreements/role → tell the user which manual Apple step to do — the user's to perform.

## Quick reference
- Command: `make ios-prod-release` (+ `ARGS="--dry-run" | "--sha <sha>" | "--whats-new '<text>'" | "--submit --ack-blockers"`);
  `make ios-prod-release-dry`. Dispatcher: `scripts/release/dispatch-ios-appstore.mjs`.
- Workflow: **"Release iOS to App Store"** (`.github/workflows/release-ios-appstore.yml`), inputs
  `sha`, `dry_run`, `whats_new`, `submit_for_review`, `notes`; `environment: production` (public
  submission is a production surface even though the binary is UAT-backed).
- TestFlight sibling: **"Ship iOS to TestFlight"** (`ship-ios-testflight` skill) — same UAT backend, no review.
- Smoke gate (shared): **"Main Post-Merge Smoke Gate"**.
- Governance: `config/ci-governance.json` (`production.manual_dispatch_users`);
  `assert-governed-actor.py --surface production`.
- Auth: GitHub secret `GCP_SA_KEY_UAT` → GCP Secret Manager `hushh-pda-uat` (same as TestFlight).
- What's New setter + review submission: `scripts/ci/submit-appstore-version.py` (ASC API — sets
  `whatsNew` per version, attaches the build, optional `--submit`).
- Build-number resolver: `scripts/ci/resolve-ios-build-number.py` (reads `MARKETING_VERSION` train + ASC history, +1).
- Version source: `MARKETING_VERSION` in `hushh-webapp/ios/App/App.xcodeproj/project.pbxproj` (App target, Debug+Release).
- Full runbook + secret setup: `docs/guides/mobile/release-ios-appstore.md`.
- Publish-safety blockers (must clear before `--submit`): `KT/hushh-one-publish-safety-audit.md`.
- Env/target: `hushh-pda-uat` (UAT backend + Firebase), App Store Connect, bundle `com.hushh.app`.
