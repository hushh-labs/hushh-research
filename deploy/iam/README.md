# Production GitHub WIF

This directory owns the single setup path for GitHub Actions deployment
authentication into the `hushh-pda` production project.

## Canonical setup

Run from the repository root with authenticated `gcloud` and `gh` sessions:

```bash
bash deploy/iam/setup_production_github_wif.sh
```

The script is idempotent. It:

1. creates or reuses the dedicated production deploy service account
2. creates or reuses the production GitHub workload identity pool and provider
3. restricts OIDC subjects to this repository, the `production` GitHub
   environment, and the `main` branch
4. applies the deployment roles used by the governed production workflow,
   including act-as authority only on the exact build and backend runtime
   service accounts, plus image-read authority only on the production backend
   artifact repository
5. writes the provider and service-account identifiers as GitHub `production`
   environment variables
6. runs the live deployment-environment governance verifier
7. reads the provider and project IAM policy back from GCP and compares them to
   the literals at the top of this script

Do not create a service-account key, reuse the Firebase Admin service account,
reuse UAT identity variables, or add a second production provider for this
repository. GitHub OIDC federation is the only deployment authentication path.

## Ownership boundary

- This script owns GCP deployment identity and the two GitHub environment
  variables consumed by the production workflow.
- `.github/workflows/deploy-production.yml` owns release sequencing, migration
  gates, candidate revisions, traffic promotion, health checks, and rollback.
- `config/ci-governance.json` owns required variable names and dispatch
  authority.
- GCP Secret Manager owns runtime credentials. This setup script never reads or
  writes application secrets.

## Verification

```bash
./scripts/ci/verify-production-environment-governance.sh
```

The verifier checks configuration names and environment governance without
printing variable values.

To compare this directory's record against what GCP actually has — the provider's
attribute mapping and condition, and every project role bound to the deploy service
account — run:

```bash
python3 scripts/ci/verify-deploy-identity-provenance.py
```

Its expectations are parsed from `setup_production_github_wif.sh` rather than
restated, so the script stays the single record. `--record-only` runs the half that
needs no cloud access (it is part of `repo-governance-check.sh`). A live read that
GCP refuses is reported as `deploy_identity_unverifiable` with a non-zero exit — it
is never recorded as a pass.

## Production image promotion

`deploy-production.yml` can deploy the exact backend image UAT verified for a
SHA instead of rebuilding it (`backend_image_source=promote-from-uat`). The
default stays `build-from-source` until these bindings exist and the founder
flips the default. The production frontend is always built in `hushh-pda`: its
image compiles production-only `NEXT_PUBLIC_*` values, so a UAT web image must
never serve production.

Exactly three bindings, all for
`serviceAccount:github-actions-prod-deployer@hushh-pda.iam.gserviceaccount.com`:

| Role | Resource | Why |
|---|---|---|
| `roles/artifactregistry.reader` | `projects/hushh-pda-uat/locations/us/repositories/gcr.io` | read the UAT-verified backend image |
| `roles/run.viewer` | project `hushh-pda-uat` | read the UAT backend revision's `deploy-sha` label and pinned image |
| `roles/artifactregistry.writer` | `projects/hushh-pda/locations/us/repositories/gcr.io` | copy that digest into the production registry |

```bash
bash deploy/iam/grant_production_image_promotion.sh          # prints the plan
bash deploy/iam/grant_production_image_promotion.sh --apply  # grants it
```

Nothing grants UAT write access or creates a key. If a binding is missing, the
promotion run stops with a message naming it: read access is checked before the
secret sync, backup gate, fence and migrations; write access fails at the copy,
still before the fence. Re-dispatch with `backend_image_source=build-from-source`
to ship without promotion.
