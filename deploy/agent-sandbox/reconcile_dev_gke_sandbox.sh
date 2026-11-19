#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Declarative reconciler for Dev GKE Autopilot AgentSandbox baseline (#9744).
# Defaults to dry-run plan output unless --apply or --scale-zero is passed.

set -euo pipefail

PROJECT_ID="${HUSSH_GKE_PROJECT:-hushh-pda-dev}"
REGION="${HUSSH_GKE_REGION:-us-central1}"
CLUSTER_NAME="${HUSSH_GKE_CLUSTER:-hussh-one-sandbox-dev}"
ROUTER_NAME="${HUSSH_GKE_ROUTER:-hussh-sandbox-router}"
NAT_NAME="${HUSSH_GKE_NAT:-hussh-sandbox-nat}"
NAMESPACE="${HUSSH_SANDBOX_NAMESPACE:-hussh-agents}"
POOL_NAME="${HUSSH_SANDBOX_POOL:-hussh-one-warm-pool}"
AGENT_SANDBOX_RELEASE="${HUSSH_AGENT_SANDBOX_RELEASE:-v1.0.11}"

MODE="plan"
REPLICAS="${HUSSH_SANDBOX_WARM_REPLICAS:-1}"

for arg in "$@"; do
  case "$arg" in
    --apply)
      MODE="apply"
      ;;
    --scale-zero)
      MODE="scale-zero"
      REPLICAS=0
      ;;
    *)
      echo "Unknown flag: $arg (expected --apply or --scale-zero)" >&2
      exit 2
      ;;
  esac
done

echo "Mode: $MODE | Project: $PROJECT_ID | Region: $REGION | Cluster: $CLUSTER_NAME | Pool Replicas: $REPLICAS"
if [ "$MODE" = "plan" ]; then
  echo "Dry-run plan (pass --apply to provision/reconcile or --scale-zero to drain SandboxWarmPool):"
  echo "  1. Enable container.googleapis.com on $PROJECT_ID"
  echo "  2. Ensure Cloud Router $ROUTER_NAME and Cloud NAT $NAT_NAME in $REGION (default VPC)"
  echo "  3. Ensure private GKE Autopilot cluster $CLUSTER_NAME in $REGION"
  echo "  4. Apply kubernetes-sigs/agent-sandbox $AGENT_SANDBOX_RELEASE CRDs + controller"
  echo "  5. Apply namespaces, NetworkPolicy, gke-sandbox SandboxTemplate, and SandboxWarmPool (replicas=$REPLICAS)"
  exit 0
fi

export CLOUDSDK_AUTH_ACCESS_TOKEN="${CLOUDSDK_AUTH_ACCESS_TOKEN:-$(gcloud auth application-default print-access-token)}"

if [ "$MODE" = "apply" ]; then
  gcloud services enable container.googleapis.com --project="$PROJECT_ID" --quiet
  gcloud compute routers describe "$ROUTER_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud compute routers create "$ROUTER_NAME" --network=default --region="$REGION" --project="$PROJECT_ID" --quiet
  gcloud compute routers nats describe "$NAT_NAME" --router="$ROUTER_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1 || \
    gcloud compute routers nats create "$NAT_NAME" --router="$ROUTER_NAME" --region="$REGION" --nat-all-subnet-ip-ranges --auto-allocate-nat-external-ips --project="$PROJECT_ID" --quiet
  if ! gcloud container clusters describe "$CLUSTER_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud container clusters create-auto "$CLUSTER_NAME" \
      --region="$REGION" \
      --project="$PROJECT_ID" \
      --release-channel=regular \
      --enable-private-nodes \
      --quiet
  fi
fi

ENDPOINT="$(gcloud container clusters describe "$CLUSTER_NAME" --region="$REGION" --project="$PROJECT_ID" --format='value(endpoint)')"
CA_FILE="$(mktemp)"
trap 'rm -f "$CA_FILE"' EXIT
gcloud container clusters describe "$CLUSTER_NAME" --region="$REGION" --project="$PROJECT_ID" --format='value(masterAuth.clusterCaCertificate)' | base64 -d > "$CA_FILE"

kctl() {
  kubectl --server="https://${ENDPOINT}" --certificate-authority="$CA_FILE" --token="$(gcloud auth application-default print-access-token)" "$@"
}

if [ "$MODE" = "scale-zero" ]; then
  kctl -n "$NAMESPACE" patch sandboxwarmpool "$POOL_NAME" --type=merge -p '{"spec":{"replicas":0}}'
  echo "Scaled $POOL_NAME to 0 replicas in namespace $NAMESPACE."
  exit 0
fi

kctl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_RELEASE}/sandbox-with-extensions.yaml"
kctl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s

for ns in "$NAMESPACE" hussh-hub-router hussh-sandbox-system; do
  kctl create namespace "$ns" --dry-run=client -o yaml | kctl apply -f -
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
kctl apply -f "${SCRIPT_DIR}/sandbox-network-policy.yaml"
echo "Reconcile complete. Apply an exact signed image SandboxTemplate and SandboxWarmPool to activate warm replicas."
