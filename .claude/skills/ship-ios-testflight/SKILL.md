---
name: ship-ios-testflight
description: Cut a Hushh One iOS build from the latest green main (what UAT runs) and ship it to TestFlight in one click for hushh-research. Use when the user says "ship ios", "ship the ios app", "ship to testflight", "cut an ios build", "push ios to testflight", or any request to release the current UAT iOS app to TestFlight. Builds the Capacitor iOS app against the UAT backend + UAT Firebase, signs with Apple-managed signing via an App Store Connect API key, and uploads to TestFlight — no App Store review, no manual compliance click. Orchestrates: preflight → pick green main SHA → (optional dry run) → dispatch the "Ship iOS to TestFlight" GitHub Actions workflow → watch to terminal → report the TestFlight build. Pauses for explicit user confirmation before the dispatch.
argument-hint: "[sha: <green-main-sha>] [dry_run: true|false] [notes: <what-to-test>]"
allowed-tools: Read Grep Glob Bash(gh *) Bash(git fetch*) Bash(git status*) Bash(git rev-parse*) Bash(git log*) Bash(git branch*)
paths:
  - .github/workflows/ship-ios-testflight.yml
  - .github/workflows/deploy-uat.yml
  - config/ci-governance.json
  - scripts/ci/**
  - hushh-webapp/ios/**
  - docs/guides/mobile/ship-ios-testflight.md
---

# Ship iOS to TestFlight (ship ios)

Orchestrates: **pick the latest green `main` SHA (what UAT runs) → build the Capacitor iOS app
against UAT → sign (Apple-managed, ASC API key) → upload to TestFlight → report.**
Trigger phrase: **`ship ios`** (also "ship to testflight", "cut an ios build", etc.).

The build runs **inside a GitHub-hosted macOS runner** (`macos-15`); the local machine only
*dispatches* via `gh` (needs the `workflow` token scope). Signing uses an **App Store Connect API
key** stored as a GitHub secret + Apple cloud-managed certificates — no local `.p12`, no fastlane.

Target: bundle `com.hushh.app`, TestFlight (internal testers, no Beta App Review), built against the
**UAT** backend (`consent-protocol` Cloud Run) + **UAT** Firebase (`hushh-pda-uat`). This is the same
source that `deploy .uat` ships to the web — it does **not** ship the `mobile`-branch redesign.

## HARD RULES (never violate)

1. **One confirmation gate.** STOP and get an explicit "yes" before dispatching the build. Show
   exactly what will happen (workflow, `--ref main`, `sha` short, `dry_run`, target = TestFlight
   / UAT backend). Never dispatch on assumption. This skill never merges anything to `main`.
2. **Only ship a green `main` SHA.** The build is only allowed from a `main` SHA where the
   **"Main Post-Merge Smoke Gate"** check-run = `success` (the workflow re-checks this via
   `require-deploy-sha-on-main.sh` and will refuse otherwise). If it isn't green, stop and report.
3. **This skill does not merge.** If the user's work isn't on `main` yet, tell them to run
   `deploy .uat` (or merge) first, then ship. This skill ships what is already live on UAT.
4. **TestFlight only — never App Store review.** The pipeline uploads to TestFlight and stops. It
   does not submit for public App Store review, does not touch prod backend/Firebase, and does not
   flip `aps-environment` to production. If the user wants a public App Store release, that is a
   separate, larger effort (see `KT/hushh-one-publish-safety-audit.md`) — do not attempt it here.
5. **Never touch secrets.** The ASC API key (`.p8`) and its Key/Issuer IDs live only in **GCP
   Secret Manager** (`hushh-pda-uat`), added by the **user**. Never print, paste, `gcloud secrets
   versions access` them, or ask the user to paste them into chat. If a required secret is missing,
   point the user to the runbook — do not work around it.
6. **Verify identity before acting.** Confirm the `gh` actor is in `config/ci-governance.json` →
   `uat.manual_dispatch_users`. If not, stop — the dispatch will be rejected by
   `assert-governed-actor.py` anyway. This operator (`ankitkumarsingh1702`) can dispatch UAT/iOS,
   not production.
7. **Report faithfully.** "Workflow green" ≠ "build in TestFlight". Confirm the new build number
   actually appears in TestFlight (or the run summary reports the upload) before calling it done.

## Phase 0 — Preflight (read-only)

```bash
gh api user --jq '.login'                               # must be in uat.manual_dispatch_users
gh auth status                                          # confirm 'workflow' scope present
git fetch --no-tags origin main
git rev-parse origin/main                               # candidate SHA (latest main)
```
- Read `config/ci-governance.json`; confirm the actor ∈ `uat.manual_dispatch_users`. If not → STOP.
- Signing + Firebase secrets live in **GCP Secret Manager** (`hushh-pda-uat`), not GitHub — the
  workflow reads them via `GCP_SA_KEY_UAT` and **fails fast with a runbook pointer** if any of
  `APPSTORE_CONNECT_API_KEY_P8_B64` / `_KEY_ID` / `_ISSUER_ID` or
  `IOS_GOOGLESERVICE_INFO_PLIST_B64` is missing. You cannot list them with the `gh`-scoped tools
  here, so don't try; if the user asks to pre-check, point them to
  `docs/guides/mobile/ship-ios-testflight.md` (they can run `gcloud secrets describe <name>
  --project hushh-pda-uat` — describe only, never `access`). A `dry_run: true` dispatch (Phase 2)
  is the safe way to confirm the secrets resolve and signing works before a real upload.

## Phase 1 — Choose the SHA (green `main`)

1. SHA = the user-provided `sha`, else latest `origin/main`. It must be an ancestor of `origin/main`.
2. Confirm the smoke gate is green on that exact SHA:
   ```bash
   gh api "repos/{owner}/{repo}/commits/$SHA/check-runs?per_page=100" \
     --jq '.check_runs[] | select(.name=="Main Post-Merge Smoke Gate") | {conclusion,html_url}'
   ```
   If not `success` → STOP, report. (The workflow enforces this too, but fail fast here.)

## Phase 2 — (Optional) dry run

Recommend a `dry_run: true` dispatch the first time after any signing/secret change: it archives +
signs on the runner **without uploading**, isolating ASC-key / managed-signing problems from a real
upload. Same dispatch as Phase 3 with `-f dry_run=true`. If the user just wants to ship, skip this.

## Phase 3 — Ship  ⛔ CONFIRMATION GATE

1. **GATE — ask the user to confirm.** Show: workflow **"Ship iOS to TestFlight"**, `--ref main`,
   `sha` (short), `dry_run` value, target = TestFlight / UAT backend / bundle `com.hushh.app`.
   Wait for an explicit "yes".
2. Dispatch:
   ```bash
   gh workflow run "Ship iOS to TestFlight" --ref main \
     -f sha="$SHA" -f dry_run=false -f notes="<what-to-test, optional>"
   ```
3. Find and watch the run to terminal:
   ```bash
   sleep 4
   gh run list --workflow "Ship iOS to TestFlight" --branch main --limit 1 --json databaseId,url,status
   gh run watch <run-id> --exit-status
   ```
   Expect ~15–35 min on a cold SPM graph (firebase/grpc/facebook). `timeout-minutes: 40`.

## Phase 4 — Verify (do not stop at "workflow green")

- Read the run's job summary: it reports version (`1.3.5`), the resolved build number, and whether
  the upload step ran (`dry_run` skips upload). Download the `.ipa`/dSYM/logs artifacts if debugging.
- For a real (non-dry) run, confirm the build reaches TestFlight. It takes a few minutes for Apple
  to finish processing; the build appears under **1.3.5 (build N)** for internal testers, already
  compliant (no "Missing Compliance" click, thanks to `ITSAppUsesNonExemptEncryption=false`).
- If the export/upload step failed, report the failing step and the ASC error verbatim. Common
  causes: unaccepted Apple Program License Agreement, ASC key role too low (needs **App Manager**),
  or a duplicate build number (the resolver should prevent the last one).

## Phase 5 — Report

Compact, honest summary:
- SHA shipped (short) + that the smoke gate was green on it.
- Run URL + final status; `dry_run` or real.
- Version / build number (e.g. `1.3.5 (57)`).
- TestFlight status: uploaded / processing / available to internal testers (or "dry run — not
  uploaded").
- On-device note: the build boots against **UAT** backend (asserted by
  `verify-ios-bundled-backend.sh` during prep).

## Failure handling
- Actor not in `uat.manual_dispatch_users` → stop in Phase 0.
- ASC secrets missing → stop in Phase 0; link the runbook. Never accept secret values in chat.
- Smoke gate not green on the SHA → stop before the gate.
- Build/archive fails → report the failing step; do not re-dispatch without the user's say-so.
- Upload fails on Apple agreements/role → tell the user which manual Apple step to do (accept the
  agreement in ASC, or raise the API key role) — these are the user's to perform, not yours.

## Quick reference
- Workflow: **"Ship iOS to TestFlight"** (`.github/workflows/ship-ios-testflight.yml`), inputs
  `sha`, `dry_run`, `notes`.
- Web sibling: **"Deploy to UAT"** (`deploy-uat` skill) — ship the same SHA to the UAT website.
- Smoke gate (shared): **"Main Post-Merge Smoke Gate"**.
- Governance source of truth: `config/ci-governance.json` (`uat.manual_dispatch_users`).
- Build-number resolver: `scripts/ci/resolve-ios-build-number.py` (ASC history vs pbxproj, +1).
- Secret setup + full flow: `docs/guides/mobile/ship-ios-testflight.md`.
- Env/target: `hushh-pda-uat`, TestFlight, bundle `com.hushh.app`, version `1.3.5`.
- This operator (`ankitkumarsingh1702`) can dispatch **UAT/iOS only** — **not** production.
