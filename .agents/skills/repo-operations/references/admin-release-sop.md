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
   head through the owner self-approval path below; ordinary reviews remain required
   for everyone else. Review exception and queue bypass are distinct.
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

### 3B. Admin landing and queue authority

Main merging is restricted to `main.merge_users`, independently of deployment
permission. CI/release/fundamental `.agents` changes need Kushal or Ankit's approval.
An explicit user instruction approving this bounded change is authorization to
execute its reviewed implementation; generic admin credentials alone are not.

**Owner self-approval:** GitHub cannot count an author's review of their own PR.
The existing queue gate therefore accepts the authenticated queue request from
Kushal or Ankit when that same person authored the PR and the captured head still
matches. The GitHub review exception is limited to those two named users, with no
team/app inheritance. It does not bypass CI, the queue, unresolved review objections,
conversation resolution or deployment admission. Someone else's PR retains ordinary
review. The same exact-owner approval applies to Dev, UAT and the retained train;
only Main additionally restricts queue requesters to its production merger cohort.
A changed head requires a new exact-head queue request.

Main review exceptions are authored separately from queue enforcement through
`branch_flow.review_rulesets`. Classic CODEOWNER review bypass did not admit an
owner-authored PR to GitHub's queue; a source-level owner check alone cannot fix
that pre-admission refusal. Migrate through `apply-governance.py --main-review-policy`
only after the queue has no bypass actors. The helper installs and reads back the
exact Main review ruleset before retiring classic review enforcement; CI, merger
restrictions, conversation resolution and queue enforcement remain independent.
Qualify an actual exact-head queue request before claiming owner approval works.
Until that proof, record the route as staged. Preserve captured classic settings
for recovery if GitHub still refuses admission. A one-time explicit owner-authorized
Admin landing must be identified as a bypass and prove that the current merge tree
is the exact CI-tested tree; it is not queue qualification or deployment authority.

Record the owner's approval and exact head in the PR release record. Use the normal
`--match-head-commit` queue command; the queue receipt records author, requester,
head and `approval_source=owner_queue_request`. Do not fabricate a GitHub review,
switch identity or temporarily disable protection. Recheck this authority at finish.

The normal command in 3A remains the landing path. Before requesting it:

1. Verify live protection and ruleset parity with the authored policy.
2. Run `./bin/hushh codex ci-status --pr <pr> --require-success
   --expected-sha <head-sha>` and require exit zero.
3. Recheck head, unresolved conversations and ordinary review or explicit owner approval immediately
   before the merge request. Missing or failed proof stops the operation.
4. Monitor the queue's actual combined-result gate, then the landed Main smoke.

The combined-result rollout removes queue-bypass actors before relaxing strict
branch-age checks. Keeping a team bypass would allow a direct UI/API merge using
old PR-head evidence. Until a mechanically enforced alternative proves the same
combined result, do not use `gh pr merge --admin` under this policy. Explicit
incident deployment authorization is separate and cannot clear a failed merge
check. Do not weaken protection temporarily to make a landing succeed.

The initial owner-approval foundation cannot authorize itself from proposed code.
Its one-time landing requires the owner’s explicit transition authorization, the
currently published Admin SOP, green exact-head CI, and proof that the current
Main merge result is the tested tree. Record any legacy Admin landing as a bypass,
never as queue validation. After the foundation is qualified, use the ordinary
queue and remove its legacy bypass actors before relaxing ancestry checks.

Historical Admin landings do not establish continuing bypass authority. The root checkout and unrelated
work remain untouched throughout the landing.

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
retained Main entrypoint remains the pre-activation path. Follow the CI runbook
for that transition. Dev does not require an application merge to `main`.
