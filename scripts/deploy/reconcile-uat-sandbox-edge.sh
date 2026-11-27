#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
# Reconcile the UAT Confidential Sandbox Edge Gateway Cloud Run service under
# governed UAT WIF right before backend Cloud Build runs, so backend-deploy.sh
# discovers the live Edge Gateway and activates UAT ACE Sandbox + BYOC parity.
# Production and non-UAT projects stay untouched by construction.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
REGION="${GCP_REGION:-us-central1}"
BACKEND_SERVICE="${BACKEND_SERVICE:-consent-protocol}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-hushh-webapp}"
EDGE_SERVICE="${SANDBOX_EDGE_SERVICE:-sandbox-edge-gateway}"
CLUSTER_NAME="${HUSSH_GKE_CLUSTER:-hussh-one-sandbox-uat}"
EDGE_SA="${HUSSH_SANDBOX_EDGE_SA:-hussh-sandbox-edge-uat@hushh-pda-uat.iam.gserviceaccount.com}"
POD_REPO="${HUSSH_UAT_POD_REPO:-us-central1-docker.pkg.dev/hushh-pda-uat/one-pod-release/consent-protocol-pod}"

if [[ "${PROJECT_ID}" != "hushh-pda-uat" ]]; then
  echo "UAT Sandbox Edge reconcile: skipping non-UAT project (${PROJECT_ID:-unset})." >&2
  exit 0
fi

for secret_name in sandbox-edge-admin-token sandbox-edge-identity-master-key sentinel-control-token; do
  if ! gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "UAT Sandbox Edge reconcile: secret ${secret_name} absent; skipping." >&2
    exit 0
  fi
done

if ! gcloud iam service-accounts describe "${EDGE_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "UAT Sandbox Edge reconcile: service account ${EDGE_SA} absent; skipping." >&2
  exit 0
fi

ENDPOINT="$(gcloud container clusters describe "${CLUSTER_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(endpoint)' 2>/dev/null || true)"
CA_B64="$(gcloud container clusters describe "${CLUSTER_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(masterAuth.clusterCaCertificate)' 2>/dev/null || true)"
if [[ -z "${ENDPOINT}" || -z "${CA_B64}" ]]; then
  echo "UAT Sandbox Edge reconcile: cluster ${CLUSTER_NAME} absent; skipping." >&2
  exit 0
fi

IMAGE_REF="${HUSSH_SANDBOX_EDGE_IMAGE:-}"
if [[ -z "${IMAGE_REF}" ]]; then
  LATEST_DIGEST="$(gcloud artifacts docker images list "${POD_REPO}" \
    --project="${PROJECT_ID}" --sort-by="~UPDATE_TIME" --limit=1 \
    --format='value(version)' 2>/dev/null || true)"
  if [[ -z "${LATEST_DIGEST}" ]]; then
    echo "UAT Sandbox Edge reconcile: no signed pod image digest found in ${POD_REPO}; skipping." >&2
    exit 0
  fi
  IMAGE_REF="${POD_REPO}@${LATEST_DIGEST}"
fi

if [[ "${IMAGE_REF}" != *@sha256:* ]]; then
  echo "UAT Sandbox Edge reconcile: refusing mutable image reference (${IMAGE_REF})." >&2
  exit 1
fi

HUB_URL="$(gcloud run services describe "${BACKEND_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)"
WEBAPP_URL="$(gcloud run services describe "${FRONTEND_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)"
EXISTING_EDGE_URL="$(gcloud run services describe "${EDGE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)"

SENTINEL_IP="$(gcloud compute forwarding-rules list --project="${PROJECT_ID}" --regions="${REGION}" \
  --filter='description~sentinel-control-ilb' --format='value(IPAddress)' 2>/dev/null | head -n 1 || true)"
SENTINEL_CONTROL_URL="${SENTINEL_CONTROL_URL:-http://${SENTINEL_IP:-10.128.0.3}:8081}"

CORS_ORIGINS="https://uat.one.hussh.si,https://uat.one.hushh.si,https://uat.one.hussh.ai,https://uat.one.hushh.ai,http://localhost:3000"
if [[ -n "${WEBAPP_URL}" ]]; then
  CORS_ORIGINS="https://uat.one.hussh.si,https://uat.one.hushh.si,https://uat.one.hussh.ai,https://uat.one.hushh.ai,${WEBAPP_URL},http://localhost:3000"
fi

ENV_FILE="$(mktemp /tmp/uat-sandbox-edge-env.XXXXXX.yaml)"
trap 'rm -f "${ENV_FILE}"' EXIT

cat > "${ENV_FILE}" <<EOF
CORS_ALLOWED_ORIGINS: "${CORS_ORIGINS}"
HUSHH_DEPLOY_ENV: "uat"
HUSHH_SCHEDULER_CALLER_EMAILS: "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
HUSSH_HUB_URL: "${HUB_URL}"
HUSSH_K8S_API_SERVER: "https://${ENDPOINT}"
HUSSH_K8S_CA_CERT_B64: "${CA_B64}"
HUSSH_SANDBOX_EDGE_PUBLIC_URL: "${EXISTING_EDGE_URL}"
HUSSH_SANDBOX_HEALTH_POLL_TIMEOUT_SECONDS: "25"
HUSSH_SANDBOX_IDLE_TIMEOUT_SECONDS: "600"
HUSSH_SANDBOX_NAMESPACE: "hussh-agents"
HUSSH_SANDBOX_POOL: "hussh-one-warm-pool"
HUSSH_SANDBOX_PREFIX_STORAGE_ENABLED: "true"
HUSSH_SENTINEL_VERTEX_LOCATION: "global"
HUSSH_SENTINEL_VERTEX_PROJECT: "${PROJECT_ID}"
SENTINEL_CONTROL_URL: "${SENTINEL_CONTROL_URL}"
SENTINEL_MODEL_GATEWAY_URL: "http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:8082"
EOF

EDGE_SECRETS="HUSSH_EDGE_ADMIN_TOKEN=sandbox-edge-admin-token:latest,HUSSH_SANDBOX_IDENTITY_MASTER_KEY=sandbox-edge-identity-master-key:latest,SENTINEL_CONTROL_TOKEN=sentinel-control-token:latest"
for pub_secret in CONSENT_ED25519_PUBLIC_KEYS OWNER_FEED_ED25519_PUBLIC_KEYS; do
  if gcloud secrets describe "${pub_secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    EDGE_SECRETS="${EDGE_SECRETS},${pub_secret}=${pub_secret}:latest"
  fi
done

echo "Reconciling ${EDGE_SERVICE} in ${PROJECT_ID} (${REGION}) with image ${IMAGE_REF}..."
gcloud run deploy "${EDGE_SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_REF}" \
  --command="/opt/venv/bin/uvicorn" \
  --args="hushh_mcp.services.agent_sandbox.edge_gateway_app:create_edge_gateway_from_env,--factory,--host,0.0.0.0,--port,8080" \
  --service-account="${EDGE_SA}" \
  --network="default" \
  --subnet="default" \
  --vpc-egress="private-ranges-only" \
  --min-instances=1 \
  --max-instances=1 \
  --cpu=1 \
  --memory=1Gi \
  --cpu-boost \
  --timeout=300 \
  --concurrency=80 \
  --port=8080 \
  --allow-unauthenticated \
  --env-vars-file="${ENV_FILE}" \
  --set-secrets="${EDGE_SECRETS}" \
  --quiet

DEPLOYED_EDGE_URL="$(gcloud run services describe "${EDGE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')"
if [[ -z "${DEPLOYED_EDGE_URL}" ]]; then
  echo "UAT Sandbox Edge reconcile: failed to resolve deployed service URL." >&2
  exit 1
fi
if [[ "${DEPLOYED_EDGE_URL}" != "${EXISTING_EDGE_URL}" ]]; then
  gcloud run services update "${EDGE_SERVICE}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --update-env-vars="HUSSH_SANDBOX_EDGE_PUBLIC_URL=${DEPLOYED_EDGE_URL}" \
    --quiet
fi

echo "Verifying ${DEPLOYED_EDGE_URL}/health..."
curl -fsS --max-time 20 "${DEPLOYED_EDGE_URL}/health" >/dev/null
echo "UAT Sandbox Edge Gateway live and healthy at ${DEPLOYED_EDGE_URL}."
