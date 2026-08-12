---
name: ship-testflight
description: Cut a Hussh One iOS build from green main and get it onto your iPhone via TestFlight, self-serve, from any OS including Windows. Use when asked to release/push/cut a TestFlight build, test an iOS fix on a real device, or when a TestFlight dispatch was refused, produced no run at all, or the build never reached testers. Works for any teammate in the UAT allowlist; needs no Mac, no Xcode, and no signing certificates.
allowed-tools: Read Grep Glob Bash(gh *) Bash(git fetch*) Bash(git status*) Bash(git rev-parse*) Bash(git log*) Bash(git merge-base*) Bash(python3 *)
---

# Ship a TestFlight build (hushh-research)

**You do not need a Mac.** The whole build runs on a GitHub-hosted `macos-15` runner. Signing
uses Apple-managed cloud signing via an App Store Connect API key, and every secret — the ASC
key, the native Firebase config, the entire `NEXT_PUBLIC_*` contract — is read at runtime from
GCP Secret Manager in `hushh-pda-uat`. Nothing touches your laptop. Windows, Linux, and macOS
dispatch identically.

**A green workflow is not a testable build.** Four distinct states, and only the last one means
done: workflow succeeded → upload accepted by Apple → Apple finished processing → the build is
visible to internal testers.

The binary is bundle `com.hushh.app` pointed at the **UAT backend + UAT Firebase**. This is not
an App Store release and does not touch production.

## 0. Preconditions

1. **Who am I?**
   ```bash
   gh auth status
   ```
   Everything below is gated on that exact GitHub login.

2. **Am I on the UAT allowlist?** The workflow's second step runs
   `scripts/ci/assert-governed-actor.py --surface uat`, which checks the dispatching actor
   against `config/ci-governance.json → uat.manual_dispatch_users`. Read it from `origin/main`,
   never from your checkout — a local tree that is a few commits behind gives a stale answer:
   ```bash
   git fetch --no-tags origin main
   git show origin/main:config/ci-governance.json \
     | python3 -c "import json,sys; print(json.load(sys.stdin)['uat']['manual_dispatch_users'])"
   ```
   Not listed → ask a governance owner for a `chore(governance)` PR adding you. That is the
   whole grant process; there is no GitHub-settings step, and no Apple-side step.

3. **Does my token have the `workflow` scope?** This is the trap that looks like nothing: the
   dispatch fails **client-side**, *no run is ever created*, and the Actions page just stays
   empty with no error anywhere. If your dispatches never appear:
   ```bash
   gh auth refresh -h github.com -s repo,workflow
   ```
   The Actions UI (step 2b) has no such trap — prefer it if the CLI ever goes quiet.

## 1. Pick the SHA

Build an exact, immutable commit that is **already on `main`**. Your fix must be merged first —
the workflow refuses any SHA that is not an ancestor of `origin/main`.

```bash
git fetch origin --prune
SHA=$(git rev-parse origin/main)     # or the mergeCommit of the PR you shipped
git merge-base --is-ancestor "$SHA" origin/main && echo "on main: ok"
```

Then confirm **Main Post-Merge Smoke** is **green — not queued** — for that SHA. The gate
(`scripts/ci/require-deploy-sha-on-main.sh`, with `REQUIRED_CHECK_NAME="Main Post-Merge Smoke
Gate"`) treats a *queued* run exactly like a red one, and the refusal reads like a permissions
problem when it is really a timing problem:

```bash
gh run list --repo hushh-labs/hushh-research \
  --workflow=main-post-merge-smoke.yml --limit 3
```

Merged is not enough. Green is enough.

## 2a. Dispatch (CLI)

```bash
gh workflow run ship-ios-testflight.yml --repo hushh-labs/hushh-research \
  --ref main -f sha="$SHA" -f notes="what you fixed / what to test"
```

- `--ref main` is mandatory. The workflow's first step reads `GITHUB_REF_NAME` and refuses
  anything else. This is separate from `sha` — the ref says which workflow file to run, `sha`
  says which commit to build.
- Leaving `sha` blank defaults to latest `origin/main`. Passing it explicitly is better: it is
  what you verified in step 1.
- Dispatches are serialized repo-wide by a `concurrency` group, so a second run queues behind
  the first rather than racing it for a build number.

## 2b. Dispatch (browser — zero install, recommended on Windows)

**Actions → Ship iOS to TestFlight → Run workflow.** Set *"Use workflow from"* to **`main`**,
paste the SHA (or leave blank), fill `notes`, run. Same gates, same result, no `gh`, no token
scope to get wrong.

## 3. Watch it to completion

```bash
sleep 10
RUN_ID=$(gh run list --repo hushh-labs/hushh-research --workflow=ship-ios-testflight.yml \
  --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --repo hushh-labs/hushh-research --exit-status
```

Expect **13–35 minutes** against a 40-minute timeout. A cold Swift package graph (Firebase,
gRPC, Facebook) is the slow case; the SPM cache makes later runs much faster. A build that dies
in seconds is a gate rejection, not a build failure — read the failing step name.

## 4. Verify — do not stop at "workflow green"

1. Read the run's **job summary**: SHA, marketing version, resolved build number, bundle,
   backend `UAT (hushh-pda-uat)`, and mode. Never assume the version or build number — the
   workflow resolves both and prints them.
2. Wait for Apple to finish processing (usually a few minutes after the run goes green).
3. Open **TestFlight on your iPhone** and confirm that exact version + build number is the one
   installed. It arrives already compliant — `ITSAppUsesNonExemptEncryption=false` is in
   `Info.plist`, so there is no "Missing Compliance" click.
4. Exercise the fix on device. The build talks to the **UAT** backend, asserted during prep by
   `verify-ios-bundled-backend.sh`.

Report with evidence: run URL and conclusion, the SHA built, the version+build installed, and
what you saw on the phone — not "should be there".

## Isolating a failure with `dry_run`

`-f dry_run=true` archives, signs, and exports the `.ipa` **without uploading**. Use it to prove
the web build, Capacitor sync, SPM resolve, archive, and signing all work after any change to
signing or secrets. It will not catch upload-time or App Store Connect-side problems.

Either way, the run uploads an artifact named `ios-testflight-<build>` (14-day retention) with
the `.ipa`, dSYMs, and both `xcodebuild` logs — that is where a compile or signing error is
actually readable.

## Hard rules

- **Never hand-build and upload from a laptop.** The pipeline is the only lane. It resolves a
  monotonic build number against App Store Connect (`scripts/ci/resolve-ios-build-number.py`);
  a manual upload collides with it and Apple rejects the duplicate.
- **This is not an App Store release.** Public submission is a different workflow
  (`release-ios-appstore.yml`), a different and much smaller allowlist, and an irreversible
  action. UAT dispatch authority is not App Store authority.
- **Swift changes are only compiled here.** CI has no macOS lane — every job in `ci.yml` is
  `ubuntu-latest` — so nothing under `hushh-webapp/ios/**` is type-checked on a PR. A Swift
  change first compiles in *this* workflow, after it has already landed on `main`. Land Swift
  changes deliberately and dispatch a `dry_run` immediately.
- **Never read or copy secret values** while debugging. Missing-secret errors name the secret;
  fixing them is a governance-owner action in `hushh-pda-uat`, not something to work around.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| No run appears at all after `gh workflow run` | Token missing the `workflow` scope (step 0.3). Nothing reached GitHub. |
| Fails in ~20s at *Authorize dispatching actor* | Your login is not in `uat.manual_dispatch_users` (step 0.2). |
| `Refusing iOS ship from '<branch>'` | You dispatched with the wrong `--ref`. It must be `main` (step 2a). |
| `not reachable from origin/main` | Your fix is not merged yet. Merge first. |
| `no required check ... is successful` | Post-merge smoke is queued or red for that SHA. Wait for green (step 1). |
| `Missing GCP secret …` | Secret absent in `hushh-pda-uat`, or the CI service account lost access. Governance owner fixes it. |
| `Invalid Pre-Release Train … is closed` / `must contain a higher version` | The marketing version is closed on Apple's side. `MARKETING_VERSION` must be bumped and landed on `main`. A `dry_run` will NOT catch this. |
| Duplicate build number rejected | The ASC builds API lagged behind a just-uploaded build. Re-run; the resolver will see the sibling and pick N+1. |
| Build stuck `PROCESSING` on Apple's side | Apple-side delay, not a pipeline failure. The run is already green; wait. |
| dSYM "Upload Symbols Failed" warnings | Non-fatal Firebase/Google framework noise. Does not fail the upload. |
| `cap:build` killed with no error | Runner ran out of memory. Report it — it needs a workflow change, not a retry. |

## When you cannot get on device fast enough

The merge-first rule means you cannot put an unmerged branch on your phone. Before reaching for
a build, try the two loops that need no pipeline at all:

- `npm run --prefix hushh-webapp dev` with `NEXT_PUBLIC_BACKEND_URL` set to the UAT backend —
  the same frontend the app ships, in a desktop browser.
- **Mobile Safari on your iPhone against the UAT web app.** Same WebKit engine as the app's
  webview, so layout, safe-area, scroll, and keyboard bugs reproduce there instantly.

Reserve TestFlight builds for what genuinely only exists in the native shell: the Capacitor
plugins, push notifications, Sign in with Apple, and anything touching the keychain.
