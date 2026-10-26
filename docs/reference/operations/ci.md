# CI Configuration Reference


## Visual Map

```mermaid
flowchart TB
  subgraph dev["Developer lanes"]
    feat["Feature / hotfix / developer branches"]
    pr["Pull request to main"]
    prci["PR Validation<br/>medium-depth, path-filtered"]
  end

  subgraph integration["Integration lane"]
    freshness["Main Freshness Gate"]
    status["CI Status Gate"]
    queueci["Queue Validation<br/>pass-through: reuses PR Validation<br/>for an identical tree"]
    queue["GitHub merge queue"]
    main["main"]
  end

  subgraph release["Environment deployment lanes"]
    devdeploy["Deploy to Dev<br/>main-owned workflow + CI-green branch SHA"]
    green["Green main SHA"]
    smoke["Main Post-Merge Smoke<br/>deploy-authority on main"]
    uat["Deploy to UAT<br/>manual exact-SHA dispatch"]
    prod["Deploy to Production<br/>manual SHA dispatch"]
  end

  feat --> pr --> prci
  prci --> freshness
  prci --> status
  prci -->|"exact SHA passes CI Status Gate"| devdeploy
  freshness --> queue
  status --> queue
  queue --> queueci --> main --> smoke --> green
  green --> uat
  green --> prod
```

This document describes CI and deployment authority. During implementation, run
focused contract checks. Before an ordinary push, run the local core mirror once
on the completed candidate; GitHub owns full web and browser validation. The
dedicated pre-PR workflow retains its exhaustive local gate. Dev can deploy an
exact CI-green branch SHA without merging application content to main.

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
**Pre-PR mirror:** [`./bin/hushh codex pre-pr`](./cli.md)  
**Underlying local lane:** [`./bin/hushh ci`](./cli.md)  
**Orchestrator:** [scripts/ci/orchestrate.sh](../../../scripts/ci/orchestrate.sh)

Canonical pre-PR command:

```bash
./bin/hushh codex pre-pr
```

This command runs the same blocking local CI surface that feeds GitHub `PR Validation` and `CI Status Gate`. Use `./bin/hushh codex pre-pr --include-advisory` only when you intentionally want the wider non-blocking readiness lane too.

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
| Scoped compatibility deployment | `deploy-uat-one-chat.yml` | Explicit backend cutover with its own capacity/recovery contract; no schedule or automatic deployment |
| Native releases | `ship-ios-testflight.yml`, `release-ios-appstore.yml`, `ship-android-playstore-v1.yml`, `resume-ios-testflight.yml` | Explicit release or continuation of a known upload; recovery does not rebuild/upload again |
| Device qualification | `ios-voice-device.yml` | Explicit/reusable physical-device evidence; not another PR suite |
| Capacity | `capacity-maintenance-clock.yml`, `capacity-maintenance.yml` | Due-work controller, authenticated bounded cleanup; timer wait occurs before runner assignment |
| Operational recovery | `rollback.yml`, `prod-cloudsql-backup-posture.yml` | Governed rollback and daily live backup-posture verification |
| Security | `verify-protected-lists.yml`, `supply-chain.yml` | Hourly protected-configuration drift; changed-dependency SBOM/provenance |
| Performance | `editor-performance-nightly.yml` | Daily runner/browser performance drift check, complementing changed-path PR coverage |
| Dependency cache | `ios-swift-package-cache.yml` | Daily main-owned cache preparation and bounded cold-fetch verification |
| Signing / package publication | `provision-wallet-pass-certificate.yml`, `publish-hushh-mcp.yml` | Explicit signing-resource creation and verified package publication |

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

## Release-chain review — 2026-10-23

One measured correction release, not a performance SLA:

| Stage | Elapsed | Evidence |
| --- | --- | --- |
| Full PR validation | 35m02s | [39981561301](https://github.com/hushh-labs/hushh-research/actions/runs/39981561301) |
| Landed-SHA smoke | 3m10s | [39986627702](https://github.com/hushh-labs/hushh-research/actions/runs/39986627702) |
| Dev, both services | 24m09s | [39987252665](https://github.com/hushh-labs/hushh-research/actions/runs/39987252665) |
| Sequential total before UAT | 62m21s | Includes gates, runner waits and cloud control-plane time |

Dev's backend wrapper took 10m20s, including a 6m19s native Gemini readiness
stage; migrations/schema took 3m08s and frontend rollout 2m30s. Images were
pinned before migrations; the frontend image built in parallel. These measurements
do not establish a redundant build or justify removing an authority gate.

The PR's 23 Ubuntu notices announced the `ubuntu-latest` migration to Ubuntu 26;
they were not download failures. Its successful hosted image was Ubuntu 24.04.5,
runner 2.338.0. Core PR/queue/security/smoke and dev/UAT/production workflows pin
`ubuntu-24.04` to retain that measured OS. Cache actions use v5's Node.js 24 runtime
with unchanged keys, paths and PR restore-only/main-save boundaries. This addresses
the observed seven Node.js 20 deprecation warnings; hosted verification is still
required. A material latency reduction is not established. [Runner announcement](https://github.com/actions/runner-images/issues/14748),
[cache runtime requirements](https://github.com/actions/cache#whats-new).

The latest five protected security workers each bound a distinct source
run/attempt. Their presence is credential isolation, not five new vulnerabilities.
The long run title participates in exact receipt discovery; renaming the producer
alone strands older PR consumers. Any title migration must preserve old/new
consumer compatibility, chronological newer-failure refusal and source/artifact
binding. macOS capacity notices are provider observations, not demonstrated code
failures. Unchanged historical evidence remains reusable where its inputs match.

## Run-history review — 2026-10-18

Read-only sample: 100 recent runs for discovery, then the last 20 completed PR
validations and 10 completed deployments per environment. Job/step metadata uses
the latest attempt; failed and cancelled runs are excluded from success timing.
These small, different source cohorts are diagnostic samples, not a speed SLA or
a controlled benchmark. Elapsed times include gates and waits, not billed CPU time.

| Successful scope | Dev median | UAT median | Sample count |
| --- | --- | --- | --- |
| Backend only | 16.5 min | 32.1 min | Dev 5; UAT 3 |
| Backend + frontend | 25.4 min | 37.5 min | Dev 4; UAT 4 |
| Frontend only | Not sampled | 14.8 min | UAT 2 |

Sources: [dev backend](https://github.com/hushh-labs/hushh-research/actions/runs/39091378215),
[UAT backend](https://github.com/hushh-labs/hushh-research/actions/runs/39167882081),
[dev both services](https://github.com/hushh-labs/hushh-research/actions/runs/39082250085),
[UAT both services](https://github.com/hushh-labs/hushh-research/actions/runs/39177524405),
[UAT frontend](https://github.com/hushh-labs/hushh-research/actions/runs/39161330609).
Comparing a frontend-only UAT run with a backend dev release is misleading.

The PR sample contains 10 successes, 7 failures and 3 cancellations. Successful
elapsed median is 19.8 min across changing lane sets. Protocol validation is the
largest repeated measured step (14.8 min median, 5 observations); iOS compilation
and tests take 7.7 min median (2). Observed macOS job starts are 5–9 seconds after
preflight in 5 successful jobs, so runner contention is not established as the
cause of those runs. [Example native-inclusive validation](https://github.com/hushh-labs/hushh-research/actions/runs/39175468636).

Successful dev steps: backend deploy wrapper 7.2 min median (9), image pin/build
2.8 min (9), migrations/schema 3.4 min (9). UAT additionally spends 7.8 min on its
private Drive worker deployment/attestation (7). That worker reuses the pinned
backend image; this is not a second image build. Frontend builds already overlap
backend preparation in both environments. Step medians are not additive estimates.

### Protocol partition correction — 25 October 2026

[Run 40158496907](https://github.com/hushh-labs/hushh-research/actions/runs/40158496907)
passed all 24 other jobs, including the four browser shards, but reached the
32-minute backend step limit. Its 23,685 parallel cases passed in 967.16 seconds;
the following serial database phase had not finished. The preceding run completed
both phases in 686.13 and 760.62 seconds. No test failure was reported before the
timeout. These are individual observations, not a new reliability percentile.

The correction keeps one manifest/classifier and separates the existing phases:
`Protocol (Python)` runs static/generated/security checks, parallel tests and
whole-tree collection; `Protocol Database` runs the same serial database list on
its own runner and PostgreSQL service. Both are mandatory for changed backend
sources. Missing, skipped, cancelled, failed and timed-out selected work refuses
clearance. The runner's explicit `PROTOCOL_TEST_PARTITION` is `parallel` or
`database` in hosted CI; default `all` retains the complete local/upstream order.
No tests or isolation checks were removed and no timeout was increased. Hosted
latency remains to be measured on the combined candidate.

### Failure causes and next improvements

- **PR preparation:** missing Live Memory impact declarations and an unauthorized
  protected-policy edit produced valid early refusals. Use the current PR template
  and existing governance preflight before publication; retain those checks.
  [Missing declaration](https://github.com/hushh-labs/hushh-research/actions/runs/39169067111),
  [protected-policy refusal](https://github.com/hushh-labs/hushh-research/actions/runs/39149416659).
- **Browser fixtures and behavior:** a source extractor could no longer locate the
  agent-name anchor; another run failed a WebKit drag assertion. Repair the owning
  fixture or interaction with unchanged behavioral limits; do not remove browser
  coverage. [Extractor failure](https://github.com/hushh-labs/hushh-research/actions/runs/39173344405),
  [drag failure](https://github.com/hushh-labs/hushh-research/actions/runs/39176000165).
- **Runtime/native tests:** a Vitest case exceeded its 5-second deadline; iOS reached
  test execution and failed assertions. These are observed failures, not proven
  flakes. Establish the cause before changing timeouts or workers.
  [Vitest](https://github.com/hushh-labs/hushh-research/actions/runs/39173073117),
  [iOS](https://github.com/hushh-labs/hushh-research/actions/runs/39169674663).
- **Deployment:** Cloud Build readback confirms image build, IAM verification,
  backend deployment and Azure memory verification succeeded in the failed UAT
  run. `verify-managed-vertex-runtime` failed; the detailed provider condition
  remains unclassified. This is a model-readiness refusal, not a Docker build failure.
  [Failed release](https://github.com/hushh-labs/hushh-research/actions/runs/39114036433),
  [Cloud Build record](https://console.cloud.google.com/cloud-build/builds/8c705e26-b042-49b8-9110-71b95044bfd3?project=hushh-pda-uat).
- **Highest-value profiling:** split protocol time into dependency setup, generated
  checks, lint/types/security, parallel tests and serial database tests before
  selecting an optimization. Profile Drive worker startup/attestation separately.
  Preserve database isolation, scanning, migration fences and exact-image readback.
- **Reuse what already exists:** targeted PR Node packs defer to the mandatory
  three-shard Vitest suite. Queue validation reuses equivalent green source.
  Dev pod-image building stays off unless the pod artifact actually changed.
  Batch completed fixes into one push; rerun only failed jobs when source is unchanged.

Future reviews should compare the same scope, lane set and attempt, with sample
counts, cache observations and failure causes. Reuse existing run timestamps and
release receipts; add no monitoring workflow or scheduled test loop for this review.

## Automatic native release cadence

**Surgical lifecycle release hold (2026-10-24, source candidate):**
`config/release-cadence.json` sets `enabled: false` so this dev/UAT correction
cannot automatically publish production or native releases. Manual governed
deployments remain available. Retain the accounting ledger, baseline run and
monitor improvements; resuming automatic publication is a separate release decision.
This source setting does not prove a running controller has adopted the hold.

`UAT Release Cadence` observes completed `Deploy to UAT` runs in a separate
workflow. UAT never waits for that observer, a native build, production deployment,
or Apple processing. The observer has its own short accounting lock; UAT and
production retain their existing independent mutation locks.

Native jobs read their governed environment configuration with `deployment: false`,
so they do not create hosted UAT/production deployment records. The UAT target
selector also excludes historical native records from its hosted baseline;
rollback, rehearsal and unknown mutation records retain their fail-closed checks.

The counter starts with the commit that introduces `config/release-cadence.json`.
Every second distinct, healthy deployed source commit qualifies for a UAT-backed
TestFlight build. Every fourth also qualifies for a production backend/frontend
deployment and a production-backed iOS build. Failed, rolled-back and NO_OP runs,
retries, repeated SHAs and pre-policy sources do not advance the counter. A
frontend-only healthy receipt counts even when it inherits an older backend.
The receipt's `sha` is authoritative; a dispatch's workflow HEAD is not its
deployed source.

A production-first restart may pin `production_baseline_run_id` to one successful
governed manual production deployment. Its healthy, complete exact-source receipt
must match an already counted UAT source, including a non-milestone ordinal. After
accounting the held history, the controller certifies that source, ordinal, run,
attempt and receipt digest once. It supersedes only strictly never-started
historical release groups through that ordinal, with an explicit cutover reason;
it preserves counts, sources, started releases and recovery evidence. For example,
a verified cutover at count 24 makes 26 the next TestFlight milestone and 28 the
next production pair; a cutover at 31 makes 32 the next milestone for both lanes.
The global two/four phase never shifts. A changed baseline, partial production receipt or started
historical bundle refuses adoption. Checkpoint recovery revalidates the pinned
attempt and receipt. The GitHub monitor shows the cutover alongside the count.

Deployment reruns retain identically named receipts. Their duplicate-name reader
uses the existing release-artifact owner to select only the current attempt's
successful upload window, repository/source identity and immutable archive digest.
It never selects by greatest artifact ID or deletes old evidence. Truncated,
ambiguous or ungoverned evidence blocks accounting.

Each milestone pins one green `main` SHA. Production deploy and archive are
dispatched together. Before upload, the iOS job joins the exact recorded production
run, requires its healthy same-SHA receipt, then rechecks live production backend
provenance. Production builds explicitly select `backend_target=production`.
The authorized cadence submits qualifying production builds to Apple and selects
automatic publication after approval. Existing manual dispatches keep their
prepare-only defaults. Automatic submission requires the existing privacy/export
compliance attestations and configured production App Review contact/sign-in
information; missing prerequisites block submission rather than weakening gates.
Under the production mutation lock, automatic deployment additionally requires
both currently serving service SHAs to equal or precede its pinned source. The
scope resolver is preserved from current main before any historical checkout;
an older or incomparable automatic source cannot roll production back. Manual
operator deployment and rollback authority remains explicit.

Only macOS build/upload jobs share `ios-build-and-upload`, preventing build-number
races across TestFlight and App Store. Apple processing, group assignment and
App Store preparation run on Ubuntu. Signed archives, IPAs, keychains, credentials
and raw build logs never pass through Actions artifacts. Newer pending milestones
replace older work that has not started; active deployments and uploads are never
cancelled by the observer. UAT may advance while a pinned binary finishes, so
supported app/backend compatibility remains a release requirement. The shared
GitHub-hosted runner limit can still cause scheduling delays; separate locks do
not reserve runner capacity.

Automatic release admission gives UAT precedence: queued, requested, pending,
waiting or running UAT workflows defer new releases in the ledger. The observer
exits immediately instead of sleeping on a runner, then retries on every terminal
UAT result (including failure/cancellation), release completion or the hourly
fallback. Failed UAT runs never advance the counter. Only one automatic release
bundle is admitted at a time: either TestFlight, or production deploy plus its
parallel App Store archive. Existing recorded starts keep a continuous stream of
production candidates from starving TestFlight. Missing production acceptance
keeps that pair pending while an eligible TestFlight bundle can proceed.
The two production dispatches each recheck UAT;
an intervening UAT request leaves a recoverable half-pair, without redispatching
production. Active deployments, uploads and Apple processing finish normally.
Manual release dispatches retain their existing operator contract.

This is best-effort priority, not a runner reservation. The admission snapshot
can race a new UAT request, an already admitted release may still occupy a slot,
and other repositories share the organization quota. GitHub's standard hosted
pool has no workflow priority or preemption setting; strict isolation requires
dedicated UAT runner capacity.

Accounting persists in the state-only `automation/release-cadence-state` branch.
Fast-forward-only updates reject concurrent writers. A tiny immutable
`release-cadence-authority` artifact certifies the ledger commit and state hash
from each protected-main controller run. Both reconciliation and bot authorization
require the newest certified checkpoint, rejecting forged or replayed branch
state. The bot is not a member of either human dispatch cohort; each child is
authorized only for its recorded run ID, workflow, milestone, source and complete
input set. `config/ci-governance.json` owns the permitted controller for each
surface. The cadence policy is a protected pipeline file.

The dispatch validator accepts omitted or null `marketing_version`/`notes` only
when the authorized value is blank, and typed booleans only for the lane's
declared Boolean fields. Every nonempty value remains required and exact;
unknown fields, changed source identities and changed switches fail closed.
Mismatch diagnostics list only known field names and received types, never
input values or caller-supplied unknown field names. A governed retry reuses the
recorded failed child run rather than issuing a second release request.

The 2/4 policy preserves the existing counter and certified sources. A one-time
certified transition makes the latest newly eligible TestFlight milestone pending
(count 2 when adoption occurs at count 2 or 3), without replaying older milestones.
Already issued 4/8 requests retain their original lanes and authority; the new
policy begins after any such request at the transition boundary. Recovery checks
both policy periods. Missing transition metadata means the original 4/8 policy.

Monitoring runs in GitHub inside the same observer job, after checkpoint
publication. It adds no workflow, runner job, polling loop or UAT dependency.
Completion events report failures and verified milestones when delivered. The
observer also subscribes to the existing `capacity-maintenance-clock` repository
dispatch, whose GitHub environment timer waits without a runner. This reuses its
hourly broadcast without changing the clock, adding a producer job or touching
UAT. The existing hourly cron remains a fallback; GitHub can delay scheduled runs.
Only the repository bot's exact clock event is accepted on protected main; clock
events cannot request full replay or checkpoint recovery. Unresolved recorded
child failures are rechecked for governed retries without replaying settled
release artifacts. More than 20 unresolved failures stops reconciliation for
operator recovery rather than silently dropping history or growing polling work.
TestFlight completion requires successful processing and distribution steps plus
active internal distribution evidence. Its optional skipped hardware gate must
not skip the distribution job. A green upload with missing delivery proof remains
a recoverable failure with the certified count available, and defers new bundles.
`resume-ios-testflight.yml` reuses the exact uploaded build without archiving or
uploading again. Its receipt binds the original run and attempt, source, bundle,
version and build to the governed recovery run and attempt. The observer reads at
most 20 recovery candidates; missing, mismatched or truncated proof never clears
the failure. Recovery completion wakes the existing observer, and verification
failures remain pending until proven or explicitly retired. UAT has no dependency
on this recovery or observer.
The monitor uses only standard-library code and the existing
repository token, with `issues: write` added for one bot-owned `UAT release monitor`
issue assigned to `monitor_issue_assignee` in the policy. Notification delivery
follows that person's GitHub notification settings.

The issue keeps a bounded observation journal separate from the certified release
ledger and links exact runs. Repeated unchanged results stay quiet. Notification
transport failures remain visible in Actions and do not prevent already authorized
children from running or change UAT's result. TestFlight reports prove upload and
internal distribution; external Beta App Review may remain pending. App Store
deferral is reported as deferral, and accepted review submission with
`AFTER_APPROVAL` is distinct from later public publication. Only existing redacted
receipts are read; monitoring needs no Apple or cloud credentials.

UAT/release overlap reports use observed workflow/job timestamps. A UAT start
during a release demonstrates progress for that sample; it does not prove reserved
capacity or that every later job avoided queuing. Each created, queued UAT job
awaiting a runner for over 10 minutes during recorded release activity raises a
possible-contention warning, even after an earlier job started. The observer
deduplicates that warning and records subsequent allocation. Dependency time
before job creation and time inside UAT's capacity step are not runner waits.
One final job scan per completed attempt also reports long allocation waits that
started and finished between observations, without adding a polling schedule.
A UAT with no allocated job also retains its run-level warning; UAT's own
concurrency and other organization jobs can explain that delay. The
monitor observes and reports; it never dispatches, cancels, retries or repairs a
release.

Every dispatch records intent first, then the exact run ID returned by the
versioned REST API. A controller interrupted after dispatch reconciles the unique
cadence marker instead of blindly posting again. A partial production pair resumes
its pending app build without redispatching the deployment. Ambiguous dispatches,
missing receipts, altered state and failed releases stop that release lane and
remain visible in the Actions summary; they do not change UAT's result.

The observer also runs a weekly full reconciliation for missed completion events
and old successful reruns. While a public version is under review, Ubuntu
preflight records a deferred receipt and allocates no Mac. An hourly observer
revisits the latest deferred candidate without redeploying production; newer
milestones supersede older deferred app candidates. TestFlight uses an independent
beta version train and continues while public review is pending. History queries split before GitHub's filtered-query
limit, and no historical build storm is created. To reconcile explicitly, a
governed production operator may run:

```bash
gh workflow run release-cadence.yml --ref main -f full_reconcile=true
```

Disabling `config/release-cadence.json` stops accounting and release admission.
The observer still verifies the existing immutable checkpoint and reports its
last certified count and timestamp, rather than claiming a new accounting pass.
A missing or inconsistent certificate remains a verification failure. Re-enabling
the policy resumes ordinary distinct-source accounting without resetting counts.

Obsolete failed candidates may be retired only by a governed production operator
through `retire_failed_before` and `reviewed_ledger_sha` on a dedicated manual
controller run. Review the exact certified ledger first. The frontier must be its
latest existing milestone; only older terminal failures are eligible. Every
native target must positively prove failed packaging preflight and skipped native
build/upload/distribution jobs at the unchanged attempt. A failed deployment needs
a later recorded healthy production successor. All targets are verified before
one ledger CAS update and checkpoint publication. Requests, sources, counts, run
IDs and failure audits are retained; retirement does not claim a successful upload
or App Store replacement. Retired candidates cannot resume or upload. Active,
deferred, changed-attempt, missing-evidence and stale-head cases fail closed.

For an interrupted upload, use the existing `Resume TestFlight Distribution`
workflow with the recorded upload run ID; do not build another binary just to
retry Apple processing. For an ambiguous dispatch, first inspect its exact
`Cadence <ordinal> <lane> · <origin-run-id>` marker and the latest certified
checkpoint. Never reset or delete the state branch to restart the counter. A
missing/expired checkpoint or a mismatch requires operator inspection before
restoring certified state. If the trusted controller was interrupted after its
Git update but before checkpoint publication, a production operator must inspect
that controller's job, the current ledger diff and every dispatch marker first.
After reviewing the exact state commit, recover through the protected controller:

```bash
gh api repos/hushh-labs/hushh-research/git/ref/heads/automation/release-cadence-state --jq .object.sha
gh workflow run release-cadence.yml --ref main -f recover_checkpoint_sha=<reviewed-ledger-commit>
```

Recovery requires that exact head, independently rereads each successful UAT
receipt, checks contiguous source counts and every milestone/child identity, then
publishes a new certified checkpoint. It never blindly redispatches an uncertain
request. Missing or expired source evidence blocks recertification. Set the
policy's `enabled` switch to false to stop new
automatic releases; existing manual workflows remain available.

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
3. if a UAT deployment was explicitly requested, dispatch `Deploy to UAT` for that same green `main` SHA and watch it to terminal state
4. report the exact failing workflow, job, and step if anything fails
5. do not stop at "triggered" or "queued"
6. if the failure is within the CI/deploy/policy surface, move into fix-and-rerun mode until the change is green or a hard blocker is identified
7. when the run is expected to outlive the current chat turn, start the persistent watcher instead of relying on manual follow-up
8. when Codex initiated the merge or queue action, continuing this watch is mandatory; needing a user reminder to resume monitoring is process drift

UAT Cloud Run provenance is a release blocker. The deploy workflow stamps each backend/frontend revision with `HUSHH_DEPLOY_ENV`, `HUSHH_DEPLOY_SOURCE`, `HUSHH_DEPLOY_SHA`, and `HUSHH_DEPLOY_RUN_ID`, then verifies live traffic with [scripts/ci/verify-cloudrun-revision-provenance.py](../../../scripts/ci/verify-cloudrun-revision-provenance.py). A revision that is unlabelled, manually deployed, or built from a different SHA is classified as `deploy_authority_drift` and must not keep UAT traffic.

Codex-first PR watcher:

```bash
./bin/hushh codex ci-status --watch
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
./bin/hushh codex rca --surface uat --text
./bin/hushh codex rca --surface runtime --text
./bin/hushh codex rca --surface ci --text
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

To prevent CI check-sprawl, only these queue/PR checks are hard-blocking by default:

1. `scripts/ci/secret-scan.sh`
2. web validation through `scripts/ci/web-core-check.sh`, `scripts/ci/web-targeted-check.sh`, and `scripts/ci/web-full-suite-check.sh` (`web-full-check.sh` is the first and last in sequence)
3. `scripts/ci/protocol-check.sh`
4. `scripts/ci/integration-check.sh`

Web validation is intentionally split. The targeted node job runs once and the
browser packs run across four Playwright shards; each job has a 30-minute budget. Run `39649422912` exhausted that budget twice after its approximately thirteen-minute WebKit group passed. The fourth shard retains all tests, worker limits and engine coverage; it changes the partition rather than the timeout.
Individual interaction and performance assertions keep their own deadlines.

1. PRs run `web-core` for install, preflight, docs/design contracts, typecheck, lint, and the required Next production build.
2. PRs run `web-targeted` for deterministic changed-path contract packs such as voice gateway, cache, analytics, routes/surface map, phone verification, and Capacitor static parity. Its five jobs are `Web Targeted Contracts (node)` and `(browser-1-of-4)` through `(browser-4-of-4)`. `WEB_TARGETED_PART=node` runs the Vitest and verifier packs once without downloading a browser. All four `WEB_TARGETED_PART=browser` jobs run the matched Playwright packs with `PLAYWRIGHT_WORKERS=3` and complementary `PLAYWRIGHT_SHARD=1/4` through `4/4`; the matrix aggregate must succeed for frontend changes. The Connections pack uses one worker; its timing, geometry and engine coverage remain unchanged. Each pack is classified by whether its npm script reaches `playwright`; a local unsharded run (`all`) still runs every pack. `scripts/ci/test_web_ci_lane_partition.py`, run by the governance check, proves the partition against the real script.
3. PRs run `web-full-suite` (job `Web Full Suite (Vitest)`) for the whole Vitest suite (`npm run test:ci`, ~9,700 tests) plus the voice gateway, One Voice, surface-map, Capacitor static-parity and Capacitor plugin-contract checks. It runs in parallel with `web-core` as three Vitest shards (`WEB_FULL_SUITE_SHARD=<i>/3`, `vitest --shard`, jobs `Web Full Suite (Vitest) 1/3` to `3/3`); shard 1 also runs the contract verifiers, once. `CI Status Gate` reads the matrix's aggregate result, which is `success` only when every shard succeeded, and requires it to have **succeeded** (not merely not failed) whenever the frontend filter matches. Until 2026-09-26 this suite ran only in `Queue Validation`, which nothing merged through, so it gated no merge.
4. `web-full` is `web-core` followed by `web-full-suite`, for local and exhaustive runs. The legacy `web` stage remains an alias for `web-full` so older local wrappers keep their exhaustive behavior.

The mandatory full suite owns matching Vitest cases in hosted validation. Analytics'
Android-scope verifier and Node failure tests remain in the targeted Node leg because
Vitest does not collect them. Siri runs once through `verify:voice-gateway`; the full
suite runs native static parity separately. Standalone focused npm commands retain
their complete behavior. The lane-partition contract checks these boundaries.

Flake budget: in CI each Playwright test gets one retry (`retries` in
`hushh-webapp/playwright.config.ts`), so a test that fails twice fails its
browser shard; the macOS `Web Editor Performance` lane uses the same config
and budget. Each browser shard's `Install Playwright browsers` step, which
also runs the web dependency install, is bounded at 8 minutes and retries a
failed browser install once, so a stalled apt mirror or browser download
fails the shard early instead of holding a runner to the job limit.

Failed synthetic Wallet and connected Calendar layout runs retain
`synthetic-layout-failures-<matrix-label>` for seven days: only those fixtures'
traces, failure screenshots and error context are admitted. Protected reviewer
journeys must never enter these artifacts. Earlier commands can clear their
output; this does not prove retention for preceding packs or failures that pass
on retry.

Calendar's lock regression holds the next Schedule response while asserting that
the prior private view is cleared, then releases distinct fresh information.
This distinguishes stale private DOM from a new Firebase-authorized read, which
Schedule supports while the vault is locked; it does not relax the whole-page
privacy assertion.

Fail-fast contract:

1. Cheap authority checks run before expensive web/protocol/integration lanes:
   secret scan, DCO/base-policy where applicable, branch freshness, path
   resolution, and repo governance.
2. The `Preflight Gate` fails before Next.js, full protocol, or integration
   runners start when one of those authority checks is already failed.
3. This intentionally saves CI minutes on governance failures. The tradeoff is
   that green runs start heavy jobs only after preflight completes.

The local parity script mirrors the blocking pre-merge validation stages. On GitHub, `main` should require `CI Status Gate` as the blocking status check on PR and queue commits, block a pull request whose base is stale through `Base Freshness Gate` (named `Main Freshness Gate` in older text; it feeds `CI Status Gate`; bounded for pull requests into `main`, see [Base freshness on pull requests](#base-freshness-on-pull-requests)), trust `Main Post-Merge Smoke Gate` for deployment eligibility on the landed `main` SHA, and restrict queue bypass to the dedicated sanctioned owner cohort only.

### Protected pipeline surfaces

Core CI and deploy surfaces are sealed separately from blanket owner-review policy.

- PRs that change protected pipeline paths are allowed only for the sanctioned bypass cohort defined in [config/ci-governance.json](../../../config/ci-governance.json).
- This guard currently covers:
  - `.github/workflows/**`
  - `.github/actions/**`
  - `scripts/ci/**`
  - `deploy/**`
  - `config/ci-governance.json`
- Enforcement happens inside the blocking governance lane through [scripts/ci/verify-protected-pipeline-edits.py](../../../scripts/ci/verify-protected-pipeline-edits.py).
- This does not waive the required independent approval of the latest push on `main`; the separately governed review-bypass cohort remains explicit. It seals core pipeline and CI authority to the sanctioned maintainer cohort.

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
3. post-upgrade investor / RIA / consent smoke from [Kai Runtime Smoke Checklist](../kai/kai-runtime-smoke-checklist.md)

The canonical blocker for that broader surface is:

1. [scripts/ci/pkm-upgrade-gate.sh](../../../scripts/ci/pkm-upgrade-gate.sh)
2. [scripts/ci/resolve-uat-verification-plan.py](../../../scripts/ci/resolve-uat-verification-plan.py) is the single changed-SHA selector used by PR, queue, post-merge, dev and UAT lanes
3. `integration-check.sh` runs the PKM gate only when that selector finds a PKM upgrade, stored-shape, migration, or fixture change; selector-policy changes are covered by always-on classifier contract tests. Ordinary UI, consent, MCP, RIA, and provider changes keep their own focused checks without repeating the PKM cycle
4. a missing or unproven comparison base fails closed to the deterministic PKM/reviewer plan, never to implicit paid model calls
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
SHA; explicit scopes remain available. Dev consumes the exact green branch SHA
without an application merge to main. UAT and production retain their main-SHA
and environment gates. Workflow changes become active only after governed main
landing; feature-branch source does not change the running workflow definition.
For reviewer BYOK, `required` selects execution; the existing UAT rollout
classifier still records the result as advisory. A green step conclusion under
`continue-on-error` is not a passing rehearsal: inspect the release receipt's
`reviewer_byok` outcome. A healthy rollout does not satisfy reviewer acceptance
when that proof is part of the task. The World Model background driver and its
provider select this lane because automatic startup must respect read-only
reviewer posture.

For RCA acceptance, `repeat_reviewer_byok=true` repeats an already-selected
baseline twice in independent browser lifetimes. It defaults to false, does not
select an otherwise-skipped lane or authorize mutations, and records requested
and completed pass counts in the release receipt. A failed pass stops that
rehearsal; it does not change the existing advisory rollback policy.

UAT backend provider admission runs Azure and Vertex synthetic checks in parallel.
Azure's complete application capability bundle must pass; Vertex results remain
diagnostic and cannot replace Azure qualification. The bundle includes streamed structured text, images, PDFs,
public search/source receipts, Location transcription/semantics, narration, Live
audio with a function round trip, and application-compatible embeddings. Explicit
PWM attribution/schema failures still block independently. Receipts bind the exact
candidate image, runtime identity, provider generation and configuration.
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
The UAT artifact collector reads the exact successful backend Cloud Build ID from
structured CLI output, then retrieves the successful aggregate step's receipt
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

## When CI Runs

| Trigger | Branches | Behavior |
|--------|-----------|----------|
| Pull request | All branches (`**`) | `PR Validation` medium-depth CI (path-filtered) |
| Merge queue | `main`, `integration/pr-train` | `Queue Validation` pass-through: reports `CI Status Gate` on the merge group only when its tree equals the PR head's tree and PR Validation passed on that head; plus `Base Freshness Gate` |
| Push | `main` | `Main Post-Merge Smoke` compact deploy-authority smoke |
| Manual | Any | `PR Validation` `workflow_dispatch` with scope `auto` (default) \| `all` \| `frontend` \| `backend`; see [Dispatched runs](#dispatched-runs) |
| Schedule | `main` | `Editor Performance Nightly` runs the macOS editor lane's steps at 23:17 UTC and opens or comments on one issue when they fail |

**Path filters:** `PR Validation` runs jobs only when relevant paths change. A dispatched run with scope `auto` applies the same filters to the dispatched commit's changes against the default branch; `all`, `frontend` and `backend` choose the lanes by hand. `Queue Validation` runs no lane of its own (see [The merge queue in practice](#the-merge-queue-in-practice)), and `Main Post-Merge Smoke` stays compact rather than path-filtered.

- **Frontend jobs** run when `hushh-webapp/**`, protected CI workflow files, `scripts/ci/orchestrate.sh`, or `scripts/ci/web-*.sh` change.
- **Backend jobs** run when `consent-protocol/**`, `packages/hushh-mcp/**`, protected CI workflow files, or backend/shared `scripts/ci/**` files change. Dedicated web-only lane scripts are excluded; `web-common.sh` also schedules the backend contracts that exercise its build defaults.
- **iOS native job** (`ios-native-check`) runs when the `ios` filter matches; that filter lists the web surfaces the XCUITests render alongside the native shell paths, and it is pinned by `consent-protocol/tests/test_ios_lane_path_filter_covers_native_test_surfaces.py`, so a native test that starts rendering a new web surface fails CI until the filter names it. Package resolution runs sequentially after `cap sync`, using the job-local package cache. `scripts/ci/resolve-ios-packages.sh` retries once only for exit 74 with the known cold binary-download cache collision; it retains verified cache entries and both attempt logs. Other failures and a second failure block the lane. Native compilation and tests are never retried by this helper. This is a bounded workaround for the [upstream SwiftPM race](https://github.com/swiftlang/swift-package-manager/pull/10203), not evidence that native checks passed. The simulator boots after the web export so it does not compete with `next build` for memory. Swift package clones may restore only under the verified graph key; a failed partial restore is cleared before resolution.
- **Editor and drawer performance job** (`web-editor-performance-check`, `Web Editor Performance (macOS)`) runs when the `editor` filter matches, not on every frontend change. The filter lists what `npm run test:layout-editor-performance` builds and reads: the editor and History motion specs, the fixtures they bundle and their transitive imports, `app/globals.css`, the inlined Plus Jakarta Sans font files, and the Playwright, TypeScript, Tailwind and PostCSS configs, `package.json` and `package-lock.json`. It took one of the org's five macOS slots on every frontend run, while its inputs changed in 78 of the 378 merged PRs that touched the frontend from 2026-10-01 to 2026-10-15. `consent-protocol/tests/test_ios_lane_path_filter_covers_native_test_surfaces.py` derives those inputs from the job itself and fails when one would not schedule it, and `.github/workflows/editor-performance-nightly.yml` runs the same steps on `main` every night at 23:17 UTC and opens (or comments on) one `Editor performance nightly failed on main` issue when it fails. The History motion case preserves its 100 ms onset and 360/260 ms observation windows in both engines on this same serial macOS lane. Linux retains tap/close geometry and interrupted-pull cancellation; its software-rendered WebKit clock is not an absolute latency measurement.
- **Integration job** runs when either frontend or backend paths change.

The existing macOS performance job also runs the shared History motion contract
in both Chromium and WebKit: first visibility under 100 ms, intermediate opening
and exit frames, interrupted-drag alignment and unchanged surrounding layout.
Its focused fixture mounts the real drawer/sidebar without unrelated agent or
connector workflows. The Linux Connections pack keeps the other layout and
interaction checks. Native collection verifies both timing identities reach
macOS and that the remaining Connections identities still reach Linux. Disabling
transitions or delaying opening beyond 100 ms must fail the timing test; dropping
a drawer input from the path filter must fail its dependency guard. These browser
checks do not replace physical Release frame-pacing qualification.

**How `scripts/ci/` is split (2026-09-26).** Each file schedules the lanes that
actually run it, instead of every lane:

| `scripts/ci/` file | Schedules | Why |
|---|---|---|
| `orchestrate.sh` | frontend and backend | dispatches every stage |
| `web-common.sh` | frontend and backend | shared web helper plus backend contracts for build-origin defaults |
| `web-core-check.sh`, `web-targeted-check.sh`, `web-full-suite-check.sh`, `web-full-check.sh`, `web-check.sh` | frontend | dedicated web lane execution |
| every other file, including any added later | backend | covers the protocol, MCP and integration lanes (`protocol-check.sh`, `verify-protocol-*`, `hushh-mcp-package-check.sh`, `integration-check.sh` and what it calls) and the deploy scripts the protocol test suite exercises directly |

The backend side includes `scripts/ci/**` and excludes the named web-only lane
scripts, so a new script is backend by default rather than scheduling nothing. The filter
step sets `predicate-quantifier: 'some-with-excludes'` for that `!` pattern;
filters without a `!` pattern behave exactly as before. The iOS filter includes
the onboarding setup screens now reached through the login render graph, plus
the shared Profile owner-state, Gemini and World Model controller inputs.

Guards, both in the backend CI manifest:
`consent-protocol/tests/test_ci_path_filters_cover_lane_scripts.py` derives
which `scripts/ci/` files each path-filtered job runs (through
`orchestrate.sh <stage>` and everything those scripts reference, plus every
script the lane's own code names) and fails when one of them would not
schedule that job. `consent-protocol/tests/test_ios_lane_path_filter_covers_native_test_surfaces.py`
traces the XCUITest render path's imports and requires the reached onboarding
screens and selected shared Profile inputs to schedule the native lane. It does
not schedule iOS for every unrelated frontend change.

One gap is known: the guard runs in the backend lane, so a PR that changes
only `web-*.sh` does not run it. If such a PR makes a web script call a
non-web `scripts/ci/` file, the guard catches it on the next backend-scheduling
change, not in that PR. Add the called file to the frontend filter in the same
change. The `editor` filter's guard has the same gap: a frontend-only PR that
makes the editor lane import or read a file outside the filter does not run
it. The next backend-scheduling change fails until the file is added, and the
nightly run catches a regression that lands on `main` in the meantime. Add the
file to the `editor` filter in the same change.

### Duplicate-Run Policy

Feature and hotfix branches intentionally rely on `pull_request` CI only. `Base Freshness Gate` blocks a PR whose merge-base is over 24 h old, or whose files `main` changed after the base its checks tested (see below), and `main` then runs a smaller smoke bundle (`Main Post-Merge Smoke`) on the real landed SHA.

### Base freshness on pull requests

`Base Freshness Gate` runs
[scripts/git/check-main-sync.sh](../../../scripts/git/check-main-sync.sh). Since
2026-10-15 it uses `MAIN_SYNC_MODE: bounded` for pull requests into `main`:

1. A head that already contains the tip of `main` passes, as before.
2. Otherwise it **blocks** when the merge-base is more than
   `MAIN_SYNC_MAX_AGE_HOURS` (24) old, or when, after the base the PR's checks
   tested, `main` changed a file the PR also changes. The log and the step
   summary list up to 20 such paths. The tested base is the first parent of the
   `refs/pull/N/merge` commit (`github.sha`) that every lane checks out. When it
   cannot be resolved, the merge-base stands in, which counts every `main`
   change the branch lacks.
3. Otherwise it passes with a warning and a step summary: how many commits
   behind, the tested base, the merge-base age, and that no file overlaps.

A missing remote, a failed fetch or an unresolvable commit still fails the gate.

Why: measured on 2026-10-14, `block` mode caused 30-57% of failed PR runs, and
about 17% of runs were sync-only re-runs. `main` lands 24-57 merges a day
against a ~25 minute green run, and the check fetches `main` when its job
starts, so runner queueing alone made fresh pushes stale. It did not keep stale
bases out either: 64% of merges landed behind `main` anyway, and `Main
Post-Merge Smoke` was 324/0 green. The lanes already test the PR merged onto
`main`. What they cannot see is a file both sides changed since, or a base old
enough to drift, and bounded mode blocks exactly those.

`block` mode, which fails any lag, stays in place for pull requests into
`integration/pr-train`, on every merge group (`Queue Validation`), and in
`scripts/ci/local-release-gate.sh`. Local pre-push stays `warn`. GitHub's own
strict up-to-date rule on `main` (`require_strict_status_checks` in
[config/ci-governance.json](../../../config/ci-governance.json)) is unchanged.

### Dispatched runs

`PR Validation` can be dispatched on any branch (`gh workflow run ci.yml --ref <branch>`). It publishes a distinct `Branch Validation Gate` that `deploy-dev.yml` accepts through `scripts/ci/require-deploy-sha-on-main.sh`.

- `auto` (the default) runs the lanes the branch's changes select, through the same path filters a pull request uses, applied to the dispatched commit against its merge-base with the default branch. On the default branch itself there is no branch diff, so `auto` runs every lane.
- `all` runs every lane.
- `frontend` and `backend` run a subset of the lanes and are diagnostic only: `Branch Validation Gate` fails them.

The default was `all` until 2026-10-15, which put iOS on one of the org's five macOS slots on every dispatch; one 30-minute dispatch loop made 59 of the 77 runs dispatched from 2026-10-07 to 2026-10-15.

A dispatch publishes **Branch Validation Gate**, while a pull request retains **CI Status Gate**. Both use the same fail-closed aggregate and selected full suites. The separate name prevents a manual run from satisfying PR branch protection or replacing its verdict. PR Base Policy, Base Freshness Gate and merge-queue reuse still require the PR's own evidence. A branch may therefore qualify for dev even when its PR cannot be merged into the current base.

Only `deploy-dev.yml` accepts the branch gate. Its exact-SHA preflight verifies branch reachability and binds the successful check to GitHub Actions, the canonical `ci.yml` workflow, `workflow_dispatch`, and the same check suite and SHA. Missing or failed provenance lookup refuses deployment. The API read is bounded to the latest 100 matching runs; an older unobserved receipt refuses rather than passing. UAT, production, queue selectors and branch-protection configuration do not accept this label. The reviewed workflow correction must be present on the branch before dispatch. `DCO` runs on dispatches too, over the branch's own commits since its merge-base with the default branch.

### The merge queue in practice

The `main merge queue` ruleset is active, but its bypass list holds the
governed maintainer cohort, and those maintainers land PRs directly. No PR has
entered the queue since 2026-09-01, the date of the last full `Queue
Validation` run, and that run's `web-full` step was red in each of its last six
runs. So the queue does **not** absorb stale-base risk; `Base Freshness Gate`
on the PR is what bounds it (see
[Base freshness on pull requests](#base-freshness-on-pull-requests)).

**Since 2026-09-26 the full Vitest suite gates every frontend PR** through the
`Web Full Suite (Vitest)` lane in PR Validation, and `Queue Validation` is a
thin pass-through rather than a second copy of CI.

Why it was not deleted: `main` requires the `CI Status Gate` check
([config/ci-governance.json](../../../config/ci-governance.json)) and the
merge-queue ruleset is active, so a PR placed in the queue needs a `CI Status
Gate` on its merge group or the entry times out and is dropped. Deleting the
workflow would turn the queue into a trap rather than retire it.

What the pass-through checks, in
[scripts/ci/verify-queue-entry-reuses-pr-validation.py](../../../scripts/ci/verify-queue-entry-reuses-pr-validation.py):

1. the merge group's head ref names one PR (`gh-readonly-queue/<base>/pr-<N>-<sha>`);
2. the merge group's git **tree** is identical to the PR head's tree, which holds
   exactly when the PR already contained its base and no other entry is queued
   underneath it. Identical trees are identical content, so PR Validation's
   verdict is a verdict on the merge group, not an approximation of it;
3. the latest `PR Validation` run on that PR head has a successful `CI Status
   Gate` job.

Anything else fails closed with the fix: update the branch, wait for PR
Validation, re-queue. `Base Freshness Gate` still runs on the merge group.
Merge groups that stack several entries are therefore rejected rather than
approximated; with `max_entries_to_merge: 1` that only costs a re-queue.

To retire the workflow outright, the founder would remove the merge-queue
rulesets (`main merge queue`, `integration pr train merge queue`) and set
`merge_queue_required: false` in `config/ci-governance.json` in the same change;
the workflow can then be deleted.

---

## Global Gates (Always Run)

| Gate | Purpose | Behavior |
|------|---------|----------|
| Secret Scan | Detect leaked credentials/tokens early | `gitleaks` OSS CLI scans the event commit range, blocks on open GitHub secret-scanning alerts, and reports Dependabot backlog through the GitHub API |
| Upstream Sync | Detect consent-protocol subtree drift against upstream | Advisory only; warnings are non-blocking |
| Main Freshness Gate (job name `Base Freshness Gate`) | Keep a branch's base fresh enough that what CI tested is what lands | Pull requests into `main`: `MAIN_SYNC_MODE: bounded`, blocking when the merge-base is over 24 h old or, after the base its checks tested, `main` changed a file the PR changes ([details](#base-freshness-on-pull-requests)). Pull requests into `integration/pr-train` and every `merge_group`: `block`, failing any lag. Feeds `CI Status Gate` |
| CI Status Gate | Single required check for branch protection | Runs on every outcome (`if: always()`), because GitHub reads a skipped required check as a pass. Fails if any job fails, is cancelled or times out. Every lane the path filters (or a dispatch scope) select must have **succeeded**: Web Core, Web Targeted Contracts, Web Full Suite (Vitest) and Integration for frontend; Protocol, MCP Package and Integration for backend, including Protocol Database; the iOS and Android native lanes; Web Editor Performance (macOS) for `editor`. UI Contracts, Secret Scan, Governance, Path filters, Preflight Gate and DCO must succeed on every run, and a pull request also needs PR Base Policy and, into `main` or `integration/pr-train`, Base Freshness Gate. Lanes the filters did not select may be skipped. A dispatch publishes the separate dev-only `Branch Validation Gate` and fails for partial or unknown scopes ([Dispatched runs](#dispatched-runs)). Pinned by `consent-protocol/tests/test_ci_status_gate_fails_closed.py`, which runs the gate's own script |

Operational note:

- `Upstream Sync` and `Main Freshness Gate` are different surfaces.
- `Upstream Sync` must summarize the actual `consent-protocol/` subtree state from `scripts/ci/subtree-sync-check.sh`.
- `Main Freshness Gate` only describes branch currency relative to `main`.
- Local pre-push keeps upstream sync opt-in for shipping speed. Use `./bin/hushh protocol check-sync` or `CONSENT_PRE_PUSH_SYNC_CHECK=1 git push`; CI remains the shared advisory evidence lane.

## Live GitHub Enforcement

Protected branches are expected to enforce the same CI contract documented here:

- repository setting
  - auto-merge enabled so `gh pr merge` can hand green PRs to merge queue instead of failing before queue placement
- `main`
- `1` independent approving review of the latest push (the governed bypass cohort is separate)
  - required status checks: `CI Status Gate`
  - strict/up-to-date checks enabled
  - conversation resolution required
  - merge queue enabled for `main`
- force-pushes disabled
- branch deletion disabled

The live GitHub setting can drift from the docs, so verify it directly:

```bash
./scripts/ci/verify-main-branch-protection.sh
```

Current live nuance:

- the repo uses branch protection for review, freshness, and conversation-resolution requirements
- the sanctioned bypass cohort should be limited to the approved owner set, without overlapping push-restriction lists
- that sanctioned cohort is intentional governance and should not be reported as drift when it exactly matches `config/ci-governance.json` and includes `kushaltrivedi5`

## Deployment environments

GitHub deployment environments are part of the release authority surface and should stay minimal:

- `uat`
  - no reviewers
  - no admin bypass
  - protected branches only
  - used by [`.github/workflows/deploy-uat.yml`](../../../.github/workflows/deploy-uat.yml)
- `production`
  - no reviewers
  - no admin bypass
  - protected branches only
  - used by [`.github/workflows/deploy-production.yml`](../../../.github/workflows/deploy-production.yml)

There should not be parallel legacy production environments carrying approval logic that the current workflows no longer use.

GitHub only records deployment history under an environment after a workflow job actually runs with `environment: <name>`. Older deploy runs from before that binding existed are not retroactively re-linked. If `uat` or `production` looks empty after environment cleanup, trigger one fresh deploy from a green `main` SHA to seed the canonical history.

Verify live environment governance with:

```bash
python3 scripts/ci/verify-deployment-environment-governance.py
```

### Qualified frontend lint toolchain

The onboarding/security correction keeps patched Next.js 16.4.2 independently
of the reviewed lint toolchain: `eslint-config-next` 16.2.4 and its supported
`eslint-plugin-react-hooks` 7.0.1. ESLint remains 9.39.4. The newer analyzer
reported 742 compiler findings across existing source (600 refs, 101 immutability,
41 manual-memoization findings). Both analyzer versions enable these rules as
errors; no rule or severity is disabled here. Qualify that analyzer migration
separately instead of changing owner/session-ref behavior during a security fix.
The lint package declares no Next runtime peer constraint. Existing dependency
alerts remain independently reported.

### GitHub Alert Parity

The secret gate is intentionally stricter than raw regex scanning:

- local runs use authenticated `gh` access to compare against open GitHub secret-scanning and Dependabot alerts
- the protected `ci-security` environment holds `GH_SECURITY_ALERTS_TOKEN`, a replacement fine-grained token with only Secret scanning alerts: read and Dependabot alerts: read; its custom deployment branch policy permits `main` only
- the final blocking mode fails if either:
  - `gitleaks` finds a leak in the scanned commit range, or
  - GitHub still reports any open secret-scanning alerts
- open Dependabot alerts are currently advisory in CI; they are still reported in logs and should be managed as backlog, but they do not block unrelated merges
- explicitly strict checks refuse missing CLI/authentication, unavailable required reads and malformed responses; unavailable authority is never a successful clearance

[The main-owned alert worker](../../../.github/workflows/ci-security.yml) reads
alerts with the protected environment credential. PR-controlled Secret Scan
receives only the read-only Actions token and verifies a bounded, immutable
receipt for its exact source run, attempt and SHA. The worker serializes
repeated start notifications and reuses a verified receipt for the same tuple;
another attempt requires a fresh inventory. Its bounded pending queue uses
`queue: max` with cancellation disabled: GitHub's default single pending slot
would cancel an earlier duplicate during a burst, correctly causing our
fail-closed consumer to refuse clearance. See the [GitHub concurrency contract](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).
The 23 October sample contained 80 successful worker records across 25 source
attempts. Receipt reuse alone did not eliminate those repeated workflow starts.
The automatic trigger now uses `requested` once for each new validation run,
instead of repeated `in_progress` transitions. This landed through
[PR #8371](https://github.com/hushh-labs/hushh-research/pull/8371), after all 26
exact-head checks passed; the canonical task carries live initial/retry receipts. Missing, expired, mismatched or
incomplete receipts fail closed. Local checks use the same bounded cursor
reader without writing raw alerts to disk.

The replacement credential was qualified on 22 October 2026 using worker
39861716513. On 23 October, PR8365 passed all 26 checks and landed as `51a5a86675`.
Main worker `39889655505` then verified receipt reuse without another inventory
read or artifact. The repository-level secret was deleted and its absence read
back; no same-name organization secret is accessible to this repository. The
main-only protected replacement remains present. Original PAT revocation is
separately unverified: removing a stored secret does not revoke its token.
Older PR branches must inherit the current read-only consumer and rerun gate through normal
main synchronization; never restore the exposed repository credential to repair
an obsolete consumer. Missing authority still refuses clearance.

The worker starts when a new PR Validation run is requested; it does not wait
for the validation it must unblock. [GitHub does not emit `requested` for reruns](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
Use the governed operator command below to request one retry and its exact
security worker together. Only immutable main code reads
the protected token. It validates the repository, canonical workflow, source run,
current attempt and exact SHA before and after bounded, complete API pagination.
GitHub's verified `pending` concurrency state is accepted alongside queued,
running and completed sources; this does not replace successful PR validation.
Its two-day artifact contains counts and provenance only. Repository-wide secret
clearance intentionally replaces the old PR-created-date filter; dependency
backlog remains advisory. No PR code, dependencies, caches or artifacts execute
with alert credentials. Manual main-only recovery requires the existing protected
pipeline operator cohort and exact `source_run_id`, `source_attempt`, `source_sha`.
A missing credential, denied read or incomplete inventory refuses clearance.

```bash
./bin/hushh codex ci-rerun --run-id <id> --expected-attempt <current-attempt> --sha <exact-head-sha>
```

The default retries failed jobs only; `--all` explicitly retries the full run.
`--job-id <id>` retries only the completed final gate after proving its run, SHA
and membership in the complete attempt-scoped job inventory; use it for gate-only
qualification instead of repeating successful suites. Other jobs use the failed
or full-run modes.
The command verifies main's operator policy and the completed source, requests
one retry, observes its incremented attempt, then dispatches the protected worker
on main. An uncertain response is reconciled without another rerun request.
The final gate verifies that new attempt's receipt even if GitHub retained the
previous successful Secret Scan job. PR permissions remain read-only.

When changing final-gate outcomes or conditions, run the nearest actual gate
harness alongside the existing security authority/receipt suites before pushing:
`cd consent-protocol && uv run pytest tests/test_ci_status_gate_fails_closed.py -q`.
Its scenarios execute the outcome bash; retry cases isolate only checkout and
receipt I/O. Unknown conditions still refuse verification.

A raw GitHub UI rerun does not automatically launch the worker. Its consumer
prints the exact main-only recovery command immediately and retains the bounded
eight-minute wait. Dispatch recovery while that attempt is running. If it has
already failed, use `ci-rerun` for the next attempt; a late receipt cannot turn a
completed failed check green. Inspect an uncertain worker dispatch before retrying
it. Never repeat the source request merely because the worker response was lost.

## Advisory Checks (Non-Blocking By Default)

1. `scripts/ci/docs-parity-check.sh`
2. `scripts/ci/subtree-sync-check.sh`
3. `npm run verify:investor-language`
4. Native build/smoke checks (`./bin/hushh native ios --mode uat`, `./bin/hushh native android --mode uat`) for native release lanes
5. `scripts/ops/verify-env-secrets-parity.py` for release preflight and deployment readiness; it fails closed when the Firebase Admin credential and public Firebase client configuration name different projects, without rendering either value
6. Broad full-suite pytest runs and Kai accuracy/compliance suites

Do not add new CI/parity scripts without replacing or consolidating an existing check.

## Lean Required Gate Model

The required pre-merge lane stays intentionally small:

1. secret scan
2. DCO signoff
3. governance drift (`docs verify`, Apache/license surface, skill lint)
4. release contract alignment (`./bin/hushh db verify-release-contract`)
5. changed-surface web/backend checks
6. cross-surface integration checks

Post-merge smoke remains the deployment eligibility gate for `main`.

Practical maintainer rule:

1. Use `git commit -s` for new branch commits that are headed to GitHub.
2. Run `./bin/hushh codex pre-pr` before opening or updating a PR; the workflow runs the local DCO signoff gate before the broader CI mirror.
3. If unsigned commits already exist on the branch, repair them before push with `git rebase --signoff <base>` or a clean signed squash onto `origin/main` when subtree sync or merge repair made the branch history noisy.
4. After subtree sync, branch merge, rebase, queue repair, or any other history-changing operation, rerun `bash scripts/ci/check-dco-signoff.sh origin/main HEAD` immediately before pushing.
5. If the last local edit touched `.codex/`, `docs/`, `config/`, or `scripts/`, rerun `bash scripts/ci/orchestrate.sh governance` even if an earlier `./bin/hushh codex pre-pr` was green.

### Local core mirror

`bash scripts/ci/orchestrate.sh core` is the fast local pre-push run: secret and governance, then protocol and web-core in parallel (separate Python and Node runtimes), then mcp-package and integration, which need the protocol stage's Python environment. Measured on 2026-09-26 it took 374 s, against about 1,126 s for every stage run serially. The browser layout packs (`web-targeted`, 429 s) and the full Vitest suite (`web-full-suite`) are not in the core mirror; GitHub Actions runs them and stays the authority. Set `CORE_SERIAL=1` to run protocol and web-core one after the other. `web-targeted` runs every matched pack and lists every failure instead of stopping at the first, so one broken pack no longer hides the next.

When the broad Chromium/WebKit layout pack is selected, it owns the agent
surface spec; `web-targeted-check.sh` retains its standalone invocation for
agent-only changes. The lane partition check proves both paths and both engines.

Tests follow the same economy: add a test only for a real regression, a trust boundary (with a negative control), or a public API or schema contract, and extend existing test files before creating new ones (`AGENTS.md`, Verification rules 5 to 8).

### Script Lifecycle Policy

1. Add a new CI/helper script only when it replaces or consolidates an existing one in the same PR.
2. Every CI/helper script must have a clear owner (`frontend`, `backend`, or `platform`) in PR notes.
3. Any CI scope expansion requires reviewer approval from the owning team.

## Branch Lanes

1. `integration/pr-train` is the intake branch for non-maintainer contributor and agent work; governed maintainers may open branches cut from `origin/main` directly to `main`. `main` remains the sole promotion authority for UAT and production.
2. UAT and production use a green `main` SHA with successful `Main Post-Merge Smoke`. Dev accepts an exact CI-green branch SHA through the [Dev Fast Lane](./dev-fast-lane.md).
3. UAT deploys only by an explicit manual dispatch of that green `main` SHA through `.github/workflows/deploy-uat.yml`.
4. Manual UAT dispatch is limited to the current
   `uat.manual_dispatch_users` cohort in `config/ci-governance.json`; do not
   transcribe actor names into this document.
5. Production deploys only through a manual SHA dispatch in `.github/workflows/deploy-production.yml`, and only actors listed in `production.manual_dispatch_users` may trigger it.
6. Manual UAT or production redeploys must use a SHA that is reachable from `origin/main` and already green in post-merge smoke.
7. Feature and hotfix branches may deploy to dev through its governed main-owned dispatch. UAT and production require promotion through `main`.

Deploy to UAT is expected to behave as a closed-loop release lane:

1. start from an explicitly chosen green `main` SHA
2. sync canonical secrets
3. capture last healthy revisions
4. deploy changed surfaces
5. verify runtime mounts and semantic behavior
6. retry once on transient readiness
7. roll back only the failing changed surface
8. publish release artifacts with revisions, reports, and final status

UAT text recovery starts one exact-image execution and observes its identity to
terminal state before removing the temporary Job. Its 420-second controller
allowance includes provider startup and settlement; the worker retains its
120-second task limit, zero retries and bounded batch. In run `39949039317`, the
old 180-second waiter deleted the Job before a receipt arrived at 207 seconds.
The provider reported cancellation, so the later worker receipt cannot qualify
that release. Require both provider success and the exact SHA/policy-bound
receipt. An unread or timed-out execution remains unconfirmed with its Job and
execution references retained for reconciliation; do not replay it or delete
active work merely because observation stopped.

UAT and production revision retirement use the existing `Capacity Maintenance` workflow,
run hourly. Releases never trigger it. Because GitHub delivered only 3-6 of its former
cron's 24 daily runs on 2026-10-12..14, `Capacity Maintenance Clock` is now its only
schedule: it checks both environments every hour without cloud credentials, wakes
maintenance only when work is due with a repository dispatch scoped to the due
environments (the scheduled pass's authority within that scope), and re-arms itself
through the `capacity-maintenance-clock` environment's 60-minute wait timer, which holds no
runner. A scoped pass's title lets the other environment's checkpoint guard skip it without
reading its jobs. The deploy-SHA gate and the UAT target selector look up the post-merge gate
by check name, so the clock's checks on an idle `main` head never crowd it out. An authorized operator
can explicitly inspect or apply cleanup; manual requests are not coalesced with cron.
Scheduled work keeps one active and one pending request without cancelling active
mutations. Each environment still shares its deployment/rollback lock.

Source-only checks before authentication and again under that lock skip settled and
not-yet-due work. Each executing pass has a 300-second budget, including subprocesses,
with teardown/checkpoint time reserved. No runner waits for request drainage: existing
artifacts retain the deadline and partial progress for the next hourly pass. Drainage
still covers the longest applicable request timeout plus 60 seconds. Unknown provider
outcomes retain mutation intent and block conflicting deployments until reconciliation;
a timeout does not prove that Google stopped the operation. No completion is claimed
for partial or unresolved work. Cleanup outcome is separate from release health and
capacity admission; diagnostic reporting does not add another unconditional cloud scan.
Retained database-connected revisions remain in admission accounting until safe
retirement. Zero minimum instances and aggregate SQL peaks do not prove that older
generations have finished their admitted requests. A shortage defers deployment.

The manual production capacity bridge has a narrowly pinned `serving_backend_clone_v3`
recovery for healthy revision `consent-protocol-00280-toz` and the failed launcher in
`consent-protocol-00283-ges`. It verifies the exact failed run's attempt-2 upload window,
artifact digest and successful rollback receipt. Only that immutable failed spec receives
a conservative two-worker reservation in maintenance accounting; ordinary worker conflicts
still refuse deployment. SQL limits, every retained revision, jobs and administrative reserve
remain counted. The clone preserves the healthy image, authority and traffic, with unchanged
secret-history verification. A verified old bridge can transition only after it and its
predecessor are absent and unreferenced; its full receipt and checksum remain archived.
Unresolved intents cannot be discarded. Existing tag retirement and the full timeout drain
must finish before ordinary deployment admission can pass. Backend deployment clears inherited
command and argument overrides so the accepted image's launcher honors `WEB_CONCURRENCY`.

Production CRM qualification uses the application's `crm_product_available` authority.
The hosted CRM product is paused, so its gateway-only credentials and transport probe are
explicitly `not_applicable_product_paused`, without claiming gateway verification. If that
authority admits the product, required credential parity and the no-record gateway handshake
remain mandatory. Missing or malformed qualification blocks both paths; no product flag,
registry row, credential or other integration gate changes to obtain a passing release.

Both UAT admission observers stop within five minutes and poll at most once a minute.
Direct inventory checks under deployment locks also bound the entire process group
to 295 seconds, with two seconds for forced teardown. Their timeouts remain verification
failures; an unavailable inventory is not an observed capacity shortage.
`DEFERRED_CAPACITY` retains the original SHA/scope for an operator retry, without
starting maintenance or automatically resuming a deployment. See
[the hosted maintenance contract](../../../deploy/README.md#hosted-revision-maintenance).
Frontend-only UAT releases use a separate zero-increment SQL admission check that verifies the live web runtime and candidate revision; backend and paired releases retain the full connection budget gate.

Before increasing database pools or tiers after a failed load stage, inspect the
existing request query counts and acquisition timing. Drive's consent projection
checks its rolling schema capabilities once inside each existing transaction;
those checks are not cached across requests. Owner filters, revocation rules and
projection totals still execute against the current schema. The PostgreSQL
projection suite guards this query bound and its missing-schema and error cases.

See [Branch Governance](./branch-governance.md).

---

## Required Versions (Must Match CI)

| Tool | CI Version | Local requirement |
|------|------------|-------------------|
| Node.js | 24 for web/Node lanes | Local preflight accepts 20+; use 24 to reproduce CI |
| Python | 3.13 | 3.13 (CI asserts exactly 3.13) |
| npm | latest | Use latest (script upgrades before run) |
| uv | pinned by workflow | install `uv` locally and use `uv sync --frozen --group dev` |

Using a different Node or Python locally can cause “pass locally, fail in CI” if behavior or dependencies differ.

---

## Build Caches

GitHub scopes an Actions cache to the ref that saved it. An entry saved by a
`pull_request` run lives under `refs/pull/<N>/merge`, and no other pull request
can restore it. An entry saved on `main` can be restored by every pull request.
All entries share the repository's 10 GB budget. GitHub evicts an entry that
nobody restores for 7 days, and over 10 GB it evicts the least recently used
entries first. At 20:00Z on 2026-10-14 the budget held 10.65 GB, and
pull-request Next.js entries that no other pull request could restore were
5.50 GB of it.

The two large build caches are therefore saved on `main` only, and only when
the key is new. `PR Validation` restores them with `actions/cache/restore`:

| Cache | Saved by | Restored by | Key |
|---|---|---|---|
| Next.js build cache, the web app's `.next/cache` (~380-460 MB) | `Main Post-Merge Smoke`, on the first green push of each UTC day | `Web Core (Next.js)` | Node version, hash of `package-lock.json` and `next.config.ts`, and the UTC day. A miss falls back to the newest entry for the same lockfile. |
| Swift package clones, `$RUNNER_TEMP/spm` (estimated 2.5-3 GB) | [`iOS Swift Package Cache`](../../../.github/workflows/ios-swift-package-cache.yml), daily at 05:37 UTC and on manual dispatch. On Sundays it also resolves from an empty directory when the entry exists, and saves nothing. | `iOS Native (Xcode)` | Xcode version, runner OS and architecture, and a hash of the project's `Package.resolved` plus the `CapApp-SPM/Package.swift` that `cap sync` generates. Exact match only. |

Each day's Next.js entry stops being read once the next day's is saved, but it
stays until it has gone 7 days unread, so up to a week of them (about 3 GB) can
sit in the budget. They are the least recently used entries, so they are
evicted first.

The Swift package job skips the native web export. `cap sync ios` only needs an
`index.html` in the web directory, and it generates the same `Package.swift`
with or without the export. A pull request that changes the package graph
resolves uncached until the next daily run saves the new graph; dispatch the
workflow to re-seed sooner. The job's `setup-node` also saves the macOS npm
cache on `main`, so the macOS pull-request lanes restore that entry instead of
saving their own copies while their lockfile matches `main`.

A pull request that restores the Swift package clones fetches nothing, so it
no longer proves that every pin in `Package.resolved`, and every binary
artifact those packages download, can still be fetched. Every Sunday, and on a
dispatch with `cold` ticked, the job therefore resolves from an empty directory
even when the entry exists. When a run fails, the workflow opens or comments on
one issue, `iOS Swift Package Cache failed on main`. Pull requests that restore the
entry stay green, but a pin that can no longer be fetched would fail every iOS
pull request at the next graph change or eviction.

`scripts/ci/test_ci_cache_scopes.py`, in the governance check, fails when a
`PR Validation` job saves either cache, or when a restore stops looking up the
path and key its saver writes.

---

## Frontend Checks (Web / Next.js)

**Working directory:** `hushh-webapp/`

| Step | Command / behavior | Fails CI? |
|------|--------------------|-----------|
| Validate files | `package-lock.json` exists and valid JSON; `next.config.ts` exists | Yes |
| Install | `npm ci` | Yes |
| Design system | `npm run verify:design-system` | Yes |
| Cache coherence | `npm run verify:cache` | Yes |
| Docs/runtime parity | `npm run verify:docs` | Yes |
| TypeScript | `npm run typecheck` | Yes |
| Lint | `npm run lint -- --max-warnings=${WEB_LINT_WARNING_BUDGET}` | Yes |
| Phone verification regression | `npm run verify:phone-verification` | Yes |
| Build (web) | `npm run build` (Next.js) | Yes |
| Security audit budget | `npm audit --json` + budget gate (`moderate/high/critical`) | Yes |
| Tests | `npm run test:ci` (the whole Vitest suite), in the `Web Full Suite (Vitest)` lane | Yes |

**Build env (CI):** `NEXT_PUBLIC_BACKEND_URL` and all six `NEXT_PUBLIC_FIREBASE_*` vars are set to placeholders in the workflow so the build does not depend on real secrets.

**Coding rules that affect CI:**

- Do **not** use `fetch("/api/...")` in components or pages; use the service layer (see [Architecture](../architecture/architecture.md)).
- ESLint must pass with zero warnings (`--max-warnings=0`).
- TypeScript must compile with no errors.

---

## Backend Checks (Python / FastAPI)

**Working directory:** `consent-protocol/`

| Step | Command / behavior | Fails CI? |
|------|--------------------|-----------|
| Validate files | `pyproject.toml`, `uv.lock`, generated `requirements*.txt`, and `tests/` | Yes |
| Install | `uv sync --frozen --group dev` plus `bash scripts/sync_runtime_requirements.sh --check` | Yes |
| Lint | `uv run ruff check .` | Yes |
| Type check | `uv run mypy --config-file pyproject.toml --ignore-missing-imports` | Yes |
| Security | `uv run bandit -r hushh_mcp/ api/ -c pyproject.toml -ll` | Yes |
| Tests | `bash scripts/run-test-ci.sh` (manifest-driven curated suites run in parallel with pytest-xdist, plus a whole-tree collection gate) | Yes |

**Parallel pytest (2026-09-26).** `consent-protocol/scripts/run-test-ci.sh` runs the manifest with
`-n auto --dist loadfile`: one worker per CPU, and every test in a file stays on
one worker in file order, so module-scoped fixtures behave as they do serially.
Parallel execution is enabled by the script. On a loaded local host, the pinned
xdist supports `PYTEST_XDIST_AUTO_NUM_WORKERS=<count>` to bound the auto worker
count; this changes scheduling only, never test coverage or deadlines.
`protocol-check` in CI and the local `orchestrate.sh core` stage both reach it through
`consent-protocol/scripts/ci/backend-check.sh`. `tests/conftest.py` gives each
xdist worker its own `OFFLINE_DB_PATH` file so workers never share SQLite rows;
the Postgres-backed tests already create a uniquely named schema or database
per test.

Measured 2026-09-26 on a 16-core Mac shared with other agent sessions (so the
spread is load, not the suite): the full manifest serially took 599 s (6,388
passed, 203 skipped); three parallel runs each passed the same 6,388 with the
same 203 skipped and zero failures, in 186 s, 59 s and 103 s. The three
`ONE_COMMAND_TEST_DATABASE_URL` Postgres files, run concurrently against one
shared database three times, passed 57/57 each time and left no schema behind.
The protocol service uses PostgreSQL 17 with pgvector 0.8.6, pinned to the
upstream OCI index `sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`
through Google's public `mirror.gcr.io` cache. On October 9, two hosted runs were
refused by Docker Hub before checkout. Both registries returned that same index
and platform digests; the mirror changes transport without changing the database
fixture. A missing cached digest must fail initialization. See
[Google's cache contract](https://docs.cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images).

Before the switch CI spent 321 s in serial pytest (of a 7.8 min `Protocol
(Python)` p50). Enabling it surfaced one class of defect: two route tests
baked a module-level `uuid4()` into their parametrize ids, so every worker
collected different test ids and xdist refused to start. They now use a fixed
synthetic id.

If a test genuinely cannot share a machine with others, mark it and run it in a
second, serial pass inside `run-test-ci.sh`; do not skip it and do not add a
flag. None needed that as of this change.

Blocking backend manifest:

1. `consent-protocol/scripts/test-ci.manifest.txt`
2. Keep this manifest small and stable.
3. Full local repo checks are available through `./bin/hushh test`.
4. Kai accuracy/compliance remains manual through `./bin/hushh protocol accuracy`.

**Test env (CI):**  
`TESTING=true`, `APP_SIGNING_KEY`, and `VAULT_DATA_KEY` are set in the workflow (see [ci.yml](../../../.github/workflows/ci.yml)).

**Consent-token rule for automated tests:** Use fixture-issued VAULT_OWNER tokens from `consent-protocol/tests/conftest.py`. `consent-protocol/tests/dev_test_token.py` is debug-only and must not be required by CI.

**Config files:**

- **Ruff:** [consent-protocol/pyproject.toml](../../../consent-protocol/pyproject.toml) — `[tool.ruff]` and `[tool.ruff.lint]`. Target Python 3.13, line-length 100, selected rules (E, F, B, I, S), per-file ignores for tests and routes.
- **Mypy:** Same `pyproject.toml` — `[tool.mypy]`. Python 3.13, `warn_return_any`, `ignore_missing_imports`, overrides for `hushh_mcp.*` and consent/vault.

**Coding rules that affect CI:**

- Use **Python 3.13**-compatible syntax and types.
- Avoid ambiguous names (e.g. single-letter `l`) so Ruff doesn’t flag them.
- Optional args: use `Optional[T] = None`, not `T = None`, to satisfy mypy.
- Return types: avoid returning untyped `Any` from functions that declare a concrete return type; use `cast()` or correct types so mypy passes.
- New backend code under `consent-protocol/` is type-checked and linted; keep `api/` and `db/` aligned with mypy and Ruff.

### Capability-graph evolution gate

`uv run python scripts/generate_capability_graph.py --check` runs in the backend lane (`consent-protocol/scripts/ci/backend-check.sh`) and again through `npm run verify:one-voice` in the web lanes. It regenerates `contracts/kai/one-capability-graph.v1.json` from its sources and diffs the semantic nodes against the pull request base, not against `HEAD`: the predecessor is the committed graph at the merge-base with `origin/<base>`, where the base is resolved in this order: `--base-ref <ref>`, then `CAPABILITY_GRAPH_BASE_REF` (used verbatim), then `GITHUB_BASE_REF` and `WEB_TARGETED_BASE_REF` (bare branch names are prefixed with `origin/`), else `origin/main`. `protocol-check` and `web-full-suite-check` both export `CAPABILITY_GRAPH_BASE_REF=origin/<PR base>` over a full-history checkout; Queue Validation runs no lane and so resolves no base. Under CI the check fails closed when that base cannot be resolved. Locally, when no base ref can be resolved, it falls back to comparing against the graph committed at `HEAD` and prints a warning; that fallback only catches a change relative to your last commit, so run with a real base ref before relying on it.

When it fires, the error names the semantic ids with unacknowledged breaking changes. Do not edit the generated graph by hand. Either land a workflow migration with the owning workflow package, or add an exact-revision deprecation entry to `consent-protocol/hushh_mcp/agents/capability_graph_evolution.v1.json` whose `from_revision` is the base graph's top-level `revision`; broad or stale acknowledgements never suppress the gate. Then regenerate in dependency order (the agent registry if it changed, the capability graph, then the runtime topology index last, because it digests the others) and rerun the check with the same base ref CI will use.

---

## Integration Check (Route and Docs Contract)

**Runs when:** Frontend or backend paths change (or manual run with scope that includes either).

| Step | Command / behavior | Fails CI? |
|------|--------------------|-----------|
| Verify | `bash scripts/ci/docs-parity-check.sh` | Yes |

Route contracts must stay in sync between frontend expectations, backend (or proxy) routes, and the route/mobile docs. See [API Contracts](../architecture/api-contracts.md). If you add or change routes, update the contract and run the docs parity lane (or full local CI).

---

## Streaming Contract Gates

Canonical streaming is a production contract, not an implementation detail.

- Contract source: [Streaming Contract](../streaming/streaming-contract.md)
- Runtime pattern: [Streaming Implementation Guide](../streaming/streaming-implementation-guide.md)
- Vertex constraints: [Vertex AI Streaming Notes](../streaming/vertex-ai-streaming-notes.md)

Minimum checks for streaming changes:

- Frontend stream checks: `cd hushh-webapp && npm run test:ci` (includes streaming/parser suites)
- Backend stream/auth tests: `cd consent-protocol && pytest tests/test_kai_auth_matrix.py`

---

## Running CI Locally

During implementation, use the focused checks for the changed contract. Before
an ordinary push, run the local core mirror once on the completed candidate:

```bash
scripts/ci/orchestrate.sh core
```

GitHub Actions remains authoritative for full web and browser validation. A
local pass does not prove hosted success. The dedicated pre-PR workflow and an
explicit full-mirror investigation still use the full command below; `codex
pre-pr` already calls it, so running both duplicates the same local suite.

```bash
./bin/hushh ci
```

This script, which also powers `./bin/hushh codex pre-pr`:

1. Validates required files (e.g. `package-lock.json`, `next.config.ts`, `pyproject.toml`, `uv.lock`, generated runtime artifacts, test files).
2. Checks Node (20+ minimum; use 24 for CI parity) and Python (3.13) and uses `uv` as the canonical backend toolchain.
3. Runs **frontend** checks: install, `tsc`, lint, Next build, audit-budget gate, curated test suite.
4. Runs **backend** checks: shared parity verification, install, Ruff, mypy, Bandit, curated test suite.
5. Runs **integration**: route/runtime contract verification.

To include advisory checks locally:

```bash
./bin/hushh ci --include-advisory
```

This advisory lane now includes the Codex operating-system audit:

```bash
./bin/hushh codex audit
```

To verify the live GitHub branch gate matches the documented minimum contract:

```bash
./scripts/ci/verify-main-branch-protection.sh
```

Fix failures in the selected local checks before pushing. Successful hosted
validation of the exact SHA remains required before deployment.

Secret-scan note:

- local and remote CI now both scan the relevant commit range by default
- use `GITLEAKS_LOG_OPTS=--all` only when you intentionally want a full-history audit

---

## Quick Reference: Commands That Must Succeed

| Area | Commands (from repo root) |
|------|----------------------------|
| Frontend | `cd hushh-webapp && npm ci && npm run typecheck && npm run lint -- --max-warnings=0 && npm run build && npm run test:ci` |
| Backend | `cd consent-protocol && uv sync --frozen --group dev && bash scripts/sync_runtime_requirements.sh --check && uv run ruff check . && uv run mypy --config-file pyproject.toml --ignore-missing-imports && uv run bandit -r hushh_mcp/ api/ -c pyproject.toml -ll && bash scripts/run-test-ci.sh` |
| Integration | `bash scripts/ci/docs-parity-check.sh` |
| Pre-PR mirror | `./bin/hushh codex pre-pr` |
| All | `./bin/hushh ci` |

---

## Strict Launch Gate (Release Cut)

One support/account-mail launch check (owner: `kushal@hushh.ai`): verify the
Workspace domain-wide delegation grant for the configured service-account client
ID includes `https://www.googleapis.com/auth/gmail.send`, then send synthetic
`[TEST]` welcome, passkey-add/remove, passphrase-change, and each support type
to the test inbox. Confirm a real Help & Feedback submission reaches
`one@hushh.ai`, its internal BCC reaches the support lead, and no report body
appears in application logs. Confirm one controlled UAT vault change produces
one notice without changing the vault outcome if mail fails. The public privacy
policy must explain support-message handling, the internal copy, and retention;
the in-app account-deletion control must be exercised. Check the managed backend
5xx and account-mail alert policies are enabled, target the verified
`kushal@hushh.ai` notification channel, and deliver a test incident. Missing
grant, policy wording, or alert delivery blocks public launch; source config
alone is not proof.

The first-welcome Firebase claim suppresses ordinary repeated sign-ins, but it
is not a distributed exactly-once mail ledger: simultaneous first-sign-in
requests or a failed claim update can duplicate an accepted welcome. Verify
the expected first-login traffic pattern or add durable idempotency before
claiming a strict at-most-once guarantee.

During launch, the owner records a short daily readout from the existing Cloud
Monitoring dashboard: backend 5xx/latency, support accepted versus failed or
uncertain, security-mail failure events, and open support issues. Follow the
existing production deploy traffic-rollback procedure for a bad application
revision; do not roll back a completed vault transition because email failed,
and do not blindly resend an uncertain Gmail submission.

Before creating a release tag/public rollout, run strict gate commands from repo root:

```bash
bash scripts/ci/docs-parity-check.sh
cd hushh-webapp && npm run typecheck
./bin/hushh native ios --mode uat
./bin/hushh native android --mode uat
cd hushh-webapp && npm run verify:cache
cd hushh-webapp && npm run verify:docs
python scripts/ops/verify-env-secrets-parity.py --project hushh-pda --region us-central1 --backend-service consent-protocol --frontend-service hushh-webapp
bash scripts/verify-pre-launch.sh
```

Blocking rule:
- Launch gate is strict-blocking. Any failing check or non-clean git tree is a release blocker.

## Production Deploy DB Governance Gates

The production deploy workflow (`.github/workflows/deploy-production.yml`) enforces additional DB governance before backend deploy:

1. Cloud SQL backup posture gate:
- validates Cloud SQL automated backups + PITR via `scripts/ops/cloudsql_backup_freshness_check.py`
- requires latest successful backup age within configured threshold (`BACKUP_MAX_AGE_HOURS`, default `30`)
- optional on-demand Cloud SQL backup via workflow input `run_predeploy_backup_job=true`

2. Migration governance + drift gate:
- checks migration filename monotonicity (`consent-protocol/db/migrations`)
- checks the production-pinned schema contract (`consent-protocol/db/contracts/prod_core_schema.json`)
- allows the repo to be ahead of production while production stays pinned to its approved migration floor
- checks live DB schema contract in read-only mode

3. Manifest artifact:
- emits a production migration release manifest with Cloud SQL backup evidence (backup id, completion timestamp)

UAT deploys use a separate latest-integrated contract:

- `consent-protocol/db/contracts/uat_integrated_schema.json`

The daily scheduled workflow `.github/workflows/prod-cloudsql-backup-posture.yml` runs the same backup posture policy and uploads a report artifact.

## Deploy Image Pipeline

Every deploy lane (`deploy-dev.yml`, `deploy-uat.yml`, `deploy-production.yml`)
builds each image once, pins it to an immutable `sha256` digest, and deploys that
digest. Nothing downstream re-resolves a mutable tag.

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

The deploy, analytics smoke, promotion and rollback order is unchanged. Expected
saving: 3.5-4.5 minutes per backend + frontend release. `frontend_image_wait` in
the release status artifact records how long the lane still blocked on the web
build; near zero means it was fully hidden. Frontend-only and backend-only scopes
build only their own image. A deployment SHA older than this split has no
build-only config and keeps the combined serial build-and-deploy. The dev
auto-deploy Cloud Build trigger also keeps the combined path, which remains the
default of `frontend.cloudbuild.yaml`.

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

- [Getting Started](../../guides/getting-started.md) -- Setup and local CI instructions.
- [API Contracts](../architecture/api-contracts.md) -- API contract verification.
- [Architecture](../architecture/architecture.md) -- Tri-Flow and service-layer rules.
- [Streaming Contract](../streaming/streaming-contract.md) -- Canonical SSE contract.

---

## Upstream CI (consent-protocol standalone)

The optional consent-protocol mirror has its own full CI pipeline at [hushh-labs/consent-protocol](https://github.com/hushh-labs/consent-protocol/actions). It runs on all branches plus merge queue and includes: secret scan, lint, typecheck, test, security scan, Docker build verification, and a final status gate.

The monorepo is authoritative. Its protocol and release gates determine merge
and deploy readiness. Mirror publication and mirror CI are optional maintainer
operations and must not delay a monorepo release or UAT deploy.

## The collection gate

`consent-protocol/scripts/run-test-ci.sh` runs `pytest --collect-only -q tests/` over the whole
tree before it runs the curated manifest. The manifest is an allowlist, so a
test file that is not listed is simply never executed, and a file that cannot
be IMPORTED is worse than that: pytest reports `no tests ran` for it, which in
CI is indistinguishable from a file that passed.

Measured 2026-09-11. `consent-protocol/tests/test_consent_lifecycle_chat.py`
imported a symbol deleted two days earlier. All 438 of its lines collected zero
tests and reported nothing, and a behavioural change to the proposal path drifted
away from an assertion in the same file with nothing going red.

It also distorts any whole-suite measurement taken against a branch that has
the broken file. A collection error aborts the entire run, so `pytest -q tests/`
returns a single error and executes nothing, and the run reads as one failure
rather than as no coverage at all. Compare failure counts only after confirming
the suite actually ran.

The gate is deliberately separate from the manifest: the manifest answers "which
suites gate a merge", and the gate answers "can every test file still be loaded".

### Browser setup mirror — 2026-10-08

PR run `37836804949` restored cached browsers, but the hosted Ubuntu mirror
downloaded 116 MB of system dependencies in 23 minutes 9 seconds. The 30-minute
job deadline interrupted the browser pack. The browser job removes only the
runner's `azure.archive.ubuntu.com` mirror preference and retains its existing
official archive/security entries and signed package checks. Chromium, WebKit,
matched packs, workers and timeout remain unchanged. A faster install is a
hosted measurement to verify, not a guaranteed mirror characteristic.

UAT uses the same mirror preference removal and prepares locked npm dependencies,
Chromium and its system libraries once for the union of frontend analytics and
selected protected browser checks. Setup retries at most twice within eight
minutes and remains blocking. Its Chromium cache has a separate key from CI's
Chromium/WebKit cache; restored binaries still pass the normal installer.
Both backend provider probes run independently after image and IAM verification.
The required provider aggregate waits for both results and the deployed candidate
before selection; dev and production retain their predeployment Vertex gate.

## Combined UI Contracts gate

Every PR runs one mandatory **UI Contracts** job before expensive lanes. It installs only the locked TypeScript parser, shares source reads, rejects Back/Search coverage and freshness drift, and verifies Surface Map, Gateway, Siri and Route Orchestration mirrors. It runs mutation regressions that prove either owner failure rejects the combined check. Target validation execution is 5–10 seconds; dependency downloads, checkout, runner startup and queue time are separate. The command prints its actual elapsed time. Preflight and CI Status require success; frontend changes also require Web Core and the full Vitest suite, which retain behavior coverage.

Run `cd hushh-webapp && npm run ui:doctor` before edits. Follow the [contributor scaffold](../architecture/ui-contract-contributor-guide.md), review authored Back cases and Search actions, then run `npm run build:ui-contracts` and `npm run verify:ui-contracts`. The pre-push wrapper runs the same read-only fast check. It never repairs or stamps source. The previous individual package commands remain available for diagnosis.
