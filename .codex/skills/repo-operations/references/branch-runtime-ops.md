# Branch And Runtime Ops

Use this reference for repo-operations tasks involving branch preservation,
push safety, local runtime terminals, deploy cadence, and UAT release gates.

## Branch Preservation

1. Record `git status --short --branch` before branch, CI, deploy, PR, or
   hotfix work.
2. Treat the user's active development branch as the return target.
3. Do NOT create a new branch for follow-up, continuation, or "phase N" work.
   Continue on the existing development branch the user named or was last on.
   Creating a branch is a non-routine action: ask the user first, or only do it
   when the user explicitly requested a new branch.
4. The ONLY times a new/temporary branch is allowed without asking: explicit
   user instruction, a hotfix branched from latest `main`, or genuinely unsafe
   unrelated in-flight changes that must be isolated. "It felt cleaner to
   isolate the new work" is NOT a valid reason.
5. When continuation work spans multiple existing branches (e.g. our merged
   work plus a teammate's feature branch), apply it to each named existing
   branch via cherry-pick; do not invent a third aggregation branch.
6. After temporary hotfix merge/validation, delete the temp branch when safe,
   return to the preserved development branch, and back-sync landed `main`.
7. If you discover you created a branch you should not have, move the real
   commits back onto the correct existing branch(es) and delete the stray
   branch (local AND remote if it was pushed but never merged); state the
   correction to the user.
8. Do not leave the workspace detached, parked on `main`, or parked on a temp
   branch unless the user explicitly asked for that state. If branch switching
   happened mid-task (including from another terminal), switch BACK to the
   developer's starting branch before handoff and say so.
9. HARD CLEANUP RULE: always delete temporary branches you created, both local
   and remote, once the work is safely preserved on the kept branches. Before
   deleting, verify every unique commit/file is represented on a branch you are
   keeping (`git --no-pager log --oneline <kept-branch> | grep <subject>` for
   each piece). Close any throwaway PR opened from the temp branch. After
   cleanup, confirm: developer on their branch, no stray local temp branches
   (`git branch | grep -iE 'ship/|phase|tmp/'`), no stray remote temp branches
   (`git ls-remote --heads origin '*<name>*'`), no dangling throwaway PRs.

## Shared Branch A Teammate Is Actively Pushing

Use this when asked to "pull main into" or "update" a feature branch that
another developer is also pushing from a different machine (for example a
long-lived integration branch like `kai-voice-level3`).

1. Identify the canonical branch name exactly. A `feat/<name>` and a bare
   `<name>` (and any `<name>-main` or `backup/<name>-*`) can all coexist on
   `origin`; confirm with `git ls-remote --heads origin '*<name>*'` and treat the
   most recently advanced, least-behind-`main` ref as canonical.
2. `git fetch origin <branch> main` first, then read `git rev-list
   --left-right --count origin/main...origin/<branch>`.
3. If `origin/<branch>` is already `0` behind `origin/main`, the teammate has
   already merged `main`. Do not start a local `git merge origin/main` — that
   races their push and can manufacture hundreds of phantom conflicts against a
   stale local line.
4. In that case, sync local to their authoritative remote with
   `git merge --ff-only origin/<branch>` (or `git switch -c <branch> --track
   origin/<branch>` if absent locally), then verify
   `origin/<branch>..origin/main` is empty.
5. Only run an actual `git merge origin/main` when `origin/<branch>` is
   genuinely behind `main` AND no teammate push is in flight. If a merge yields
   a very large conflict set, the local base is almost always stale — re-fetch
   and re-check canonical identity before resolving anything.
6. Never force-push or reset a shared branch a teammate is pushing. Preserve any
   superseded local line under a `_safety/<name>-...` tag before discarding it.

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

Telemetry-first default: when a coding agent is driving the work, run the server
IN the agent's own terminal session (in-process / background terminal) so the
agent streams live logs, errors, and telemetry directly. This is the default for
agent-run servers because direct log access is required for monitoring and fast
fix loops. Use a visible OS terminal window only when the developer explicitly
asks to watch logs themselves, or when the agent has no managed terminal.

Canonical local runtime = THREE separate in-session terminals, one per
component. There is no combined `stack` command — it was removed so each
component's telemetry stays isolated and readable. Launch each canonical command
DIRECTLY (not the `terminal` wrapper, which always pops a visible OS window),
each as its own background/async terminal in the agent:

1. Cloud SQL proxy — terminal 1: `./bin/hushh proxy --mode local`
2. Backend — terminal 2: `./bin/hushh backend --mode local --reload`
3. Frontend — terminal 3: `./bin/hushh web --mode local`

Notes:

- `--reload` on the backend is the native hot-restart: code edits auto-restart
  the worker, so most "restart" needs are handled without a manual kill.
- The proxy must be running (terminal 1) before the backend. The backend
  auto-detects an existing proxy listener on `127.0.0.1:<CLOUDSQL_PROXY_PORT>`
  (local default `6543`) and reuses it instead of spawning its own. If you run
  the backend without a standalone proxy, it will still start its own proxy as a
  child — but the canonical, telemetry-isolated flow is the three terminals
  above.
- Visible OS terminal windows (`./bin/hushh terminal proxy|backend|web`) are
  opt-in: use when the developer explicitly wants to watch logs themselves, or
  for a detached long-running session the agent does not need to read.

### What each component binds (all three)

1. Cloud SQL proxy (`./bin/hushh proxy --mode local` →
   `scripts/runtime/run_proxy_local.sh`) binds `127.0.0.1:6543` (local default
   `CLOUDSQL_PROXY_PORT`) to the configured Cloud SQL instance (e.g.
   `hushh-pda-uat:...:hushh-uat-pg`). Confirm in logs:
   `Starting Cloud SQL proxy for <instance> on 127.0.0.1:6543`.
2. Backend (`./bin/hushh backend --mode local --reload`) runs uvicorn on `:8000`
   (ENVIRONMENT=development for local). Confirm: `Uvicorn running on
   http://127.0.0.1:8000` and `Application startup complete`.
3. Frontend (`./bin/hushh web --mode local`) runs `npm run dev` (Next.js) on
   `:3000`.

To confirm all three are healthy in-session: `./bin/hushh doctor --mode local`,
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/docs` (expect 200),
web origin `http://localhost:3000`, and `lsof -ti :6543` (proxy) / `:8000`
(backend) / `:3000` (frontend) each showing a bound listener.

### Native restart playbook (agent-driven)

1. Prefer the built-in hot-reload first: with `--reload` running, a code change
   restarts the backend worker automatically — no manual restart needed.
2. For a full restart, stop the relevant agent-managed terminal cleanly (kill
   the managed terminal/process), then verify the ports are free before
   relaunching: `lsof -ti :6543` (proxy), `:8000` (backend), and `:3000`
   (frontend) should each be empty; if a stray listener remains, terminate it
   before relaunch.
3. Relaunch the same in-session command(s) from the three-terminal list; keep
   each terminal in the agent so telemetry resumes streaming immediately.
   Restart only the component that changed — e.g. backend code edits restart the
   backend terminal, frontend edits restart the web terminal, and the proxy
   rarely needs a restart.
4. Do not claim restart success until backend health and web origin respond
   (probe `./bin/hushh doctor --mode local` and the web origin / backend
   `/docs`).
5. If the frontend does not bind, verify package-local Next resolution and
   repair through canonical bootstrap (`./bin/hushh bootstrap --mode local`)
   before retrying.
6. For container-based local stacks, use `./bin/hushh compose up`,
   `./bin/hushh compose logs <service>`, and `./bin/hushh compose health` for
   the equivalent in-session telemetry and restart loop.

## Merge, Deploy, And UAT

1. `merge to main` means land and monitor through `Main Post-Merge Smoke` only.
2. Merge-to-main lane is decided by AUTHOR. A governed maintainer shipping their
   own code branches from `origin/main` and opens a PR DIRECTLY into `main` — no
   `integration/pr-train` detour, no cherry-pick, no promote-branch whitelist.
   The `PR Base Policy` gate authorizes this by actor identity; the CI status
   gate, merge queue, and post-merge smoke gate still apply. Non-maintainer PRs
   route through `integration/pr-train`. Never cherry-pick a train-built branch
   onto `main` (it references train-only code `main` lacks → dependency trap);
   branch from `origin/main` at the start instead.
3. `deploy to UAT` is separate: land on `main`, identify the green SHA,
   dispatch UAT deploy for that SHA, and monitor terminal status.
4. Monitor `PR Validation`, `Queue Validation`, `Main Post-Merge Smoke`,
   `Deploy to UAT`, and RCA-triggered release authority runs until terminal.
5. Core runs in `queued`, `in_progress`, or `requested` state mean the task is
   not complete.
6. For UAT runtime failures, start with the repo RCA command and classify
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
