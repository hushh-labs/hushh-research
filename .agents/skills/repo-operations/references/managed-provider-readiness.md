# Managed-provider readiness failures

Authority remains with the [Admin release SOP](admin-release-sop.md).

Bind the failure to its exact workflow run/attempt, application SHA, image digest,
Cloud Build and provider-job execution. An aggregate failure does not identify the
failed provider; HTTP 200 proves transport, not later semantic/capability gates.
Read the sanitized execution verdict before changing credentials, quota or policy.

Keep authored model instructions, output contracts and synthetic graders aligned.
Fix the actual contract or implementation; never replace generated answers with
fixtures, add a second semantic stage, weaken a gate or retry until a desired answer
appears. Preserve the producer's existing deadlines and bounded recovery.

Use fixed case/stage/reason/timing diagnostics without prompts, model output or
credentials. A semantic failure must remain fail-closed in its terminal verdict
even if earlier log lines arrive later. Verify producer and collector regressions,
then qualify the fixed image through the existing runtime-identity release path.
A source patch or healthy newer workflow cannot repair an older pinned image.

## Readiness and live-check guardrails

These apply to anyone, human or agent, who changes a readiness check, eval, probe
or grader, or instruction text that a live check grades (`agents/*/agent.yaml`,
system prompts).

On 2026-10-29 the only check that graded the Documents planner instruction against
the UAT model ran after merge, inside the UAT deploy. A reworded name rule, and later
a merge that kept "our" wording, each passed every PR check, landed on main and
blocked every team's UAT release, for about 6 hours and then about 2. Dev looked
green because it serves a different model, and failures without reason codes were
retried as flakes.

Each rule names the check that enforces it today, or its gap.

1. **No post-merge-only gates.** A check that can block a release needs a pre-merge
   counterpart for the files it depends on.
   - Enforced: none yet.
   - Gap: no pre-merge Azure exam; PR CI has no cloud identity.
2. **Declare what a check grades.** One manifest lists each case's instruction
   anchors and code paths. Mark anchored text `graded by readiness exam: <case>`.
   Editing an anchor triggers the pre-merge exam.
   - Enforced: none yet.
   - Gap: no exam manifest and no path-scoped PR check.
3. **Same model, same settings.** A check that predicts a gate uses that gate's
   provider, deployment, reasoning setting and output schema. A pass on another
   model, such as Dev's Gemini for the Azure gate, is not evidence.
   - Enforced: the UAT exam runs the exact candidate image under the UAT runtime
     identity (`verify-azure-pwm-runtime` in `deploy/backend.cloudbuild.yaml`).
4. **Instruction text is code.** A rewording changes behaviour, so the PR needs the
   affected exam's result. In a merge, never resolve instruction text as "ours or
   theirs": run `git log -S"<sentence>" origin/main -- <file>` to learn why the text
   exists, keep both intents and rerun the exam.
   - Enforced: review only. The merge-regression hook catches upstream lines a
     textual merge dropped, not a deliberate resolution.
5. **Every failure names its reason.** No bare asserts. Each check emits a fixed
   reason code, and the terminal verdict keeps it.
   - Enforced: the Drive planner probe raises fixed reasons
     (`test_ordinary_contract_failure_has_fixed_reason_without_plan_text`), and the
     collector keeps the terminal verdict
     (`test_capability_timeouts_reach_one_terminal_without_runtimeerror_masking`,
     `test_primary_http_success_never_erases_later_qualification_failure`).
   - Gap: `one_text_root`, the planner lead and location semantics lack specific
     reasons.
6. **Classify before reacting.** Transport means a timeout, 5xx or 429. Variance
   means the same SHA flips. Deterministic means it fails every time. Never retry a
   deterministic or semantic failure, retry until green, majority-pass a
   misconfiguration, loosen a grader or skip a check.
   - Enforced: fixed per-call deadlines, `max_retries=0`, and the aggregate
     classifications in `scripts/ci/managed_provider_readiness.py`.
   - Gap: variance is not classified automatically.
7. **Fail fast, stay cheap.** Run a check as soon as its artifact exists, run
   independent checks concurrently, fail the aggregate on the first required
   failure, keep sleeps and log polling off the critical path, and report
   time-to-verdict.
   - Enforced: none yet.
   - Gap: the exam starts about 11 minutes into UAT, runs sequentially, and the
     aggregate waits for the Vertex step.
8. **Prove the check catches what it claims.** A new or changed check ships with a
   negative control (a known-bad input that must fail) and a positive control, both
   run before merge.
   - Enforced: the planner probe's parametrized defect tests.
   - Gap: no live negative control for instruction edits.
9. **Trusted code holds the credentials.** A pre-merge live check runs main's grader
   with the PR's text as data, under a least-privilege, probe-only identity. PR code
   never receives credentials.
   - Enforced: GitHub workload identity is bound to protected environments on
     `refs/heads/main`; see `deploy/iam/setup_production_github_wif.sh` for the
     production condition.
   - Gap: no probe-only identity for PR checks.
10. **One source of truth.** One manifest and one grader serve PR, Dev and UAT. No
    duplicate graders and no second semantic stage.
    - Enforced: one planner producer
      (`consent-protocol/scripts/probe_drive_activity_planner.py`) with its dedicated
      tests.
    - Gap: no shared manifest.
11. **Broken main has an owner.** The PR that broke a check owns the fix-forward;
    restoring the last passing text is the default. Post the reason code and the
    breaking commit where the team sees them.
    - Enforced: the [Admin release SOP](admin-release-sop.md) and this procedure.
    - Gap: not automated.
