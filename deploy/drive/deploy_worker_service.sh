#!/usr/bin/env bash
set -euo pipefail

# UAT-only post-gate deployment of the private Drive work service. The scanner
# runs as a pinned ClamAV sidecar on localhost; ordinary API instances never
# start it. Candidate startup itself executes offline E5 and EICAR checks.
readonly PROJECT_ID="hushh-pda-uat"
readonly REGION="us-central1"
readonly SERVICE="consent-protocol-drive-worker"
readonly SCHEDULER_JOB="drive-work-drain-uat"
readonly SCHEDULER_AUDIENCE="https://api.uat.hushh.ai"
readonly SCHEDULER_ID="drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
readonly CLAMAV_IMAGE="clamav/clamav@sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817"

IMAGE_REFERENCE="${IMAGE_REFERENCE:?immutable backend image required}"
DEPLOY_SHA="${DEPLOY_SHA:?release SHA required}"
RUNTIME_SERVICE_ACCOUNT="${RUNTIME_SERVICE_ACCOUNT:?runtime identity required}"
CLOUDSQL_INSTANCE="${CLOUDSQL_INSTANCE:?Cloud SQL instance required}"
RELEASE_RUN_ID="${RELEASE_RUN_ID:?release run id required}"

if [[ ! "${IMAGE_REFERENCE}" =~ ^gcr\.io/hushh-pda-uat/consent-protocol@sha256:[0-9a-f]{64}$ \
  || ! "${DEPLOY_SHA}" =~ ^[0-9a-f]{40}$ \
  || ! "${RELEASE_RUN_ID}" =~ ^[0-9]+$ \
  || "${RUNTIME_SERVICE_ACCOUNT}" != "consent-protocol-runtime@${PROJECT_ID}.iam.gserviceaccount.com" \
  || "${CLOUDSQL_INSTANCE}" != "${PROJECT_ID}:${REGION}:hushh-uat-pg" ]]; then
  echo "Drive worker release inputs do not match the reviewed UAT boundary" >&2
  exit 1
fi

# An existing service needs a known rollback revision before deploying an
# unserved candidate. Cloud Run does not accept --no-traffic on first creation;
# that first revision is private and the scheduler still points at the API.
service_exists="$(gcloud run services list \
  --project="${PROJECT_ID}" --region="${REGION}" --format=json \
  | SERVICE_NAME="${SERVICE}" python3 -c 'import json,os,sys; rows=json.load(sys.stdin); assert isinstance(rows,list); print("true" if any((row.get("metadata") or {}).get("name")==os.environ["SERVICE_NAME"] for row in rows) else "false")')"
previous_revision=""
traffic_flags=(--tag="drive-candidate-${RELEASE_RUN_ID}")
if [[ "${service_exists}" == true ]]; then
  previous_revision="$(gcloud run services describe "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format=json \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); traffic=(data.get("status") or {}).get("traffic") or []; serving=[item.get("revisionName") for item in traffic if item.get("percent")==100]; print(serving[0] if len(serving)==1 else "")')"
  if [[ -z "${previous_revision}" ]]; then
    echo "Existing Drive worker has no unambiguous serving revision; refusing release" >&2
    exit 1
  fi
  traffic_flags=(--no-traffic "${traffic_flags[@]}")
fi
previous_scheduler_uri="$(gcloud scheduler jobs describe "${SCHEDULER_JOB}" \
  --project="${PROJECT_ID}" --location="${REGION}" \
  --format='value(httpTarget.uri)' 2>/dev/null || true)"
previous_scheduler_audience="$(gcloud scheduler jobs describe "${SCHEDULER_JOB}" \
  --project="${PROJECT_ID}" --location="${REGION}" \
  --format='value(httpTarget.oidcToken.audience)' 2>/dev/null || true)"
if [[ "${previous_scheduler_uri}" != https://*/api/internal/drive-work/drain \
  || "${previous_scheduler_audience}" != https://* ]]; then
  echo "Existing Drive scheduler target is missing or malformed" >&2
  exit 1
fi
promoted=false
retargeted=false
rollback() {
  local status="$?"
  local restore_failed=0
  local actual_uri actual_audience actual_revision
  trap - EXIT
  # A second cancellation must not interrupt scheduler/traffic restoration.
  trap '' INT TERM
  if [[ "${retargeted}" == true ]]; then
    BACKEND_URL="${previous_scheduler_uri%/api/internal/drive-work/drain}" \
      OIDC_AUDIENCE="${previous_scheduler_audience}" \
      bash deploy/drive/setup_work_drain_scheduler.sh >&2 || restore_failed=1
    actual_uri="$(gcloud scheduler jobs describe "${SCHEDULER_JOB}" \
      --project="${PROJECT_ID}" --location="${REGION}" \
      --format='value(httpTarget.uri)' 2>/dev/null)" || restore_failed=1
    actual_audience="$(gcloud scheduler jobs describe "${SCHEDULER_JOB}" \
      --project="${PROJECT_ID}" --location="${REGION}" \
      --format='value(httpTarget.oidcToken.audience)' 2>/dev/null)" || restore_failed=1
    if [[ "${actual_uri}" != "${previous_scheduler_uri}" \
      || "${actual_audience}" != "${previous_scheduler_audience}" ]]; then
      echo "Drive scheduler restoration could not be verified" >&2
      restore_failed=1
    fi
  fi
  if [[ "${promoted}" == true && -n "${previous_revision}" ]]; then
    gcloud run services update-traffic "${SERVICE}" \
      --project="${PROJECT_ID}" --region="${REGION}" \
      --to-revisions="${previous_revision}=100" >&2 || restore_failed=1
    actual_revision="$(gcloud run services describe "${SERVICE}" \
      --project="${PROJECT_ID}" --region="${REGION}" --format=json 2>/dev/null \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); t=(d.get("status") or {}).get("traffic") or []; r=[x.get("revisionName") for x in t if x.get("percent")==100]; print(r[0] if len(r)==1 else "")' 2>/dev/null)" || restore_failed=1
    if [[ "${actual_revision}" != "${previous_revision}" ]]; then
      echo "Drive worker traffic restoration could not be verified" >&2
      restore_failed=1
    fi
  elif [[ "${promoted}" == true ]]; then
    # A first-ever service has no prior serving revision to restore. It remains
    # IAM-private and unreachable by the scheduler after target restoration.
    echo "First Drive worker release has no previous revision; leave the idle private candidate for investigation" >&2
  fi
  if [[ "${restore_failed}" != 0 ]]; then
    echo "CRITICAL: Drive worker rollback is incomplete; investigate scheduler and traffic before enabling connectors" >&2
  fi
  echo "Drive worker candidate failed; connector execution must remain disabled" >&2
  exit "${status}"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
  --args=server_drive_worker:app,-w,1,-k,uvicorn.workers.UvicornWorker,--timeout,220,-b,0.0.0.0:8080 \
  --depends-on=clamav \
  --startup-probe=httpGet.port=8080,httpGet.path=/ready,periodSeconds=10,timeoutSeconds=5,failureThreshold=24 \
  --set-env-vars="ENVIRONMENT=uat,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},DRIVE_WORKER_MODE=true,DRIVE_WORK_DRAIN_ENABLED=true,DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID=${PROJECT_ID},DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL=${SCHEDULER_ID},DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE=${SCHEDULER_AUDIENCE},DB_POOL_MIN_SIZE=0,DB_POOL_MAX_SIZE=2,DB_SQLALCHEMY_POOL_SIZE=1,DB_SQLALCHEMY_MAX_OVERFLOW=0" \
  --set-secrets="BACKEND_RUNTIME_CONFIG_JSON=BACKEND_RUNTIME_CONFIG_JSON:latest,DB_USER=DB_USER:latest,DB_PASSWORD=DB_PASSWORD:latest,APP_SIGNING_KEY=APP_SIGNING_KEY:latest,VAULT_DATA_KEY=VAULT_DATA_KEY:latest,GOOGLE_DRIVE_OAUTH_CLIENT_ID=GOOGLE_DRIVE_OAUTH_CLIENT_ID:latest,GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=GOOGLE_DRIVE_OAUTH_CLIENT_SECRET:latest,EXTERNAL_CONNECTOR_CREDENTIAL_KEY=EXTERNAL_CONNECTOR_CREDENTIAL_KEY:latest,DRIVE_DOCUMENT_KEY_V1=DRIVE_DOCUMENT_KEY_V1:latest,DRIVE_SHARING_KEY_V1=DRIVE_SHARING_KEY_V1:latest,FIREBASE_ADMIN_CREDENTIALS_JSON=FIREBASE_ADMIN_CREDENTIALS_JSON:latest" \
  --container=clamav \
  --image="${CLAMAV_IMAGE}" --cpu=2 --memory=4Gi \
  --startup-probe=tcpSocket.port=3310,periodSeconds=10,timeoutSeconds=5,failureThreshold=24 \
  --set-env-vars=CLAMD_STARTUP_TIMEOUT=180,FRESHCLAM_CHECKS=24

candidate_revision="$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(status.latestCreatedRevisionName)')"
if [[ ! "${candidate_revision}" =~ ^consent-protocol-drive-worker-[a-z0-9-]+$ ]]; then
  echo "Drive worker candidate revision is invalid" >&2
  exit 1
fi
gcloud run revisions describe "${candidate_revision}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format=json \
  | EXPECTED_SHA="${DEPLOY_SHA}" EXPECTED_APP_IMAGE="${IMAGE_REFERENCE}" \
      EXPECTED_SCANNER_IMAGE="${CLAMAV_IMAGE}" python3 -c '
import json, os, sys
revision=json.load(sys.stdin)
labels=(revision.get("metadata") or {}).get("labels") or {}
containers=(revision.get("spec") or {}).get("containers") or []
images={item.get("name"): item.get("image") for item in containers}
conditions=(revision.get("status") or {}).get("conditions") or []
ready=any(item.get("type")=="Ready" and item.get("status")=="True" for item in conditions)
if (not ready or labels.get("deploy-sha")!=os.environ["EXPECTED_SHA"]
    or images.get("drive-worker")!=os.environ["EXPECTED_APP_IMAGE"]
    or not str(images.get("clamav") or "").endswith(os.environ["EXPECTED_SCANNER_IMAGE"].split("@",1)[1])):
    raise SystemExit("Drive worker candidate readiness or image provenance failed")
print("Verified Drive worker candidate readiness, SHA and image digests")'

# The private service admits only this scheduler identity. The route repeats
# the exact issuer/email/audience check after Cloud Run IAM verification.
gcloud run services add-iam-policy-binding "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_ID}" --role=roles/run.invoker --quiet >/dev/null
promoted=true
gcloud run services update-traffic "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --to-revisions="${candidate_revision}=100" --quiet

worker_url="$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" \
  --format='value(status.url)')"
if [[ "${worker_url}" != https://*.run.app ]]; then
  echo "Drive worker origin is invalid" >&2
  false
fi
retargeted=true
BACKEND_URL="${worker_url}" OIDC_AUDIENCE="${SCHEDULER_AUDIENCE}" \
  bash deploy/drive/setup_work_drain_scheduler.sh

triggered_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
gcloud scheduler jobs run "${SCHEDULER_JOB}" \
  --project="${PROJECT_ID}" --location="${REGION}" --quiet
verified=false
for _attempt in $(seq 1 12); do
  if gcloud logging read \
    "resource.type=cloud_scheduler_job AND resource.labels.job_id=${SCHEDULER_JOB} AND timestamp>=${triggered_at}" \
    --project="${PROJECT_ID}" --freshness=10m --limit=20 --format=json \
    | python3 -c 'import json,sys; rows=json.load(sys.stdin); sys.exit(0 if any("URL_CRAWLED. Original HTTP response code number = 200" in json.dumps(row) for row in rows) else 1)'
  then
    verified=true
    break
  fi
  sleep 5
done
if [[ "${verified}" != true ]]; then
  echo "Drive scheduler produced no fresh 200 completion" >&2
  false
fi
trap - EXIT INT TERM
echo "Verified private Drive worker ${candidate_revision} at ${worker_url}, SHA ${DEPLOY_SHA}; scheduler returned 200"
