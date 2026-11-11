---
name: release-ios-appstore
description: Use when releasing, submitting, or verifying a public Hussh One iOS App Store build cut from green main: Apple-managed signing with an Admin ASC API key, a binary whose backend is chosen by `backend_target` (production by default; explicit legacy UAT diagnostics), per-version "What's New" and build attach via the ASC API, and the two-gate dispatch path (prepare-only default, opt-in irreversible public submit).
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
3. Production Cloud Run deploys route to `repo-operations`; scoped UAT deploys route to `uat-scoped-deploy`.
4. Publish-safety clearance or consent-boundary decisions — route to `security-audit`.

## Read First

1. `.github/workflows/release-ios-appstore.yml`
2. `docs/guides/mobile/release-ios-appstore.md`
3. `scripts/release/dispatch-ios-appstore.mjs`
4. `scripts/ci/submit-appstore-version.py`
5. `scripts/ci/resolve-ios-build-number.py`
6. `deploy/app_store_deployment.md`
7. `.agents/skills/repo-operations/references/admin-release-sop.md`
8. `.agents/skills/release-ios-appstore/references/release-proof.md`

## Workflow

1. Confirm the `gh` actor and rerunner have current `deploy-production` team membership through the trusted admission check. Saved username lists and organization-admin status do not grant release authority.
2. Pick SHA = user-provided else latest `origin/main`; it must be an ancestor of `origin/main`.
3. Require "Main Post-Merge Smoke Gate" = success on that exact SHA (the workflow re-checks via `scripts/ci/require-deploy-sha-on-main.sh` and refuses otherwise).
4. First run after any signing/secret change, dispatch a dry run (`make ios-prod-release-dry`): archive + sign, no upload. A dry run does NOT catch a closed marketing-version train.
5. GATE 1 (every dispatch): restate workflow, `--ref main`, exact SHA, mode, production backend and bundle `com.hushh.app`. Existing explicit authorization for that operation is sufficient; do not ask again. Use `make ios-prod-release ARGS="--sha <sha> --backend production --yes --whats-new '<notes>'"` (prepare-only default; no `--submit`). Explicit UAT remains a legacy diagnostic option, not a public-release target. A backend transition for existing installations requires a reviewed recovery plan: the same Firebase UID does not transfer vaults or records between databases.
6. Before packaging, follow `release-proof.md` → Live version and concurrent-release admission. Read current Apple marketing versions/states and other developers' in-flight uploads; a higher build number does not advance the marketing version. Use a supported explicit `--marketing-version` or reviewed source change when needed, verify app/extension/receipt parity, and preserve exact backend provenance. Resolve an approved-but-unreleased public version before preparing its successor; publishing or withdrawing it requires its own authorization.
7. GATE 2 (manual public submission): irreversible and publishes to real users; requires fresh explicit authorization and every publish-safety blocker cleared, then `--submit --ack-blockers` (workflow input `submit_for_review=true`). Unattended UAT/native cadence is retired; preparation never authorizes submission or publication.
8. Verify from the ASC API and the run Job summary — uploaded, processed, "What's New" set, build attached, submitted-or-prepared — before reporting done. Never print, paste, or read the ASC `.p8` / Key / Issuer secrets.
9. A production-backed submit needs the dedicated production reviewer account and its App Review Information, set by hand in App Store Connect (`docs/guides/mobile/release-ios-appstore.md` § *App Review sign-in on a production-backed build*). Production never advertises or mints review mode (`consent-protocol/api/routes/health.py`), so do not "enable" `APP_REVIEW_MODE` there, and never reuse the production reviewer UID as a UAT or dev `REVIEWER_UID`: the lanes share one Firebase authority and UAT mints with no credential.
10. Any verify step shared with the TestFlight sibling must bring the same runtime. Run 36358944003 (2026-09-27) died in `verify:one-voice` on `ModuleNotFoundError: dotenv`: the capability-graph generator needs the consent-protocol package, TestFlight got its Python step in 231c6e50f, and this lane did not. Diff both workflows' setup steps whenever a verify step is shared.

## Handoff Rules

1. If the request is broad or ambiguous, route it back to `repo-operations`.
2. Route iOS native/Capacitor build, entitlement, or plist issues to `mobile-native`.
3. Route production Cloud Run and web deploys to `repo-operations`; route scoped UAT deploys to `uat-scoped-deploy`.
4. Route publish-safety, consent, or secret-boundary findings to `security-audit`.

## Required Checks

```bash
gh run list --workflow release-ios-appstore.yml --limit 5 --json databaseId,status,conclusion,headSha,event,url
gh workflow view release-ios-appstore.yml
python3 .agents/skills/codex-skill-authoring/scripts/skill_lint.py
```
