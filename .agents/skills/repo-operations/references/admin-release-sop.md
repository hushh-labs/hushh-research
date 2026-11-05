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
3. Admin SOP coordinates an authorized landing. Required CI and combined-result
   validation always apply. An owner may explicitly approve their own captured PR
   head through the validated direct path below; explicitly configured Main direct
   operators may use the same route for their own PRs. Other Main authors retain
   ordinary reviews; eligible Dev/UAT maintainers follow §3B. Review exception and queue bypass are distinct.
4. Main source changes require a PR. Use the queue or the validated direct PR route
   below; organization-admin credentials do not create a direct-push route.
   An emergency deployment does not waive source-merge requirements.
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
3. Inspect destination changes using `maintainer-branch-freshness.md`. Reconcile
   relevant fixes and conflicts, then verify affected contracts. Age alone does
   not reject a PR; the queue qualifies the resulting combined code.

### 2. Prove the exact PR head

Before queue or Admin action, record the PR number, base, head branch, exact head
SHA, author, review state, mergeability, and check rollup from live GitHub state.

Required pre-merge proof:

1. base/lane is allowed by `config/ci-governance.json` and PR Base Policy;
2. the applicable focused or release validation, DCO, secret hygiene, and
   governance checks pass; diagnostic-only hygiene is not a required PR gate;
3. every required check on the exact current PR head is terminal and successful;
   intentionally skipped path lanes are recorded as evidence, while unexpected
   auxiliary failures still block;
4. unresolved conversations and merge conflicts are cleared; destination drift
   is recorded and the queue validates the current combined result;
5. the head SHA is re-read immediately before the state-changing command.

### 3A. Ordinary merge-queue path

1. Request merge for the exact head with `gh pr merge <pr> --merge
   --match-head-commit <head-sha>`.
2. Confirm actual queue entry from live merge-queue state. Auto-merge enabled or
   a successful CLI response is not by itself proof that the PR entered queue.
3. Monitor `Queue Validation` to terminal state and, if landed, continue through
   `Main Post-Merge Smoke` for the landed `main` SHA.
4. If review blocks queue entry, resolve ordinary review or the owner self-approval
   path below. Do not ask an authorized owner for another person merely because
   GitHub cannot count their self-review. Confirm actual queue entry.

### 3B. Ordinary Dev/UAT maintainer landing

Eligible maintainers may land their own verified product PRs without personal
Kushal/Ankit review. Follow the [Dev/UAT Admin preflight](dev-uat-admin-landing.md).
CI/core authorization and required CI remain mandatory; merging never deploys.
Kushal and Ankit retain the validated direct route for their own Dev/UAT PRs after
the destination's owner guard is installed and verified. Other maintainers use
the queue; Main's additional direct operators do not inherit Dev/UAT bypass.

### 3C. Main merger policy and validated Admin routes

Main merging is restricted to `main.merge_users`, independently of deployment
permission. CI/release/fundamental `.agents` changes need Kushal or Ankit's approval.
An explicit user instruction approving this bounded change is authorization to
execute its reviewed implementation; generic admin credentials alone are not.

**Validated direct merge:** GitHub cannot count an author's self-review. Users
explicitly listed in both `main.review_bypass_users` and
`main.merge_queue_bypass_users` may approve their own captured Main application
PR through the canonical command below. Do not repeatedly toggle bypass modes.
This additional operator exception is Main-only. Dev/UAT retain their existing
protected-owner direct route and ordinary maintainer queue admission. Protected
CI, release and fundamental `.agents` changes still require current-head approval
from Kushal or Ankit; review/direct membership does not grant pipeline editing.
Other Main contributors retain independent/latest-push/CODEOWNER reviews and the queue.
GitHub's native queue admission does not reliably honor its review-bypass allowance
for an author. Do not request another owner merely because GitHub cannot count
an authorized owner's self-review; use the validated route above.

The validated direct route preserves these independent protections:

- Baseline `CI Status Gate` from GitHub Actions, admin enforcement, conversation
  resolution and the six-person Main merger restriction remain active.
- `main owner validated merge` requires a PR and strict current-base CI for every
  configured Main direct operator. Dev/UAT's corresponding guards apply to the
  two protected owners. Other authorized mergers bypass this additional freshness
  layer only; they cannot bypass the ordinary queue or baseline CI.
- Review and queue exceptions name their own explicit governed users. No team,
  GitHub App or general organization-admin role inherits them. Native user exceptions cannot
  encode self-authorship or unresolved review objections; the command below
  enforces those additional Admin SOP requirements. Do not claim otherwise.

From reviewed tooling synchronized with Main, use:

```bash
./bin/hushh codex admin-merge --pr <number> --sha <exact-head> --receipt <local-receipt.json>
./bin/hushh codex admin-merge --pr <number> --sha <exact-head> --receipt <local-receipt.json> --apply
```

The first command is read-only apart from fetching Git objects and writing its
local receipt. The second is explicit approval to merge that captured head. It
requires the authenticated configured operator to be the PR author, live policy parity,
resolved conversations, no outstanding/withdrawn review objection, the current
successful CI attempt and immutable evidence for the exact current merge tree.
It rechecks before mutation and verifies the landed parents and tree. An uncertain
response is reconciled, never automatically replayed. Main merges additionally
require landed Main smoke. Merging any destination never dispatches deployment.

For this direct route only, reconcile the PR's actual current destination if its
tested base changed. Ordinary eligible contributors can use the queue without
this ancestry requirement. A changed source needs its own validation. Missing or failed evidence
is a refusal, not permission to run `gh --admin` directly.

Land the reviewed policy first, then dry-run/apply the existing scoped
`apply-governance.py --main-review-policy` reconciliation and finally `--main-merge-policy`. The bounded
migration recognizes only the legacy coupled-owner rules or the authored result.
It strengthens the native strict guard before updating review actors, and grants
queue exceptions last. It rechecks concurrent changes and preserves every other
rule. The parity verifier checks each cohort separately. Never use a proposed
policy to authorize its own protected change, or remove the strict guard while
queue exceptions remain enabled.

Dev/UAT activation uses `apply-governance.py --branch dev` or
`--branch uat` only after native protected review and exact Main
authority sources are verified on the destination. Reconcile live changes serially
and read back the result. Each path installs the strict owner CI/PR guard before
granting owner queue exceptions; retain that guard while an exception is enabled.

The bootstrap of PR #8825 was a separately authorized one-time Admin exception:
the exact merge tree was proven by CI, server-side strict CI was enabled, only the
authenticated owner received temporary queue authority, and the original settings
were restored and read back. That receipt is historical evidence, not a reusable
approval or proof of ordinary queue behavior.

No merge command grants deployment authority or starts an application deployment.
The root checkout and unrelated work remain untouched throughout the landing.

### 3D. Queue check-response budget

The shared `branch_flow.merge_queue_check_response_timeout_minutes` policy is
120 minutes for Main, Dev, UAT, UAT-isolated and the integration train. On
2026-11-05, GitHub removed PR #8848's queue entry with `checks_timed_out` while
run `41938357317` was still validating. Its application checks subsequently
passed; the final membership guard correctly refused the removed entry.

The authored critical path allows 100 minutes: admission (10), path selection
(5), governance (15), preflight (5), the longest parallel affected lane (45),
combined aggregation (10), and final queue authority (10). The 120-minute
budget leaves 20 minutes for scheduling; it does not guarantee runner availability.
Job timeouts, required checks, membership and exact-attempt authority are unchanged.

After this policy is reviewed and landed, use its existing controller to repair
only the timeout. This operation is independent of review/bypass migration and
does not require Stage B destination source parity, so source-sync PRs can finish
before those later operations:

```bash
python3 scripts/ci/apply-governance.py --queue-response-timeout-policy main dev uat uat-isolated integration/pr-train
python3 scripts/ci/apply-governance.py --queue-response-timeout-policy main dev uat uat-isolated integration/pr-train --apply
```

The first command is a dry-run. The second requires existing repository ruleset
administration access, validates every selected exact-ref queue before writing,
and preserves its actors, other parameters and unrelated rules. It rechecks the
snapshot before each write and verifies the readback. If a later branch fails,
inspect the completed changes before resuming; it does not roll back peer edits.
Branches may be selected separately, but repair all shared queue templates before
subsequent branch-policy reconciliation. No branch protection, authority, refs,
reviews, CI results or application deployments change in this operation.

Run the existing branch-protection verifier for each selected branch. It rejects
stale/missing budgets and ambiguous queues as well as other policy drift. A
successful budget-only readback does not prove Stage B or full policy parity;
resolve those independent differences through their existing reviewed operations.
Requeue a removed PR only after the timeout readback succeeds and its current
head/base/reviews/CI are qualified again.

### 4. Establish deploy authority

1. Resolve the selected environment’s exact application revision from its
   protected history. Dev uses its qualified Dev revision; direct UAT uses the
   assembled UAT revision and its exact release qualification. Neither requires
   an application merge to Main or a preceding environment deployment.
2. For Main-backed production approval, resolve the actual landed Main SHA and
   require `Main Post-Merge Smoke Gate = success` for that SHA. Keep application
   source, Main approval and trusted release-tooling revisions distinct.
3. Default UAT scope to `auto`. The workflow compares the target SHA with each
   service's currently deployed SHA, so it safely includes every merge since the
   deployed baseline—not only the latest PR or commit. Record its requested and
   resolved scope. Force `frontend`, `backend`, or `all` only after comparing the
   complete target-to-deployed-service deltas and documenting why the automatic
   resolver is insufficient.
4. Read the exact-SHA verification-plan artifact. It alone selects PKM and BYOK
   reviewer lanes; do not invent a second path classifier.

UAT backend changes use the normal `deploy-uat.yml` workflow with reviewed
backend scope. The retired One-chat cutover's historical evidence and recovery
readers remain available; its fixed-source exceptions do not authorize new releases.

### 5. Dispatch only the requested environment

Curated UAT requires protected source history and exact-source CI or retained Dev acceptance.
Production retains that application's UAT receipt. A distinct `main_approval_sha`
must incorporate the application with an identical Git tree and Main smoke;
see the [promotion contract](../../../../docs/reference/operations/branch-governance.md#dev--uat-branch-preparation).

For direct UAT qualification and dispatch, follow the
[UAT-scoped deploy procedure](../../uat-scoped-deploy/SKILL.md).

Production:

```bash
gh workflow run deploy-production.yml --ref main -f scope=<frontend|backend|all> -f sha=<approved-main-sha>
```

For a read-only current-release check, follow the
[Production verification procedure](../../../../docs/reference/operations/ci.md#verify-current-production).

Production requires an explicit production request and an actor in
`production.manual_dispatch_users`. UAT success does not authorize production.

Approved manual incidents follow the [incident contract](../../../../docs/reference/operations/branch-governance.md#manual-emergency-production).
Only Dev/UAT deployment acceptance is waived; all other release gates remain.

### 6. Monitor and prove

1. Watch each dispatched run until terminal success or a concrete blocker.
2. Confirm requested/resolved scope and skipped lanes.
3. Capture release artifacts plus the touched services' project, discovered
   region, ready revision, image digest/tag, deploy SHA/run labels, timeout,
   traffic, applicable schema/semantic result, and live request or log evidence.
   UAT and production both require exact revision provenance and a consolidated
   release-status artifact; environment-specific semantic gates remain explicit
   in their owning workflow/report. Use [provider diagnosis](managed-provider-readiness.md) for readiness failures.
4. Prefer workflow artifacts as authoritative proof. Local admin work as
   `kushal@hushh.ai` uses Application Default Credentials (ADC), independently of
   the selected gcloud CLI account. Refresh ADC, verify the expected
   principal and target project, then prove the exact authorized read. Classify
   authentication failure separately from permission denial; never try unrelated
   identities, broaden IAM, or change impersonation to make a check pass. An
   evidence-only CLI helper may receive an ephemeral `CLOUDSDK_AUTH_ACCESS_TOKEN`
   from the verified ADC in the same process. Approved reviewer
   secret reads must stay in process memory. Never print or persist tokens,
   credential files, secret payloads or provider error bodies, or move credentials
   between environments. Request ADC renewal only when that approved identity
   actually cannot refresh. Local ADC does not replace workflow deployment WIF.
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

## Stop conditions

Stop rather than improvise when the exact head changes, required checks are not
terminal green, actor authority is absent, environment identity is ambiguous,
provenance does not match, or a rollback target cannot be proved. Ordinary Main
promotion requires reachability from `main` and successful post-merge smoke;
curated/incident source exceptions follow section 5. Dev follows
[Dev Fast Lane](../../../../docs/reference/operations/dev-fast-lane.md): its exact
CI-green SHA must be reachable from the requested branch. Matching-branch callers
use the reviewed Main-owned implementation after live routing qualification; the
thin callers already on Main are not a pre-activation fallback: normal releases
wait for destination synchronization and successful `inspect-routing`. Retained
Main receipts are historical recovery evidence. Follow the CI runbook for activation. Dev does not require an application merge to `main`.
