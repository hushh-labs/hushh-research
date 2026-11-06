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

# Commit and push Akshat_Working_branch first; the tree must be clean.
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

## Access and timing

Live permission checks on 2026-11-06 passed for source uploads, builds, service
updates, invocation and the dedicated identities. The required deployment grants are:

- `cloudbuild.builds.create` in `hushh-pda-uat` for the dedicated sandbox builder.
- `run.services.update` on `backend-dev-akshat` only.

The launcher permits only `Akshat_Working_branch`, including its merged Main and
memory changes. The separate `New_memory_architecutre` branch is not modified.
No changes to shared pipelines or shared services are needed for this local path.

Deployment receipts record source preparation/upload, Cloud Build queue and
execution, revision rollout and total deployment time. Frontend startup timings
are saved separately in `direct-frontend.json`, including authenticated tunnel
and first successful login-page response. These are measured durations, not estimates.
