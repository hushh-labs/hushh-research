# Akshat's personal sandbox

This local operator path targets only `hushh-pda-uat/us-central1/backend-dev-akshat`.
It does not edit GitHub workflows, required checks, Main, Dev or shared UAT services.
It is separate from the Main-owned GitHub deployment workflow and does not fabricate
GitHub run IDs, CI results or GitHub deployment receipts.

The account must be `i-akshat@hush1one.com`. Authenticate the local application-default
credentials using `gcloud auth application-default login` if necessary. The tunnel
uses that verified owner's ADC identity token with the SDK's native
`cloud-run-proxy` component, renewing before expiry. Tokens are never logged.
The separate localhost signer retains its dedicated identity while its source
credential is synchronized with the verified owner's current ADC at startup.

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
The tag uses a compact hexadecimal timestamp so its name and the service name
fit Cloud Run's combined 46-character limit.

No application test suite or successful CI run is a prerequisite of this local
sandbox path. The Dockerfile's image-building steps still execute. Normal PR and
release checks remain required for protected destinations.

Receipts and unresolved-operation checkpoints live in Git metadata under
`hushh-sandbox-akshat/direct-*.json`. If an attempt fails or times out, inspect the
recorded build/operation and reconcile its actual state before removing the pending
checkpoint or retrying. Do not treat a timeout as evidence that nothing happened.

The frontend reuses the clean sibling `../hushh-research-akshat-sandbox`, checks
out the deployed commit, builds optimized production output in `.next-sandbox-prod`
and runs its standalone Node server with a bounded 4 GB heap. It requires the dedicated Firebase web config
and impersonated localhost signing credentials under
`~/.codex/private/akshat-sandbox/`. It refuses ordinary frontend `.env` files.

## Phone verification in this sandbox

The frontend uses Firebase project `hushh-akshat-sandbox-auth`, separate from UAT.
Its configured fictional numbers are `+19898989881` through `+19898989886`.
Select **United States (+1)** and enter the remaining ten digits. Use the matching
test code from that project's Firebase Authentication phone-provider settings;
Firebase does not send an actual SMS to these numbers. Keep test codes out of Git.

On 2026-11-06 the production localhost frontend successfully requested verification
for `+19898989881` and displayed **Enter your code**, using normal reCAPTCHA.
No application-verification bypass or frontend rebuild was needed.
The dedicated project's SMS allowlist now contains US and India. Billing is disabled
on that Firebase project, so real-number SMS remains unavailable until an authorized
operator attaches an approved billing account. Region permission alone does not
prove SMS delivery. Shared UAT authentication settings remain unchanged.

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
production build and first successful login-page response. These are measured durations, not estimates.
