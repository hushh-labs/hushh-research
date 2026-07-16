#!/usr/bin/env bash
set -euo pipefail

required_env=(GCP_PROJECT_ID GCP_REGION BACKEND_SERVICE BACKEND_REVISION GITHUB_RUN_ID)
for name in "${required_env[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "${name} is required for candidate PKM evaluation." >&2
    exit 1
  fi
done

job_name="uat-pkm-eval-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}"
job_name="${job_name,,}"
job_name="${job_name:0:63}"

image="$(gcloud run revisions describe "$BACKEND_REVISION" \
  --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" \
  --format='value(spec.containers[0].image)')"
runtime_service_account="$(gcloud run services describe "$BACKEND_SERVICE" \
  --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" \
  --format='value(spec.template.spec.serviceAccountName)')"

if [ -z "$image" ] || [ -z "$runtime_service_account" ]; then
  echo "Unable to resolve the candidate image or runtime service account." >&2
  exit 1
fi

cleanup() {
  gcloud run jobs delete "$job_name" \
    --project "$GCP_PROJECT_ID" \
    --region "$GCP_REGION" \
    --quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

gcloud run jobs create "$job_name" \
  --project "$GCP_PROJECT_ID" \
  --region "$GCP_REGION" \
  --image "$image" \
  --service-account "$runtime_service_account" \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout 45m \
  --set-env-vars "ENVIRONMENT=uat,HUSHH_DEPLOY_ENV=uat,HUSHH_GENAI_AUTH_MODE=vertex_adc,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID},GOOGLE_CLOUD_LOCATION=global" \
  --command python \
  --args "scripts/eval_pkm_structure_agent.py,--phase,fresh_chain_60,--skip-shadow,--enforce-gates,--json-out,/tmp/pkm-structure-agent-eval.json" \
  --quiet

for attempt in 1 2; do
  echo "Running synthetic candidate PKM evaluator ${attempt}/2..."
  gcloud run jobs execute "$job_name" \
    --project "$GCP_PROJECT_ID" \
    --region "$GCP_REGION" \
    --wait \
    --quiet
done

echo "Candidate PKM evaluator passed twice with synthetic-only input."
