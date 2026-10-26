#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Reuse the canonical production provider; create no service-account keys.
set -euo pipefail
readonly PROJECT=hushh-pda
readonly REPOSITORY=hushh-labs/hushh-research
readonly ACCOUNT_ID=github-prod-backup-reader
readonly ACCOUNT="${ACCOUNT_ID}@${PROJECT}.iam.gserviceaccount.com"
readonly ROLE_ID=productionBackupPostureReader
readonly PERMISSIONS=cloudsql.instances.get,cloudsql.backupRuns.list

# A newly created service account can take a few seconds to reach project IAM.
# Retry only the same idempotent binding, with a bounded delay; never widen it.
retry_binding() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if "$@"; then return 0; fi
    if [[ "$attempt" -lt 5 ]]; then sleep "$((attempt * 2))"; fi
  done
  return 1
}

# Refuse missing/drifted production federation before granting access.
python3 scripts/ci/verify-deploy-identity-provenance.py --report-path "${TMPDIR:-/tmp}/production-backup-identity.json"
provider="$(gh variable get GCP_WORKLOAD_IDENTITY_PROVIDER --repo="$REPOSITORY" --env=production)"
project_number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
expected="projects/${project_number}/locations/global/workloadIdentityPools/github-actions-prod/providers/hushh-research-prod"
[[ "$provider" == "$expected" ]] || { echo 'Production provider mismatch' >&2; exit 1; }

accounts="$(gcloud iam service-accounts list --project="$PROJECT" --filter="email=${ACCOUNT}" --format='value(email)')"
if [[ -z "$accounts" ]]; then
  gcloud iam service-accounts create "$ACCOUNT_ID" --project="$PROJECT" --display-name='Production backup posture reader' --quiet
else
  [[ "$accounts" == "$ACCOUNT" ]] || exit 1
fi
roles="$(gcloud iam roles list --project="$PROJECT" --filter="name=projects/${PROJECT}/roles/${ROLE_ID}" --format='value(name)')"
if [[ -z "$roles" ]]; then action=create; else
  [[ "$roles" == "projects/${PROJECT}/roles/${ROLE_ID}" ]] || exit 1
  action=update
fi
gcloud iam roles "$action" "$ROLE_ID" --project="$PROJECT" --title='Production backup posture reader' \
  --description='Read instance backup configuration and list backup outcomes; no database or mutation access.' \
  --permissions="$PERMISSIONS" --stage=GA --quiet --format=none
retry_binding gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${ACCOUNT}" \
  --role="projects/${PROJECT}/roles/${ROLE_ID}" --condition=None --quiet --format=none
retry_binding gcloud iam service-accounts add-iam-policy-binding "$ACCOUNT" --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/github-actions-prod/attribute.repository/${REPOSITORY}" \
  --quiet --format=none
printf '%s' "$ACCOUNT" | gh variable set GCP_BACKUP_SERVICE_ACCOUNT --repo="$REPOSITORY" --env=production
printf 'Configured dedicated production backup reader. Run Verify Production Backups from main and inspect its report.\n'
