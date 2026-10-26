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

UAT defaults `backend_image_source=auto`. When the exact accepted Dev backend
attempt records a verified executable image, UAT revalidates that same
run/attempt/artifact pin and copies its immutable digest into UAT's registry.
The canonical image resolver checks the copied manifest and requires its
executable digest to equal Dev's accepted digest. Frontend images continue to
build with UAT configuration.

Historical Dev receipts without image metadata use the existing source build.
Present but invalid image metadata, missing source images, copy permission
failures and digest mismatches stop the run; they cannot silently trigger a
source build. An operator may explicitly select `build-from-source`, or require
proof with `promote-from-dev`. All UAT migration, provider, candidate, semantic,
worker, traffic, provenance and rollback gates still run. Image reuse removes a
duplicate build; actual deployment duration still requires hosted measurement.
See [the repository-scoped IAM plan](iam/README.md#uat-image-promotion) before
enabling cross-project image reads. IAM grants require separate authorization.

After migrations and preservation checks, a frontend image can roll out at zero
traffic in the same Cloud Build as the backend candidate and provider probes.
A still-building image waits in an independent branch after backend image and
runtime-IAM verification. Its exact run/attempt image build must succeed before
the existing manifest resolver verifies raw bytes and pins the executable digest.
The canonical frontend steps consume only that pin; GitHub collects its original
native [build-step output](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds#Results)
instead of resolving the tag again. The raw manifest artifact is fetched by that
immutable index and independently revalidated. Exact build-step wait timing is
reported separately from pin collection; wait can overlap provider probes and
does not by itself measure critical-path cost. A failed image build,
digest mismatch or missing/misbound receipt fails the required build or release.
The UAT scheduling adapter derives every frontend check,
secret binding and deploy step from the shared frontend template, with separate
substitutions for its runtime identity, image and capacity. The whole build must
succeed before candidate verification, paired analytics smoke or exact-revision
traffic promotion. Frontend-only scopes and historical targets without the
prebuilt-image contract retain the existing serial frontend deploy. Release
receipts and summaries identify the shared build so
overlapped rollout time is not reported as a zero-second deployment.

Worker rollback captures and scheduler verification use one response per
observation. A paused scheduler is resumed and read again before its state,
target, OIDC identity, audience and stage body are verified. These reads retain
the existing worker startup, trigger-completion and rollback gates.

UAT keeps the backend's maximum concurrency at 20 and sets
`_CLOUD_RUN_SCALING_CONCURRENCY_TARGET=0.20`. The default 60% target seeks about
12 concurrent requests per instance, while one Feed worker admits only six
streams. A 20% target requests earlier scaling at about four average concurrent
requests, preserving shared ingress headroom for Profile, auth and Voice.
The six-stream worker cap, three-stream owner cap, five-instance limit and DB
pool budgets remain enforced. This utilization target cannot eliminate burst
or maximum-capacity refusals; genuine saturation still returns 503 with its
retry delay. The optional Cloud Build substitution defaults empty for other
lanes, preserving their existing scaling target. See the
[Cloud Run scaling controls contract](https://docs.cloud.google.com/run/docs/configuring/scaling-controls).

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
Retried UAT releases can retain duplicate artifact names. Cleanup resolves these
only through the current run attempt and its unique successful upload step, then
verifies the immutable artifact ID and archive digest. Unproven or ambiguous
attempts remain blocked; existing release health and live provenance checks still apply.

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

UAT inventory reads use at most three concurrent service collections, followed
by at most three job describes. Each service still reads its revision inventory
after its description and verifies every reachable non-database revision. Every
read must complete successfully before budget evaluation. The two fresh admission
snapshots and the independent under-lock check remain sequential; no inventory is
cached between them. Production retains serial collection. Query subprocesses
inherit the existing admission process group and five-minute deadline.

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

### Fixed production capacity bridge

When the serving, latest-created and rollback-protected backend revisions consume
the next release's admission budget, a governed operator may dispatch the existing
maintenance workflow with `environment=production`, the verified healthy serving
`healthy_release_run_id`, `apply=true` and `production_capacity_bridge=true`.
Scheduled passes and UAT cannot create this bridge. Both source checks force a
fresh inspection, and mutation still holds the production deployment lock.

The fixed `serving_backend_clone_v2` profile creates one zero-traffic revision
from the reviewed healthy image digest, preserving its runtime identity, bindings
and service controls. It uses one instance, one explicit Gunicorn worker,
asyncpg maximum four and SQLAlchemy pool two without overflow: six connections.
The frozen image hardcodes two workers in its shell CMD, so `WEB_CONCURRENCY=1`
alone is insufficient. The explicit direct launcher preserves `server:app`,
Gunicorn configuration, Uvicorn worker class, 120-second timeout, eight-second
graceful timeout and port 8080. An unreviewed image or source launcher is rejected.

V1's two-slot async pool could not boot this frozen application: consent and
referral listeners each retain one slot, leaving none for mandatory market-cache
startup. V2 preserves the known healthy async ceiling and leaves two slots beyond
those listeners. The failed v1 remains counted at eight; it is not called healthy.
For three retained 80-connection backends, creation admission is
`240 + failed-v1 8 + v2 6 + readiness 16 + reserve 30 = 300`.
Only this fixed maintenance operation omits a hypothetical worker candidate,
because it creates no worker revision. Every existing worker, revision and job
still counts. Ordinary application release admission remains unchanged.

The operation supports the verified source's `latest` secret selectors only.
It pins enabled numeric versions after verifying that every version since source
creation has the same value. Changed, disabled, missing or ambiguous history
blocks creation. Payload comparisons happen only in memory; receipts contain
numeric resource names and evidence flags, never payloads or payload digests.
Source/service drift before mutation or configuration drift afterwards also blocks
completion. The clone may execute the existing runtime's background work; zero
traffic is not a promise of zero database writes.

Before the provider request, `completed.json.capacity_bridge` records durable
intent. A timeout never authorizes another create: a later pass observes only
that exact deterministic revision. Explicit manual v2 recovery may supersede
the unresolved v1 only after observing its exact deterministic revision and
verifying its frozen image, pins, configuration, eight-connection bound, unchanged
service controls and zero positive traffic. Enabled numeric pins are rechecked.
The predecessor must remain latest-created, but may be unready while Cloud Run
keeps the serving revision latest-ready. This observation does not establish
health; the successor still requires provider readiness and HTTP verification.
The complete original intent is retained as predecessor evidence, explicitly
observed unhealthy. Durable successor intent records both identities before
provider submission; an absent or mismatched predecessor cannot authorize creation.
Until successor readiness, frozen configuration,
unchanged positive traffic, HTTP health and connection admission are proven,
the receipt blocks conflicting deployment. The temporary health tag is removed
by ordinary retention. A verified rerun accepts its removal without recreating
the revision. The former latest revision and failed v1 are deleted only through
the existing 3,660-second drain and ordinary protection checks. Serving `00268`
and recovery `00265` remain protected. After those deletions,
`160 + v2 6 + backend candidate 80 + worker candidate 6 + readiness 16 + reserve 30 = 298`
admits the ordinary backend release. A verified successor resolves creation
uncertainty through the explicit link; it never relabels v1 healthy.

If creation fails or its provider outcome is uncertain, preserve the checkpoint
and all protected revisions. Reconcile via maintenance before another deployment;
do not delete the bridge or a recovery anchor, shorten drainage, rewrite serving
traffic, increase the connection limit, or retry creation blindly. A failed latest
revision can require operator investigation before live readiness is provable.
A failed v2 has no room for another automatic recovery candidate. Preserve its
intent and stop creation attempts rather than broadening the profile or budget.
This is maintenance evidence, not a healthy application release or permission
to promote the clone. An ordinary release and its existing rollback contract
remain responsible for application rollout.

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

Dev temporarily pins the supported `gemini-3.7-flash` text model. During the
2026-10-22 release recovery, the same candidate image, runtime identity and ADK
factory answered on 3.7 while 3.8 timed out. Restore Dev's 3.8 pin only after its
configured runtime probe passes. This Dev recovery preserves UAT's Azure
selection, production's model profile, and the regional Live Voice model.

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

Backend traffic rollback uses `activate_release.py --qualify-rollback-source`:
the exact source must declare account policy v1 and migrations 423 and 425.
Migration 425 is the conservative source floor for retired-phone admission.
Pre-phone backend rollback is refused even when phone state appears empty;
the existing release lifecycle does not prove phone-transfer quiescence.
Initial producer admission still uses `--qualify-source` and migration 423, so
upgrading a pre-phone producer remains possible. Source qualification does not
replace schema, runtime health, provider-settlement or device acceptance proof.

The UAT expensive-lane selector is
`scripts/ci/resolve-uat-verification-plan.py`. It alone decides when PKM upgrade
rehearsal or reviewer BYOK proof is required. Paid candidate PKM evaluation and RIA live-model checks retain the explicit
`run_live_model_checks=true` dispatch input. UAT backend releases always run
synthetic Azure and Vertex provider checks from the exact candidate image and
runtime identity, in parallel. A provider passes only when its full application
capability bundle passes: structured and streamed text, image and PDF inputs,
public search citations, exact public source retrieval, Location transcription
and semantics, isolated narration, Live audio with function results and input
transcription, and compatible embeddings. The required aggregate accepts either
complete provider (or both), preferring Azure; neither passing blocks promotion.
The API and both Drive workers must bind the same selected provider. UAT remains
held until Azure has a verified replacement for every declared capability.

Azure's canonical PWM schema and six-case attribution evaluation remain
independent safety checks. An explicit identity, attribution or schema violation
blocks release even when the alternate provider succeeds. The terminal receipt
carries a closed trust-failure flag so log-ingestion order cannot erase a failure.
The execution-bound aggregate is uploaded as `uat-managed-provider-readiness.json`.
After the migration gate passes, UAT derives its Cloud Build scheduling from the
shared backend template with `scripts/ci/uat_backend_build_config.py`. Only the
pinned, zero-traffic UAT candidate may warm alongside the provider jobs. The
unchanged required aggregate joins that candidate and both provider results
before selection or promotion. The generated config refuses an unexpected DAG;
Dev and production retain the shared template's predeployment Vertex gate.

Backend images compile dependency bytecode while installing the locked graph,
so cold instances and probe jobs can read it with runtime bytecode writes disabled.
The schema guard batches relation, visible-column and public-function catalog
reads into three queries while retaining every contract check and ordered report.
Migration bodies still replay under their existing lock and transaction policy.
The Drive worker overlaps isolated E5 admission with scanner freshness/EICAR
attestation, joins both before readiness, and settles cancelled tasks before exit.
Its fixed `drive_worker_startup` timing fields identify each stage without logging
document content. The shared 180-second startup budget and all isolation limits
remain authoritative. The same public synthetic E5 admission emits fixed
`drive_worker_embedding_admission` phases for Torch setup, SentenceTransformers
import, model construction and encoding, with wall and child-process CPU
milliseconds. The enclosing startup `embedding` wall time also includes semaphore,
child startup, IPC, validation and any eligible retry. Private queries never emit these
metrics; missing or malformed metrics do not change readiness. No extra model
call is made. An eligible cold-start retry emits a fixed processing-timeout event.
Compare completed full-release timings before claiming a
deployment-duration improvement; cache seeding and infrastructure waits can vary.

Worker scheduler capture validates the complete fixed-job records from one
unlimited JSON inventory. After worker promotion, setup verifies the actual worker
origin, scheduler identity and a fresh full inventory once. An enabled job whose
entire normalized configuration already matches needs no update; missing,
drifting or paused jobs use the existing setup helper and a fresh verification.
The three explicit trigger/completion checks remain ordered and mandatory.
The unchanged path removes 15 serial Cloud SDK invocations across capture/setup.
`drive_worker_release` timing lines separate candidate deployment, attestation,
invoker grant, traffic promotion, scheduler configuration and completion waits;
they contain fixed stage names and elapsed seconds only.

Search citations identify received provider sources; they do not imply fresh
page retrieval. Exact public-page review uses the existing public-network fence.

The selected UAT Azure adapters use workload federation rather than stored keys.
Live input is resampled from the existing 16 kHz client contract to 24 kHz Azure
PCM; output remains 24 kHz. Playback acknowledgements come from the player clock
and fence interrupted context. Older Voice clients use the same selected
processor. Without playback acknowledgements, an in-flight interruption truncates output
at zero and may discard already-heard context. Completed generated turns remain
in conversation history for ordinary follow-ups; completion is not proof of playback.
No transcript is replayed to another provider. BYOK and non-UAT processor selection retain
their existing contracts. Local E5 Drive/action embeddings are unchanged. The
768-dimensional Location prototype separates cache generations by model and
processor; this migration does not activate it or backfill a production index.

The older SHA-bound one-time exception remains separately guarded. Its legacy
text-only receipts do not satisfy this release's complete-capability gate.
Provenance, IAM, authorization, schemas, preservation and candidate health remain
mandatory. A diagnostic source-overlay job is useful during development, but
only the immutable candidate image qualifies a release.

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
