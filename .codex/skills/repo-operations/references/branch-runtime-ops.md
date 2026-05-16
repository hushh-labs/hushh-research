# Branch And Runtime Ops

Use this reference for repo-operations tasks involving branch preservation,
push safety, local runtime terminals, deploy cadence, and UAT release gates.

## Branch Preservation

1. Record `git status --short --branch` before branch, CI, deploy, PR, or
   hotfix work.
2. Treat the user's active development branch as the return target.
3. Do not create temporary branches for routine follow-up work.
4. Use a temporary branch only for explicit isolation, a hotfix from latest
   `main`, or unsafe unrelated in-flight changes.
5. After temporary hotfix merge/validation, delete the temp branch when safe,
   return to the preserved development branch, and back-sync landed `main`.
6. Do not leave the workspace detached, parked on `main`, or parked on a temp
   branch unless the user explicitly asked for that state.

## Commit And Push Safety

1. Before every commit or push, classify remaining dirty files as included,
   intentionally excluded, or blocking.
2. If the user asks to push the full tree, run secret hygiene first and stage
   the full tree unless a file is unsafe to publish.
3. Before every PR update, verify commits in `origin/main..HEAD` carry DCO
   signoff trailers.
4. After subtree sync, merge, rebase, squash, or automated repair, rerun the
   DCO signoff check before pushing.
5. For `.codex/`, docs, config, scripts, or governance surfaces, rerun the
   governance orchestrator after final local edits.

## Runtime Terminals

1. Default local runtime launch is visible OS terminal windows.
2. Use inline Codex sessions only when the user explicitly asks for inline,
   background, or in-Codex logs.
3. Prefer separate backend and web terminals unless one combined stack terminal
   is explicitly requested.
4. For restarts, stop repo-launched listeners, terminate shells cleanly, verify
   ports are free, then relaunch.
5. Do not claim restart success until backend health and web origin respond.
6. If frontend does not bind, verify package-local Next resolution and repair
   through canonical bootstrap before retrying.

## Merge, Deploy, And UAT

1. `merge to main` means land and monitor through `Main Post-Merge Smoke` only.
2. `deploy to UAT` is separate: land on `main`, identify the green SHA,
   dispatch UAT deploy for that SHA, and monitor terminal status.
3. Monitor `PR Validation`, `Queue Validation`, `Main Post-Merge Smoke`,
   `Deploy to UAT`, and RCA-triggered release authority runs until terminal.
4. Core runs in `queued`, `in_progress`, or `requested` state mean the task is
   not complete.
5. For UAT runtime failures, start with the repo RCA command and classify
   secret drift, runtime mounts, DB drift, and semantic breakage before editing.

## DB Release Gate

For changes touching DB migrations, DB contracts, or the release manifest:

1. Run DB release-contract verification from the exact code SHA.
2. Run live UAT schema verification and save a report.
3. If UAT lacks a required table, column, function, trigger, or version, apply
   only the specific ordered migration needed and rerun the live guard.
4. Report the DB guard separately from app deploy health.

## Live Environment Checks

1. Branch protection, merge queue, release authority, and production deploy
   governance need live GitHub or runtime verification.
2. Firebase Auth readiness requires checking shared auth project, API key
   restrictions, auth domain, authorized domains, phone provider state, and app
   verification flag separately.
3. Local real-SMS throttling is not proof that UAT auth is misconfigured.
