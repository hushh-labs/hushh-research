---
name: release-ios-appstore
description: Cut a Hushh One iOS build from the latest green main and take it all the way to the App Store — build against PRODUCTION backend + prod Firebase, sign with Apple-managed signing (Admin ASC API key), upload to App Store Connect, and prepare the App Store version. Use when the user says "release ios to app store", "ship ios to production", "cut a prod ios build", "app store release", "prod ios release", or "make ios-prod-release". Prepares everything up to — but NOT including — the irreversible public "Submit for Review", which is opt-in only via a double gate. Orchestrates: preflight → pick green main SHA → (optional dry run) → dispatch the "Release iOS to App Store" workflow → watch to terminal → report the App Store Connect build/version. Pauses for explicit user confirmation before dispatch, and requires a separate explicit gate before any public submission.
argument-hint: "[sha: <green-main-sha>] [dry_run: true|false] [submit: true|false] [notes: <text>]"
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

# Release iOS to App Store (prod)

Orchestrates: **pick the latest green `main` SHA → build the Capacitor iOS app against the
PRODUCTION backend + prod Firebase → sign (Apple-managed, Admin ASC API key) → archive → upload to
App Store Connect → prepare the App Store version → report.** By default it **stops before** the
irreversible public "Submit for Review".

One command drives it:

```bash
make ios-prod-release                      # prepare-only (upload + attach build, NO public submit) — SHA=origin/main
make ios-prod-release ARGS="--dry-run"     # archive + sign on the runner, no upload / no ASC changes
make ios-prod-release ARGS="--sha <sha>"   # pin an explicit green SHA
make ios-prod-release ARGS="--submit --ack-blockers"   # ⛔ IRREVERSIBLE public App Store submission
```

`make ios-prod-release-dry` is shorthand for `ARGS="--dry-run"`. The Makefile target just calls the
auditable dispatcher `scripts/release/dispatch-ios-appstore.mjs`, which resolves the SHA, prints
exactly what will run, asks for confirmation, dispatches `gh workflow run "Release iOS to App
Store"`, and streams the run. The build itself runs **inside a GitHub-hosted macOS runner**
(`macos-15`, Xcode 26.3) — the local machine only dispatches (needs the `workflow` token scope).

Target: bundle `com.hushh.app`, App Store Connect, built against the **PRODUCTION** backend
(`api.hushh.ai`) + **prod** Firebase (`hushh-pda`), keyless GCP auth via Workload Identity
Federation. Sibling for testing: the `ship-ios-testflight` skill (UAT backend → TestFlight).

## HARD RULES (never violate)

1. **Two gates, not one.**
   - **Gate 1 (every dispatch):** STOP and get an explicit "yes" before dispatching. Show exactly
     what will happen (workflow, `--ref main`, `sha` short, mode = dry-run / prepare-only / submit,
     backend = PRODUCTION, bundle `com.hushh.app`). The dispatcher prints this and prompts too.
   - **Gate 2 (public submission only):** `--submit` is **IRREVERSIBLE** — it publishes to real
     users. It requires BOTH `--submit --ack-blockers`, a separate explicit user instruction, and
     every publish-safety blocker in `KT/hushh-one-publish-safety-audit.md` cleared first. **Never**
     pass `--submit` from an automated/background context or on assumption. Default and near-always
     correct is **prepare-only** (no `--submit`).
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
   `GoogleService-Info.plist` live only in **GCP Secret Manager** (`hushh-pda`), added by the
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
- Signing + Firebase secrets live in **GCP Secret Manager** (`hushh-pda`), not GitHub — the workflow
  reads them via Workload Identity Federation and fails fast with a runbook pointer if any of
  `APPSTORE_CONNECT_API_KEY_P8_B64` / `_KEY_ID` / `_ISSUER_ID` or
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
signs with production entitlements on the runner **without uploading**, isolating ASC-key / managed
signing problems. It does **not** validate the marketing-version train (that only happens on a real
upload). If the user just wants to prepare the release, skip to Phase 3.

## Phase 3 — Prepare the release  ⛔ CONFIRMATION GATE (Gate 1)

1. **GATE 1 — ask the user to confirm.** Show: workflow **"Release iOS to App Store"**, `--ref main`,
   `sha` (short), mode = **prepare-only** (upload + attach build, no public submit), backend =
   PRODUCTION, bundle `com.hushh.app`. Wait for an explicit "yes".
2. Dispatch (prepare-only is the default — no `--submit`):
   ```bash
   make ios-prod-release ARGS="--sha $SHA --yes --notes '<what changed, optional>'"
   ```
   (`--yes` skips the dispatcher's own prompt once you've taken Gate 1 in chat. Omit it to keep the
   interactive confirm. Equivalent raw form:
   `node scripts/release/dispatch-ios-appstore.mjs --sha $SHA --yes`.)
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
   make ios-prod-release ARGS="--sha $SHA --submit --ack-blockers"
   ```
   (Do not add `--yes`; let the dispatcher require typing `submit`. `--submit` + `--dry-run` are
   mutually exclusive; the dispatcher enforces `--submit` ⇒ `--ack-blockers`.)
3. The workflow's "Prepare App Store version" step re-checks `submit_for_review=true` +
   `ack_publish_blockers=true` before it does anything public.

## Phase 6 — Report

Compact, honest summary:
- SHA released (short) + that the smoke gate was green on it.
- Run URL + final status; mode (dry-run / prepare-only / submitted).
- Version / build number (e.g. `1.3.6 (57)`).
- ASC status: uploaded / processing / build attached to version / (prepare-only — NOT submitted for
  review), or "dry run — not uploaded".
- On-device note: the build boots against **PRODUCTION** backend (asserted during prep).

## Failure handling
- Actor not in `production.manual_dispatch_users` → stop in Phase 0.
- ASC/Firebase secrets missing → stop in Phase 0; link the runbook. Never accept secret values in chat.
- Smoke gate not green on the SHA → stop before Gate 1.
- Closed version train on upload → bump `MARKETING_VERSION`, land on `main`, re-release (HARD RULE 4).
- Build/archive/export fails → report the failing step verbatim; do not re-dispatch without the user's say-so.
- Upload fails on Apple agreements/role → tell the user which manual Apple step to do — the user's to perform.

## Quick reference
- Command: `make ios-prod-release` (+ `ARGS="--dry-run" | "--sha <sha>" | "--submit --ack-blockers"`);
  `make ios-prod-release-dry`. Dispatcher: `scripts/release/dispatch-ios-appstore.mjs`.
- Workflow: **"Release iOS to App Store"** (`.github/workflows/release-ios-appstore.yml`), inputs
  `sha`, `dry_run`, `submit_for_review`, `ack_publish_blockers`, `notes`; `environment: production`.
- TestFlight sibling: **"Ship iOS to TestFlight"** (`ship-ios-testflight` skill) — UAT backend, no review.
- Smoke gate (shared): **"Main Post-Merge Smoke Gate"**.
- Governance: `config/ci-governance.json` (`production.manual_dispatch_users`);
  `assert-governed-actor.py --surface production`.
- Build-number resolver: `scripts/ci/resolve-ios-build-number.py` (reads `MARKETING_VERSION` train + ASC history, +1).
- Version source: `MARKETING_VERSION` in `hushh-webapp/ios/App/App.xcodeproj/project.pbxproj` (App target, Debug+Release).
- Full runbook + secret setup: `docs/guides/mobile/release-ios-appstore.md`.
- Publish-safety blockers (must clear before `--submit`): `KT/hushh-one-publish-safety-audit.md`.
- Env/target: `hushh-pda` (prod), App Store Connect, bundle `com.hushh.app`.
