#!/usr/bin/env bash
set -euo pipefail

# Isolated UAT lane for deterministic V1 request search. This does not deploy
# consent-protocol-drive-worker or mutate its three paused Scheduler jobs.
readonly PROJECT_ID="hushh-pda-uat"
readonly REGION="us-central1"
readonly SERVICE="consent-protocol-drive-v1-worker"
readonly SCHEDULER_ID="drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
readonly SCHEDULER_AUDIENCE="https://api.uat.hushh.ai"
readonly JOB="drive-work-v1-uat"
readonly CLAMAV_IMAGE="clamav/clamav@sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817"
readonly CLAMAV_AMD64_DIGEST="sha256:e8388295191bff0893fb889d9415ae975491201c989b205e30c9057b1985d36a"

IMAGE_REFERENCE="${IMAGE_REFERENCE:?immutable backend image required}"
DEPLOY_SHA="${DEPLOY_SHA:?release SHA required}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:?runtime identity required}"
CLOUDSQL_INSTANCE="${CLOUDSQL_INSTANCE:?Cloud SQL instance required}"
RELEASE_RUN_ID="${RELEASE_RUN_ID:?release run id required}"
SNAPSHOT_PATH="${SNAPSHOT_PATH:?persistent V1 scheduler snapshot path required}"
PREVIOUS_REVISION_PATH="${PREVIOUS_REVISION_PATH:?persistent V1 revision path required}"
DRIVE_WORK_DRAIN_ENABLED="${DRIVE_WORK_DRAIN_ENABLED:-true}"
DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED="${DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED:-false}"
if [[ "${DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED}" != true && "${DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED}" != false ]]; then
  echo "Data packet activation must be true or false" >&2
  exit 1
fi
if [[ "${DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED}" == true && "${DRIVE_WORK_DRAIN_ENABLED}" != true ]]; then
  echo "Data packets require an enabled private worker; the V1 pause is preserved" >&2
  exit 1
fi
groups_snapshot="${SNAPSHOT_PATH%.json}-groups.json"
if [[ "${DRIVE_WORK_DRAIN_ENABLED}" != true && "${DRIVE_WORK_DRAIN_ENABLED}" != false ]]; then
  echo "V1 background processing must be true or false" >&2
  exit 1
fi
DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER_UAT="${DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER_UAT:-gemini}"
case "${DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER_UAT}" in
  gemini|azure_openai) ;;
  *) echo "Invalid Documents semantic provider" >&2; exit 1 ;;
esac

if [[ ! "${IMAGE_REFERENCE}" =~ ^gcr\.io/hushh-pda-uat/consent-protocol@sha256:[0-9a-f]{64}$ \
  || ! "${DEPLOY_SHA}" =~ ^[0-9a-f]{40}$ \
  || ! "${RELEASE_RUN_ID}" =~ ^[0-9]+$ \
  || "${RUNTIME_SERVICE_ACCOUNT}" != "consent-protocol-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  || "${CLOUDSQL_INSTANCE}" != "${PROJECT_ID}:${REGION}:hushh-uat-pg" \
  || "${SNAPSHOT_PATH}" != /tmp/uat-drive-v1-before.json \
  || "${PREVIOUS_REVISION_PATH}" != /tmp/uat-drive-v1-previous-revision.txt ]]; then
  echo "V1 worker release inputs are outside the reviewed UAT boundary" >&2
  exit 1
fi

# Use the serving API's exact release binding, including a Vertex-only selection.
MANAGED_TEXT_PROVIDER="$(python3 scripts/ci/managed_provider_readiness.py worker-provider \
  --sha="${DEPLOY_SHA}" --image="${IMAGE_REFERENCE}" \
  --run-id="${RELEASE_RUN_ID}" --account="${RUNTIME_SERVICE_ACCOUNT}")"
readonly MANAGED_TEXT_PROVIDER

# The old worker may be paused, but the isolated V1 lane needs the same
# connector credentials and the existing UAT Stripe separation.
source deploy/drive/uat_stripe_bindings.sh
_STRIPE_MODE="${STRIPE_UAT_MODE}"
_STRIPE_CONNECT_MODE="${STRIPE_CONNECT_UAT_MODE}"
_STRIPE_SECRET_KEY_SECRET="${STRIPE_UAT_KEY_SECRET}"
_STRIPE_CONNECT_SECRET_KEY_SECRET="${STRIPE_UAT_CONNECT_KEY_SECRET}"
_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET="${STRIPE_UAT_CONNECT_SECRET}"
_STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET="${STRIPE_UAT_CONNECT_TEST_WEBHOOK_SECRET}"
_DRIVE_REQUEST_HASHCOINS_ENABLED="${DRIVE_REQUEST_HASHCOINS_UAT_ENABLED:-false}"
_DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED="${DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED}"
source deploy/drive/verify_hashcoin_config.sh "${PROJECT_ID}"

if ! gcloud iam service-accounts describe "${SCHEDULER_ID}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "V1 worker Scheduler identity is missing" >&2
  exit 1
fi

service_exists="$(gcloud run services list --project="${PROJECT_ID}" --region="${REGION}" --format=json \
  | python3 -c 'import json,sys; rows=json.load(sys.stdin); print("true" if any((row.get("metadata") or {}).get("name")=="consent-protocol-drive-v1-worker" for row in rows) else "false")')"
previous_revision=""
traffic_flags=()
if [[ "${service_exists}" == true ]]; then
  previous_revision="$(gcloud run services describe "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format=json \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); rows=[r for r in ((d.get("status") or {}).get("traffic") or []) if r.get("percent",0)>0]; print(rows[0].get("revisionName","") if len(rows)==1 and rows[0].get("percent")==100 else "")')"
  if [[ ! "${previous_revision}" =~ ^consent-protocol-drive-v1-worker-[a-z0-9-]+$ ]]; then
    echo "Existing V1 worker has ambiguous serving traffic" >&2
    exit 1
  fi
  traffic_flags=(--no-traffic)
fi
printf '%s\n' "${previous_revision}" > "${PREVIOUS_REVISION_PATH}"

# Failure after the snapshot always restores/quarantines only this V1 lane.
snapshot_captured=false
rollback() {
  local status="$?"
  trap - EXIT INT TERM
  if [[ "${snapshot_captured}" == true ]]; then
    if ! bash deploy/drive/restore_v1_worker.sh "${SNAPSHOT_PATH}" "${previous_revision}" >&2; then
      python3 deploy/drive/v1_scheduler_state.py quarantine >&2 || true
      python3 deploy/drive/v1_scheduler_state.py quarantine --stage groups >&2 || true
      echo "CRITICAL: V1 worker rollback is incomplete; the V1 job is quarantined" >&2
    fi
  fi
  exit "${status}"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A paused release requires an existing, reviewed paused lane. Attest it before
# any deployment and preserve it through promotion; never create or resume work.
if [[ "${DRIVE_WORK_DRAIN_ENABLED}" == false ]]; then
  if [[ "${service_exists}" != true ]]; then
    echo "A paused V1 release requires an existing worker" >&2
    exit 1
  fi
  python3 deploy/drive/v1_scheduler_state.py capture-paused --snapshot "${SNAPSHOT_PATH}"
  python3 deploy/drive/v1_scheduler_state.py verify-paused --snapshot "${SNAPSHOT_PATH}"
  snapshot_captured=true
fi

payment_secret_bindings=""
stripe_secret_ready=true
for payment_secret in "${STRIPE_UAT_KEY_SECRET}" "${STRIPE_UAT_WEBHOOK_SECRET}" APP_FRONTEND_ORIGIN; do
  if ! gcloud secrets describe "${payment_secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    stripe_secret_ready=false
  fi
done
if [[ ( "${DRIVE_REQUEST_PAYMENTS_UAT_ENABLED:-false}" == true \
     || "${DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED:-false}" == true ) \
  && "${stripe_secret_ready}" != true ]]; then
  echo "V1 payments require the reviewed UAT Stripe secrets" >&2
  exit 1
fi
if [[ "${stripe_secret_ready}" == true ]]; then
  payment_secret_bindings=",STRIPE_SECRET_KEY=${STRIPE_UAT_KEY_SECRET}:latest,STRIPE_WEBHOOK_SECRET=${STRIPE_UAT_WEBHOOK_SECRET}:latest,APP_FRONTEND_ORIGIN=APP_FRONTEND_ORIGIN:latest"
fi
for pair in \
  "STRIPE_CONNECT_SECRET_KEY:${STRIPE_UAT_CONNECT_KEY_SECRET}" \
  "STRIPE_CONNECT_WEBHOOK_SECRET:${STRIPE_UAT_CONNECT_SECRET}" \
  "STRIPE_CONNECT_TEST_WEBHOOK_SECRET:${STRIPE_UAT_CONNECT_TEST_WEBHOOK_SECRET}"; do
  key="${pair%%:*}"
  secret="${pair#*:}"
  if gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    payment_secret_bindings="${payment_secret_bindings},${key}=${secret}:latest"
  fi
done

gcloud --quiet run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --platform=managed \
  --service-account="${RUNTIME_SERVICE_ACCOUNT}" \
  --ingress=internal --no-allow-unauthenticated \
  --add-custom-audiences="${SCHEDULER_AUDIENCE}" \
  --add-cloudsql-instances="${CLOUDSQL_INSTANCE}" \
  --concurrency=1 --timeout=240 --max-instances=1 --min-instances=0 \
  --max=1 --min=0 "${traffic_flags[@]}" \
  --labels="managed-by=hushh-github-actions,deploy-env=uat,deploy-sha=${DEPLOY_SHA},github-run-id=${RELEASE_RUN_ID}" \
  --container=drive-worker \
  --image="${IMAGE_REFERENCE}" --port=8080 --cpu=2 --memory=4Gi \
  --command=gunicorn \
  --args=server_drive_worker:app,-w,1,-k,uvicorn.workers.UvicornWorker,--timeout,220,--worker-tmp-dir,/tmp,-b,0.0.0.0:8080 \
  --depends-on=clamav \
  --startup-probe=httpGet.port=8080,httpGet.path=/ready,periodSeconds=10,timeoutSeconds=5,failureThreshold=24 \
  --set-env-vars="^|^ENVIRONMENT=uat|HUSHH_UAT_MANAGED_TEXT_PROVIDER=${MANAGED_TEXT_PROVIDER}|HUSHH_UAT_MANAGED_AI_PROVIDER=${MANAGED_TEXT_PROVIDER}|GOOGLE_CLOUD_PROJECT=${PROJECT_ID}|STRIPE_MODE=${STRIPE_UAT_MODE}|STRIPE_CONNECT_MODE=${STRIPE_CONNECT_UAT_MODE}|DRIVE_WORKER_MODE=true|DRIVE_WORKER_V1_ONLY=true|DRIVE_WORK_DRAIN_ENABLED=${DRIVE_WORK_DRAIN_ENABLED}|DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER=${DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER_UAT}|DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED=${DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED:-false}|DRIVE_REQUEST_HASHCOINS_ENABLED=${DRIVE_REQUEST_HASHCOINS_UAT_ENABLED:-false}|DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED=${DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED}|DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID=${PROJECT_ID}|DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL=${SCHEDULER_ID}|DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE=${SCHEDULER_AUDIENCE}|DB_POOL_MIN_SIZE=0|DB_POOL_MAX_SIZE=2|DB_SQLALCHEMY_POOL_SIZE=1|DB_SQLALCHEMY_MAX_OVERFLOW=0" \
  --set-secrets="BACKEND_RUNTIME_CONFIG_JSON=BACKEND_RUNTIME_CONFIG_JSON:latest,DB_USER=DB_USER:latest,DB_PASSWORD=DB_PASSWORD:latest,APP_SIGNING_KEY=APP_SIGNING_KEY:latest,VAULT_DATA_KEY=VAULT_DATA_KEY:latest,GOOGLE_DRIVE_OAUTH_CLIENT_ID=GOOGLE_DRIVE_OAUTH_CLIENT_ID:latest,GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=GOOGLE_DRIVE_OAUTH_CLIENT_SECRET:latest,EXTERNAL_CONNECTOR_CREDENTIAL_KEY=EXTERNAL_CONNECTOR_CREDENTIAL_KEY:latest,DRIVE_DOCUMENT_KEY_V1=DRIVE_DOCUMENT_KEY_V1:latest,DRIVE_SHARING_KEY_V1=DRIVE_SHARING_KEY_V1:latest,FIREBASE_ADMIN_CREDENTIALS_JSON=FIREBASE_ADMIN_CREDENTIALS_JSON:latest${payment_secret_bindings}" \
  --container=clamav \
  --image="${CLAMAV_IMAGE}" --cpu=2 --memory=4Gi \
  --startup-probe=tcpSocket.port=3310,periodSeconds=10,timeoutSeconds=5,failureThreshold=24 \
  --set-env-vars=CLAMD_STARTUP_TIMEOUT=180,FRESHCLAM_CHECKS=24

candidate_revision="$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(status.latestCreatedRevisionName)')"
if [[ ! "${candidate_revision}" =~ ^consent-protocol-drive-v1-worker-[a-z0-9-]+$ ]]; then
  echo "V1 worker candidate revision name is invalid" >&2
  exit 1
fi
gcloud run revisions describe "${candidate_revision}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format=json \
  | EXPECTED_SHA="${DEPLOY_SHA}" EXPECTED_APP_IMAGE="${IMAGE_REFERENCE}" \
    EXPECTED_SCANNER_INDEX_DIGEST="${CLAMAV_IMAGE#*@}" \
    EXPECTED_SCANNER_AMD64_DIGEST="${CLAMAV_AMD64_DIGEST}" \
    EXPECTED_DRAIN_ENABLED="${DRIVE_WORK_DRAIN_ENABLED}" \
    EXPECTED_SEMANTIC_MODEL_PROVIDER="${DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER_UAT}" \
      EXPECTED_MANAGED_TEXT_PROVIDER="${MANAGED_TEXT_PROVIDER}" \
    python3 deploy/drive/verify_v1_worker_revision.py

if [[ "${snapshot_captured}" != true ]]; then
  python3 deploy/drive/v1_scheduler_state.py capture --snapshot "${SNAPSHOT_PATH}"
  snapshot_captured=true
fi
python3 deploy/drive/v1_scheduler_state.py capture --stage groups --snapshot "${groups_snapshot}"
if [[ "${DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED}" != true ]]; then
  python3 deploy/drive/v1_scheduler_state.py quarantine --stage groups
fi
if [[ "${DRIVE_WORK_DRAIN_ENABLED}" == true ]]; then
  gcloud run services add-iam-policy-binding "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_ID}" --role=roles/run.invoker --quiet >/dev/null
fi
gcloud run services update-traffic "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --to-revisions="${candidate_revision}=100" --quiet >/dev/null
if [[ "${DRIVE_WORK_DRAIN_ENABLED}" == false ]]; then
  python3 deploy/drive/v1_scheduler_state.py verify-paused --snapshot "${SNAPSHOT_PATH}"
  trap - EXIT INT TERM
  echo "Verified isolated V1 worker ${candidate_revision}, SHA ${DEPLOY_SHA}; background processing paused"
  exit 0
fi
python3 deploy/drive/v1_scheduler_state.py apply
scheduled_jobs=("${JOB}")
if [[ "${DRIVE_FOUR_GROUP_INDEX_UAT_ENABLED}" == true ]]; then
  python3 deploy/drive/v1_scheduler_state.py apply --stage groups
  python3 deploy/drive/v1_scheduler_state.py verify --stage groups
  scheduled_jobs+=(drive-work-groups-uat)
fi

for scheduled_job in "${scheduled_jobs[@]}"; do
triggered_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
gcloud scheduler jobs run "${scheduled_job}" --project="${PROJECT_ID}" --location="${REGION}" --quiet
worker_url="$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
verified=false
for _attempt in $(seq 1 55); do
  if gcloud logging read \
    "resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"${scheduled_job}\" AND timestamp>=\"${triggered_at}\"" \
    --project="${PROJECT_ID}" --freshness=10m --limit=20 --format=json \
    | EXPECTED_URL="${worker_url}/api/internal/drive-work/drain" \
      EXPECTED_JOB="projects/${PROJECT_ID}/locations/${REGION}/jobs/${scheduled_job}" \
      python3 -c 'import json,os,sys; rows=json.load(sys.stdin); url=os.environ["EXPECTED_URL"]; job=os.environ["EXPECTED_JOB"]; sys.exit(0 if any((p:=row.get("jsonPayload") or {}).get("@type")=="type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished" and p.get("jobName")==job and p.get("url")==url and "URL_CRAWLED. Original HTTP response code number = 200" in str(p.get("debugInfo") or "") for row in rows if isinstance(row,dict)) else 1)'; then
    verified=true
    break
  fi
  sleep 5
done
if [[ "${verified}" != true ]]; then
  echo "V1 Scheduler did not produce a fresh 200 response" >&2
  exit 1
fi
done
python3 deploy/drive/v1_scheduler_state.py verify
trap - EXIT INT TERM
echo "Verified isolated V1 worker ${candidate_revision}, SHA ${DEPLOY_SHA}; ${JOB} returned 200"
