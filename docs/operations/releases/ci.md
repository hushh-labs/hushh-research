# CI Configuration Reference

[Operations](../README.md)

## Main-owned release control

Dispatch Dev, UAT and Production deployments from `main`. Application sources remain
isolated: qualified protected `dev`, protected `uat`, and approved Main content respectively.
Run names identify the application branch and SHA; the Actions Main badge identifies
execution authority. Merges never deploy. UAT needs no prior Dev deployment; production
requires qualified protected Main, compatibility and rollback without a preceding
UAT deployment. Source merges never publish an application or change serving traffic.

Current access comes only from the live GitHub teams: ordinary review/self-service uses
`allowed-maintainers-to-approve`; environments use their `deploy-*` team; protected CI,
fundamental guidance and emergency authorization use `pipeline-editors`. Saved usernames
are historical evidence, never current grants. A membership lookup failure refuses the
operation. An organization-owner role does not replace deployment-team membership.

Protected PR jobs classify affected authority without receiving membership credentials.
Native Team review and the trusted Main merge decision enforce approval. The queue requests
current permission at admission and completion through the existing Main broker; no PR
observer or recurring security-alert workflow runs. Explicit Main-origin deployments use
the protected security job directly in the same run, without a second branch broker run. Current mutation boundaries also request a bounded Main-owned
permission recheck, so revoked actors cannot keep using an earlier clearance. These
explicit operation checks do not scan alerts or observe ordinary PR events.
Every step calling `assert-governed-actor.py` supplies its existing job token
and requires `actions: write` for the bounded Main permission request. Forwarded
clearance does not replace that current-operation recheck. Keep the App key and
security-alert credential inside the protected Main job.
The same requirement applies to mutation callers, including PLG frontend
finalization and production incident dispatch. UAT's read-only capacity wait
instead validates the security job's exact-source, current-attempt authorization
directly and needs only Actions read access. It does not request another broker
run. Deployment still refreshes live membership before mutation; candidate build
jobs remain unprivileged.

Pass the two protected security secrets by their declared names at every reusable
workflow hop: `GH_SECURITY_ALERTS_TOKEN` and `CI_TEAM_APP_PRIVATE_KEY`. Keep both
required mappings; a thin caller lacking an environment is not a reason to remove
them. Do not replace these bindings with broad secret inheritance.

Explicit Dev/UAT release CI uses the verified serving comparison through the
existing `uat_base_sha` input (`scope=all`). For Dev, supply the accepted Dev
serving SHA. Graph validation checks that transition before replaying a landed
PR's comparison metadata; it never bypasses semantic or mirror-integrity checks.

App-browser automation is an explicit diagnostic, not a required PR, merge-queue
or release lane. Required web validation covers build/type correctness and affected
unit/runtime contracts. Browser-engine-specific document/phone behavior is not
certified by those non-browser results; use the existing explicit document/browser
commands when that qualification is requested. One's Browser capability tests are
separate runtime authority checks and remain selected when affected.

Dev deployment performs no app-browser rehearsal. Use the existing reviewer
diagnostic command explicitly when needed. UAT may explicitly request its
reviewer diagnostic; neither changed paths nor an unknown comparison base
selects a browser automatically. Unknown bases retain PKM preservation checks.


> **Branch state:** `dev` is the protected development intake and default Dev
> deployment source. UAT selects its protected branch independently, with exact
> candidate CI; deployment rechecks observed baselines, compatibility and rollback.
> Main owns release workflows. Branch state does not prove what is serving; see
> [branch preparation](./branch-governance.md#dev--uat-branch-preparation).

## Visual Map

UAT inspection distinguishes a source-only operations/docs sync from an
application release. When the current immutable acceptance, live service
sources/revisions and unchanged Main execution source agree, it reports
`source_only_update`: do not dispatch full release CI solely because the branch
advanced. Required PR and combined-result CI still applies. This advisory result
does not publish acceptance, certify cloud health or authorize deployment.
Runtime, build, configuration, unknown impact or changed serving evidence retains
normal qualification. Explicit redeployment requests retain every release gate.
Out-of-band environment/secret changes are not assessed by this source hint;
request their release explicitly even when application source is unchanged.

Source-only backend image builds overlap preparation, then join and pin their
immutable executable digest before the account-deletion fence or migrations.
Failed preparation cancels this run's known unused image builds. This moves
build waiting off the critical path; it removes no candidate or rollback check.

The [branch and live-team map](./branch-governance.md#visual-map) joins review,
combined-result merging, isolated application sources and Main-owned explicit
deployment. It also shows agent-owned downstream source syncs. No merge or sync
starts a deployment.

This document describes CI and deployment authority. For an ordinary change,
run the nearest owner checks and let CI select affected regression owners from
its exact changed-file list. `focused` keeps authority/security checks and
affected owners; `release` adds core release-authority checks; `diagnostic`
runs the retained historical full set, including optional hygiene. A full local
core mirror is for cross-stage dependency changes or diagnosis, not a required
pre-push step. Browser journeys and engine-specific cryptography are explicit
diagnostics; required runtime/API/database checks do not claim browser-engine proof. Native
app checks run when native source or its contract changes. Unknown selection stays
conservative, and security/source-authority gates remain blocking. Dev can
deploy an exact CI-green branch SHA without merging application content to main.

The database connection budget inventories every dedicated caller. All share
a process-wide ceiling of three in `db.connection`, reserved before connecting
and released after session teardown. Saturation returns a retryable receipt-scan
busy state or defers background sweeps to their next interval; it never borrows
from the request pool. Per-caller limits still apply. The source-bound budget
and concurrency/failure checks must agree before changing this ceiling.

The canonical state-changing operator procedure is the
[Admin merge and release SOP](../../../.agents/skills/repo-operations/references/admin-release-sop.md).
This page defines CI behavior; it does not redefine Admin bypass or deployment
authority.

**Workflow files:** [.github/workflows/ci.yml](../../../.github/workflows/ci.yml), [.github/workflows/queue-validation.yml](../../../.github/workflows/queue-validation.yml), [.github/workflows/main-post-merge-smoke.yml](../../../.github/workflows/main-post-merge-smoke.yml)
**Pre-PR preparation:** [`./bin/hushh agents pre-pr`](../configuration/cli.md)
**Underlying local lane:** [`./bin/hushh ci`](../configuration/cli.md)
**Orchestrator:** [scripts/ci/orchestrate.sh](../../../scripts/ci/orchestrate.sh)

Canonical pre-PR command:

```bash
./bin/hushh agents pre-pr --base-ref origin/dev --body-file /path/to/pr-body.md
# Or inspect an existing, exact-head PR:
./bin/hushh agents pre-pr --pr <number>
```

Use the actual destination (`origin/main`, `origin/dev` or `origin/uat`). This
runs affected local owners, validates the PR body and protects core edits. Its
report lists affected runtime, database and native checks still required; a local
pass cannot satisfy exact-head hosted admission. Use `--diagnostic` for the
retained full mirror, optionally with `--include-advisory`.

Unknown application impact retains conservative unit/service coverage. Known
helpers belong to their existing test or compiler owner. Request timeouts retain
direct cancellation tests. App-browser tests, including layout and interaction
journeys, run only when explicitly requested; they do not block ordinary PRs,
combined-result queue checks or release qualification.

## Modular CI & Release References

Core release authority, blocking policies, managed-provider readiness, and the deploy image pipeline stay on this page. Detailed lane/gate matrices and historical operational runbooks live in focused sibling documents:

| Reference | Scope |
| --- | --- |
| [CI Gates, Lanes & Local Checks](ci-gates-and-checks.md) | Trigger matrix, global gates, branch lanes, frontend/backend/streaming/UI-contract check definitions, local reproduction commands, and DB launch gates. |
| [Manual Deployment Paths & Release History](ci-release-history.md) | Manual dispatch runbooks and recorded production/release-chain restoration reviews. |

## Queue response and build limits

PR Validation runs before queue admission. Queue Validation then verifies the
current combined code; it does not merge or deploy first. A single-PR group can
reuse its latest successful PR attempt only when the tested base/tree and the
actual API, merged-tree and integration selection inventories agree. A behind
branch alone does not disqualify reuse. Changed code, PR-only lane profiles,
multiple PRs, missing proof or legacy receipts require combined validation.

Main/Dev/UAT use one native queue build at a time. Their CI concurrency is scoped
to the destination so a rebuilt temporary ref cancels obsolete checks. Legacy
speculative destinations retain independent per-ref execution. GitHub does not
guarantee event ordering: a late obsolete event can cancel a newer run, requiring
rebuild/retry; current-source admission still refuses stale results. Inspect the
current native group before retrying, rather than repeatedly pushing unchanged
source. This cancellation policy never applies to deployments or maintenance.

Main, Dev and UAT allow 120 minutes for required queue checks to return. This is
an expiry ceiling, not a runtime target: GitHub previously removed valid entries
at 30 minutes while their combined-result validation was still running. Inspect
runner waiting and actual test execution separately. Never turn missing, failed
or cancelled required checks into success to avoid expiry.

The bounded repair command is `python3 scripts/ci/apply-governance.py --queue-timeouts`
for inspection, followed by `--apply` for an approved policy change. It validates
all three scopes first, preserves every other rule and actor, refuses intervening
changes and verifies each write. It does not deploy or alter team membership. Its retained
`--queue-timeouts` flag applies only the reviewed response ceiling and build
concurrency; merge method, merge limits, reviews, bypasses and conditions stay
unchanged. Missing build policy preserves historical scheduling. Apply only after
the reviewed policy lands and active groups settle; record native readback.

## Manual deployment paths

Before qualification, reconcile Main-owned recipe and migration-controller imports,
including their SQL-generation helpers. An application-only branch may retain its
own migration inventory; synchronizing the reviewed controller does not activate
absent migrations or transfer an application tree to Main. Exact-input refusal is
a source dependency to repair before launching another expensive validation.

| Developer intent | Source | Required proof | Deployment |
| --- | --- | --- | --- |
| Feature integration | Feature PR into `dev` | Destination sync guidance and authoritative combined-result CI | Explicit Dev dispatch |
| UAT-focused release | Selected SHA in protected `uat` history; preserve branch history | Read-only `operation=inspect` reports ready for exact full-scope CI and the observed serving base; deployment repeats security and baseline checks | Explicit deployment; no Dev deployment required once ready |
| Historical Dev-backed release | Existing accepted application | Exact Dev receipt and verified image, or source build | Existing UAT path |
| Production release | Qualified protected Main application | Canonical functional CI and Main smoke; exact-tree approval when distinct; compatibility and rollback | Explicit production dispatch; no preceding UAT deployment required |
| Emergency production | Exact incident-approved source | Governed operator, focused CI, security, schema and qualified rollback | Manual incident route only |
| Operations/hotfix source | Reviewed Main PR | CI, Admin/queue procedure and landed smoke | Merge does not deploy an application |

### Direct production from qualified Main

Production is an explicit action by the live `deploy-production` team; no prior
UAT deployment is mandatory. Main owns the workflow and privileged release tools.
The existing source-admission owner requires canonical functional CI **and** Main
smoke, with current attempts and complete inventories. It rereads both proofs
together and checks the unchanged qualification again before traffic promotion.
A failed, cancelled or superseded attempt refuses release; smoke alone and old
UAT receipts cannot substitute. If the landed Main commit has no functional
qualification, qualify that exact Main source before dispatch. A distinct tested
application/Main approval pair may reuse proof only when their complete trees
match and the approval incorporates the application.

Optional `promote-from-uat` still requires acceptance of the actual immutable UAT
image. Recorded recovery/activation operations keep their original source and
checkpoint contracts. Normal direct Main deployment does not grant emergency
source authority. Merges and downstream source syncs deploy nothing.

### Qualify the recorded production recovery source

The sealed cold-proof application is `84b80bcab6b5b7a4de21a5a992d3c969dacba5b9`.
Its landed Main smoke already ran on that SHA. Functional CI for the original
PR ran on a different commit. Dispatching the historical workflow would still
require a receipt from the retired `ci-security.yml` alert observer.

After the validation workflow is reviewed and lands on Main, a production
operator can dispatch **Validate Production Recovery Source** on `main` with
`sha=84b80bcab6b5b7a4de21a5a992d3c969dacba5b9`. A new dispatch is required if
the attempt fails. Application tests run from the sealed checkout without an
overlay. Governance runs Main's controller checks and selects affected checks
from the exact first-parent application delta. Web Core applies Main's read-only
Back/Search validators to the historical application; a missing source snapshot
is diagnostic, while malformed receipts and structural failures still block.
The full release scope retains the historical test inventory, current Main CI
job graph, DCO and Gitleaks policy, and protected Deployment Security job.
Recovery also requires the snapshot’s selected
Chromium and WebKit contracts and its native WebKit document check. The run
records the application SHA, its
tree and comparison SHA, and the separate Main tooling SHA.

Production's existing Main-source verifier requires the newest successful
recovery validation dispatch and the separate smoke for the exact application.
It verifies the run and job identities and rereads them during admission. This
workflow uses no cloud identity or production environment. Worker staging,
rollout, and activation each retain their own admission and explicit dispatch.

### Branded sign-in repair of the restored frontend

The explicit `frontend_auth_domain_refresh=true` incident input is restricted to
candidate `00507b68ea293524f73ad42b1839984bcaa46c98`, whose application tree matches
the restored `d8a5fa4858741e611d39fd4f1f28b1ab930d057c` release. Its only source
change removes retired alert-reader credentials from historical CI. This is not
permission to deploy current Main application code.

The existing emergency route still requires exact-source validation, protected
deployment security, a governed incident and captured rollback revisions. It pins
the original frontend build secret versions, changing only the Firebase auth
domain to `id.hussh.ai`. It refuses a changed serving baseline or enabled document
intake; configured storage and the unchanged backend are preserved. Frontend
health includes the published auth-domain check and backend identity readback;
failure uses the existing rollback. No database migration or backend deployment
belongs to this frontend-only repair. Successful deployment invalidates its old
baseline, so another fresh invocation cannot reuse the exception.

If the restored baseline retains an operational-backend recovery anchor, the
repair binds its exact annotated tag object and accepted serving-backend origin.
Provider identity, IAM, initial traffic and the sealed schema boundary are checked
after cloud authentication and rechecked before mutation. The repair publishes
an immutable deployment tag and records its readback in the existing release
artifact; `deployed/production-latest` stays unchanged so the recovery anchor
cannot be lost. This does not activate the staged backend or clear its source
restriction. The regular hourly controller remains responsible for retirement.

On 3 November 2026, run [41608303952](https://github.com/hushh-labs/hushh-research/actions/runs/41608303952)
promoted frontend `hushh-webapp-00162-r4d` to 100%; backend
`consent-protocol-00309-nir` remained unchanged. Published login scripts use
`id.hussh.ai`. The final immutable-tag publication refused before creating a tag;
the original run remains failed and its artifact is preserved. Do not redeploy
the one-time repair to retry bookkeeping: its original serving baseline no
longer applies. Independent read-only verification
[41612439877](https://github.com/hushh-labs/hushh-research/actions/runs/41612439877)
passed. This proves current health, not retrospective tag/publication clearance.

Historical restoration evidence retains its reviewed producer exclusions even
when later dispatch modes add stricter conditions. The maintenance guard accepts
those exact exclusions only with the pinned historical restoration job; changed
or missing exclusions still refuse deployment.

### Verify the current Production release

```bash
gh workflow run deploy-production.yml --ref main -f operation=verify_current
```

Leave `sha` and all release inputs at their defaults. The protected verifier
reads the 100%-traffic revisions and checks the public backend/frontend health
routes before and after. Revision `deploy-sha` is the application source; the
run SHA identifies only the verifier. It creates no release artifact, tag or
GitHub deployment record and makes no Cloud Run changes. The existing
Production WIF principal remains deployment-capable; this mode constrains its
commands to fixed Cloud Run reads and public HTTP GETs.

The coding agent completes reviewed Main → UAT/Dev and UAT → Dev source syncs
as part of each merge task, following the [downstream completion procedure](../../../.agents/skills/repo-operations/references/maintainer-branch-freshness.md). No sync bot, scheduled release cadence or automatic application dispatch is installed. The standalone CI Security Alerts workflow is retired; source secret
scanning remains in PR validation and privileged unresolved-secret clearance runs
only in an explicit Main-owned deployment's protected job.

The two bundled public email-risk data files use actual-blob digest/bounds checks
and the existing domain-policy cases in Governance. Their runtime parser, test
module, schema and unrecognized neighboring inputs retain backend validation.
This data-only owner does not replace full application release qualification.
The synthetic worker CLI fixture retains both deployment and rollback consumer
suites in the controller owner. The database connection-ceiling reader also runs
there when deployment controls change, including configuration-driven worker
capacity. It remains in backend validation for runtime changes. Unknown helpers
retain conservative selection.

UAT admission retains Main’s connection limits and workload inventory while
binding the worker size to the immutable selected application profile, bounded
by Main’s reviewed ceiling. Both admission reads and the preserved checkout
overlay use that effective profile; a different Main default cannot silently
resize UAT. Environment, process and pool mismatches require correction before
cloud mutation.

Read-only UAT inspection checks the selected candidate's public email-risk snapshot
when email authentication is enabled. Expired or malformed inputs require a pinned
upstream refresh before qualification; the full integrity and activation checks
remain enforced during deployment. Base-pinned release `scope=all` keeps web/backend core
qualification, selecting native lanes only from their existing ownership filters
against that candidate and serving base. Explicit diagnostic scopes are unchanged.

For a direct UAT candidate, record the actual serving base, dispatch `ci.yml` on
`uat` with `scope=all` and `uat_base_sha`, then dispatch `deploy-uat.yml` from `main`
with `sha`, `ci_run_id`, `ci_run_attempt` and `ci_base_sha`. The explicit
release selects that protected application SHA after full exact-candidate CI;
ordinary Dev/UAT needs no manual PR-history chain or serving-commit ancestry.
Once selected, that frozen ordinary UAT SHA remains eligible after newer merges
while it remains in protected UAT history; CI, current authority and live-baseline
checks still apply. Never silently substitute the new tip.
The base identifies changed verification inputs, not merge authority. Recheck both
actual service revisions under the lock, including partial releases with different
frontend/backend SHAs. Compatibility, candidate health, qualified rollback and
Main-owned deployment security remain required. Legacy isolated-history recovery
keeps its separately reviewed approval contract. Do not substitute a PR merge-tree
check, another attempt or a branch status for the exact candidate run.
The complete same-SHA dispatch inventory must identify the selected current
attempt. A sole matching run needs no chronological ordering, so inconsistent
provider timestamps do not discard otherwise verified evidence. Multiple runs
still require valid chronology, including an older-ID run retried later; a newer
failed or pending attempt blocks. Incomplete inventories, stale attempts and
unverified source, jobs or producers always refuse admission. Never correct
provider timestamps, sort by run ID or choose only successful runs.
Ordinary UAT application code, dependencies and branch-owned tests may differ from
Main. Its exact current CI and manifest-format checks remain required. Privileged
build/deployment recipes and migration controllers must match the frozen trusted
Main revision; required-test execution changes require pipeline-editor authority.
This is a narrow execution boundary, not whole-directory parity. Compatibility,
health, rollback, serving-revision and production acceptance checks remain.

Current support requires the selected services to share that tested serving base;
a mixed or unknown baseline refuses before mutation. Historical UAT receipt
retention remains finite; expired evidence is not an exemption.

Manual capacity dry runs are named **revision inspection**, separate from mutation
jobs, and never publish mutation checkpoints. Failed inspections cannot masquerade
as interrupted deletions. After the existing history guard and source validation,
a new apply can publish a version-3 `preparing` journal before looking up the latest
deployment. Its observation is explicitly unknown, it remains due, and it never
certifies completion or replaces orphaned state. Existing custody is retained.
Failures before this boundary still require verified pre-mutation evidence; a
missing checkpoint never establishes successful cleanup. A reviewed manual guard
refusal can establish absence of revision cleanup only from its exact immutable
controller source, complete failed-attempt transcript and skipped checkpoint save.
It grants no release clearance, checkpoint boundary or drain credit; earlier
custody must still be verified. Phone activation is separately proved as
a nonproducer of cold-backend leases; its lifecycle activation remains governed
and never substitutes for ordinary lease retirement.

## Workflow catalog and naming

Workflow files and required check names are stable API identifiers. Display names
use a clear action and purpose: **Deploy**, **Release**, **Resume**, **Verify**,
**Measure**, **Warm**, **Schedule**, **Maintain**, **Provision** or **Rollback**.
`PR Validation`, `Queue Validation` and `Main Post-Merge Smoke` keep their existing
names because governance and external tooling use them as release authority.
App Store and Android publication also retain the exact display names checked
by their dispatch verifiers; filenames and release receipts remain unchanged.
Never rename required job/check contexts for cosmetic consistency.

| Family | Workflow files | Purpose / trigger |
| --- | --- | --- |
| Validation | `ci.yml`, `queue-validation.yml`, `main-post-merge-smoke.yml` | PR checks; identical-tree queue reuse; landed-main smoke. No duplicate full suite in the queue |
| Deployment | `deploy-dev.yml`, `deploy-uat.yml`, `deploy-production.yml` | Governed manual exact-SHA deployment through existing shared build/provenance helpers |
| Native releases | `ship-ios-testflight.yml`, `release-ios-appstore.yml`, `ship-android-playstore-v1.yml` | Explicit release or continuation of a known upload; recovery does not rebuild/upload again |
| Device qualification | `ios-voice-device.yml` | Internal reusable physical-device evidence, selected by the native release; no standalone dispatch |
| Capacity | `capacity-maintenance-clock.yml`, `capacity-maintenance.yml` | Due-work controller, authenticated bounded cleanup; timer wait occurs before runner assignment |
| Operational recovery | `rollback.yml`, `prod-cloudsql-backup-posture.yml` | Governed rollback and daily live backup-posture verification |
| Security | `deployment-security.yml`, `verify-protected-lists.yml`, `supply-chain.yml` | Protected alert clearance inside explicit releases; protected-list fallback during cloud-timer qualification; changed-dependency SBOM/provenance |

| Dependency cache | `ios-swift-package-cache.yml` | Daily Main-owned Swift package cold-fetch verification and exact-key cache warm |
| Signing / package publication | `provision-wallet-pass-certificate.yml`, `publish-hushh-mcp.yml` | Explicit signing-resource creation and verified package publication |
Managed Vertex diagnosis uses `./bin/hushh diagnose uat-vertex --build-id <UUID>`
with authorized UAT log-reading credentials. It reads only that build and its
probe job (24 hours, bounded records and timeout), sanitizes the output and
removes temporary handles on failure. It grants no deployment acceptance and
replaces the standalone diagnostic workflow.

Backend-only UAT changes use the normal UAT deployment scope. The retired
One-chat cutover retains its historical provenance readers and numeric workflow
identity; its fixed-source exceptions grant no new release authority.


The separate weekly offline pod drill and weekday completion-judge workflow
files are removed from main. Both core test suites remain in Protocol CI's manifest;
the judge CLI and live completion receipts remain in the existing
[readiness workflow](./pod-completion-judge.md). No scheduled failure is needed to
announce an unchanged external prerequisite. Historical workflow entries do not
represent active source on the default branch.

Capacity tick run titles are protocol inputs for checkpoint reconciliation. They
retain their exact names independently of the workflow's display name. Dispatchers
and provenance readers should bind to workflow file paths rather than presentation
labels unless a specific authority contract explicitly requires the label.

GitHub also exposes platform-managed CodeQL, Dependabot and Copilot workflows,
and may retain entries for deleted workflow files. Those entries are not proof of
an active source workflow or a duplicate test. Reconcile old entries with main and
recent runs before disabling anything. Required security coverage must remain.
No remote disable, cancellation or schedule change is authorized by this local edit.

The orphan CI Trust Qualification workflow/helper is retired. Its accepted run
40598204935 attempt 1 recorded historical Linux/macOS qualification for source
`6267f321c821b0ff2e1995dcd50d4eff8b045dc9`; the hashed receipts are archived
privately. This records that historical scope only and grants no current CI or
release authority. GitHub history and artifacts remain intact.

## Explicit releases and retired cadence

UAT and production release only through governed manual dispatch. Commits, Main
merges and completed workflows do not dispatch a release. The UAT Release Cadence
workflow and automatic actor authority are retired. Its state branch and existing
receipts remain historical evidence; do not reset or delete them. Shared receipt,
retention and native-resume helpers remain supported independently of the observer.
The retained CLI supports `wait-production` for an already approved exact run;
`reconcile` refuses before ledger access or dispatch.

Keep Dev/UAT/Main history separate. Stable fixes move downward through reviewed
manual sync PRs. Freshness checks use the destination branch; deployment is a
separate decision. Follow [branch governance](./branch-governance.md) for exact
application/Main-approval mapping, direct-UAT qualification and the emergency
production route. Removing cadence does not authorize using an unqualified path.

## Account deletion regression gate

Every frontend or backend PR runs `scripts/ci/account-deletion-check.sh` in the
required Integration lane. It exercises the production client flow, proxy error
contract, backend route, cancellation settlement, and disposable PostgreSQL
recovery-history erasure. Missing PostgreSQL fails this gate; it cannot silently
skip the database proof. `CI Status Gate` rejects a failed or skipped required
Integration lane. The protected-behavior registry pins the essential regression
cases so deleting their coverage also fails governance.

The existing full-account inventory test also compares migration-authored
user-keyed tables with the production erasure path, checked cascades and explicit
retention reasons. A feature that adds an unaccounted user-keyed table fails this
gate.

The `feature_account_deletion` / `@feature_account_deletion` tag identifies this
pack; run `bash scripts/ci/account-deletion-check.sh` for its complete mandatory
selection. Tags aid discovery; the required gate runs explicit files so removing
a marker cannot silently deselect a regression.

The database regression sends HTTP through the production router, service and
transaction into disposable PostgreSQL. It includes hundreds of parent revisions,
multiple segment batches in one parent, and slow deletes on both tables under a
short SQL statement deadline. A failure at final vault cleanup restores both
recovery tables; another owner's history survives. The existing request context
is asserted across the HTTP response and database worker. Client tests cover
delayed status replies and pending-lock recovery without another DELETE or a
premature uncertain sign-out.
A late-cursor PostgreSQL execution-plan regression bounds actual parent scan
work as well as the batch size. The parent cursor uses an inclusive lower bound
so remaining segments within the current revision are preserved; segmentless
parents cannot terminate the erasure early.
The initiating owner generation is captured before bank preflight; returning to
the same account after sign-out cannot reuse that deletion approval. Voice tool
and relay tests require an authoritative lifecycle lock to stay pending in
narration without sign-in or retry instructions. Client claims never establish
that pending state or a completed deletion.
Recovery-reference indexes are replayed, validated and rolled back on the same
disposable database. This establishes these contracts with synthetic information;
it does not measure deletion time for a real person's full recovery history.

## Monitoring Rule

After any merge to `main`, bypass merge, deploy trigger, or manual workflow dispatch, keep monitoring the resulting GitHub workflow chain until it reaches a terminal state.

Minimum expectation:

1. watch the immediate `PR Validation`, `Queue Validation`, or dispatched workflow
2. if `main` goes green, watch `Main Post-Merge Smoke`
3. if a UAT deployment was explicitly requested, dispatch `Deploy to UAT` for the protected-UAT application SHA with its exact current CI run and observed serving base, then watch it to terminal state
4. report the exact failing workflow, job, and step if anything fails
5. do not stop at "triggered" or "queued"
6. if the failure is within the CI/deploy/policy surface, move into fix-and-rerun mode until the change is green or a hard blocker is identified
7. when the run is expected to outlive the current chat turn, start the persistent watcher instead of relying on manual follow-up
8. when Codex initiated the merge or queue action, continuing this watch is mandatory; needing a user reminder to resume monitoring is process drift

UAT Cloud Run provenance is a release blocker. The deploy workflow stamps each backend/frontend revision with `HUSHH_DEPLOY_ENV`, `HUSHH_DEPLOY_SOURCE`, `HUSHH_DEPLOY_SHA`, and `HUSHH_DEPLOY_RUN_ID`, then verifies live traffic with [scripts/ci/verify-cloudrun-revision-provenance.py](../../../scripts/ci/verify-cloudrun-revision-provenance.py). A revision that is unlabelled, manually deployed, or built from a different SHA is classified as `deploy_authority_drift` and must not keep UAT traffic.

Codex-first PR watcher:

```bash
./bin/hushh agents ci-status --watch
```

Use this command first for active pull-request checks because it classifies failing jobs into the right owner skill and points to the next workflow pack before dropping to raw `gh run` inspection.

Merge-queue rule:

If Codex triggers `gh pr merge`, `gh pr merge --auto`, or any action that places a PR into merge queue, that is not completion. Codex must confirm the queue entry, then continue monitoring the authoritative workflow chain until:

1. `Queue Validation` reaches terminal state for the merge candidate
2. if the PR lands, `Main Post-Merge Smoke` reaches terminal state for the landed `main` SHA
3. only stop earlier when the user explicitly asked for queue placement rather than landed completion
4. if Codex triggered the merge path, it owns this monitoring step through terminal completion and should not pause after the queue accepts the PR

The repository-level `allow_auto_merge` setting must stay enabled. On a merge-queue repository, GitHub CLI uses that setting to enqueue PRs whose requirements are still settling; disabling it can make a validated maintainer PR fail with `enablePullRequestAutoMerge` before the queue is reached. This is not a validation bypass: `CI Status Gate`, merge queue validation, and `Main Post-Merge Smoke` remain mandatory.

Codex-first RCA surface:

```bash
./bin/hushh agents rca --surface uat --text
./bin/hushh agents rca --surface runtime --text
./bin/hushh agents rca --surface ci --text
```

Use this command when the failure is already on a core authority surface and the next step is classification, not generic monitoring. It preserves structured artifacts and keeps helper-only drift advisory unless it masks a runtime, deploy, DB, or semantic verification failure.

**Read `unevaluable_checks` before any blocking classification.** The runner reports three
states, not two: `healthy`, `blocked`, and `unevaluable` (exit `0`, `1`, `2`). An entry under
`unevaluable_checks` means a check could not run at all, so nothing was verified either way, and
it names the domain class it would otherwise have been blamed for. Never remediate a domain class
that came from an unevaluable check.

Why this matters, measured 2026-08-29: the uat surface reported `db_contract_drift` and
"Resolve DB release-contract drift before treating the surface as deployable" because
`verify_runtime_db_contract.sh` died at `import asyncpg`. The database contract was fine. In the
same run the semantic verifier died at `import dotenv` and produced *no* classification, so a
crashed release check read as a clean one, and the `ci` surface reported `core_ci_failed` for an
exit code of 143, which is SIGTERM: CI had not failed, CI had been killed. (The check it killed, `verify-runtime-config-contract.py`, was measured at 486s under heavy load; it scans every tracked file against 23 patterns.) Sub-reports now land
in `tmp/rca/<surface>/` (gitignored) instead of a temp directory that evaporated before anyone
could open the path the runner printed.

Canonical watcher:

```bash
scripts/ci/watch-gh-workflow-chain.sh --run-id <ci-run-id> --follow-workflow "Main Post-Merge Smoke"
```

Local daemon form:

```bash
scripts/ci/watch-gh-workflow-chain.sh --run-id <ci-run-id> --follow-workflow "Main Post-Merge Smoke" --daemonize
```

For deploy-only monitoring:

```bash
scripts/ci/watch-gh-workflow-chain.sh --run-id <deploy-run-id> --daemonize
```

The watcher logs to `tmp/devops-watch/`.

---

## Fundamental Blocking Policy

Authority checks are not diagnostic work: UI Contracts, Secret Scan, DCO,
applicable PR Base Policy, path resolution, Preflight, and
CI Status remain blocking. Repo Governance runs its focused or release profile
alongside unprivileged functional lanes and remains mandatory in the final gate;
unknown changed-file selection is conservative. For selected surfaces, the
required jobs are listed below. A selected job must succeed, while an unselected
path lane may skip. Safari-specific layout/performance and non-security hygiene
remain available locally or in diagnostic validation; they are not required PR
jobs.

1. `Web Core` retains install, preflight, docs/design contracts, typecheck, lint
   and the required Next production build for frontend changes.
2. `Web Targeted Contracts (node)` runs the existing selected non-browser
   commands. It installs no browser, runs no layout matrix and emits no synthetic
   browser artifacts. `CI Status Gate` still requires successful selected Node
   contracts. Browser npm commands remain available as explicit diagnostics.
   The first required unit leg owns the exact voice-gateway, capability-graph,
   surface-map and native-plugin verifier commands. Targeted CI does not repeat
   those four commands; functional packs, composite commands and invocations
   with additional arguments retain their checks. Local targeted-only runs and
   historical recovery retain their original ownership.
3. `Web Unit Contracts` runs affected Vitest cases and contract verifiers from
   `hushh-webapp/scripts/testing/affected-tests.mjs`. Local runs with no explicit
   validation level retain historical full-suite behavior. UI Contracts uses that
   same exact-source plan to select one focused/release leg or three native
   Vitest legs for diagnostic fallback, with two workers per runner. Verifiers
   run once on the first leg. Release admission requires the complete successful
   shard set; historical unstamped evidence is accepted only from its verified
   pre-matrix workflow. Late execution fallbacks remain serial. Explicit local
   diagnostic shards remain available through `WEB_FULL_SUITE_SHARD`.
   Planning runs before Governance finishes; the final status gate still requires
   Governance independently. Historical recovery keeps its three-shard plan.
   The selector sends registered JSON contract inputs through Vitest's related
   dependency graph, keeps unknown runtime JSON fail-closed, and leaves the exact
   iOS XCTest and phone-flow browser harness to their platform/browser owners.
   Import analysis uses the locked TypeScript 5.9.3 parser installed from the
   existing UI tooling lock before selection. It scans runtime and Vitest roots,
   then follows local imports, re-exports, literal CommonJS `require` calls, and
   proven `createRequire(import.meta.url)` aliases into helpers, including
   unit-reachable E2E or script helpers. It resolves literal imports and unique
   top-level constant-string identifiers; a test that dynamically imports or
   requires a changed file is selected directly. An unresolved computed import,
   require, or unproved `createRequire` alias in a unit-only helper selects every
   whole Vitest owner of that helper. Runtime-reachable unresolved loaders,
   parser or module-resolution errors, and graphs exceeding the 64 MiB,
   250,000-state, or 500,000-edge bounds retain diagnostic coverage. E2E-only imports remain
   with the browser owner unless a unit/runtime root imports that helper. The
   tracked web JS/TS tree measures 44.57 MiB, above the former 32 MiB cap; the
   larger finite limit is not a latency guarantee.
4. Backend changes require `Protocol`, `Protocol Database (1/2)`,
   `Protocol Database (2/2)`, `MCP Package` and `Integration`. The database jobs
   use separate PostgreSQL services and serial test partitions; both must
   succeed. Unselected lanes may skip, but selected lanes cannot pass by skip.

When the full Protocol owner is required in the same hosted run, it owns the
exact whole-module overlap with Governance's release-controller checks.
Governance keeps its other controller modules; Protocol keeps its complete
manifest, runtime setup and import collection. Draft/auth-health suppression,
local or diagnostic runs, invalid selection and historical recovery retain the
full Governance owner. The final gate refuses missing, skipped, cancelled or
failed required Protocol results. This avoids duplicate execution without
adding a wait between the jobs or removing a functional contract.

The exact production-restoration fixture helper and test module use a focused
Governance controller owner. It runs the restoration suite, both phone-schema
history consumers, and the single historical Drive release-tooling case. Only
those two fixture paths use that owner. Other explicitly listed release-test
files use the existing release-controller owner, including legacy phone-job
receipt compatibility. Test-only changes run those complete files without
selecting unrelated runtime/database suites; account-deletion release tests
retain their dedicated owner exactly once. Runtime modules, schemas, migrations
and unregistered test paths still select the existing backend lanes. The path
contract checks both focused coverage and those conservative controls.

The inert PLG qualification helper and its four consumer suites also use that
controller owner. Fixture-only edits do not schedule the full backend. Changes
to shared PLG runtime fixtures, application code or unknown helpers retain
backend coverage, and release qualification retains both database partitions.

Manual `scope=auto` uses the dispatched commit's real merge-base against the
repository's default branch. This development comparison does not grant UI
review inheritance or replace a serving-base release receipt. Unavailable or unrelated history refuses selection; an explicit `uat_base_sha`
can supply the intended comparison. UAT release qualification still requires
its verified serving base rather than a development comparison.

The affected unit selector does not own standalone Node verifiers: analytics'
Android-scope verifier and Node failure tests remain in the targeted Node job.
`verify:voice-gateway` and the other explicit contract verifiers run once in
their owning job. Standalone focused npm commands retain their complete
behavior; the lane-partition contract protects these boundaries.

Integration's required `--ci-core` mode retains runtime, account-deletion and
applicable database contracts without starting an app browser. The existing
`document-delivery-check.sh` modes are explicit engine-specific diagnostics:
`all`, `--ci-linux-document` and `--ci-macos-webkit`. Those commands retain their
actual browser/SQL assertions and platform prerequisites. Their results are not
implied by a normal CI pass.

Calendar's lock regression holds the next Schedule response while asserting that
the prior private view is cleared, then releases distinct fresh information.
This distinguishes stale private DOM from a new Firebase-authorized read, which
Schedule supports while the vault is locked; it does not relax the whole-page
privacy assertion.

Validation result collection:

Independent checks finish and report their failures together. Browser commands,
backend validators, backend assertion-test partitions, web validators and the
cross-surface integration checks retain a final nonzero result if any check fails.
This reduces fix–push–rerun cycles; a failing run may take longer because it
reveals failures that previously remained hidden. Governance and the outer web
pack runner already collected independent failures.

Prerequisite installation, invalid selection, cancellation, fixture safety and
release authority still stop dependent work. Pytest interruption/internal/usage
failures do not continue to later partitions. Never use `continue-on-error` to
make a required lane green, or continue traffic promotion after failed candidate
verification. Deployment mutations retain their ordered safety checks.

Fail-fast contract:

1. Cheap prerequisites run before expensive web/protocol/integration lanes:
   UI Contracts, secret scan, DCO/base policy where applicable and path resolution.
2. The `Preflight Gate` stops dependent work when those prerequisites fail.
3. Governance runs alongside unprivileged functional lanes; its failure still
   refuses the final CI gate, merge and release. This removes serial waiting
   without removing checks or granting credentials. Web Unit Contracts retain
   their separate Governance dependency because Governance publishes their matrix.
   Deployment authorization, migrations and traffic changes keep ordered safeguards.

Required `CI Status Gate` remains the landing authority on PR and queue commits.
Destination sync is advisory; the queue verifies the current combined code.
Main smoke certifies its landed SHA separately. See the [Admin SOP](../../../.agents/skills/repo-operations/references/admin-release-sop.md)
for review and actual-merger controls; a source merge never deploys.

### Protected pipeline surfaces

CI and fundamental development policy require current **`pipeline-editors`**
authority. GitHub team membership owns access; `config/ci-governance.json`
defines protected capabilities, not a saved membership roster. General
application maintainership does not grant protected-edit approval.

- The protected set covers workflows/actions, CI/release scripts, deployment
  configuration, CODEOWNERS, the agent kernel and fundamental skills/workflows.
  The policy file owns the complete list.
- An authorized owner's explicit bounded change, or a current-head approval
  from an owner, admits the protected edit. Stale, dismissed or superseded
  reviews do not authorize the new head.
- `verify-protected-pipeline-edits.py` reads policy from the trusted PR base;
  candidate policy cannot authorize itself. CODEOWNERS supplies the matching
  review routing. CLI access and generic autonomous permission are not human
  approval of an unrelated policy change.
- Ordinary review and team-authorized owner self-approval are defined once in
  Admin SOP. Eligible pipeline editors use its explicit Admin PR command for
  their own captured head. It
  verifies the current successful attempt and exact merge tree. The native owner
  route has strict CI and PR-only guards; it never authorizes a deployment.

### PKM rollout blocker

Production rollout is blocked unless PKM compatibility stays green for supported stored-version paths. The blocking CI manifests now explicitly include:

1. frontend `__tests__/services/pkm-upgrade-orchestrator.test.ts`
2. backend `tests/test_pkm_upgrade_routes.py`

These are the minimum gates for:

1. missing-manifest compatibility
2. malformed/legacy manifest normalization
3. manifest-authoritative upgrade truth when index summaries lag behind
4. structured PKM failure metadata reaching the task center

Local/UAT release rehearsal should additionally run the Kai no-write PKM drill before production rollout:

1. automatic upgrade start from app entry after unlock
2. no-write dummy save validation for the Kai drill user
3. post-upgrade investor / RIA / consent smoke from [Kai Runtime Smoke Checklist](../../architecture/finance/kai-runtime-smoke-checklist.md)

The canonical blocker for that broader surface is:

1. [scripts/ci/pkm-upgrade-gate.sh](../../../scripts/ci/pkm-upgrade-gate.sh)
2. [scripts/ci/resolve-uat-verification-plan.py](../../../scripts/ci/resolve-uat-verification-plan.py) is the single changed-SHA selector used by PR, queue, post-merge, dev and UAT lanes
3. `integration-check.sh` runs the PKM gate only when that selector finds a PKM upgrade, stored-shape, migration, or fixture change; selector-policy changes are covered by always-on classifier contract tests. Ordinary UI, consent, MCP, RIA, and provider changes keep their own focused checks without repeating the PKM cycle
4. a missing or unproven comparison base fails closed to the deterministic PKM/reviewer plan, never to implicit paid model calls; UAT treats a serving SHA as proven only once its exact-SHA UAT acceptance covers that service, so a candidate still serving after its acceptance failed is unproven (Dev does not apply this check yet)
5. when `PKM_UPGRADE_RUNTIME_AUDIT_BASE_URL` is set for a selected PKM release, the same gate also runs the live Playwright investor / RIA / PKM audits against that runtime

Every selected plan is written as a `*-verification-plan` workflow artifact and
includes the changed files, each lane's `required`/`skipped` state, and its
reason. This is evidence only: authority checks, migrations, deployment
provenance, runtime health, and directly affected frontend/backend checks remain
mandatory regardless of the expensive-lane selection.

Dev and UAT execute selected preservation through
[scripts/ci/run-release-pkm-gate.sh](../../../scripts/ci/run-release-pkm-gate.sh)
independently of backend deployment. A frontend-only change can therefore require
preservation without a backend migration. The helper owns its proxy and temporary
resources, pins the environment/project, and propagates the existing synthetic
preservation gate's result. Selected reviewer navigation uses memory-only Secret
Manager resolution; dev refuses release acceptance when its required receipt is
missing, skipped or failed. Candidate health, schema, provenance and semantic
verification keep their existing authority.

Dev, UAT and production expose `scope=auto` against each service's actual serving
SHA; explicit scopes remain available. Dev consumes an exact green SHA in
protected Dev history without requiring an application merge to Main; the
requested ref is only a lookup hint. UAT remains Main-workflow-owned, but new
application selections must belong to protected UAT history and satisfy exact CI
plus serving-base admission. Production retains its UAT-acceptance and distinct
Main-approval gates. Workflow changes become active only after governed main
landing; feature-branch source does not change the running workflow definition.
For explicitly requested reviewer BYOK diagnostics, the input selects execution; the existing UAT rollout
classifier still records the result as advisory. A green step conclusion under
`continue-on-error` is not a passing rehearsal: inspect the release receipt's
`reviewer_byok` outcome. A healthy rollout does not satisfy reviewer acceptance
when that proof is part of the task. Changed World Model paths do not automatically start a reviewer browser.
The explicit diagnostic retains its read-only reviewer posture.

For RCA acceptance, `repeat_reviewer_byok=true` explicitly requests two passes
in independent browser lifetimes. It defaults to false. The input requests
diagnostics, grants no mutation authority, and records requested and completed
pass counts in the release receipt. A failed pass stops that
rehearsal; it does not change the existing advisory rollback policy.

### Managed-provider readiness policy

Ordinary deployment requires **core** proof for the effective providers of its required scopes. UAT verifies One chat
and Drive text scopes, current authority, structured output, attribution/schema,
candidate health, compatibility and rollback. The exact candidate image, runtime
identity, run/attempt and configuration bind that proof. Trust failures always block;
an HTTP 200 is not sufficient. Core mode neither probes an unused alternate nor
changes runtime fallback authority.

Core text proof retains both configured scope/provider/structured-output roundtrips.
When both UAT text scopes explicitly use Vertex, core qualification runs their
Vertex proof even if the fleet default remains Azure. The receipt records
`core_provider` separately from `selected_provider`; qualification leaves the
fleet flags and worker inheritance unchanged. Missing, stale or mismatched scoped
proof still blocks release. An independent Azure PWM probe is not a prerequisite
for those Vertex scopes; full diagnostics retain its existing checks.
The Drive activity planner's semantic quality scenarios belong to explicit `full`
diagnostics; core reports that planner result as unrun. Full diagnostics retain
the authored cases, graders and blocking semantic-failure verdicts.
Scoped receipts still prove each configured provider, model, location, policy
generation and binding fingerprint. Only trusted core mode accepts an explicit
unrun planner result; missing or failed evidence is not unrun. Historical core
receipts with a valid full planner result remain readable.

Search, images, PDFs, transcription, narration, Live audio and the broader capability
exam are **secondary diagnostics**. A secondary failure is reported as that feature's
failure rather than a core outage. When full diagnostics were not requested, record
`secondary_diagnostics: not_run`; do not claim those features passed. Capability
activation and provider changes still need the affected capability's acceptance.
The retained `full` producer mode runs the broader exam with its existing verdicts;
it remains the default for callers that do not explicitly select core. Ordinary UAT
uses core when the candidate recipe supports it; older approved candidates retain
full qualification. Full provider diagnostics remain explicit, using the existing
probe producers with `MANAGED_READINESS_MODE=full` under their admitted runtime
identity; they do not replace core release evidence. `run_live_model_checks` retains
its separate PKM/RIA meaning.

Dev and production keep their own configured Vertex ADC model and project. Candidates
with common-core contract version 2 prove a real, nonempty ADK chat response at that
exact target; secondary modalities are not run. Older images retain full qualification.
A source declaration permits requesting core but cannot certify the image: its terminal
report must acknowledge the mode/version, environment, configuration and active chat
result. The collector binds those results to the exact build, immutable image and runtime
identity. It does not select or change providers outside UAT. The isolated Dev commerce
target retains its existing full checks until separately qualified. Build failure still
blocks deployment. Dev records its build ID before waiting; production preserves
synchronous submission because its schema-recovery history requires an acknowledged
terminal build. Successful builds publish the exact ID for receipt collection.

For a policy-changing release candidate, run the retained functional/core set once
on the completed candidate, plus affected security and release contracts. Do not
repeat the full collection after each edit. Ordinary PRs use core/affected checks.
Use the measured timing guidance below; no optimization target waives required proof.

The one-request Azure readiness leaf records its failed stage, elapsed time and
sanitized exception class. Transport deadlines and network failures retain their
provider-unavailable classification; that classification does not make a failed
readiness gate pass. An initial HTTP 200 cannot erase a later nonce, attribution,
schema or capability failure. Existing deadlines and retry limits remain fixed.
Actual bounded retries within the same verified execution retain the first
failure and subsequent outcomes in the receipt. Only an observed failed attempt
followed by success is marked `recovered_after_retry`; recovery does not establish
a permanent fix. Separate GitHub reruns are separate evidence: retain the failed
attempt's artifact and incident context rather than infer lineage from a later
clean run. Repeated timeouts require incident follow-up. The existing observability
provisioner owns a separate UAT release-job terminal-timeout policy at two events
in ten minutes; configuration/readback and actual notification delivery are
separate evidence. See [the Azure probe alert runbook](../../../deploy/observability/README.md#azure-release-probe-timeouts).
The UAT workflow records the exact backend Cloud Build ID before waiting for its
terminal result, and records duration even on failure. The artifact collector reads
that ID, then retrieves the aggregate step's receipt
from Cloud Logging. It does not depend on streamed build stdout. Collection has
a bounded ingestion retry and verifies build, run, image, runtime identity and
canonical configuration bindings before publishing a sanitized receipt. Missing,
conflicting or foreign evidence writes a failure artifact and blocks promotion;
it never changes provider selection or relaxes readiness. The current collector
survives checkout of an older application SHA; an incompatible target fails
closed with a diagnostic artifact. See
[the deployment contract](../../../deploy/README.md) for capability and compatibility boundaries.

Additional Gemini/Vertex candidate evaluations are opt-in, not ordinary CI gates. UAT
dispatches default `run_live_model_checks=false`; explicitly setting it to
`true` selects candidate-model readiness and synthetic PKM evaluation for a
backend deployment, plus the live RIA Stage-1 semantic probe. Both semantic
verification attempts consume the same plan flag. Without the opt-in, the
verifier records RIA as skipped with `live_model_checks_not_requested`; health,
authentication, connector configuration and command recovery still run. An
explicitly requested RIA transport timeout or negative result still blocks;
only an actual provider-unavailable response is reported as degraded.
The workflow retains the current verifier across checkout of an older approved
application SHA, so that release also obeys the operator's explicit selection.
Production also preserves `managed_provider_readiness.py` alongside the current
Cloud Build definition. Its build-scoped receipt check remains required when
the approved application SHA predates that release-tooling companion.
Direct backend Cloud Builds (including production) default
`_VERIFY_MANAGED_VERTEX_RUNTIME=false`; an operator may explicitly set it to
`true`. Local PKM evaluation similarly requires
`PKM_UPGRADE_STRUCTURE_AGENT_EVAL=1`. Omitted evaluation is **skipped**, not a
model-quality pass. Mocked provider contracts, model configuration checks,
zero-loss preservation/rollback, authorization, schema, provenance and runtime
health remain mandatory. This does not disable the application's own voice
readiness or model calls caused by an explicitly exercised product journey.

## Deploy Image Pipeline

### Deployment overhead and retention limits

The existing worker rollout remains required when selected. Frontend-only scope
already avoids it. Same-image reuse is not yet qualified on a serving release;
most backend changes alter its shared image. Do not add a retention controller
or claim worker savings until a real accepted same-image case demonstrates net
benefit. Cross-image reuse needs an explicit worker compatibility contract.

Selected UAT PKM preservation runs the existing transactionally rolled-back SQL
rehearsal against the live database. Source contracts run in exact-candidate CI;
deployment does not repeat those frontend/backend suites. Schema compatibility,
account-work fences, activation and rollback remain required operational work.
Secret inventory overlaps at most three metadata reads, preserves ordered
results and fails closed on unknown access. It never logs secret values.
Ordinary UAT defers local profile hydration to candidate/serving verification,
which reads fresh credentials. Only legacy or explicitly requested reviewer
analytics hydrates earlier for its intervening consumer. This removes one
redundant setup pass without caching secret authority.

Pre-mutation refusal is not a failed deployment. Missing qualification pins name
the required input and inspection action before scope lookup. Dev acceptance
cannot run before trusted tools are staged. Maintenance emits only allowlisted
reason identifiers for authored safety refusals; unknown/provider text stays
private. A diagnostic code never grants permission to erase a checkpoint or
repeat an uncertain operation.

Ordinary UAT/Dev privileged-input checks retain Main recipe/migration authority.
Only the two proven production-only Drive launchers are excluded; new/shared
Drive files remain guarded. Do not remove the whole directory comparison.

Routine PR and deployment design target: **10–15 minutes each**, including normal
startup/queueing, for routine affected-change paths. This is a measurement goal,
not a forced timeout or a universal release guarantee. On 11 November 2026,
necessary runs measured ordinary frontend PRs at 7–13 minutes, full-core
qualification at 22m08, frontend-only deployment at 12m54, and combined Dev/UAT
deployment at 27m49/37m04. These scopes are distinct. Record critical path, queue
wait, runner time and retained work separately. Broader backend, schema, worker,
recovery and native releases retain their required checks even when slower.
Further optimization needs measured redundant work or a verified safe overlap;
source completion alone does not establish a faster release.


Every deploy lane (`deploy-dev.yml`, `deploy-uat.yml`, `deploy-production.yml`)
builds each image once, pins it to an immutable `sha256` digest, and deploys that
digest. Nothing downstream re-resolves a mutable tag.

Automatic scope compares backend-owned files with the serving backend source,
and frontend-owned files with the serving frontend source. Mixed serving versions
from a scoped release do not select an already-current service again merely
because the other service is older. Shared inputs, unknown paths and the atomic
account-lifecycle boundary still consider both baselines and select both services.

**Parallel web build.** A backend + frontend release used to run the web Cloud
Build (p50 263s, p90 333s over the last 30 UAT deploys) serially after the backend
image build, the migration fence, the migrations and the backend candidate
checks, although it depends on none of them. Now:

1. `Start frontend image build in parallel` submits
   `deploy/frontend-image.cloudbuild.yaml` with `--async`, right after the runtime
   secret sync (the build compiles `NEXT_PUBLIC_*` values from Secret Manager) and
   at the same moment as the backend image build.
2. `Wait for frontend image and pin its digest` runs where the frontend build used
   to start. `scripts/ci/await-prebuilt-image.sh` streams the build log, fails on
   any status but `SUCCESS`, resolves the tag once, and pins the executable
   linux/amd64 manifest with `scripts/ci/resolve-cloud-run-image.py`.
3. `Deploy frontend using Cloud Build` refuses to run without a well-formed
   `gcr.io/<lane project>/hushh-webapp@sha256:<64 hex>`, then submits
   `deploy/frontend.cloudbuild.yaml` with `_SKIP_IMAGE_BUILD=true` and
   `_IMAGE_REFERENCE=<digest>` and `--no-source` (no 59 MB upload for a
   deploy-only build). UAT and production then check the candidate revision runs
   exactly that digest.

Core candidate verification, promotion and rollback retain their ordering. Ordinary
UAT analytics/browser rehearsal is an explicit secondary diagnostic; a skipped
diagnostic is reported as not run, not success. Legacy isolated qualification
retains its required checks. Expected
saving: 3.5-4.5 minutes per backend + frontend release. `frontend_image_wait` in
the release status artifact records how long the lane still blocked on the web
build; near zero means it was fully hidden. Frontend-only and backend-only scopes
build only their own image. A deployment SHA older than this split has no
build-only config and keeps the combined serial build-and-deploy. Retained
combined Cloud Build recipes support historical releases; their filenames do not
authorize an automatic deployment. Current environment dispatch remains explicit.

**Production backend promotion.** `deploy-production.yml` input
`backend_image_source` chooses the backend image:

- `build-from-source` (default today): rebuild at the SHA, as before.
- `promote-from-uat`: deploy the exact bytes UAT tested (about 2.7 minutes
  less). A preflight, before the secret sync, backup gate, fence and migrations,
  requires a healthy UAT release tag `deployed/uat/<sha8>-*` for exactly this SHA,
  reads the backend revision that tag recorded, and requires its `deploy-sha`
  label and `HUSHH_DEPLOY_SHA` to equal the SHA and its image to be
  `gcr.io/hushh-pda-uat/consent-protocol@sha256:...`
  (`scripts/ci/resolve-uat-verified-image.py`). A frontend-only UAT release does
  not verify a backend image and is refused. The build step then copies that
  digest into `gcr.io/hushh-pda/consent-protocol:prod-<sha>` and refuses a copy
  whose digest differs. Production Cloud Run always deploys from its own
  registry.

Promotion needs three read/copy bindings for the production deployer, listed in
[`deploy/iam/README.md`](../../../deploy/iam/README.md#production-image-promotion)
(`deploy/iam/grant_production_image_promotion.sh`). Until they exist, a promotion
run stops with a message naming the missing access. The founder flips the default
once they do.

The production **frontend** is never promoted: its image compiles
production-only public configuration (Firebase project, backend URL, GA4 id,
passkey RP ID, app env), and the build refuses a UAT analytics id. It is built
in `hushh-pda` with the parallel pattern above.

**Rollback.** Revert the change, or dispatch production with
`backend_image_source=build-from-source`. Cloud Run traffic rollback is
unchanged.

---

## Related Docs

- [Getting Started](../../development/guides/getting-started.md) -- Setup and local CI instructions.
- [API Contracts](../../development/contracts/api-contracts.md) -- API contract verification.
- [Architecture](../../architecture/system.md) -- Tri-Flow and service-layer rules.
- [Streaming Contract](../../development/streaming/streaming-contract.md) -- Canonical SSE contract.

---
