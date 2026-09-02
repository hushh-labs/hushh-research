# Admin Merge And Release SOP

This is the canonical authority contract for merging, Admin PR landing, and
deploying Hussh environments. Every skill or workflow that reaches a merge,
deployment, rollback, or environment-promotion decision must route here through
`repo-operations`; it must not carry a competing release procedure.

## Authority boundaries

1. Record and preserve the developer's starting branch. Branch switching,
   approval, merge, deploy, credentials, rollback, and final release decisions
   stay in the parent session.
2. The ordinary path is PR validation followed by the GitHub merge queue.
3. An Admin PR landing is a queue bypass, not a validation bypass. Use it only
   when the user explicitly authorizes the Admin SOP for that PR.
4. A direct `git push` to `main` is a separate emergency path governed by the
   Direct Main Admin Push Preflight in `branch-runtime-ops.md`. Never substitute
   that push preflight for the Admin PR landing gate below.
5. Merge, post-merge smoke, UAT, production, and native release are separate
   authority transitions. Do not infer or dispatch a later transition unless
   the user requested it.
6. Hosted Cloud Run UAT and production use their own governed GitHub
   environments and workload identities. Never copy UAT credentials, secrets,
   or runtime identity into production. Native/App Store builds follow their
   separate release contract and may intentionally target a UAT-backed binary;
   do not reinterpret that product contract as Cloud Run credential reuse.

## State machine

### 1. Preserve and refresh

1. Record `git branch --show-current` and `git status --short --branch`.
2. Fetch `origin/main` and the active remote branch. Continue on the preserved
   branch; do not create a convenience release branch.
3. If the shared branch is behind, use the normal freshness contract in
   `maintainer-branch-freshness.md`. Re-run checks after any history change.

### 2. Prove the exact PR head

Before queue or Admin action, record the PR number, base, head branch, exact head
SHA, author, review state, mergeability, and check rollup from live GitHub state.

Required pre-merge proof:

1. base/lane is allowed by `config/ci-governance.json` and PR Base Policy;
2. local changed-surface checks, DCO, secret hygiene, and governance checks pass;
3. every required check on the exact current PR head is terminal and successful;
   intentionally skipped path lanes are recorded as evidence, while unexpected
   auxiliary failures still block;
4. unresolved conversations, merge conflicts, and freshness drift are cleared;
5. the head SHA is re-read immediately before the state-changing command.

### 3A. Ordinary merge-queue path

1. Request merge for the exact head with `gh pr merge <pr> --merge
   --match-head-commit <head-sha>`.
2. Confirm actual queue entry from live merge-queue state. Auto-merge enabled or
   a successful CLI response is not by itself proof that the PR entered queue.
3. Monitor `Queue Validation` to terminal state and, if landed, continue through
   `Main Post-Merge Smoke` for the landed `main` SHA.
4. If independent approval or approval-of-latest-push blocks queue entry, report
   that blocker and obtain the required review. Do not claim the PR is queued.

### 3B. Explicit Admin PR landing

Use this only after the user explicitly requests the Admin SOP and queue entry is
blocked or the user explicitly chooses the governed bypass.

Admin PR landing preflight:

1. prove the active GitHub actor is the intended governed maintainer;
2. prove that actor is present in both `main.review_bypass_users` and
   `main.merge_queue_bypass_users`;
3. verify live branch protection with
   `./scripts/ci/verify-main-branch-protection.sh`;
4. require every required PR check on the exact head SHA to be terminal and
   successful; record intentional path-lane skips and block on unexpected
   auxiliary failures;
5. require clean mergeability, no unresolved conversations, DCO, secret hygiene,
   and changed-surface verification; classify unrelated local changes and stop
   only when they overlap or make exact-head proof unsafe;
6. re-read the PR head SHA and abort if it differs from the reviewed SHA.

Then land only that reviewed head:

```bash
gh pr merge <pr> --admin --merge --match-head-commit <head-sha>
```

Report this truthfully as an Admin queue bypass. Never describe it as merge-queue
execution or claim `Queue Validation` ran when it did not. Monitor the resulting
`Main Post-Merge Smoke` for the exact landed `main` SHA.

### 4. Establish deploy authority

1. Resolve the landed `main` SHA from GitHub after merge; never reuse the PR head
   SHA or a local SHA by assumption.
2. Require `Main Post-Merge Smoke Gate = success` for that exact landed SHA.
3. Default UAT scope to `auto`. The workflow compares the target SHA with each
   service's currently deployed SHA, so it safely includes every merge since the
   deployed baseline—not only the latest PR or commit. Record its requested and
   resolved scope. Force `frontend`, `backend`, or `all` only after comparing the
   complete target-to-deployed-service deltas and documenting why the automatic
   resolver is insufficient.
4. Read the exact-SHA verification-plan artifact. It alone selects PKM and BYOK
   reviewer lanes; do not invent a second path classifier.

### 5. Dispatch only the requested environment

UAT:

```bash
gh workflow run deploy-uat.yml --ref main -f scope=auto -f sha=<landed-main-sha>
```

Production:

```bash
gh workflow run deploy-production.yml --ref main -f scope=<frontend|backend|all> -f sha=<approved-main-sha>
```

Production requires an explicit production request and an actor in
`production.manual_dispatch_users`. UAT success does not authorize production.

### 6. Monitor and prove

1. Watch each dispatched run until terminal success or a concrete blocker.
2. Confirm requested/resolved scope and skipped lanes.
3. Capture release artifacts plus the touched services' project, discovered
   region, ready revision, image digest/tag, deploy SHA/run labels, timeout,
   traffic, applicable schema/semantic result, and live request or log evidence.
   UAT and production both require exact revision provenance and a consolidated
   release-status artifact; environment-specific semantic gates remain explicit
   in their owning workflow and report.
4. Prefer workflow artifacts as authoritative proof. If local `gcloud` user auth
   is stale but ADC is valid, an evidence-only helper may receive an ephemeral
   `CLOUDSDK_AUTH_ACCESS_TOKEN` sourced from ADC in the same process. Never print,
   persist, or move that token between environments.
5. A warning-only evaluator does not authorize rollback by itself. Runtime
   health, provenance, schema, or semantic authority failures follow the owning
   workflow's bounded rollback contract. Humans do not repair traffic with an
   ad hoc `gcloud run deploy` or `update-traffic` command.

### 7. Close out

1. State which path ran: merge queue, Admin PR landing, or direct-main emergency
   push. Never collapse those labels.
2. Report PR, workflow, run, and artifact links; exact PR head and landed/deployed
   SHAs; environment; scope; revisions; traffic; and remaining risk.
3. Restore the preserved developer branch, back-sync landed `main` when needed,
   remove only temporary branches created by this session, and leave the tree
   clean.

### Lessons from the 2026-09-02 Wallet release

- **Deploy-surface changes get their own local proof before the PR.** When `deploy/`,
  a workflow substitution string, or an agent manifest changes, run
  `tests/test_cloudbuild_step_arg_limit.py` (the 10,000-character Cloud Build arg cap,
  per-lane after substitution) and the readiness probe's manifest collection
  (`scripts/verify_managed_vertex_runtime.py::_managed_manifest_models` with the lane's
  `HUSSH_GEMINI_TEXT_MODEL`). A protocol lane that stops at mypy never reaches pytest, so
  a "clean" local run can hide a failing test; rerun the lane after the mypy fix.
- **A lane's Gemini project is not the deploy project.** UAT deploys to `hushh-pda-uat`
  but its Gemini calls go to `hushh-gemini-bridge`; a model admitted in one allowlist can
  still be rejected by the other. Probe the lane's Gemini project directly before flipping
  the fleet model switch for that lane.
- **Prove a run's conclusion, never its watcher.** `gh run watch --exit-status` reported
  exit 0 for a failed UAT deploy; read `gh run view <id> --json conclusion` and the
  job list before acting on a result.
- **The serving worktree never switches branches.** The founder's localhost is served
  from `.claude/worktrees/adk-orchestration`; while it sat on a release branch, the old
  wording came back on screen. Land from the workstream branch, fast-forward it after
  each landing, and give scratch work its own worktree.

## Stop conditions

Stop rather than improvise when the exact head changes, required checks are not
terminal green, deploy SHA is not reachable from `main`, post-merge smoke is not
green, actor authority is absent, environment identity is ambiguous, provenance
does not match, or a rollback target cannot be proved.
