# Pre-merge readiness exam

The pre-merge counterpart of the UAT readiness exam, under the
[readiness guardrails](managed-provider-readiness.md#readiness-and-live-check-guardrails).

`.github/workflows/readiness-exam.yml` is the pre-merge counterpart of the UAT Azure
exam. It runs on `pull_request_target` for PRs into main that touch a live anchor
file, and on maintainer dispatch for controls. It checks out only Main
(`github.workflow_sha`) and never checks out, installs or runs PR code. It grades
what would land: the PR's test merge when its parents are Main's tip and the head,
or the head when it already contains Main; otherwise it reports `stale_merge`.
Anchor files are read through the contents API. When the anchored subagent's
mapping changes, that whole mapping is graded as data, so instruction, reasoning
and output-budget edits all count; other subagents and top-level fields keep
Main's text. A Python anchor contributes only its string literal, never the
module.
Each selected case runs in its own process (`scripts/ci/readiness_exam_runner.py`)
through Main's probe and grader, on the same deployment and settings as UAT. Its
identity is the selected managed Azure account's `readiness_exam_client_id`.

Verdict rows carry the case, selection reason, result, class (`semantic`,
`transport`, `identity`) and the probe's fixed reason code, plus time-to-verdict,
in the run summary and the `readiness-exam-<run>-<attempt>` receipt. A transport
result is inconclusive, never a pass. Forks get no live call. `readiness_exam.mode`
in `config/ci-governance.json` is `advisory`: a verdict or an exam fault annotates
the run, and the check still concludes successfully. Every step is bounded
(checkout 2 minutes, setup 4, exam 6, upload 1) inside a 14-minute job limit, and
an incomplete setup reports `not_run: setup_incomplete` instead of grading.
`ci_preflight` waits for the check like every check, so an Admin landing waits at
most the job limit after it starts, plus queue time. An advisory verdict never
refuses a landing. A runner or checkout fault can still fail the job, which then
needs a rerun.

Owner setup, once per managed Azure account:

1. Run `deploy/iam/setup_readiness_exam_identity.sh <account>`. It creates the
   main-only environment, a probe-only Entra app with a GitHub federated credential
   (`repo:hushh-labs/hushh-research:environment:readiness-exam`), and
   `Cognitive Services OpenAI User` on that account's resource only. Before granting
   anything it refuses each of these:
   - an app or principal with another owner, a secret or a certificate;
   - an API permission the app requests, or one granted to its principal;
   - group or directory role membership;
   - another trusted subject;
   - another role in any visible subscription, directly or through a group.

   Every read fails closed. After granting, it proves the exact result. If that
   proof fails, it rolls back the credential and role it granted, and an
   incomplete rollback stops with exit 3. Azure roles reach no finer than the
   resource, so the identity can call every deployment on it, inference only.
2. Put the printed app ID in the account's `readiness_exam_client_id` and merge.
   From then on `python3 scripts/ci/verify-deployment-environment-governance.py
   --surface readiness-exam` must pass: GitHub recreates a deleted referenced
   environment without protection, which would hand the subject to any branch.
   No scheduled job runs that check yet, so run it after setup and after any change
   to repository environments.
3. Before 2026-12-02, add a repository Actions event policy scoped to
   `.github/workflows/readiness-exam.yml` only, allowing both
   `pull_request_target` and `workflow_dispatch`. GitHub blocks
   `pull_request_target` in public repositories from then, and an event policy is
   an allowlist, so listing only `pull_request_target` would stop the controls.
   Then confirm a control dispatch still starts.

Live controls, run after setup and before promotion:

```bash
gh workflow run readiness-exam.yml --ref main -f text_commit=98fcd55bc6c2dea44577583e6cae1fb3ff2b3456 \
  -f cases=drive_planner.ordinary -f expect=must_fail \
  -f expected_reason=clause_core_entity_or_sparse_fallback_missing
gh workflow run readiness-exam.yml --ref main -f text_commit="$(git rev-parse origin/main)" \
  -f expect=must_pass
```

A control fails its run unless the expectation holds; a transport or identity
result never satisfies `must_fail`. Only fresh dispatches count: a rerun is
refused. To measure one case's variance, dispatch `expect=report` with that one
case and `reps` (1 to 3, one bounded wave). The receipt's `verdict.samples`
gives k of N with every outcome's reason. It is a measurement, never a verdict,
so wait for a dispatch to finish before the next one for the same commit. Before promotion to `required`, each control must give the same outcome
in three fresh dispatches, and a measured pilot must show time-to-verdict,
verdicts by class and agreement with the UAT exam. Promotion also needs:
- the aggregate CI gate to read the exam's verdict when it ran (a path-filtered
  required check would block every PR that skips it);
- a bounded wait for GitHub's recomputed merge ref, because `stale_merge` fails
  a required run until the next push;
- a rerun guard, so a semantic failure cannot be rerun to green;
- no case with residual variance on Main's own text. `drive_planner.ordinary`
  passed about 6 of 8 UAT runs on Main's wording after #8648, so one advisory
  verdict can flip either way. Fix that at its cause; never sample until green
  or majority-vote;
- an always-on check of PRs that change more than 300 files, because GitHub
  evaluates `paths` against only the first 300 files of a PR.
