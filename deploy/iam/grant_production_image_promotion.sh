#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
#
# Grant the production deployer the access that
# `deploy-production.yml` needs for backend_image_source=promote-from-uat:
# read the backend revision UAT verified, read that image from the UAT
# registry, and copy it into the production registry by digest.
#
# Prints the plan and changes nothing unless --apply is passed. Idempotent.
# Until these bindings exist, dispatch production with
# backend_image_source=build-from-source (the default).
set -euo pipefail

readonly PROD_PROJECT_ID="hushh-pda"
readonly UAT_PROJECT_ID="hushh-pda-uat"
readonly REGISTRY_REPOSITORY="gcr.io"
readonly REGISTRY_LOCATION="us"
readonly DEPLOYER="serviceAccount:github-actions-prod-deployer@${PROD_PROJECT_ID}.iam.gserviceaccount.com"

apply=false
case "${1:-}" in
  --apply) apply=true ;;
  "") ;;
  *) echo "Usage: $0 [--apply]" >&2; exit 2 ;;
esac

cat <<EOF
Production image promotion needs exactly three bindings for ${DEPLOYER}:

  1. roles/artifactregistry.reader on projects/${UAT_PROJECT_ID}/locations/${REGISTRY_LOCATION}/repositories/${REGISTRY_REPOSITORY}
     Read the UAT-verified backend image (repository-scoped, read-only).
  2. roles/run.viewer on project ${UAT_PROJECT_ID}
     Read the UAT backend revision's deploy-sha label and pinned image (read-only).
  3. roles/artifactregistry.writer on projects/${PROD_PROJECT_ID}/locations/${REGISTRY_LOCATION}/repositories/${REGISTRY_REPOSITORY}
     Copy that digest into the production registry. Today only Cloud Build's
     identity pushes there; the deployer holds reader only.

No UAT write access and no key is created. Revoke by removing the same three.
EOF

if [ "${apply}" != "true" ]; then
  echo
  echo "Dry run. Re-run with --apply to grant."
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || { echo "gcloud is required." >&2; exit 1; }

gcloud artifacts repositories add-iam-policy-binding "${REGISTRY_REPOSITORY}" \
  --project="${UAT_PROJECT_ID}" \
  --location="${REGISTRY_LOCATION}" \
  --role="roles/artifactregistry.reader" \
  --member="${DEPLOYER}" \
  --quiet \
  --format=none

gcloud projects add-iam-policy-binding "${UAT_PROJECT_ID}" \
  --role="roles/run.viewer" \
  --member="${DEPLOYER}" \
  --condition=None \
  --quiet \
  --format=none

gcloud artifacts repositories add-iam-policy-binding "${REGISTRY_REPOSITORY}" \
  --project="${PROD_PROJECT_ID}" \
  --location="${REGISTRY_LOCATION}" \
  --role="roles/artifactregistry.writer" \
  --member="${DEPLOYER}" \
  --quiet \
  --format=none

echo "Production image promotion access granted. A production dispatch with backend_image_source=promote-from-uat now proves it: missing read access fails its preflight before anything changes, and missing write access fails before the fence and migrations."
