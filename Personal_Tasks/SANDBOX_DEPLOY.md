# Akshat's personal sandbox

This local operator path targets only `hushh-pda-uat/us-central1/backend-dev-akshat`.
It does not edit GitHub workflows, required checks, Main, Dev or shared UAT services.
It is separate from the Main-owned GitHub deployment workflow and does not fabricate
GitHub run IDs, CI results or GitHub deployment receipts.

The account must be `i-akshat@hush1one.com`. Authenticate the local application-default
credentials using `gcloud auth application-default login` if necessary. The CLI
tunnel also needs that account's normal `gcloud auth login` session.

```bash
# Read-only identity, permission and resource-isolation verification:
bash Personal_Tasks/akshat-sandbox.sh check

# Commit and push New_memory_architecutre first; the tree must be clean.
bash Personal_Tasks/akshat-sandbox.sh deploy

# After a successful deployment, start the matching clean frontend and tunnel:
bash Personal_Tasks/akshat-sandbox.sh frontend
# Open http://localhost:3000. Ctrl-C stops the owned runtime processes.
```

Deploy archives the exact pushed commit's backend and contracts, uploads a new
immutable Storage generation, and runs the existing image-only Cloud Build recipe
with `backend-dev-akshat-build`. It deploys the resulting digest with the existing
`backend-dev-akshat` runtime identity, isolated SQL database, private IAM and
single-instance capacity. Azure uses the dedicated sandbox Entra client. Existing
default traffic stays pinned to its prior revision; localhost selects the new
explicit `local-<commit>-<timestamp>` revision tag.

No application test suite or successful CI run is a prerequisite of this local
sandbox path. The Dockerfile's image-building steps still execute. Normal PR and
release checks remain required for protected destinations.

Receipts and unresolved-operation checkpoints live in Git metadata under
`hushh-sandbox-akshat/direct-*.json`. If an attempt fails or times out, inspect the
recorded build/operation and reconcile its actual state before removing the pending
checkpoint or retrying. Do not treat a timeout as evidence that nothing happened.

The frontend reuses the clean sibling `../hushh-research-akshat-sandbox`, checks
out the deployed commit, and requires the existing dedicated Firebase web config
and impersonated localhost signing credentials under
`~/.codex/private/akshat-sandbox/`. It refuses ordinary frontend `.env` files.

## Current activation blocker

Live permission checks on 2026-11-06 confirmed the caller can view/invoke the
sandbox, upload/read its source bucket, and act as both dedicated identities.
Direct deployment is missing:

- `cloudbuild.builds.create` in `hushh-pda-uat` for the dedicated sandbox builder.
- `run.services.update` on `backend-dev-akshat` only.

An authorized cloud operator must grant the bounded permissions or provide an
approved sandbox-only executor. GitHub Owner status does not grant GCP permissions.
Image deployment, Azure calls and the new frontend connection are not yet verified.
