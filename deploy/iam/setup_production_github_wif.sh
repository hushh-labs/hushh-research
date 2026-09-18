#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

set -euo pipefail

readonly PROD_PROJECT_ID="hushh-pda"
readonly GITHUB_REPOSITORY="hushh-labs/hushh-research"
readonly GITHUB_ENVIRONMENT="production"
readonly POOL_ID="github-actions-prod"
readonly PROVIDER_ID="hushh-research-prod"
readonly DEPLOY_SERVICE_ACCOUNT_ID="github-actions-prod-deployer"
readonly DEPLOY_SERVICE_ACCOUNT_EMAIL="${DEPLOY_SERVICE_ACCOUNT_ID}@${PROD_PROJECT_ID}.iam.gserviceaccount.com"
readonly RUNTIME_SERVICE_ACCOUNT_EMAIL="consent-protocol-runtime@${PROD_PROJECT_ID}.iam.gserviceaccount.com"
readonly BACKEND_ARTIFACT_REPOSITORY="gcr.io"
readonly BACKEND_ARTIFACT_LOCATION="us"
readonly ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
readonly ATTRIBUTE_CONDITION="assertion.sub == 'repo:${GITHUB_REPOSITORY}:environment:${GITHUB_ENVIRONMENT}' && assertion.ref == 'refs/heads/main'"

readonly -a DEPLOY_PROJECT_ROLES=(
  "roles/cloudbuild.builds.editor"
  "roles/run.admin"
  "roles/secretmanager.admin"
  "roles/secretmanager.secretAccessor"
  "roles/serviceusage.serviceUsageConsumer"
  "roles/storage.admin"
)

add_project_role_binding() {
  local deploy_role="$1"
  local attempt

  for attempt in 1 2 3 4 5 6; do
    if gcloud projects add-iam-policy-binding "${PROD_PROJECT_ID}" \
      --role="${deploy_role}" \
      --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT_EMAIL}" \
      --condition=None \
      --quiet \
      --format=none; then
      return 0
    fi

    if [ "${attempt}" -lt 6 ]; then
      sleep "$((attempt * 2))"
    fi
  done

  echo "Failed to bind ${deploy_role} after IAM propagation retries." >&2
  return 1
}

command -v gcloud >/dev/null 2>&1 || {
  echo "gcloud is required." >&2
  exit 1
}
command -v gh >/dev/null 2>&1 || {
  echo "gh is required." >&2
  exit 1
}

gcloud auth print-access-token >/dev/null
gh auth status >/dev/null
gcloud projects describe "${PROD_PROJECT_ID}" >/dev/null
prod_project_number="$(
  gcloud projects describe "${PROD_PROJECT_ID}" --format="value(projectNumber)"
)"
readonly prod_project_number
readonly build_service_account_email="${prod_project_number}-compute@developer.gserviceaccount.com"

if ! gcloud iam service-accounts describe "${DEPLOY_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROD_PROJECT_ID}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${DEPLOY_SERVICE_ACCOUNT_ID}" \
    --project="${PROD_PROJECT_ID}" \
    --display-name="GitHub Actions Production Deployer"
fi

if ! gcloud iam workload-identity-pools describe "${POOL_ID}" \
  --project="${PROD_PROJECT_ID}" \
  --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "${POOL_ID}" \
    --project="${PROD_PROJECT_ID}" \
    --location=global \
    --display-name="GitHub Actions Production"
fi

if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" \
  --project="${PROD_PROJECT_ID}" \
  --location=global \
  --workload-identity-pool="${POOL_ID}" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "${PROVIDER_ID}" \
    --project="${PROD_PROJECT_ID}" \
    --location=global \
    --workload-identity-pool="${POOL_ID}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="${ATTRIBUTE_MAPPING}" \
    --attribute-condition="${ATTRIBUTE_CONDITION}"
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_ID}" \
    --project="${PROD_PROJECT_ID}" \
    --location=global \
    --workload-identity-pool="${POOL_ID}" \
    --display-name="hushh-research Production" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="${ATTRIBUTE_MAPPING}" \
    --attribute-condition="${ATTRIBUTE_CONDITION}"
fi

readonly repository_principal_set="principalSet://iam.googleapis.com/projects/${prod_project_number}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPOSITORY}"

gcloud iam service-accounts add-iam-policy-binding "${DEPLOY_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROD_PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="${repository_principal_set}" \
  --quiet \
  --format=none

gcloud iam service-accounts add-iam-policy-binding "${build_service_account_email}" \
  --project="${PROD_PROJECT_ID}" \
  --role="roles/iam.serviceAccountUser" \
  --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT_EMAIL}" \
  --quiet \
  --format=none

# Cloud Run revalidates act-as authority on the revision runtime identity when
# traffic changes. Keep this binding on the exact runtime service account.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SERVICE_ACCOUNT_EMAIL}" \
  --project="${PROD_PROJECT_ID}" \
  --role="roles/iam.serviceAccountUser" \
  --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT_EMAIL}" \
  --quiet \
  --format=none

for deploy_role in "${DEPLOY_PROJECT_ROLES[@]}"; do
  add_project_role_binding "${deploy_role}"
done

# Cloud Run validates the candidate image while shifting traffic. Keep image
# read authority scoped to the production backend repository instead of adding
# Artifact Registry read access across the entire project.
gcloud artifacts repositories add-iam-policy-binding "${BACKEND_ARTIFACT_REPOSITORY}" \
  --project="${PROD_PROJECT_ID}" \
  --location="${BACKEND_ARTIFACT_LOCATION}" \
  --role="roles/artifactregistry.reader" \
  --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT_EMAIL}" \
  --quiet \
  --format=none

readonly provider_resource="projects/${prod_project_number}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
printf '%s' "${provider_resource}" | gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
  --repo="${GITHUB_REPOSITORY}" \
  --env="${GITHUB_ENVIRONMENT}"
printf '%s' "${DEPLOY_SERVICE_ACCOUNT_EMAIL}" | gh variable set GCP_DEPLOY_SERVICE_ACCOUNT \
  --repo="${GITHUB_REPOSITORY}" \
  --env="${GITHUB_ENVIRONMENT}"

python3 scripts/ci/verify-deployment-environment-governance.py --surface production

# Read back what GCP actually has and compare it to the literals above. This file is
# the authoritative record of who may mint a production deploy token; until now
# nothing compared that record to reality, so a console edit to the provider or an
# out-of-band role binding on the deploy account was undetectable. The check runs
# here because this is the one place the operator credential can read IAM -- the
# deploy lane's federated identity is scoped to deploying and cannot.
python3 scripts/ci/verify-deploy-identity-provenance.py \
  --report-path /tmp/production-deploy-identity.json

echo "Production GitHub WIF configuration is ready."
