#!/usr/bin/env bash
set -euo pipefail

# UAT-only post-gate deployment of the private Drive work service. The scanner
# runs as a pinned ClamAV sidecar on localhost; ordinary API instances never
# start it. Candidate startup itself executes offline E5 and EICAR checks.
readonly PROJECT_ID="hushh-pda-uat"
readonly REGION="us-central1"
readonly SERVICE="consent-protocol-drive-worker"
readonly SCHEDULER_STATE_HELPER="deploy/drive/work_drain_scheduler_snapshot.py"
readonly SCHEDULER_AUDIENCE="https://api.uat.hushh.ai"
readonly SCHEDULER_ID="drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
readonly CLAMAV_IMAGE="clamav/clamav@sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817"
# The pinned OCI index above contains this Linux/AMD64 child manifest. Cloud
# Run's registry mirror records the child digest in the deployed revision.
readonly CLAMAV_AMD64_DIGEST="sha256:e8388295191bff0893fb889d9415ae975491201c989b205e30c9057b1985d36a"

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
# Cloud Run limits service name + '-' + traffic tag to 46 characters. Base36
# preserves the full numeric GitHub run ID without a collision-prone truncation.
traffic_tag="$(python3 - "${SERVICE}" "${RELEASE_RUN_ID}" <<'PY'
import sys

service, raw_run_id = sys.argv[1:]
run_id = int(raw_run_id)
if not 0 < run_id <= 2**64 - 1:
    raise SystemExit("Drive worker release run ID is outside the supported 64-bit range")
alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
encoded = ""
while run_id:
    run_id, digit = divmod(run_id, 36)
    encoded = alphabet[digit] + encoded
tag = f"d-{encoded}"
if len(service) + 1 + len(tag) > 46:
    raise SystemExit("Drive worker traffic tag exceeds the Cloud Run 46-character limit")
print(tag)
PY
)"
traffic_flags=(--tag="${traffic_tag}")
if [[ "${service_exists}" == true ]]; then
  serving_state="$(gcloud run services describe "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format=json \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); traffic=(data.get("status") or {}).get("traffic") or []; positive=[item for item in traffic if item.get("percent",0)>0]; print("empty" if not positive else "serving:"+str(positive[0].get("revisionName")) if len(positive)==1 and positive[0].get("percent")==100 and positive[0].get("revisionName") else "ambiguous")')"
  case "${serving_state}" in
    serving:*)
      previous_revision="${serving_state#serving:}"
      traffic_flags=(--no-traffic "${traffic_flags[@]}")
      ;;
    empty)
      # A failed first creation leaves an IAM-private service but no serving
      # revision. The next verified candidate is still a first real release.
      ;;
    *)
      echo "Existing Drive worker has no unambiguous serving revision; refusing release" >&2
      exit 1
      ;;
  esac
fi
prior_worker_url=""
if [[ "${service_exists}" == true ]]; then
  prior_worker_url="$(gcloud run services describe "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --format='value(status.url)')"
fi
scheduler_snapshot="$(mktemp)"
capture_args=(capture --snapshot "${scheduler_snapshot}")
if [[ -n "${prior_worker_url}" ]]; then
  capture_args+=(--worker-origin "${prior_worker_url}")
fi
if ! python3 "${SCHEDULER_STATE_HELPER}" "${capture_args[@]}"; then
  rm -f "${scheduler_snapshot}"
  echo "Drive scheduler pre-release state is unavailable; refusing worker release" >&2
  exit 1
fi
promoted=false
retargeted=false
worker_url=""
rollback() {
  local status="$?"
  local restore_failed=0
  local actual_revision
  trap - EXIT
  # A second cancellation must not interrupt scheduler/traffic restoration.
  trap '' INT TERM
  if [[ "${retargeted}" == true ]]; then
    if ! python3 "${SCHEDULER_STATE_HELPER}" restore \
      --snapshot "${scheduler_snapshot}" --worker-origin "${worker_url}" >&2; then
      restore_failed=1
      echo "Drive scheduler restoration could not be verified" >&2
      # A failed restore can leave one or more jobs pointed at a new worker.
      # Disable those fixed jobs and revoke only this worker invoker grant.
      python3 "${SCHEDULER_STATE_HELPER}" quarantine >&2 || restore_failed=1
      gcloud run services remove-iam-policy-binding "${SERVICE}" \
        --project="${PROJECT_ID}" --region="${REGION}" \
        --member="serviceAccount:${SCHEDULER_ID}" \
        --role=roles/run.invoker --quiet >/dev/null 2>&1 || restore_failed=1
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
  rm -f "${scheduler_snapshot}"
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
  --concurrency=1 --timeout=240 --max-instances=2 --min-instances=0 \
  --max=2 --min=0 "${traffic_flags[@]}" \
  --labels="managed-by=hushh-github-actions,deploy-env=uat,deploy-sha=${DEPLOY_SHA},github-run-id=${RELEASE_RUN_ID}" \
  --container=drive-worker \
  --image="${IMAGE_REFERENCE}" --port=8080 --cpu=2 --memory=4Gi \
  --command=gunicorn \
  --args=server_drive_worker:app,-w,1,-k,uvicorn.workers.UvicornWorker,--timeout,220,--worker-tmp-dir,/tmp,-b,0.0.0.0:8080 \
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
      EXPECTED_SCANNER_INDEX_DIGEST="${CLAMAV_IMAGE#*@}" \
      EXPECTED_SCANNER_AMD64_DIGEST="${CLAMAV_AMD64_DIGEST}" \
      python3 deploy/drive/verify_worker_revision.py

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
for fixed_job in drive-work-drain-uat drive-work-suggestions-uat drive-work-sharing-uat; do
  case "${fixed_job}" in
    drive-work-drain-uat) fixed_stage=documents; fixed_cron='*/4 * * * *' ;;
    drive-work-suggestions-uat) fixed_stage=suggestions; fixed_cron='2-59/4 * * * *' ;;
    drive-work-sharing-uat) fixed_stage=sharing; fixed_cron='* * * * *' ;;
  esac
  JOB_NAME="${fixed_job}" STAGE="${fixed_stage}" CRON="${fixed_cron}" \
    BACKEND_URL="${worker_url}" OIDC_AUDIENCE="${SCHEDULER_AUDIENCE}" \
    bash deploy/drive/setup_work_drain_scheduler.sh
done

for fixed_job in drive-work-drain-uat drive-work-suggestions-uat drive-work-sharing-uat; do
  triggered_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  gcloud scheduler jobs run "${fixed_job}" \
    --project="${PROJECT_ID}" --location="${REGION}" --quiet
  verified=false
  # Scheduler and Cloud Run each allow a 240-second attempt; wait through the
  # full bounded execution plus log-delivery margin before declaring failure.
  for _attempt in $(seq 1 55); do
    if gcloud logging read \
      "resource.type=cloud_scheduler_job AND resource.labels.job_id=${fixed_job} AND timestamp>=${triggered_at}" \
      --project="${PROJECT_ID}" --freshness=10m --limit=20 --format=json \
      | EXPECTED_URL="${worker_url}/api/internal/drive-work/drain" \
          EXPECTED_JOB="projects/${PROJECT_ID}/locations/${REGION}/jobs/${fixed_job}" \
          python3 -c 'import json,os,sys; rows=json.load(sys.stdin); expected_url=os.environ["EXPECTED_URL"]; expected_job=os.environ["EXPECTED_JOB"]; sys.exit(0 if any((payload:=row.get("jsonPayload") or {}).get("@type")=="type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished" and payload.get("jobName")==expected_job and payload.get("url")==expected_url and "URL_CRAWLED. Original HTTP response code number = 200" in str(payload.get("debugInfo") or "") for row in rows if isinstance(row,dict)) else 1)'
    then
      verified=true
      break
    fi
    sleep 5
  done
  if [[ "${verified}" != true ]]; then
    echo "Drive scheduler ${fixed_job} produced no fresh 200 completion" >&2
    false
  fi
done
trap - EXIT INT TERM
rm -f "${scheduler_snapshot}"
echo "Verified private Drive worker ${candidate_revision} at ${worker_url}, SHA ${DEPLOY_SHA}; all three schedulers returned 200"
