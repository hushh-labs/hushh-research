---
name: ship-without-actions
description: The complete release pipeline for when GitHub Actions is unavailable — runs every CI check, then deploys, as one command. Use when Actions runs sit queued or never start, when a deploy fails at "Validate deployment SHA against main", when someone says "GitHub Actions is down" / "deployment is down" / "runners are stuck", when asked to "run all the CI checks locally" or "verify before deploying", or when work must ship and the governed workflow cannot be scheduled.
---

# Shipping when GitHub Actions is down

When runners disappear, the checks and the deploy are both still perfectly
runnable. What disappears is the thing that **runs them in order and refuses to
continue when a step fails**. That ordering is the actual product of a CI/CD
system, and restoring it is what this skill is for.

```bash
scripts/ops/release_pipeline.sh --env production
```

That one command is the whole pipeline:

```
PREFLIGHT  →  VERIFY  →  DEPLOY  →  PROVE  →  REPORT
```

Each stage refuses to start unless the one before it passed.

## First: is Actions actually down?

Actions being *slow* and Actions being *broken* look identical from the deploy
workflow's error message, and only one of them justifies this path.

```bash
gh run list --limit 15
gh run list --workflow=main-post-merge-smoke.yml --limit 8
```

You are in an outage when runs sit in `queued` far past their historical
duration, or when a push produces **no run at all**. A run that reached
`completed / failure` is a real failure — fix the code.

The symptom that sends people here: a deploy failing at **"Validate deployment
SHA against main"**. That step is not testing your code. It runs
`require-deploy-sha-on-main.sh` with `REQUIRE_CI_SUCCESS=1` and
`REQUIRED_CHECK_NAME="Main Post-Merge Smoke Gate"`, so a smoke run that is merely
*queued* fails it exactly like a red one. The deploy is blocked by a **missing**
verdict, not a bad one.

## What each stage does

**1. PREFLIGHT** — resolves the commit, proves it is a real ancestor of
`origin/main`, and confirms this account can actually finish a deploy. Authority
is checked *before* the checks run, so a permission wall is discovered while it
is still cheap rather than after an hour of testing.

**2. VERIFY** — runs every check Actions would run, against the exact commit, in
a throwaway git worktree. The worktree matters: other agents share this checkout,
and a pipeline that ran `git checkout` under them would destroy uncommitted work.

**3. DEPLOY** — builds through the same `deploy/*.cloudbuild.yaml` configs the
governed workflow uses, deploys with `--no-traffic`, promotes explicitly, then
verifies provenance, environment parity and HTTP health. A failed health check
rolls traffic back to the previous working revision.

**4. PROVE** — reads the `deploy-sha` label off the revision actually serving
traffic and compares it to what you shipped. This answers the question a person
really asks after a deploy: *is my commit the one serving?*

**5. REPORT** — writes the evidence: which checks ran, the toolchain used, which
revisions are live.

## The safety properties, and why they exist

- **DEPLOY is unreachable without a complete, green VERIFY on the same commit.**
  `--from deploy` does not bypass this — the report check runs even when VERIFY
  is skipped, so resume cannot be used to sneak past verification.
- **A partial run cannot authorize a deploy.** `--fast-gate` or a single stage
  records `complete: false`. A partial run must never be mistaken for a verdict.
- **A commit that never landed on main is always refused**, even with
  `--skip-ci-check`. Shipping code that is not on main is a worse failure than a
  delayed release.
- **UAT is refused, on purpose.** See below.

## UAT cannot be deployed this way, and that is correct

`hushh-pda-uat` carries an IAM **deny** policy, `uat-deploy-authority-lock`, that
blocks `cloudbuild.builds.create` and `run.services.*` for everyone except the CI
deployer service account. Deny policies are invisible to `get-iam-policy`, so
`roles/run.admin` will look granted while every real call returns 403.

It is a working safety control that forces UAT through the governed path. **Do
not remove it, do not grant yourself token-creator on the deployer service
account, and do not route around it with a Cloud Build trigger.** The pipeline
checks effective permissions in PREFLIGHT and stops before mutating anything.

Production and dev are reachable. For UAT, the honest answer is to wait for
runners.

Check any project's real authority with:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["cloudbuild.builds.create","run.services.update"]}' \
  "https://cloudresourcemanager.googleapis.com/v1/projects/<PROJECT>:testIamPermissions"
```

## Running only the checks

The gate is usable on its own, and is the fastest way to know if a branch is
shippable:

```bash
scripts/ci/local-release-gate.sh --list      # stage → GitHub check mapping
scripts/ci/local-release-gate.sh --fast      # tight loop while iterating
scripts/ci/local-release-gate.sh --stage protocol
scripts/ci/local-release-gate.sh             # full gate; required before a deploy
```

Eleven stages stand in for the named GitHub jobs: `secret`, `governance`, `dco`,
`pr-base-policy`, `main-freshness`, `web-core`, `web-targeted`, `protocol`,
`mcp-package`, `integration`, `smoke`.

It differs from `orchestrate.sh all` in three ways that matter when shipping:
`all` stops at the first failing stage, omits `smoke` (the stage the deploy gate
names), and omits the three PR-shaped checks. This runs everything, keeps going
past failures so you get the whole list at once, and writes a report.

Two things it genuinely cannot reproduce, recorded in the report's `not_covered`
rather than quietly skipped: GitHub's secret-scanning and dependabot alert
*state* beyond what an authenticated `gh` can read, and the merge commit GitHub
itself would construct.

## Reading failures honestly

**A stage that fails in under three seconds never reached real work.** It died on
argument parsing or a missing tool. The gate says so explicitly. "Failed" and
"never ran" are different problems and only one is about your code — treating a
setup failure as a code failure is how people lose an afternoon.

The same instinct applies in reverse: a scan whose range resolved to zero commits
is an *unrun* scan, not a passing one.

### The two toolchain traps in this repo

Both produce failures that look like real defects. The gate now handles both, but
recognize them anyway:

**Node.** CI pins 24. On Node 20, `child_process.exec` caps captured stdout at
8192 bytes, so `packages/hushh-mcp`'s tests parse a truncated 36KB manifest and
fail with `Unterminated string in JSON at position 8192`. That reads as a corrupt
gateway manifest; it is a version skew. The tell is the number — 8192 is a buffer
boundary, and real data does not end on one by coincidence. Measured: 8,192 bytes
captured on Node 20 versus 30,956 on Node 24. The gate borrows a matching Node
from nvm for its own subprocesses and leaves your default alone. If none is
installed: `nvm install 24`.

**Python.** CI runs 3.13. A bare `python3` on macOS is often the system 3.9,
which has no `tomllib` and no `PyYAML`, so governance dies with
`No module named 'tomllib'`. The gate prefers `consent-protocol/.venv` because
that is what CI provisions and it carries the deps a bare 3.13 lacks — it also
brings the repo-pinned `ruff`, which the pre-commit hook expects. A newer system
`ruff` reports format diffs on files you never touched. If the venv is missing:
`(cd consent-protocol && uv sync --frozen --group dev)`.

## Fallback releases are labelled as fallback

Revisions deployed this way carry `_DEPLOY_SOURCE=cloudbuild-fallback-<env>`
instead of `deploy-production`. That is deliberate: it makes a fallback release
visible in `gcloud run revisions describe` and in provenance reports. **Do not
relabel it to impersonate the governed lane** — the label is how the next person
knows which releases bypassed Actions.

Once runners recover, re-run the governed workflow for the same commit so the
release carries normal provenance, and confirm the serving revision's
`HUSHH_DEPLOY_SOURCE` no longer reads `cloudbuild-fallback-*`.

## Getting a verdict back to GitHub

The gate proves the code; it does not tell GitHub. Every deploy workflow polls
for a check named exactly `Main Post-Merge Smoke Gate`. To close that loop,
`deploy/ci.cloudbuild.yaml` can run the same stages on Cloud Build and publish a
check-run:

```bash
gcloud builds submit --no-source --project=hushh-pda-dev \
  --config=deploy/ci.cloudbuild.yaml \
  --substitutions=_SHA=<sha>,_STAGE=smoke,_PUBLISH_CHECK=true
```

It uses `--no-source` deliberately: this repo's `.gcloudignore` excludes `.git/`,
`*.sh`, `*.md`, `docs/` and `tests/` because it is tuned for the Docker deploy
builds, so a CI run on that upload would be missing every `scripts/ci/*.sh`. Step
0 clones the repo (public, no credentials) at the commit with full history.

Publishing a check-run is a claim that a gate passed. Only set
`_PUBLISH_CHECK=true` when the build genuinely ran that stage green on that exact
commit.

**None of this is a reason to relax branch protection.** If the gate is green and
the change still cannot merge, that is a scheduling problem to wait out or
escalate — not a control to switch off.

## Writing a new Cloud Build config here

Cloud Build resolves `$VAR` / `${VAR}` **before bash runs**. A name that is
neither a declared `_SUBSTITUTION` nor a built-in fails the build; no config in
this repo enables `ALLOW_LOOSE`.

- Shell locals must be **lowercase**: `node_version`, `${config_arg[@]}`.
- Real environment variables must be escaped **`$$VAR`**: `$$PATH`.
- Never a bare uppercase `${VAR}` for a shell variable.

Keep each step's inline bash under 10,000 characters — Cloud Build's cap on a
single step arg, which has taken all three deploy lanes down twice.
`consent-protocol/tests/test_cloudbuild_step_arg_limit.py` enforces it, and any
new config must be added to its `CLOUDBUILD_CONFIGS` list.

## Repo facts worth not rediscovering

- `deploy/` and `scripts/ci/` are `protected_pipeline_paths`; edits are gated by
  an actor allowlist in `config/ci-governance.json`.
- `verify-runtime-config-contract.py` forbids legacy runtime key names **anywhere
  in a tracked file** — including a local shell variable, and including prose in
  a markdown file that only mentions one.
- `resolve-deploy-scope.py --json` emits real JSON booleans; Python's `print()`
  renders them `True`/`False`, which never matches a lowercase `"true"` shell
  comparison.
- When a route is added, three generated artifacts must be regenerated or
  Governance fails closed: the cache-coherence manifest, the route orchestration
  index, and the runtime topology index. This has already shipped a red `main`
  once.
