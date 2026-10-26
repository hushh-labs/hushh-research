#!/usr/bin/env bash
set -euo pipefail

# Wake the existing durable worker even after Cloud Run scales to zero.
# Run during release after migration 428; never use a client heartbeat as a timer.
case "${DEPLOY_ENV:-}" in
  uat) project=hushh-pda-uat; origin=https://api.uat.hushh.ai ;;
  production) project=hushh-pda; origin=https://api.hushh.ai ;;
  *) echo 'DEPLOY_ENV must be uat or production' >&2; exit 1 ;;
esac
account="system-push-drain@${project}.iam.gserviceaccount.com"
job=system-push-drain
region=us-central1
if ! gcloud iam service-accounts describe "$account" --project="$project" >/dev/null 2>&1; then
  gcloud iam service-accounts create system-push-drain --project="$project" --display-name='Durable system notification scheduler'
fi
number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding "$account" --project="$project" \
  --member="serviceAccount:service-${number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountTokenCreator >/dev/null
args=(--project="$project" --location="$region" --schedule='* * * * *' --time-zone=Etc/UTC
  --uri="$origin/api/internal/system-push/drain" --http-method=POST --oidc-service-account-email="$account"
  --oidc-token-audience="$origin" --attempt-deadline=180s --max-retry-attempts=3 --min-backoff=10s --max-backoff=60s)
if gcloud scheduler jobs describe "$job" --project="$project" --location="$region" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$job" "${args[@]}"
else
  gcloud scheduler jobs create http "$job" "${args[@]}"
fi
