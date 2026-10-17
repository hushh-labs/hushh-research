# Production Drive rollout

The production workflow preserves the serving Drive state by default. It stays
off until explicitly enabled. Dispatch `.github/workflows/deploy-production.yml`
from `main` at the exact green SHA with `drive_live_mode=enable` only after
these prerequisites are complete. Use `drive_live_mode=disable` to turn it off
deliberately; an ordinary deploy uses `preserve`:

1. Provision enabled production Secret Manager versions for
   `GOOGLE_DRIVE_OAUTH_CLIENT_ID`, `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_DRIVE_PICKER_API_KEY`, `EXTERNAL_CONNECTOR_CREDENTIAL_KEY`,
   `DRIVE_DOCUMENT_KEY_V1`, and `DRIVE_SHARING_KEY_V1`. Generate the three
   encryption keys independently and retain them across deployments. Never
   copy UAT keys. The Picker secret must match the reviewed, browser-restricted
   production API key named `Hussh Drive Picker (Production)`, restricted to
   `picker.googleapis.com` and the exact HTTPS production hosts in
   `hushh-webapp/lib/vault/passkey-domain-aliases.json`: `one.hushh.ai`,
   `one.hussh.ai` and `one.hussh.si`, each with `/*`. UAT, localhost, HTTP and
   wildcard hosts are not production referrers. The workflow retains the
   current catalog with release tooling before checking out an older app SHA.
2. Verify the production Google OAuth app's approved Drive scopes and exact
   web/native callbacks, including the connector return at
   `/one/profile/connectors/oauth/return` on all three production One domains and
   the two native callback paths on all three production API domains. UAT and local
   origins do not belong in this production client. Set the
   production environment variable `GOOGLE_DRIVE_OAUTH_PROD_VERIFIED=true`
   only after provider verification. Existing generic Google OAuth secrets do
   not prove this registration.
3. Run `PROJECT_ID=hushh-pda bash deploy/drive/setup_native_callback_log_exclusion.sh`
   through the authorized production operator. The release preflight reads it
   back with `--verify-only` and cannot silently create or repair it. The guard
   excludes only the fixed backend/native and frontend/web callback request
   logs; structured application outcomes remain available. If an external
   load balancer logs these callbacks, protect its request-log boundary too.
4. Provision the fixed production Scheduler service account, the backend
   runtime account's `roles/cloudscheduler.jobRunner` grant, and the deployer's
   permissions to read the six secrets and reviewed Picker key, deploy the
   private Cloud Run worker, attach Cloud SQL, grant the Scheduler identity
   `roles/run.invoker`, and create/run the three fixed production jobs.

The workflow checks credentials, Picker restrictions and IAM, then attests the
live production database **before** secret sync or migration. It keeps the
canonical runtime secret unchanged and writes an enabled config to a
new `BACKEND_RUNTIME_CONFIG_JSON_DRIVE_<run_id>_<run_attempt>` secret. Only this release's
backend candidate and private worker bind that secret. After migrations, the
workflow activates and verifies the fixed production registry row, validates
the backend candidate, deploys the worker, and requires fresh 200 responses
from the documents, suggestions and sharing Scheduler jobs **before** app
traffic moves. A failed worker rollout restores its exact Scheduler snapshot
and prior worker revision. If the paired app release later fails, the workflow
restores the worker and scheduler to their pre-release state as well.
On an explicit disable, the workflow first promotes the disabled backend, then
captures and pauses the fixed jobs. A later failed release rolls the backend
back before restoring the exact Scheduler snapshot.

For verification, inspect the workflow's preflight, DB attestation, registry,
candidate runtime-secret binding, worker revision provenance, three fresh
Scheduler 200s, and final serving backend/web SHA. Then use two consented
accounts to confirm a document request resumes, the owner can switch
background access off, and no new background sharing occurs while off. A
Scheduler 200 proves dispatch only; it does not prove Google file sharing or
device notification delivery.

## UAT background processing pause

Dispatch `deploy-uat.yml` with `preserve_paused_drive_worker=true` to disable
the UAT API drain and retain the existing private worker and its three paused
scheduler jobs. The workflow captures and verifies that exact paused baseline;
queued work and stored files remain intact. The ordinary dispatch path activates
legacy Drive processing, regardless of the older
`DRIVE_WORK_DRAIN_UAT_ENABLED` variable. Keep the explicit preservation input on
incident releases until background processing is authorized to resume.

Cloud Scheduler refuses `jobs.run` on a paused job (`400 FAILED_PRECONDITION`,
`Job.state must be ENABLED for RunJob`), so pausing the jobs also stops the
API's prompt wakes; each refusal logs `drive_work_wake.failed stage=<stage>
outcome=paused`. During an incident pause, withdraw the UAT runtime account's
`roles/cloudscheduler.jobRunner` grant as well, until a serving disabled drain
is verified. The withdrawn grant denies every wake at the IAM layer
(`outcome=permission_denied`) whatever each job's state, so a job that a
release or an operator resumes or recreates still cannot be run by the API.
Restore that grant only with an explicitly authorized background-processing
resume.

The isolated V1 UAT lane has its own switch:
`DRIVE_V1_WORK_DRAIN_UAT_ENABLED=false`. With
`preserve_paused_drive_worker=true`, this deploys and attests the V1 image with
its drain disabled, requires an existing paused V1 scheduler baseline, and
verifies that baseline again after promotion. It never resumes or dispatches the
job, and reports paused-state proof separately from a fresh Scheduler 200. Use
the preservation input and the V1 switch together during a complete processing pause.

Only a request created with `DRIVE_AGENT_PACKAGES_ENABLED=true` enters the V1
lane, so the API wakes the V1 job only where that setting is on. Elsewhere it
records `drive_work_wake.skipped stage=v1 outcome=disabled` at debug level and
never calls the job; the V1 job's own schedule drains any older V1 work.
