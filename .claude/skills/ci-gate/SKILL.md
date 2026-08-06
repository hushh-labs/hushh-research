---
name: ci-gate
description: Run every CI check GitHub Actions would run, in one command, and get a verdict that can authorize a deploy. Use before pushing, before merging, when Actions runners are queued or unavailable, when asked to "run CI locally" / "run all the checks" / "verify before deploy", or when a deploy is blocked because a required check never reported. Produces the signed report that scripts/ops/cloudbuild_release.sh requires under --skip-ci-check.
---

# The CI gate

One command runs every check GitHub Actions runs and writes a verdict keyed to
the exact commit:

```bash
scripts/ci/local-release-gate.sh
```

The checks were never coupled to GitHub. `scripts/ci/orchestrate.sh` is the
canonical stage runner and describes itself as being for "GitHub Actions and
local CI wrappers" — Actions is one caller, this is another. What Actions adds
is scheduling, a check-run name, and the PR event payload.

## What it covers, and what it cannot

`scripts/ci/local-release-gate.sh --list` prints the live mapping. Each stage
stands in for a named GitHub job:

| Stage | Stands in for | In `--fast` |
|---|---|---|
| `secret` | Secret Scan | yes |
| `governance` | Governance | yes |
| `dco` | DCO | yes |
| `pr-base-policy` | PR Base Policy | yes |
| `main-freshness` | Base Freshness Gate | yes |
| `web-core` | Web Core (Next.js) | no |
| `web-targeted` | Web Targeted Contracts | no |
| `protocol` | Protocol (Python) | no |
| `mcp-package` | MCP Package | no |
| `integration` | Integration | yes |
| `smoke` | Main Post-Merge Smoke Gate | no |

Two things it genuinely cannot reproduce, and does not pretend to: GitHub's
secret-scanning and dependabot alert *state* beyond what an authenticated `gh`
can read, and the merge commit GitHub itself would construct and build. Both are
recorded in the report's `not_covered` field rather than quietly omitted.

## Why not just `orchestrate.sh all`

`all` is the right tool when you want a quick local parity check. It is the
wrong tool for authorizing a deploy, for three reasons:

- **It stops at the first failing stage.** When you are trying to ship you want
  the whole list of what is broken, not a fresh single failure every twenty
  minutes.
- **It omits `smoke`** — which is the stage the deploy gate actually names.
- **It omits `dco`, `pr-base-policy` and `main-freshness`**, which `CI Status
  Gate` lists in its `needs`.

The gate runs everything, keeps going past failures, and writes a report.

## The report is what makes it a gate

Every run writes `hushh-ci-gate-<sha>.json` with the per-stage results and two
fields that matter: `verdict` and `complete`. `scripts/ops/cloudbuild_release.sh
--skip-ci-check` refuses to deploy without one:

```
No local gate report for <sha>.
--skip-ci-check replaces the GitHub check with a local run; it does not remove
the requirement to verify.
```

A `--fast` or single-stage run sets `complete: false` and **cannot** authorize a
deploy — a partial run must never be mistaken for a full verdict. That is the
whole point: during an outage the green check is replaced by a real local run,
not by a waiver.

Normal working loop:

```bash
scripts/ci/local-release-gate.sh --fast          # tight loop while iterating
scripts/ci/local-release-gate.sh --stage protocol # one lane you just touched
scripts/ci/local-release-gate.sh                  # full gate before deploying
```

## Reading a failure honestly

The gate flags any stage that fails in under three seconds:

> `(failed in 1s -- suspect setup/arguments, not the code under test)`

A stage that dies that fast never reached real work — it died on argument
parsing or a missing tool. "Failed" and "never ran" are different problems and
only one of them is about your code. Treating a setup failure as a code failure
is how people spend an hour debugging a working feature.

The same instinct applies to a stage that passes *suspiciously* fast: a scan
whose range resolved to zero commits is an unrun scan, not a passing one.

## The Python trap this repo will hand you

CI runs Python 3.13. A bare `python3` on macOS is usually the system 3.9, which
has no `tomllib` and no `PyYAML`, so the governance stage dies with
`No module named 'tomllib'` — a failure that reads exactly like a code problem
and is not one.

The gate resolves a correct interpreter itself and puts it first on `PATH`,
preferring `consent-protocol/.venv/bin` because that is what CI provisions and
it carries the deps a bare 3.13 install lacks. It also brings the repo-pinned
`ruff`, which is what the pre-commit hook expects — a newer system ruff will
report formatting diffs on files you never touched.

If no suitable interpreter exists the gate stops with instructions rather than
producing false failures:

```bash
(cd consent-protocol && uv sync --frozen --group dev)
```

## When runners are down

This gate gives you the verdict; it does not give GitHub the check. Those are
separate problems:

- To get a **verdict** on the code: run this gate.
- To get a **deploy** out: `scripts/ops/cloudbuild_release.sh`, which consumes
  the gate's report. See the `cloudbuild-ci-fallback` skill for the deploy lane,
  the UAT authority boundary, and the Cloud Build substitution rules.

Neither is a reason to relax branch protection. If the gate is green and the
change still cannot merge, that is a scheduling problem to wait out or escalate,
not a control to switch off.

## Related repo facts

- The gate reads `origin/<base>` for the freshness and DCO ranges, so
  `git fetch origin` first if the clone is stale.
- `scripts/ci/verify-runtime-config-contract.py` forbids legacy runtime key
  names **anywhere in a tracked file**, including as a local shell variable.
  `FRONTEND_URL` is forbidden; use `APP_FRONTEND_ORIGIN` for the public origin,
  or a distinct name like `FRONTEND_SERVICE_URL` for a Cloud Run service URL.
- Other agents share the primary checkout. Use a git worktree for anything
  non-trivial, and note a fresh worktree has no `consent-protocol/.venv` until
  you create one.
