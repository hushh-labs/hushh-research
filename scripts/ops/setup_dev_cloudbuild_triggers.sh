#!/usr/bin/env bash
# Create/update the GCP-native dev auto-deploy lane: Cloud Build triggers
# in hushh-pda-dev that deploy Cloud Run on pushes to main, replicating
# the scope logic of .github/workflows/deploy-dev.yml natively:
#   dev-backend-autodeploy  -> deploy/dev.autodeploy.backend.cloudbuild.yaml
#                              (migrations + schema floor, then the shared
#                              backend build config)
#   dev-frontend-autodeploy -> deploy/frontend.cloudbuild.yaml directly
# Both fire only on main and only when their lane's files change.
#
# One-time human prerequisite (cannot be scripted): the Cloud Build
# GitHub (2nd gen) connection + repository link, authorized via the
# console at Cloud Build > Repositories > Create host connection.
# This script detects the link and prints instructions if missing.
#
# Idempotent: re-running updates triggers in place (delete+create).
# Dev-only by design; never point triggers like these at UAT/production.

set -euo pipefail

PROJECT_ID="${DEV_PROJECT_ID:-hushh-pda-dev}"
REGION="us-central1"
CONNECTION_NAME="${CLOUDBUILD_GITHUB_CONNECTION:-hushh-labs-github}"
REPO_LINK_NAME="${CLOUDBUILD_REPO_LINK:-hushh-labs-hushh-research}"
REPO_REMOTE="https://github.com/hushh-labs/hushh-research.git"

echo "== Dev Cloud Build auto-deploy trigger setup (project: ${PROJECT_ID}) =="

gcloud services enable cloudbuild.googleapis.com developerconnect.googleapis.com \
  --project="${PROJECT_ID}" >/dev/null

# --- Resolve the 2nd-gen repository link -----------------------------------
repo_resource=""
for conn in $(gcloud builds connections list --project="${PROJECT_ID}" \
    --region="${REGION}" --format='value(name)' 2>/dev/null); do
  found="$(gcloud builds repositories list --project="${PROJECT_ID}" \
    --region="${REGION}" --connection="${conn##*/}" \
    --filter="remoteUri=${REPO_REMOTE}" --format='value(name)' 2>/dev/null | head -1)"
  if [ -n "${found}" ]; then
    repo_resource="${found}"
    break
  fi
done

if [ -z "${repo_resource}" ]; then
  cat <<EOF
ERROR: no Cloud Build (2nd gen) repository link found for ${REPO_REMOTE}.

One-time setup (requires a human with GitHub org admin, ~2 minutes):
  1. Console: https://console.cloud.google.com/cloud-build/repositories/2nd-gen?project=${PROJECT_ID}
  2. "Create host connection" -> GitHub -> name it '${CONNECTION_NAME}' (region ${REGION})
     and authorize the Cloud Build GitHub App for hushh-labs/hushh-research.
  3. "Link repository" -> connection '${CONNECTION_NAME}' -> hushh-labs/hushh-research
     -> name it '${REPO_LINK_NAME}'.
  4. Re-run this script.
EOF
  exit 1
fi
echo "Repository link: ${repo_resource}"

# --- Build service account roles -------------------------------------------
# Trigger builds run as the default compute SA; the orchestrator needs to
# submit inner builds, reach Cloud SQL, read secrets, and deploy Cloud Run.
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in \
    roles/cloudbuild.builds.editor \
    roles/run.admin \
    roles/iam.serviceAccountUser \
    roles/cloudsql.client \
    roles/secretmanager.secretAccessor \
    roles/storage.admin \
    roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${BUILD_SA}" --role="${role}" \
    --condition=None --quiet >/dev/null
  echo "role ensured: ${role} -> ${BUILD_SA}"
done

# --- Triggers ----------------------------------------------------------------
recreate_trigger() {
  local name="$1"
  local existing
  existing="$(gcloud builds triggers list --project="${PROJECT_ID}" --region="${REGION}" \
    --filter="name=${name}" --format='value(id)' 2>/dev/null | head -1)"
  if [ -n "${existing}" ]; then
    gcloud builds triggers delete "${existing}" --project="${PROJECT_ID}" \
      --region="${REGION}" --quiet
    echo "replaced existing trigger: ${name}"
  fi
}

recreate_trigger dev-backend-autodeploy
gcloud builds triggers create github \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --name=dev-backend-autodeploy \
  --description="Auto-deploy backend to dev Cloud Run on main pushes (migrations + schema floor + shared build config)" \
  --repository="${repo_resource}" \
  --branch-pattern='^main$' \
  --build-config=deploy/dev.autodeploy.backend.cloudbuild.yaml \
  --included-files='consent-protocol/**,deploy/backend.cloudbuild.yaml,deploy/dev.autodeploy.backend.cloudbuild.yaml'

recreate_trigger dev-frontend-autodeploy
gcloud builds triggers create github \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --name=dev-frontend-autodeploy \
  --description="Auto-deploy frontend to dev Cloud Run on main pushes (shared build config)" \
  --repository="${repo_resource}" \
  --branch-pattern='^main$' \
  --build-config=deploy/frontend.cloudbuild.yaml \
  --included-files='hushh-webapp/**,deploy/frontend.cloudbuild.yaml' \
  --substitutions='_FRONTEND_SERVICE=hushh-webapp,_REGION=us-central1,_APP_ENV=uat,_CLOUD_RUN_NO_TRAFFIC=false,_IMAGE_TAG=dev-${COMMIT_SHA},_DEPLOY_ENV=dev,_DEPLOY_SOURCE=cloudbuild-trigger,_DEPLOY_SHA=${COMMIT_SHA},_GITHUB_RUN_ID=cb-${BUILD_ID}'

echo
echo "Done. Verify with:"
echo "  gcloud builds triggers list --project=${PROJECT_ID} --region=${REGION}"
echo "  python3 scripts/ops/dev_environment_doctor.py"
