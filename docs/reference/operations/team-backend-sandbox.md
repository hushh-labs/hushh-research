# Team backend sandbox

The team frontend runs at [localhost:3000](http://localhost:3000). Its API and
WebSocket traffic goes through an authenticated Cloud Run proxy on port 8080.
The launcher checks that the deployed revision tag, full Git commit, image
digest, telemetry label and Firebase project match the sandbox receipt.

| Surface | Sandbox |
| --- | --- |
| Cloud Run | `hushh-pda-uat/us-central1/backend-dev-ankit` |
| Cloud SQL | `backend-dev-ankit-pg`, database `backend_dev_ankit` |
| Firebase Authentication | `hushh-team-sandbox-auth`, admin-provisioned email and password |
| Backend traces and logs | Cloud Trace and Cloud Logging in `hushh-pda-uat`, tagged `sandbox-ankit` |

## One-time setup

Use a clean worktree for the sandbox commit. Sign in to GitHub and Google Cloud
with your engineering account, install the Cloud Run proxy component, and
create a separate local ADC profile for Firebase session cookies.

```bash
gh auth status
gcloud auth login
gcloud components install cloud-run-proxy
CLOUDSDK_CONFIG="$HOME/.config/hushh-sandbox-gcloud" \
  gcloud auth application-default login \
  --impersonate-service-account=localhost-sandbox-auth@hushh-team-sandbox-auth.iam.gserviceaccount.com \
  --disable-quota-project
```

Ask the sandbox admin to provision your email in
[the sandbox Firebase Authentication console](https://console.firebase.google.com/project/hushh-team-sandbox-auth/authentication/users)
and send a password reset for that account. Use your sandbox password on the
localhost form. Each engineer uses their own Firebase account.
For full onboarding or Voice tests, have the admin attach a unique fictional
phone number to your sandbox Firebase account. Use sandbox fixtures for those
tests. Choose `Hussh Shared` in setup and unlock your sandbox vault to use Voice.

## Start the frontend

From the sandbox worktree root, fetch the team branch, download the artifact for
the approved deployment run, and check out the exact commit from its receipt.

```bash
git fetch origin codex/ankit-sandbox-runtime
run_id=REPLACE_WITH_APPROVED_RUN_ID
receipt="$(git rev-parse --path-format=absolute --git-path hushh-personal-backend)"
gh run download "$run_id" --repo hushh-labs/hushh-research \
  --name backend-dev-ankit-receipt --dir "$(dirname "$receipt")"
git switch --detach "$(cut -f1 "$receipt")"
cd hushh-webapp
npm ci
npm run dev:sandbox
```

Use [localhost:3000](http://localhost:3000) in the browser. Keep this terminal
open while testing. Cloud Run request timings describe the cloud backend.
Browser timings also include the local authenticated proxy and the network.
Filter Cloud Logging by service `backend-dev-ankit` and the revision printed
by the launcher. Filter application traces by `deployment.environment=sandbox-ankit`.

Sandbox deployments use the operator-owned `Deploy Ankit's personal backend`
workflow on Main. It builds the generation-qualified source archive in Cloud
Build, deploys its digest and attaches an explicit commit tag. The new receipt
selects that revision for the team. Existing receipts keep their pinned revision.
