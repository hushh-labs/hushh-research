---
name: release-ios-appstore
description: Use when releasing, submitting, or verifying a public Hussh One iOS App Store build cut from green main — Apple-managed signing with an Admin ASC API key, a UAT-backend/UAT-Firebase binary, per-version "What's New" and build attach via the ASC API, and the two-gate dispatch path (prepare-only default, opt-in irreversible public submit).
---

# Hussh Release iOS to App Store Skill

## Purpose and Trigger

- Primary scope: `release-ios-appstore-scope`
- Trigger on releasing, submitting, or verifying a public iOS App Store build from a green `main` SHA.
- Avoid overlap with `uat-scoped-deploy`, `mobile-native`, and broad `repo-operations` intake.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `repo-operations`

Owned repo surfaces:

1. `.github/workflows/release-ios-appstore.yml`
2. `scripts/release/dispatch-ios-appstore.mjs`

Non-owned surfaces:

1. `mobile-native`
2. `uat-scoped-deploy`
3. `security-audit`
4. `repo-operations`

## Do Use

1. Cutting a public App Store build from the latest green `main` (prepare-only by default).
2. Setting per-version "What's New", attaching the processed build, and resolving the build number.
3. Verifying an App Store Connect upload/version/submission state after a "Release iOS to App Store" run.

## Do Not Use

1. TestFlight-only distribution — use the `ship-ios-testflight` sibling (same UAT-backed binary).
2. Merging code to `main`; this ships what is already on `main` and never merges.
3. Production Cloud Run or scoped UAT deploys — route to `uat-scoped-deploy`.
4. Publish-safety clearance or consent-boundary decisions — route to `security-audit`.

## Read First

1. `.github/workflows/release-ios-appstore.yml`
2. `docs/guides/mobile/release-ios-appstore.md`
3. `scripts/release/dispatch-ios-appstore.mjs`
4. `scripts/ci/submit-appstore-version.py`
5. `scripts/ci/resolve-ios-build-number.py`
6. `deploy/app_store_deployment.md`
7. `docs/reference/operations/branch-governance.md`
8. `.codex/skills/release-ios-appstore/references/release-proof.md`

## Workflow

1. Confirm the `gh` actor is in `config/ci-governance.json` -> `production.manual_dispatch_users`, else STOP (the run is rejected by `scripts/ci/assert-governed-actor.py` with `--surface production`).
2. Pick SHA = user-provided else latest `origin/main`; it must be an ancestor of `origin/main`.
3. Require "Main Post-Merge Smoke Gate" = success on that exact SHA (the workflow re-checks via `scripts/ci/require-deploy-sha-on-main.sh` and refuses otherwise).
4. First run after any signing/secret change, dispatch a dry run (`make ios-prod-release-dry`): archive + sign, no upload. A dry run does NOT catch a closed marketing-version train.
5. GATE 1 (every dispatch): restate workflow, `--ref main`, short SHA, mode, backend = UAT (`hushh-pda-uat`), bundle `com.hushh.app`; get an explicit yes, then `make ios-prod-release ARGS="--sha <sha> --yes --whats-new '<notes>'"` (prepare-only default; no `--submit`).
6. If a real upload fails with "train ... is closed", bump `MARKETING_VERSION` in `hushh-webapp/ios/App/App.xcodeproj/project.pbxproj` (Debug+Release), land it on `main`, re-release; the resolver only bumps the build number.
7. GATE 2 (public submission only): irreversible and publishes to real users; requires a fresh explicit yes and every publish-safety blocker cleared, then `--submit --ack-blockers` (workflow input `submit_for_review=true`). Never dispatch submit from automation or on assumption.
8. Verify from the ASC API and the run Job summary — uploaded, processed, "What's New" set, build attached, submitted-or-prepared — before reporting done. Never print, paste, or read the ASC `.p8` / Key / Issuer secrets.

## Handoff Rules

1. If the request is broad or ambiguous, route it back to `repo-operations`.
2. Route iOS native/Capacitor build, entitlement, or plist issues to `mobile-native`.
3. Route UAT/prod Cloud Run and web deploy scope to `uat-scoped-deploy`.
4. Route publish-safety, consent, or secret-boundary findings to `security-audit`.

## Required Checks

```bash
gh run list --workflow release-ios-appstore.yml --limit 5 --json databaseId,status,conclusion,headSha,event,url
gh workflow view "Release iOS to App Store" --ref main
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```
