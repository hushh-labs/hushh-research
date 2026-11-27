#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
# Unified declarative reconciler for Dev, UAT, and Production Confidential Sandbox
# GKE Autopilot clusters (Sentinel HA, SandboxTemplate, non-evicting WarmPool)
# and Cloud Run sandbox-edge-gateway. Runs identically under GitHub Actions WIF
# and local ADC without printing or persisting secret payloads.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-${PROJECT_ID:-}}"
REGION="${GCP_REGION:-us-central1}"
BACKEND_SERVICE="${BACKEND_SERVICE:-consent-protocol}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-hushh-webapp}"
EDGE_SERVICE="${SANDBOX_EDGE_SERVICE:-sandbox-edge-gateway}"
SANDBOX_HUB_TAG="${SANDBOX_HUB_TAG:-}"

case "${PROJECT_ID}" in
  hushh-pda-dev)
    DEPLOY_ENV="dev"
    DEFAULT_CLUSTER="hussh-one-sandbox-dev"
    DEFAULT_EDGE_SA="hussh-sandbox-edge-dev@${PROJECT_ID}.iam.gserviceaccount.com"
    DEFAULT_WARM_REPLICAS="1"
    DEFAULT_CORS="https://dev.one.hussh.si,https://dev.one.hushh.si,https://dev.one.hussh.ai,https://dev.one.hushh.ai,http://localhost:3000"
    DEFAULT_PLAID_ENV="sandbox"
    ;;
  hushh-pda-uat)
    DEPLOY_ENV="uat"
    DEFAULT_CLUSTER="hussh-one-sandbox-uat"
    DEFAULT_EDGE_SA="hussh-sandbox-edge-uat@${PROJECT_ID}.iam.gserviceaccount.com"
    DEFAULT_WARM_REPLICAS="1"
    DEFAULT_CORS="https://uat.one.hussh.si,https://uat.one.hushh.si,https://uat.one.hussh.ai,https://uat.one.hushh.ai,http://localhost:3000"
    DEFAULT_PLAID_ENV="sandbox"
    ;;
  hushh-pda)
    DEPLOY_ENV="production"
    DEFAULT_CLUSTER="hussh-one-sandbox-prod"
    DEFAULT_EDGE_SA="hussh-sandbox-edge-prod@${PROJECT_ID}.iam.gserviceaccount.com"
    DEFAULT_WARM_REPLICAS="2"
    DEFAULT_CORS="https://one.hussh.si,https://stage.one.hussh.si,https://one.hushh.si,https://one.hussh.ai,https://stage.one.hussh.ai,https://one.hushh.ai"
    DEFAULT_PLAID_ENV="production"
    ;;
  *)
    echo "Sandbox cluster reconcile: skipping unsupported project (${PROJECT_ID:-unset})." >&2
    exit 0
    ;;
esac

CLUSTER_NAME="${HUSSH_GKE_CLUSTER:-${DEFAULT_CLUSTER}}"
EDGE_SA="${HUSSH_SANDBOX_EDGE_SA:-${DEFAULT_EDGE_SA}}"
POD_REPO="${HUSSH_POD_REPO:-us-central1-docker.pkg.dev/${PROJECT_ID}/one-pod-release/consent-protocol-pod}"
WARM_REPLICAS="${HUSSH_SANDBOX_WARM_REPLICAS:-${DEFAULT_WARM_REPLICAS}}"
SENTINEL_REPLICAS="${HUSSH_SENTINEL_REPLICAS:-2}"

for secret_name in sandbox-edge-admin-token sandbox-edge-identity-master-key sentinel-control-token; do
  if ! gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "Sandbox cluster reconcile (${DEPLOY_ENV}): secret ${secret_name} absent; skipping." >&2
    exit 0
  fi
done

if ! gcloud iam service-accounts describe "${EDGE_SA}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Sandbox cluster reconcile (${DEPLOY_ENV}): service account ${EDGE_SA} absent; skipping." >&2
  exit 0
fi

ENDPOINT="$(gcloud container clusters describe "${CLUSTER_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(endpoint)' 2>/dev/null || true)"
CA_B64="$(gcloud container clusters describe "${CLUSTER_NAME}" --region="${REGION}" --project="${PROJECT_ID}" --format='value(masterAuth.clusterCaCertificate)' 2>/dev/null || true)"
if [[ -z "${ENDPOINT}" || -z "${CA_B64}" ]]; then
  echo "Sandbox cluster reconcile (${DEPLOY_ENV}): cluster ${CLUSTER_NAME} absent; skipping." >&2
  exit 0
fi

IMAGE_REF="${HUSSH_SANDBOX_EDGE_IMAGE:-}"
if [[ -z "${IMAGE_REF}" ]]; then
  EXPECTED_TAG="${HUSSH_EXPECTED_POD_TAG:-}"
  if [[ -n "${EXPECTED_TAG}" ]]; then
    TAG_DIGEST="$(gcloud artifacts docker images describe "${POD_REPO}:${EXPECTED_TAG}" \
      --project="${PROJECT_ID}" --format='value(image_summary.digest)' 2>/dev/null || true)"
    if [[ "${TAG_DIGEST}" =~ ^sha256:[0-9a-fA-F]{64}$ ]]; then
      IMAGE_REF="${POD_REPO}@${TAG_DIGEST}"
    fi
  fi
fi
if [[ -z "${IMAGE_REF}" ]]; then
  LATEST_TAG_DIGEST="$(gcloud artifacts docker images describe "${POD_REPO}:latest" \
    --project="${PROJECT_ID}" --format='value(image_summary.digest)' 2>/dev/null || true)"
  if [[ "${LATEST_TAG_DIGEST}" =~ ^sha256:[0-9a-fA-F]{64}$ ]]; then
    IMAGE_REF="${POD_REPO}@${LATEST_TAG_DIGEST}"
  fi
fi
if [[ -z "${IMAGE_REF}" ]]; then
  LATEST_DIGEST="$(gcloud artifacts docker images list "${POD_REPO}" \
    --project="${PROJECT_ID}" --include-tags --sort-by="~UPDATE_TIME" --limit=15 \
    --format=json 2>/dev/null | python3 -c '
import json, sys
items = json.loads(sys.stdin.read() or "[]")
for it in items:
    tags = [str(t) for t in (it.get("tags") or [])]
    ver = str(it.get("version") or "").strip()
    if ver.startswith("sha256:") and tags and "buildcache" not in tags:
        print(ver)
        break
' || true)"
  if [[ -z "${LATEST_DIGEST}" ]]; then
    echo "Sandbox cluster reconcile (${DEPLOY_ENV}): no signed pod image digest found in ${POD_REPO}; skipping." >&2
    exit 0
  fi
  IMAGE_REF="${POD_REPO}@${LATEST_DIGEST}"
fi

if [[ "${IMAGE_REF}" != *@sha256:* ]]; then
  echo "Sandbox cluster reconcile (${DEPLOY_ENV}): refusing mutable image reference (${IMAGE_REF})." >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  gcloud components install kubectl --quiet >/dev/null 2>&1 || true
fi

WORK_DIR="$(mktemp -d /tmp/hussh-sandbox-reconcile.XXXXXX)"
chmod 700 "${WORK_DIR}"
trap 'rm -rf "${WORK_DIR}"' EXIT

CA_FILE="${WORK_DIR}/ca.crt"
TOKEN_FILE="${WORK_DIR}/token"
touch "${CA_FILE}" "${TOKEN_FILE}"
chmod 600 "${CA_FILE}" "${TOKEN_FILE}"
printf '%s' "${CA_B64}" | base64 -d > "${CA_FILE}"
if [[ -n "${CLOUDSDK_AUTH_ACCESS_TOKEN:-}" ]]; then
  printf '%s' "${CLOUDSDK_AUTH_ACCESS_TOKEN}" > "${TOKEN_FILE}"
elif gcloud auth print-access-token > "${TOKEN_FILE}" 2>/dev/null; then
  :
else
  gcloud auth application-default print-access-token > "${TOKEN_FILE}"
fi

kctl() {
  kubectl --server="https://${ENDPOINT}" --certificate-authority="${CA_FILE}" --token="$(< "${TOKEN_FILE}")" "$@"
}

verify_uat_sandbox_allocator() {
  local role_json="${WORK_DIR}/sandbox-edge-role.json"
  local binding_json="${WORK_DIR}/sandbox-edge-binding.json"
  kctl -n hussh-agents get role sandbox-edge-allocator -o json > "${role_json}"
  kctl -n hussh-agents get rolebinding sandbox-edge-allocator-binding -o json > "${binding_json}"
  python3 - "${role_json}" "${binding_json}" "${EDGE_SA}" <<'PY'
import json
import sys
from itertools import product
from pathlib import Path

role_path, binding_path, edge_account = sys.argv[1:]
role = json.loads(Path(role_path).read_bytes())
binding = json.loads(Path(binding_path).read_bytes())
api_group = "rbac.authorization.k8s.io"
role_ref = {"apiGroup": api_group, "kind": "Role", "name": "sandbox-edge-allocator"}
edge_subject = {"apiGroup": api_group, "kind": "User", "name": edge_account}
if (
    role.get("metadata", {}).get("namespace") != "hussh-agents"
    or binding.get("metadata", {}).get("namespace") != "hussh-agents"
    or binding.get("roleRef") != role_ref
    or edge_subject not in binding.get("subjects", [])
):
    raise SystemExit("UAT Sandbox allocator binding must reference its existing Role and Edge identity.")

# The Edge allocator creates, reads, extends, and deletes claims, scales the
# warm pool, and reads a pod for IP or termination status.
extensions = "extensions.agents.x-k8s.io"
required = {
    *((extensions, "sandboxclaims", verb) for verb in ("create", "get", "patch", "delete")),
    *((extensions, "sandboxwarmpools", verb) for verb in ("get", "patch")),
    ("", "pods", "get"),
}
allowed = {
    operation
    for rule in role.get("rules", [])
    if not rule.get("resourceNames") and not rule.get("nonResourceURLs")
    for operation in product(rule.get("apiGroups", []), rule.get("resources", []), rule.get("verbs", []))
}
if not required <= allowed:
    raise SystemExit("UAT Sandbox allocator Role is missing required namespaced permissions.")
PY
}

if [[ "${DEPLOY_ENV}" == "uat" ]]; then
  # The cluster owner provisions allocator authorization. Routine UAT deploys
  # verify it without replacing permissions or removing other subjects.
  verify_uat_sandbox_allocator
fi

HUB_BASE_URL="$(gcloud run services describe "${BACKEND_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)"
WEBAPP_URL="$(gcloud run services describe "${FRONTEND_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)"
EXISTING_EDGE_URL="$(gcloud run services describe "${EDGE_SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)"

HUB_URL="${HUB_BASE_URL}"
if [[ -n "${SANDBOX_HUB_TAG}" && -n "${HUB_BASE_URL}" ]]; then
  HUB_URL="https://${SANDBOX_HUB_TAG}---${HUB_BASE_URL#https://}"
fi

HUB_HOST="${HUB_BASE_URL#https://}"
STAGE_HUB_HOST="${HUB_HOST:+stage---${HUB_HOST}}"
ALLOW_HOSTS="dev.api.hussh.si,uat.api.hussh.si,stage.api.hussh.si,api.hussh.si,dev.api.hussh.ai,uat.api.hussh.ai,stage.api.hussh.ai,api.hussh.ai,www.googleapis.com,oauth2.googleapis.com,sandbox.plaid.com,production.plaid.com"
if [[ -n "${HUB_HOST}" ]]; then
  ALLOW_HOSTS="${ALLOW_HOSTS},${HUB_HOST},${STAGE_HUB_HOST}"
fi

read_secret_optional() {
  local sec_name="$1"
  local dest_file="$2"
  if gcloud secrets describe "${sec_name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud secrets versions access latest --secret="${sec_name}" --project="${PROJECT_ID}" > "${dest_file}" 2>/dev/null || true
  fi
}

echo "Reconciling GKE namespaces and Sentinel secrets on ${CLUSTER_NAME} (${PROJECT_ID})..."
for ns in hussh-agents hussh-hub-router hussh-sandbox-system; do
  kctl create namespace "${ns}" --dry-run=client -o yaml | kctl apply -f - >/dev/null
  kctl label namespace "${ns}" "kubernetes.io/metadata.name=${ns}" --overwrite >/dev/null 2>&1 || true
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
if [[ -f "${REPO_ROOT}/deploy/agent-sandbox/sandbox-network-policy.yaml" ]]; then
  kctl apply -f "${REPO_ROOT}/deploy/agent-sandbox/sandbox-network-policy.yaml" >/dev/null
fi

EXISTING_AUDIT_HMAC="$(kctl -n hussh-sandbox-system get secret sentinel-proxy-secrets -o jsonpath='{.data.audit-hmac-key}' 2>/dev/null || true)"
AUDIT_HMAC_FILE="${WORK_DIR}/audit-hmac"
CONTROL_TOKEN_FILE="${WORK_DIR}/control-token"
chmod 600 "${AUDIT_HMAC_FILE}" "${CONTROL_TOKEN_FILE}" 2>/dev/null || true
if [[ -n "${EXISTING_AUDIT_HMAC}" ]]; then
  printf '%s' "${EXISTING_AUDIT_HMAC}" | base64 -d > "${AUDIT_HMAC_FILE}"
else
  python3 -c 'import secrets; print(secrets.token_hex(32), end="")' > "${AUDIT_HMAC_FILE}"
fi
gcloud secrets versions access latest --secret="sentinel-control-token" --project="${PROJECT_ID}" > "${CONTROL_TOKEN_FILE}"

WEB_CID_FILE="${WORK_DIR}/web-cid"
WEB_SEC_FILE="${WORK_DIR}/web-sec"
WEB_CID_SOURCE=""
read_secret_optional "GOOGLE_WEB_OAUTH_CLIENT_ID" "${WEB_CID_FILE}"
if [[ -s "${WEB_CID_FILE}" ]]; then
  WEB_CID_SOURCE="web"
  read_secret_optional "GOOGLE_WEB_OAUTH_CLIENT_SECRET" "${WEB_SEC_FILE}"
  if [[ ! -s "${WEB_SEC_FILE}" ]]; then
    read_secret_optional "GOOGLE_OAUTH_CLIENT_SECRET" "${WEB_SEC_FILE}"
  fi
fi
if [[ ! -s "${WEB_CID_FILE}" ]]; then
  read_secret_optional "GOOGLE_OAUTH_CLIENT_ID" "${WEB_CID_FILE}"
  if [[ -s "${WEB_CID_FILE}" ]]; then
    WEB_CID_SOURCE="oauth"
    read_secret_optional "GOOGLE_OAUTH_CLIENT_SECRET" "${WEB_SEC_FILE}"
  fi
fi
if [[ ! -s "${WEB_CID_FILE}" ]]; then
  read_secret_optional "GOOGLE_UAT_MAIL_WEB_CLIENT_ID" "${WEB_CID_FILE}"
  if [[ -s "${WEB_CID_FILE}" ]]; then
    WEB_CID_SOURCE="uat_mail"
  fi
fi
if [[ "${DEPLOY_ENV}" == "uat" && "${WEB_CID_SOURCE}" == "uat_mail" ]]; then
  UAT_MAIL_SEC_B64="$(kctl -n hussh-agents get secret uat-private-mail-oauth -o jsonpath='{.data.client-secret}' 2>/dev/null || true)"
  if [[ -n "${UAT_MAIL_SEC_B64}" ]]; then
    printf '%s' "${UAT_MAIL_SEC_B64}" | base64 -d > "${WEB_SEC_FILE}"
  fi
fi

PLAID_CID_FILE="${WORK_DIR}/plaid-cid"
PLAID_SEC_FILE="${WORK_DIR}/plaid-sec"
PLAID_SANDBOX_SEC_FILE="${WORK_DIR}/plaid-sandbox-sec"
PLAID_PROD_SEC_FILE="${WORK_DIR}/plaid-prod-sec"
read_secret_optional "PLAID_CLIENT_ID" "${PLAID_CID_FILE}"
read_secret_optional "PLAID_SECRET" "${PLAID_SEC_FILE}"
read_secret_optional "PLAID_SANDBOX_SECRET" "${PLAID_SANDBOX_SEC_FILE}"
read_secret_optional "PLAID_PRODUCTION_SECRET" "${PLAID_PROD_SEC_FILE}"

SECRET_ARGS=(
  "--from-file=audit-hmac-key=${AUDIT_HMAC_FILE}"
  "--from-file=control-token=${CONTROL_TOKEN_FILE}"
)
SENTINEL_EXTRA_ENV=""
if [[ -s "${WEB_CID_FILE}" && -s "${WEB_SEC_FILE}" ]]; then
  SECRET_ARGS+=("--from-file=google-web-oauth-client-id=${WEB_CID_FILE}" "--from-file=google-web-oauth-client-secret=${WEB_SEC_FILE}")
  SENTINEL_EXTRA_ENV="${SENTINEL_EXTRA_ENV}
            - name: GOOGLE_WEB_OAUTH_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: google-web-oauth-client-id
            - name: GOOGLE_WEB_OAUTH_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: google-web-oauth-client-secret"
fi
if [[ -s "${PLAID_CID_FILE}" && ( -s "${PLAID_SEC_FILE}" || -s "${PLAID_SANDBOX_SEC_FILE}" || -s "${PLAID_PROD_SEC_FILE}" ) ]]; then
  SECRET_ARGS+=("--from-file=plaid-client-id=${PLAID_CID_FILE}")
  SENTINEL_EXTRA_ENV="${SENTINEL_EXTRA_ENV}
            - name: PLAID_ENV
              value: \"${DEFAULT_PLAID_ENV}\"
            - name: PLAID_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: plaid-client-id"
  if [[ -s "${PLAID_SEC_FILE}" ]]; then
    SECRET_ARGS+=("--from-file=plaid-secret=${PLAID_SEC_FILE}")
    SENTINEL_EXTRA_ENV="${SENTINEL_EXTRA_ENV}
            - name: PLAID_SECRET
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: plaid-secret"
  fi
  if [[ -s "${PLAID_SANDBOX_SEC_FILE}" ]]; then
    SECRET_ARGS+=("--from-file=plaid-sandbox-secret=${PLAID_SANDBOX_SEC_FILE}")
    SENTINEL_EXTRA_ENV="${SENTINEL_EXTRA_ENV}
            - name: PLAID_SANDBOX_SECRET
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: plaid-sandbox-secret"
  fi
  if [[ -s "${PLAID_PROD_SEC_FILE}" ]]; then
    SECRET_ARGS+=("--from-file=plaid-production-secret=${PLAID_PROD_SEC_FILE}")
    SENTINEL_EXTRA_ENV="${SENTINEL_EXTRA_ENV}
            - name: PLAID_PRODUCTION_SECRET
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: plaid-production-secret"
  fi
fi

kctl -n hussh-sandbox-system create secret generic sentinel-proxy-secrets \
  "${SECRET_ARGS[@]}" --dry-run=client -o yaml | kctl apply -f - >/dev/null

if [[ -s "${WEB_CID_FILE}" ]]; then
  kctl -n hussh-agents create secret generic sandbox-public-oauth-config \
    "--from-file=google-web-oauth-client-id=${WEB_CID_FILE}" \
    --dry-run=client -o yaml | kctl apply -f - >/dev/null
fi

SENTINEL_VERTEX_GSA="hussh-sentinel-vertex@${PROJECT_ID}.iam.gserviceaccount.com"
SENTINEL_MANIFEST="${WORK_DIR}/sentinel.yaml"
cat > "${SENTINEL_MANIFEST}" <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sentinel-vertex-sa
  namespace: hussh-sandbox-system
  annotations:
    iam.gke.io/gcp-service-account: "${SENTINEL_VERTEX_GSA}"
  labels:
    app: sentinel-egress-proxy
    app.kubernetes.io/part-of: hussh-one
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sentinel-egress-proxy
  namespace: hussh-sandbox-system
  labels:
    app: sentinel-egress-proxy
    app.kubernetes.io/part-of: hussh-one
spec:
  replicas: ${SENTINEL_REPLICAS}
  selector:
    matchLabels:
      app: sentinel-egress-proxy
  template:
    metadata:
      labels:
        app: sentinel-egress-proxy
    spec:
      serviceAccountName: sentinel-vertex-sa
      automountServiceAccountToken: true
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: sentinel-egress-proxy
                topologyKey: kubernetes.io/hostname
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: sentinel
          image: ${IMAGE_REF}
          command:
            - /opt/venv/bin/python
            - -m
            - hushh_mcp.services.agent_sandbox.sentinel_proxy_server
          ports:
            - name: proxy
              containerPort: 3128
              protocol: TCP
            - name: control
              containerPort: 8081
              protocol: TCP
            - name: model-gateway
              containerPort: 8082
              protocol: TCP
          env:
            - name: ENVIRONMENT
              value: "${DEPLOY_ENV}"
            - name: HUSHH_DEPLOY_ENV
              value: "${DEPLOY_ENV}"
            - name: SENTINEL_DEFAULT_MODE
              value: deny
            - name: SENTINEL_MODEL_GATEWAY_PORT
              value: "8082"
            - name: SENTINEL_SYSTEM_ALLOW_HOSTS
              value: "${ALLOW_HOSTS}"
            - name: SENTINEL_AUDIT_LOG_PATH
              value: /var/run/hussh-audit/sentinel-audit.jsonl
            - name: SENTINEL_VERTEX_PROJECT
              value: "${PROJECT_ID}"
            - name: SENTINEL_VERTEX_LOCATION
              value: "global"
            - name: SENTINEL_AUDIT_HMAC_KEY
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: audit-hmac-key
            - name: SENTINEL_CONTROL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: sentinel-proxy-secrets
                  key: control-token${SENTINEL_EXTRA_ENV}
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 1
            periodSeconds: 5
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
              ephemeral-storage: 1Gi
            limits:
              cpu: 500m
              memory: 1Gi
              ephemeral-storage: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 10001
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: audit-sink
              mountPath: /var/run/hussh-audit
            - name: sentinel-tmp
              mountPath: /tmp
      volumes:
        - name: audit-sink
          emptyDir:
            sizeLimit: 256Mi
        - name: sentinel-tmp
          emptyDir:
            medium: Memory
            sizeLimit: 64Mi
---
apiVersion: v1
kind: Service
metadata:
  name: sentinel-egress-proxy
  namespace: hussh-sandbox-system
  labels:
    app: sentinel-egress-proxy
spec:
  selector:
    app: sentinel-egress-proxy
  ports:
    - name: proxy
      port: 3128
      targetPort: 3128
      protocol: TCP
    - name: control
      port: 8081
      targetPort: 8081
      protocol: TCP
    - name: model-gateway
      port: 8082
      targetPort: 8082
      protocol: TCP
---
apiVersion: v1
kind: Service
metadata:
  name: sentinel-control-ilb
  namespace: hussh-sandbox-system
  annotations:
    networking.gke.io/load-balancer-type: "Internal"
  labels:
    app: sentinel-egress-proxy
spec:
  type: LoadBalancer
  selector:
    app: sentinel-egress-proxy
  ports:
    - name: control
      port: 8081
      targetPort: 8081
      protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sentinel-egress-proxy-policy
  namespace: hussh-sandbox-system
spec:
  podSelector:
    matchLabels:
      app: sentinel-egress-proxy
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: hussh-agents
          podSelector:
            matchLabels:
              app: hussh-one-sandbox
      ports:
        - protocol: TCP
          port: 3128
        - protocol: TCP
          port: 8082
    - ports:
        - protocol: TCP
          port: 8081
EOF

echo "Applying stateless Sentinel HA (${SENTINEL_REPLICAS} replicas) with image ${IMAGE_REF}..."
kctl apply -f "${SENTINEL_MANIFEST}" >/dev/null
kctl -n hussh-sandbox-system rollout status deployment/sentinel-egress-proxy --timeout=300s

SENTINEL_CLUSTER_IP="$(kctl -n hussh-sandbox-system get svc sentinel-egress-proxy -o jsonpath='{.spec.clusterIP}')"
SENTINEL_ILB_IP=""
for _ in $(seq 1 24); do
  SENTINEL_ILB_IP="$(kctl -n hussh-sandbox-system get svc sentinel-control-ilb -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
  if [[ -n "${SENTINEL_ILB_IP}" ]]; then
    break
  fi
  sleep 5
done
if [[ -z "${SENTINEL_ILB_IP}" ]]; then
  SENTINEL_ILB_IP="$(gcloud compute forwarding-rules list --project="${PROJECT_ID}" --regions="${REGION}" \
    --filter='description~sentinel-control-ilb' --format='value(IPAddress)' 2>/dev/null | head -n 1 || true)"
fi
if [[ -z "${SENTINEL_ILB_IP}" ]]; then
  echo "Sandbox cluster reconcile (${DEPLOY_ENV}): failed to resolve sentinel-control-ilb VIP." >&2
  exit 1
fi

SANDBOX_OAUTH_ENV=""
if [[ -s "${WEB_CID_FILE}" ]]; then
  SANDBOX_OAUTH_ENV="
            - name: GOOGLE_WEB_OAUTH_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: sandbox-public-oauth-config
                  key: google-web-oauth-client-id"
fi

UAT_MAIL_SIDECAR=""
if [[ "${DEPLOY_ENV}" == "uat" ]] && kctl -n hussh-agents get secret uat-private-mail-oauth >/dev/null 2>&1; then
  SANDBOX_OAUTH_ENV="${SANDBOX_OAUTH_ENV}
            - name: GOOGLE_UAT_MAIL_WEB_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: uat-private-mail-oauth
                  key: client-id"
  UAT_MAIL_SIDECAR="
        - name: mail-web-exchange
          image: ${IMAGE_REF}
          command:
            - /opt/venv/bin/python
            - -m
            - uvicorn
            - hushh_mcp.services.agent_sandbox.mail_web_exchange:app
            - --host
            - 127.0.0.1
            - --port
            - \"8764\"
            - --no-access-log
            - --no-proxy-headers
          env:
            - name: GOOGLE_UAT_MAIL_WEB_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: uat-private-mail-oauth
                  key: client-id
            - name: GOOGLE_UAT_MAIL_WEB_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: uat-private-mail-oauth
                  key: client-secret
            - name: HTTPS_PROXY
              value: http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:3128
          resources:
            requests:
              cpu: 50m
              memory: 96Mi
            limits:
              cpu: 250m
              memory: 192Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 10002
            runAsGroup: 10002
            capabilities:
              drop:
                - ALL"
fi

TEMPLATE_MANIFEST="${WORK_DIR}/sandbox-template-and-pool.yaml"
if [[ "${DEPLOY_ENV}" != "uat" ]]; then
  cat > "${TEMPLATE_MANIFEST}" <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: sandbox-edge-allocator
  namespace: hussh-agents
rules:
  - apiGroups: ["agents.x-k8s.io", "extensions.agents.x-k8s.io"]
    resources: ["sandboxes", "sandboxclaims", "sandboxtemplates", "sandboxwarmpools"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods", "services"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: sandbox-edge-allocator-binding
  namespace: hussh-agents
subjects:
  - kind: User
    name: "${EDGE_SA}"
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: sandbox-edge-allocator
  apiGroup: rbac.authorization.k8s.io
---
EOF
fi
cat >> "${TEMPLATE_MANIFEST}" <<EOF
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata:
  name: hussh-one-sandbox-v1
  namespace: hussh-agents
  labels:
    app.kubernetes.io/part-of: hussh-one
    hussh.ai/sanitization-mode: single-use-destroy
    hussh.ai/compliance-profile: fedramp-high-baseline
spec:
  envVarsInjectionPolicy: Disallowed
  volumeClaimTemplatesPolicy: Disallowed
  failedPodPolicy: Retain
  networkPolicyManagement: Unmanaged
  podTemplate:
    metadata:
      labels:
        app: hussh-one-sandbox
        hussh.ai/pool: hussh-one-sandbox-v1
        hussh.ai/egress-enforced: sentinel
    spec:
      runtimeClassName: gvisor
      nodeSelector:
        cloud.google.com/gke-spot: "true"
      automountServiceAccountToken: false
      restartPolicy: Never
      hostAliases:
        - ip: "${SENTINEL_CLUSTER_IP}"
          hostnames:
            - sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local
            - sentinel-egress-proxy.hussh-sandbox-system.svc
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: sandbox
          image: ${IMAGE_REF}
          command:
            - /opt/venv/bin/python
            - -m
            - hushh_mcp.services.agent_sandbox.virgin_standby
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          env:
            - name: HUSSH_POD_MODE
              value: "1"
            - name: HUSSH_SANDBOX_PROFILE
              value: virgin_pool_v1
            - name: TMPDIR
              value: /run/hussh-tmp
            - name: HTTP_PROXY
              value: http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:3128
            - name: HTTPS_PROXY
              value: http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:3128
            - name: http_proxy
              value: http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:3128
            - name: https_proxy
              value: http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:3128
            - name: NO_PROXY
              value: localhost,127.0.0.1,::1,169.254.169.254,metadata.google.internal,metadata.goog,.hussh-sandbox-system.svc.cluster.local,.hussh-sandbox-system.svc
            - name: no_proxy
              value: localhost,127.0.0.1,::1,169.254.169.254,metadata.google.internal,metadata.goog,.hussh-sandbox-system.svc.cluster.local,.hussh-sandbox-system.svc${SANDBOX_OAUTH_ENV}
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 1
            periodSeconds: 5
          resources:
            requests:
              cpu: 2000m
              memory: 4Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 10001
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: workspace-nvme
              mountPath: /workspace
            - name: runtime-tmp
              mountPath: /run/hussh-tmp
            - name: gunicorn-runtime
              mountPath: /app/.gunicorn${UAT_MAIL_SIDECAR}
      volumes:
        - name: workspace-nvme
          emptyDir:
            sizeLimit: 4Gi
        - name: runtime-tmp
          emptyDir:
            medium: Memory
            sizeLimit: 256Mi
        - name: gunicorn-runtime
          emptyDir:
            medium: Memory
            sizeLimit: 64Mi
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata:
  name: hussh-one-warm-pool
  namespace: hussh-agents
  labels:
    app.kubernetes.io/part-of: hussh-one
spec:
  replicas: ${WARM_REPLICAS}
  sandboxTemplateRef:
    name: hussh-one-sandbox-v1
EOF
if [[ "${DEPLOY_ENV}" == "uat" ]]; then
  # Preserve the live strategy that replaces old pool-owned instances and
  # prevents new claims from adopting an earlier pod image.
  cat >> "${TEMPLATE_MANIFEST}" <<'EOF'
  updateStrategy:
    type: Recreate
EOF
fi

echo "Applying SandboxTemplate and SandboxWarmPool (replicas=${WARM_REPLICAS})..."
kctl apply -f "${TEMPLATE_MANIFEST}" >/dev/null

# In UAT the Sandbox controller owns pod replacement. Claims can retain a
# warm-pool name after allocation, so a workload rollout cannot delete them.
if [[ "${DEPLOY_ENV}" != "uat" ]]; then
  # Rotate ONLY unallocated warm-pool standby pods running an older image digest;
  # NEVER evict a pod bound to an active owner SandboxClaim.
  CLAIMS_JSON="${WORK_DIR}/claims.json"
  PODS_JSON="${WORK_DIR}/pods.json"
  kctl -n hussh-agents get sandboxclaims -o json > "${CLAIMS_JSON}" 2>/dev/null || echo '{"items":[]}' > "${CLAIMS_JSON}"
  kctl -n hussh-agents get pods -l app=hussh-one-sandbox -o json > "${PODS_JSON}" 2>/dev/null || echo '{"items":[]}' > "${PODS_JSON}"

  STALE_UNALLOCATED_PODS="$(python3 - "${CLAIMS_JSON}" "${PODS_JSON}" "${IMAGE_REF}" <<'PY'
import json
import sys

claims = json.loads(open(sys.argv[1]).read()).get("items") or []
pods = json.loads(open(sys.argv[2]).read()).get("items") or []
target_image = sys.argv[3]

bound_names = set()
for claim in claims:
    status = claim.get("status") or {}
    for key in ("sandboxName", "podName"):
        val = str(status.get(key) or "").strip()
        if val:
            bound_names.add(val)
    sbx = status.get("sandbox") or {}
    if isinstance(sbx, dict) and sbx.get("Name"):
        bound_names.add(str(sbx["Name"]).strip())

for pod in pods:
    meta = pod.get("metadata") or {}
    name = str(meta.get("name") or "").strip()
    labels = meta.get("labels") or {}
    owners = meta.get("ownerReferences") or []
    is_claimed = (
        name in bound_names
        or any(str(b) in name for b in bound_names if b)
        or bool(labels.get("agents.x-k8s.io/claim-name"))
        or any(o.get("kind") == "Sandbox" and not str(o.get("name") or "").startswith("hussh-one-warm-pool") for o in owners)
    )
    if is_claimed:
        continue
    containers = (pod.get("spec") or {}).get("containers") or []
    current_img = str(containers[0].get("image") or "") if containers else ""
    if current_img != target_image:
        print(name)
PY
)"

  for stale_pod in ${STALE_UNALLOCATED_PODS}; do
    echo "Recycling unallocated standby pod ${stale_pod} to ${IMAGE_REF}..."
    kctl -n hussh-agents delete pod "${stale_pod}" --wait=false >/dev/null 2>&1 || true
  done
fi

CORS_ORIGINS="${DEFAULT_CORS}"
if [[ -n "${WEBAPP_URL}" ]]; then
  STAGE_WEBAPP_URL="https://stage---${WEBAPP_URL#https://}"
  CORS_ORIGINS="${CORS_ORIGINS},${WEBAPP_URL},${STAGE_WEBAPP_URL}"
fi

TASK_WORKER_EMAIL=""
if gcloud iam service-accounts describe "hussh-sandbox-task-worker@${PROJECT_ID}.iam.gserviceaccount.com" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  TASK_WORKER_EMAIL="hussh-sandbox-task-worker@${PROJECT_ID}.iam.gserviceaccount.com"
fi

ENV_FILE="${WORK_DIR}/edge-env.yaml"
cat > "${ENV_FILE}" <<EOF
CORS_ALLOWED_ORIGINS: "${CORS_ORIGINS}"
HUSHH_DEPLOY_ENV: "${DEPLOY_ENV}"
HUSHH_SCHEDULER_CALLER_EMAILS: "consent-protocol-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
HUSSH_HUB_URL: "${HUB_URL}"
HUSSH_K8S_API_SERVER: "https://${ENDPOINT}"
HUSSH_K8S_CA_CERT_B64: "${CA_B64}"
HUSSH_SANDBOX_EDGE_PUBLIC_URL: "${EXISTING_EDGE_URL}"
HUSSH_SANDBOX_HEALTH_POLL_TIMEOUT_SECONDS: "25"
HUSSH_SANDBOX_IDLE_TIMEOUT_SECONDS: "600"
HUSSH_SANDBOX_NAMESPACE: "hussh-agents"
HUSSH_SANDBOX_POOL: "hussh-one-warm-pool"
HUSSH_SANDBOX_PREFIX_STORAGE_ENABLED: "true"
HUSSH_SANDBOX_TASK_WORKER_EMAIL: "${TASK_WORKER_EMAIL}"
HUSSH_SENTINEL_VERTEX_LOCATION: "global"
HUSSH_SENTINEL_VERTEX_PROJECT: "${PROJECT_ID}"
SENTINEL_CONTROL_URL: "http://${SENTINEL_ILB_IP}:8081"
SENTINEL_MODEL_GATEWAY_URL: "http://sentinel-egress-proxy.hussh-sandbox-system.svc.cluster.local:8082"
EOF

EDGE_SECRETS="HUSSH_EDGE_ADMIN_TOKEN=sandbox-edge-admin-token:latest,HUSSH_SANDBOX_IDENTITY_MASTER_KEY=sandbox-edge-identity-master-key:latest,SENTINEL_CONTROL_TOKEN=sentinel-control-token:latest"
for pub_secret in CONSENT_ED25519_PUBLIC_KEYS OWNER_FEED_ED25519_PUBLIC_KEYS GOOGLE_IOS_CONNECTOR_CLIENT_ID; do
  if gcloud secrets describe "${pub_secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    EDGE_SECRETS="${EDGE_SECRETS},${pub_secret}=${pub_secret}:latest"
  fi
done

echo "Reconciling Cloud Run ${EDGE_SERVICE} in ${PROJECT_ID} (${REGION}) with image ${IMAGE_REF}..."
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
  echo "Sandbox cluster reconcile (${DEPLOY_ENV}): failed to resolve deployed service URL." >&2
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
echo "Confidential Sandbox cluster (${CLUSTER_NAME}) and ${EDGE_SERVICE} healthy at ${DEPLOYED_EDGE_URL}."
