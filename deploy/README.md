# Hussh Deployment Package

This directory contains Cloud Build definitions and environment-provisioning
helpers used by the governed GitHub deployment workflows. It is not a manual
Cloud Run deployment runbook.

## Release authority

Use the canonical
[Admin merge and release SOP](../.agents/skills/repo-operations/references/admin-release-sop.md)
for merge queue, explicit Admin PR landing, exact-SHA UAT/production dispatch,
monitoring, evidence, rollback, and branch restoration.

Runtime traffic authority belongs to these workflows:

1. [Deploy to Dev](../.github/workflows/deploy-dev.yml)
2. [Deploy to UAT](../.github/workflows/deploy-uat.yml)
3. [Deploy UAT One Chat Backend Only](../.github/workflows/deploy-uat-one-chat.yml)
4. [Deploy to Production](../.github/workflows/deploy-production.yml)

Humans dispatch governed workflows. Do not deploy images, mutate Cloud Run
traffic, or repair CORS/runtime variables with direct `gcloud builds submit`,
`gcloud run deploy`, `gcloud run services update`, or `update-traffic` commands.
The workflow identity, provenance labels, bounded verification, and rollback
receipts are part of the release contract.

## Normal UAT dispatch

After the exact landed `main` SHA passes `Main Post-Merge Smoke Gate`, dispatch
UAT with automatic scope resolution:

```bash
gh workflow run deploy-uat.yml --ref main -f scope=auto -f sha=<landed-main-sha>
```

`scope=auto` compares the target SHA with each service's currently deployed SHA.
This includes every accumulated frontend/backend change when UAT lags more than
one merge. Force `frontend`, `backend`, or `all` only after proving the complete
target-to-deployed-service delta and recording why automatic resolution is not
appropriate.

With a blank `sha`, UAT selects the newest main commit with its own successful
post-merge gate. If main already matches the newest UAT deployment and its
latest status is successful, the workflow finishes successfully with a `NO_OP`
summary only after matching the existing `deployed/uat-latest` exact-SHA receipt
to that same successful `deploy-uat.yml` run. Rollback and rehearsal environment
records, mismatched targets, and missing receipt proof cannot authorize a no-op.
Selection runs before entering the UAT environment, so this no-op
creates no deployment record, builds, traffic changes, or release tag updates.
Unknown deployment state and unavailable or failed gates still block selection.
An explicit SHA continues through the existing exact-SHA deployment validator.

For the One chat external Vertex cutover, including its pre-vault intro head,
the reviewed deploy-uat-one-chat.yml workflow updates the existing consent-protocol service
without touching the frontend, Drive worker, schedulers, secrets, or database.
Dispatch it with an exact green main SHA after the Main Post-Merge Smoke Gate
succeeds. It rejects accumulated backend image and release-input changes outside
its cutover allowlist. Four Location files already on main are admitted only at
their reviewed Git blob IDs; a later edit to those files blocks this lane. It
creates a zero-traffic backend candidate, and uses a temporary Cloud Run Job
under the UAT runtime identity to require a synthetic Gemini response from the
external project. The Job must be deleted before traffic promotion. The workflow
then promotes only the backend revision, verifies full traffic, and removes the
candidate's direct tag URL. On failure it removes that tag, attempts to restore
the prior backend traffic, and publishes the result as a release artifact. This
partial deployment does not advance the full UAT release tag; normal UAT
selection ignores its environment record when resolving the full-release
baseline. The synthetic model check is a deployment gate, not an authenticated
end-to-end chat acceptance test.

Production is a separate explicit authority transition. UAT success does not
authorize it, and UAT credentials or runtime identities must never be reused in
production.

### Email OTP in UAT

`EMAIL_AUTH_ENABLED_UAT=true` enables the independent email sign-in rollout.
It defaults off. The runtime configuration compiler owns its four nonsecret
settings; encryption and verification keys never enter runtime configuration JSON.
Provision three distinct base64-encoded 32-byte secrets in `hushh-pda-uat`:
`EMAIL_AUTH_VERIFIER_KEY`, `EMAIL_AUTH_PAYLOAD_KEY`, and `EMAIL_AUTH_LOOKUP_KEY`.
Keep these stable across redeploys, especially the lookup key used for persistent
mailbox budgets and bindings. UAT backend deployment binds the existing `MAIL_API_KEY`
secret as `EMAIL_AUTH_MAIL_API_KEY`.

Before building enabled candidates, the UAT workflow validates key readiness and
the packaged risk manifest, proves that the existing mail API accepts the One
consumer with a deliberately invalid request that cannot send mail, and refreshes
delegated `gmail.send` authority for `one@hushh.ai` using the candidate's credential
source. A generic non-One key or a sender refresh failure blocks rollout.

After migration and schema verification, the workflow activates the same reviewed
policy through `scripts/email_auth_policy.py` using its already-attested UAT
connection. The activation receipt retains the actor, release SHA and risk version.
The backend candidate must expose enabled email capabilities before promotion.
Manifest activation does not renew evidence expiry; refresh the reviewed snapshot
before its recorded deadline. No company administrator setup or WorkOS is involved.

Traffic rollback preserves the database policy and keys. The process enable flag
does not disable other running revisions: drain or disable every enabled issuer
and delivery worker before applying migration359's destructive rollback or
scrubbing challenges. Do not rotate keys or delete policy records as a traffic
rollback shortcut.

## Hosted revision maintenance

UAT and production deployments complete after release verification, artifact publication, quick
zero-traffic tag retirement, and the final health assertion. Old revision deletion runs in **Capacity Maintenance**,
hourly and independently of deployment events. Maintenance
uses the matching environment without creating a deployment record. Its failure does
not change the release result.

The authority job verifies the source repository, workflow, governed actor and
release artifact before cloud authentication. Deployment observations never authorize deletion.
The helper independently selects a
completed, healthy source and verifies live provenance. The narrow passkey-association
failure case may use its proven serving backend and the immediately preceding
healthy UAT release's frontend after verifying both against live revision
provenance. A UAT run that passed every release gate and failed solely while
retiring old tags may use its healthy artifact after job and live revision
provenance checks. Other failed deployments and no-op runs grant no cleanup authority.
Maintenance runs hourly or by explicit governed manual request; no deployment
event starts it. GitHub delivered only 3-6 of the 24 daily runs of its former
minute-17 cron on 2026-10-12..14, so **Capacity Maintenance Clock** is now its only
schedule: each clock run checks both environments without cloud credentials, sends
one repository dispatch only when maintenance is due, scoped to the due environments
(`capacity-maintenance-tick`, `-tick-uat` or `-tick-production`), and re-arms itself
after a 60-minute wait in the `capacity-maintenance-clock` environment (a wait timer,
so no runner is held). A tick has exactly the scheduled pass's authority within its
scope. Quiet hours add no maintenance run, and a scoped pass's title lets the other
environment's checkpoint guard skip it without reading its jobs. Scheduled requests and
ticks coalesce without cancelling active work, and manual requests keep independent
identities. Cancelling the clock's waiting run stops it until its next delivered
cron. Each mutation pass verifies
its source against live traffic, removes unused tags, and saves drain evidence in
`uat-retention-state` or `production-retention-state`. A later hourly pass deletes
only eligible revisions after the maximum request timeout plus 60 seconds. A backend
with 3,600-second requests therefore keeps its approximately 61-minute drain without
occupying a sleeping runner. Settled and unchanged future deadlines skip cloud setup,
including a second due check under the environment lock.

Cleanup execution is bounded to 300 seconds, with teardown/checkpoint time reserved.
Partial progress remains due; uncertain provider outcomes keep sanitized intent in the
same receipt and block conflicting deployments until observation establishes completion.
If the intended revision still exists after an uncertain delete, do not retry blindly:
operator reconciliation is required. Traffic, service incarnation, expanded candidates
or protected-set changes invalidate the clock; expired evidence cannot authorize deletion.
Current, latest, predeploy rollback and actual last-known-good revisions stay protected.

Only a short maintenance pass shares its environment's rollout/rollback lock; all
participants queue without replacing pending deployments. Backend and paired-release admission checks conservatively count every retained UAT database revision while cleanup is deferred, so overlapping drains cannot silently exceed the database budget. A frontend-only release is classified as zero incremental SQL demand only when the live web runtime and new candidate have no declared database bindings; this is checked under the deploy lock and again before candidate smoke and traffic promotion. Unverifiable web configuration blocks the release. This is a reviewed application contract: runtime configuration checks cannot prove arbitrary image code will never access a database. The frontend identity should ultimately have access only to its own named secrets.

Both UAT deploy workflows poll capacity for at most five minutes, including
query and final-verification time, before taking
the `deploy-uat` mutation lock. A backend request (including One chat and `auto`)
waits in the backend request group; an explicit `scope=frontend` request uses a
separate group and can proceed while backend revisions drain. GitHub's
`queue: max` holds at most 100 pending runs per group; a further run is canceled.
For backend admission, an exact job inventory drift with extra unprofiled jobs and no missing profiled jobs is retried within the five-minute check. Exhaustion returns `DEFERRED_CAPACITY`
with the original SHA/scope for a governed operator retry; it does not dispatch
an automatic release or produce a healthy release receipt. The check never admits while that drift
persists and reports the extra names if it times out. Missing profiled jobs,
authentication and query errors, and malformed reports fail immediately. Once
admitted, the deployment rechecks the exact SHA,
actor, scope, and connection budget under the mutation lock before any writes.

The UAT deploy request promptly wakes a verified Capacity Maintenance first pass;
later short scheduled passes can free old revisions after drainage. If no eligible source
is found, a governed operator should verify the live healthy release run and dispatch `capacity-maintenance.yml`
for `environment=uat`, that `healthy_release_run_id`, and `apply=true`. The
maintenance workflow verifies the source and live traffic before deletion. If
there is no eligible source or capacity remains blocked after the bounded wait,
escalate for capacity review; do not bypass the admission gate.

Production's source-only selection skips cloud authentication after a settled
pass, or while every retained drain deadline is still in the future. A completion
receipt binds the environment, project, healthy release and latest completed
deployment observation. Missing or expired receipts and newer deployments cause
a fresh pass; a failed deployment is an inspection signal, never cleanup
authority. Production alone permits a terminal run whose only failed step is
post-release tag retirement: all required release steps and the canonical healthy
artifact must pass before cloud authentication. Before cleanup, serving revisions
must additionally prove that artifact's SHA, source run, immutable image and
readiness. Failed maintenance artifacts still cannot restore drain authority.
This reuses the existing workflow and timer, with no new cron runs.

The default capacity phase reserves the next deployment's candidate revisions.
UAT resolves deployment scope before admission: a frontend-only release reserves
no new database service revisions, while a backend release reserves both the
backend and Drive worker candidates. All retained database revisions and jobs
remain counted in either case.
The exceptional One chat backend-only lane reserves only its backend candidate.
Post-release reporting uses `--phase post-release`, which counts current retained
revisions, jobs and the administrative reserve without adding another hypothetical
deployment. Actual over-budget capacity remains blocking in both phases.
Manual Cloud Run changes outside governed releases require an explicit maintenance
dispatch; the settled-receipt optimization does not claim to detect those changes.

## What lives here

| Path | Purpose |
| --- | --- |
| `backend.cloudbuild.yaml` | Backend image build and Cloud Run candidate deployment used by governed workflows |
| `backend-image.cloudbuild.yaml` | Build-only backend image; lanes pin its digest before the migration fence |
| `frontend.cloudbuild.yaml` | Frontend Cloud Run candidate deployment (deploys a pinned digest with `_SKIP_IMAGE_BUILD=true`; builds and deploys by tag otherwise) used by governed workflows |
| `frontend-image.cloudbuild.yaml` | Build-only frontend image; lanes start it in parallel with the backend image build and pin its digest |
| `iam/` | Environment-specific workload-identity and IAM provisioning helpers |
| `marketplace/` | Marketplace job/scheduler provisioning helpers |
| `observability/` | Observability infrastructure provisioning helpers |
| `app_store_deployment.md` | Native App Store deployment reference |

Cloud Build files are implementation inputs. Their presence does not authorize
direct human builds or traffic changes.

## Environment and secret contracts

Canonical owners:

1. [Environment and secrets](../docs/reference/operations/env-and-secrets.md)
2. [Environment key matrix](../docs/reference/operations/env-secrets-key-matrix.md)
3. [Branch governance](../docs/reference/operations/branch-governance.md)
4. [CI configuration](../docs/reference/operations/ci.md)
5. [Migration governance](../docs/reference/operations/migration-governance.md)

Hosted Gemini uses environment-specific Cloud Run identity through Vertex ADC.
Do not mount a Gemini API key or `GOOGLE_APPLICATION_CREDENTIALS` into the
runtime. Database releases use the governed `DB_*` and Cloud SQL contracts; do
not restore a parallel `DATABASE_URL` deployment path.

GitHub deployment environments expose only the environment-specific WIF
provider and deploy service account. Production WIF setup is owned by
`deploy/iam/setup_production_github_wif.sh`; never provision a parallel provider
or restore a JSON service-account key.

## Verification model

Every hosted deployment must prove:

1. governed actor and environment;
2. exact deployable SHA and required upstream gate;
3. requested and resolved scope plus skipped lanes;
4. migration/schema result when applicable;
5. ready revision, image, provenance labels, timeout, and traffic;
6. runtime/semantic checks selected by the workflow;
7. bounded rollback result when an authority failure requires it;
8. terminal workflow status and uploaded release evidence.

The UAT expensive-lane selector is
`scripts/ci/resolve-uat-verification-plan.py`. It alone decides when PKM upgrade
rehearsal or reviewer BYOK proof is required. Paid candidate evaluation and
Gemini/Vertex generation probes require UAT's explicit
`run_live_model_checks=true` dispatch input; changed paths and unknown comparison
bases never opt in. Backend Cloud Build generation probes also default off for
production/direct builds (`_VERIFY_MANAGED_VERTEX_RUNTIME=false`). An omitted
model check is recorded as skipped, not passed. When explicitly selected, the
structure-agent evaluator is warning-only and does not authorize rollback by
itself; preservation, provenance, schema, runtime and semantic authority remain
blocking. Product journeys may still exercise their own model/readiness calls.

Each selected managed Vertex probe requires a usable provider response. A
transport timeout or retryable provider status permits one recovery attempt
against the same model, project and identity, paced by the existing 30-second
start interval. Permission, schema and billing failures are not retried.
All targets run before optional recovery. A 330-second sequence budget includes
the command rehearsal and leaves startup/receipt headroom inside the unchanged
420-second job limit. A recovery that cannot fit is recorded as not dispatched,
retaining the original failure. Attempt verdicts and durations remain in the
redacted diagnostic receipt; exhaustion still fails readiness. Per-call deadlines
and the release admission rules are unchanged.

## Read-only operator diagnostics

Read-only inspection is allowed when it does not mutate runtime state. Prefer
workflow artifacts, then use repository helpers such as:

```bash
python3 .agents/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py \
  --project hushh-pda-uat \
  --service hushh-webapp \
  --service consent-protocol \
  --format text
```

Discover service project/region tuples before describing them. Keep tokens,
credentials, secret values, vault material, and decrypted information out of
logs and artifacts.

## Infrastructure changes

One-time IAM, API enablement, backup posture, scheduler, observability, or secret
changes are infrastructure administration—not application deployment. Route
them through `repo-operations`, verify the target project and actor first, and
use the owning idempotent helper where one exists. Never turn an infrastructure
repair command into an alternative release path.

## Troubleshooting

1. Classify CI, deploy, runtime, schema, provenance, or semantic failure before
   editing.
2. Start with `./bin/hushh codex rca --surface uat --text` for UAT failures.
3. Inspect the exact failing GitHub job/step and its artifacts.
4. Apply the smallest owner-routed correction, rerun local parity, and dispatch
   a new governed workflow from an eligible SHA.
5. Do not mask a failed workflow with a manual Cloud Run mutation.

## Location command runtime deployment

Talk to One now uses bounded recording, ordinary Gemini transcription and
semantic Location planning. Deploy the matching generated contracts and the
complete ordered release migration manifest with the backend. The Location
repair requires migrations 213–219 in addition to the existing command schema;
rebuild and sync native web assets before
packaging the apps. The existing fleet model configuration supplies command
reasoning. No Live API key, ASR pack, intent-ranker pack, or model-pack registry is
required by the command path. One Live Voice (Gemini Live on Vertex ADC) is a separate,
flag-gated adapter: `_ONE_VOICE_LIVE_ENABLED`, `_VERTEX_LIVE_MODEL_ID` and
`_VERTEX_LIVE_LOCATION` pin the model and region, and there is still no API key.
Voice sessions, their child model calls, and the pre-traffic Live probe use the
environment's project in `consent-protocol/config/managed-ai-runtime.json`
(UAT: `hushh-vertex-personal54` since 2026-10-15). The per-surface
`_HUSHH_ONE_VOICE_VERTEX_PROJECT` override is retired.

The model-pack publication workflow is retired. Preserve historical release
records without treating them as current prerequisites. Follow the
[command runtime contract](../docs/reference/one/one-voice-runtime-architecture.md)
for checkpoint, receipt and rollback requirements. Provider access and physical
device acceptance remain release evidence, not conclusions from a static build.

### Capacity scaling acceptance

Configured connection exposure is not the number of active database sessions.
The admission report accounts for actual worker overrides, both pools, retained
revisions, scoped candidates, jobs and administrative reserve. Cleanup success and
capacity admission are reported separately. Unprofiled database jobs remain a
blocking inventory gap until their owner registers or reconciles them.

Scaling changes require measured traffic/latency/session/pool/CPU/memory evidence,
a matching live/profile connection budget and a priced cost projection. The approved
2026-10-13 activity has a US$2,000 incremental monthly ceiling including verification,
UAT stays zonal, and production regional HA is scheduled for 2026-10-14 22:00–23:00
America/Los_Angeles after backup, recovery and verification prerequisites pass.
This is an execution window, not evidence that HA has been enabled.

Use the existing read-only UAT load probe at 5, 10 and 20 requests/s, then 40
requests/s for five minutes, with at most 40 workers and no live model calls.
Require no server errors/pool acquire timeouts, p95 <=2s, p99 <=5s, sufficient
generator throughput, sustained CPU <70% and memory <80%. Stop at the first
failing stage. UAT evidence does not establish production's maximum throughput.

The 2026-10-13 UAT baseline on `consent-protocol-02115-faq` completed 3,000
read-only requests at 5 requests/s with no server errors, but its steady memory
utilization remained 86.9–87.85% of 4 GiB. UAT therefore selects 6 GiB at unchanged
2 CPU, five maximum instances and existing connection pools. This is a candidate
working-set adjustment, not passing burst evidence. Repeat the same 5 requests/s
stage before increasing load. Maximum incremental RAM allocation at all five
instances for 730 hours is US$52.56/month at current Tier 1 instance-based list
pricing; actual allocation and the remaining verification resources must be
reconciled against the approved ceiling. Production memory remains unchanged.
