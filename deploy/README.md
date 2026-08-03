# Hussh Deployment Package

This directory contains Cloud Build definitions and environment-provisioning
helpers used by the governed GitHub deployment workflows. It is not a manual
Cloud Run deployment runbook.

## Release authority

Use the canonical
[Admin merge and release SOP](../.codex/skills/repo-operations/references/admin-release-sop.md)
for merge queue, explicit Admin PR landing, exact-SHA UAT/production dispatch,
monitoring, evidence, rollback, and branch restoration.

Runtime traffic authority belongs to these workflows:

1. [Deploy to Dev](../.github/workflows/deploy-dev.yml)
2. [Deploy to UAT](../.github/workflows/deploy-uat.yml)
3. [Deploy to Production](../.github/workflows/deploy-production.yml)

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

Production is a separate explicit authority transition. UAT success does not
authorize it, and UAT credentials or runtime identities must never be reused in
production.

## What lives here

| Path | Purpose |
| --- | --- |
| `backend.cloudbuild.yaml` | Backend image build and Cloud Run candidate deployment used by governed workflows |
| `frontend.cloudbuild.yaml` | Frontend image build and Cloud Run candidate deployment used by governed workflows |
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
rehearsal, candidate evaluation, or reviewer BYOK proof is required. The
structure-agent evaluator is warning-only and does not authorize rollback by
itself; provenance, schema, runtime, and semantic authority remain blocking.

## Read-only operator diagnostics

Read-only inspection is allowed when it does not mutate runtime state. Prefer
workflow artifacts, then use repository helpers such as:

```bash
python3 .codex/skills/uat-scoped-deploy/scripts/cloud_run_service_evidence.py \
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
