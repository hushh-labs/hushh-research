# Release Diagnostics

The Wallet release on 2 September 2026 established these checks.

- **Deploy-surface changes get their own local proof before the PR.** When `deploy/`,
  a workflow substitution string, or an agent manifest changes, run
  `consent-protocol/tests/test_cloudbuild_step_arg_limit.py` (the 10,000-character Cloud Build arg cap,
  per-lane after substitution) and the readiness probe's manifest collection
  (`consent-protocol/scripts/verify_managed_vertex_runtime.py` (its manifest model collection) with the lane's
  `HUSSH_GEMINI_TEXT_MODEL`). A protocol lane that stops at mypy never reaches pytest, so
  a "clean" local run can hide a failing test; rerun the lane after the mypy fix.
- **A lane's Gemini project is not the deploy project.** UAT deploys to `hushh-pda-uat`
  but its Gemini calls go to `hushh-gemini-bridge`; a model admitted in one allowlist can
  still be rejected by the other. Probe the lane's Gemini project directly before flipping
  the fleet model switch for that lane.
- **Prove a run's conclusion, never its watcher.** `gh run watch --exit-status` reported
  exit 0 for a failed UAT deploy; read `gh run view <id> --json conclusion` and the
  job list before acting on a result.
- **The serving worktree never switches branches.** The founder's localhost was served
  from an ADK worktree; while it sat on a release branch, the old
  wording came back on screen. Land from the workstream branch, fast-forward it after
  each landing, and give scratch work its own worktree.

## Authentication and evidence

Use verified ADC for local admin reads as `kushal@hushh.ai`, independently of
the selected gcloud CLI account. Verify the principal, project, and exact
authorized read. Distinguish authentication failures from permission denials.
Keep approved secret reads and any ephemeral `CLOUDSDK_AUTH_ACCESS_TOKEN` in
process memory. Preserve the existing IAM and impersonation boundaries. Hosted
deployment uses the workflow's workload identity. Renew ADC only when the
approved identity cannot refresh.
