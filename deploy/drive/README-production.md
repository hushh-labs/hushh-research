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
   production API key.
2. Verify the production Google OAuth app's approved Drive scopes and exact
   web/native callbacks, including the connector return at
   `https://one.hushh.ai/one/profile/connectors/oauth/return`. Set the
   production environment variable `GOOGLE_DRIVE_OAUTH_PROD_VERIFIED=true`
   only after provider verification. Existing generic Google OAuth secrets do
   not prove this registration.
3. Provision the fixed production Scheduler service account, the backend
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
