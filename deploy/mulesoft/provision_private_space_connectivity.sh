#!/usr/bin/env bash
set -euo pipefail

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

ENV="${ENV:-nonprod}"
ACTION="${ACTION:-plan}"
PHASE="${PHASE:-foundation}"
REGION="${REGION:-}"

case "${ENV}" in
  nonprod)
    REGION="${REGION:-us-east5}"
    PROJECT_ID="${PROJECT_ID:-hushh-pda-uat}"
    VPC_NAME="${VPC_NAME:-hushh-mulesoft-np-ohio-vpc}"
    SERVICE_SUBNET_NAME="${SERVICE_SUBNET_NAME:-hushh-mulesoft-np-services-us-east5}"
    SERVICE_SUBNET_CIDR="${SERVICE_SUBNET_CIDR:-10.88.0.0/24}"
    PROXY_SUBNET_NAME="${PROXY_SUBNET_NAME:-hushh-mulesoft-np-proxy-us-east5}"
    PROXY_SUBNET_CIDR="${PROXY_SUBNET_CIDR:-10.88.1.0/24}"
    MULESOFT_PRIVATE_SPACE_CIDR="${MULESOFT_PRIVATE_SPACE_CIDR:-10.81.0.0/22}"
    DNS_ZONE_NAME="${DNS_ZONE_NAME:-hushh-mulesoft-np-ohio-private}"
    PRIVATE_DNS_DOMAIN="${PRIVATE_DNS_DOMAIN:-np.hushh-gateway.private}"
    DNS_POLICY_NAME="${DNS_POLICY_NAME:-hushh-mulesoft-np-ohio-inbound-dns}"
    ROUTER_NAME="${ROUTER_NAME:-hushh-mulesoft-np-router-us-east5}"
    VPN_GATEWAY_NAME="${VPN_GATEWAY_NAME:-hushh-mulesoft-np-ha-vpn-us-east5}"
    HUSSH_ASN="${HUSSH_ASN:-64520}"
    ;;
  prod)
    REGION="${REGION:-us-east5}"
    PROJECT_ID="${PROJECT_ID:-hushh-pda}"
    VPC_NAME="${VPC_NAME:-hushh-mulesoft-prod-ohio-v2-vpc}"
    SERVICE_SUBNET_NAME="${SERVICE_SUBNET_NAME:-hushh-mulesoft-prod-services-v2-us-east5}"
    SERVICE_SUBNET_CIDR="${SERVICE_SUBNET_CIDR:-10.98.0.0/24}"
    PROXY_SUBNET_NAME="${PROXY_SUBNET_NAME:-hushh-mulesoft-prod-proxy-v2-us-east5}"
    PROXY_SUBNET_CIDR="${PROXY_SUBNET_CIDR:-10.98.1.0/24}"
    MULESOFT_PRIVATE_SPACE_CIDR="${MULESOFT_PRIVATE_SPACE_CIDR:-10.91.0.0/22}"
    DNS_ZONE_NAME="${DNS_ZONE_NAME:-hushh-mulesoft-prod-v2-private}"
    PRIVATE_DNS_DOMAIN="${PRIVATE_DNS_DOMAIN:-prod.hushh-gateway.private}"
    DNS_POLICY_NAME="${DNS_POLICY_NAME:-hushh-mulesoft-prod-v2-inbound-dns}"
    ROUTER_NAME="${ROUTER_NAME:-hushh-mulesoft-prod-router-v2-us-east5}"
    VPN_GATEWAY_NAME="${VPN_GATEWAY_NAME:-hushh-mulesoft-prod-ha-vpn-v2-us-east5}"
    HUSSH_ASN="${HUSSH_ASN:-64521}"
    ;;
  *)
    echo "ERROR: ENV must be nonprod or prod" >&2
    exit 1
    ;;
esac

EXTERNAL_VPN_GATEWAY_NAME="${EXTERNAL_VPN_GATEWAY_NAME:-${VPC_NAME}-mulesoft-peer}"
VPN_TUNNEL_0="${VPN_TUNNEL_0:-${VPC_NAME}-tunnel-0}"
VPN_TUNNEL_1="${VPN_TUNNEL_1:-${VPC_NAME}-tunnel-1}"
ROUTER_INTERFACE_0="${ROUTER_INTERFACE_0:-mulesoft-if-0}"
ROUTER_INTERFACE_1="${ROUTER_INTERFACE_1:-mulesoft-if-1}"
BGP_PEER_0="${BGP_PEER_0:-mulesoft-peer-0}"
BGP_PEER_1="${BGP_PEER_1:-mulesoft-peer-1}"
MULESOFT_ASN="${MULESOFT_ASN:-64512}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

log() {
  echo "[mulesoft-provision] $*"
}

format_command() {
  local formatted=()
  local redact_next="false"
  local arg

  for arg in "$@"; do
    if [[ "${redact_next}" == "true" ]]; then
      formatted+=("***redacted***")
      redact_next="false"
      continue
    fi

    case "${arg}" in
      --shared-secret)
        formatted+=("${arg}")
        redact_next="true"
        ;;
      --shared-secret=*)
        formatted+=("--shared-secret=***redacted***")
        ;;
      *)
        formatted+=("${arg}")
        ;;
    esac
  done

  printf "%q " "${formatted[@]}"
}

run() {
  log "+ $(format_command "$@")"
  if [[ "${ACTION}" == "apply" ]]; then
    "$@"
  fi
}

ensure_action() {
  case "${ACTION}" in
    plan|apply) ;;
    *)
      echo "ERROR: ACTION must be plan or apply" >&2
      exit 1
      ;;
  esac
}

ensure_phase() {
  case "${PHASE}" in
    foundation|vpn|all) ;;
    *)
      echo "ERROR: PHASE must be foundation, vpn, or all" >&2
      exit 1
      ;;
  esac
}

require_vpn_vars() {
  local missing=()
  for name in \
    MULESOFT_VPN_IP_0 \
    MULESOFT_VPN_IP_1 \
    HUSSH_BGP_IP_0 \
    MULESOFT_BGP_IP_0 \
    HUSSH_BGP_IP_1 \
    MULESOFT_BGP_IP_1 \
    VPN_SHARED_SECRET_0 \
    VPN_SHARED_SECRET_1; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("${name}")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    echo "ERROR: PHASE=vpn requires: ${missing[*]}" >&2
    exit 1
  fi
}

router_status_has() {
  local pattern="$1"
  gcloud compute routers get-status "${ROUTER_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --format=json 2>/dev/null | grep -q "\"${pattern}\""
}

ensure_foundation() {
  run gcloud services enable \
    compute.googleapis.com \
    dns.googleapis.com \
    certificatemanager.googleapis.com \
    networkservices.googleapis.com \
    --project "${PROJECT_ID}"

  if ! gcloud compute networks describe "${VPC_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    run gcloud compute networks create "${VPC_NAME}" \
      --project "${PROJECT_ID}" \
      --subnet-mode=custom \
      --bgp-routing-mode=regional
  else
    log "VPC already exists: ${VPC_NAME}"
  fi

  if ! gcloud compute networks subnets describe "${SERVICE_SUBNET_NAME}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    run gcloud compute networks subnets create "${SERVICE_SUBNET_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --network "${VPC_NAME}" \
      --range "${SERVICE_SUBNET_CIDR}" \
      --enable-private-ip-google-access
  else
    log "Service subnet already exists: ${SERVICE_SUBNET_NAME}"
  fi

  if ! gcloud compute networks subnets describe "${PROXY_SUBNET_NAME}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    run gcloud compute networks subnets create "${PROXY_SUBNET_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --network "${VPC_NAME}" \
      --range "${PROXY_SUBNET_CIDR}" \
      --purpose=REGIONAL_MANAGED_PROXY \
      --role=ACTIVE
  else
    log "Proxy-only subnet already exists: ${PROXY_SUBNET_NAME}"
  fi

  if ! gcloud compute routers describe "${ROUTER_NAME}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    run gcloud compute routers create "${ROUTER_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --network "${VPC_NAME}" \
      --asn "${HUSSH_ASN}"
  else
    log "Cloud Router already exists: ${ROUTER_NAME}"
  fi

  if ! gcloud compute vpn-gateways describe "${VPN_GATEWAY_NAME}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    run gcloud compute vpn-gateways create "${VPN_GATEWAY_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --network "${VPC_NAME}"
  else
    log "HA VPN gateway already exists: ${VPN_GATEWAY_NAME}"
  fi

  if ! gcloud dns managed-zones describe "${DNS_ZONE_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    run gcloud dns managed-zones create "${DNS_ZONE_NAME}" \
      --project "${PROJECT_ID}" \
      --dns-name "${PRIVATE_DNS_DOMAIN}." \
      --visibility=private \
      --networks "${VPC_NAME}" \
      --description "Private DNS for MuleSoft Managed Omni Gateway ${ENV}"
  else
    log "Private DNS zone already exists: ${DNS_ZONE_NAME}"
  fi

  if ! gcloud dns policies describe "${DNS_POLICY_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    run gcloud dns policies create "${DNS_POLICY_NAME}" \
      --project "${PROJECT_ID}" \
      --enable-inbound-forwarding \
      --networks "${VPC_NAME}" \
      --description "Inbound DNS forwarding for MuleSoft Managed Omni Gateway ${ENV}"
  else
    log "Cloud DNS policy already exists: ${DNS_POLICY_NAME}"
  fi

  log "Foundation target: env=${ENV}, project=${PROJECT_ID}, vpc=${VPC_NAME}, mulesoft_cidr=${MULESOFT_PRIVATE_SPACE_CIDR}"
}

ensure_vpn() {
  require_vpn_vars

  if ! gcloud compute external-vpn-gateways describe "${EXTERNAL_VPN_GATEWAY_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    run gcloud compute external-vpn-gateways create "${EXTERNAL_VPN_GATEWAY_NAME}" \
      --project "${PROJECT_ID}" \
      --interfaces "0=${MULESOFT_VPN_IP_0},1=${MULESOFT_VPN_IP_1}" \
      --redundancy-type TWO_IPS_REDUNDANCY
  else
    log "External VPN gateway already exists: ${EXTERNAL_VPN_GATEWAY_NAME}"
  fi

  if ! gcloud compute vpn-tunnels describe "${VPN_TUNNEL_0}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    run gcloud compute vpn-tunnels create "${VPN_TUNNEL_0}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --vpn-gateway "${VPN_GATEWAY_NAME}" \
      --interface 0 \
      --peer-external-gateway "${EXTERNAL_VPN_GATEWAY_NAME}" \
      --peer-external-gateway-interface 0 \
      --router "${ROUTER_NAME}" \
      --ike-version 2 \
      --shared-secret "${VPN_SHARED_SECRET_0}"
  else
    log "VPN tunnel already exists: ${VPN_TUNNEL_0}"
  fi

  if ! gcloud compute vpn-tunnels describe "${VPN_TUNNEL_1}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    run gcloud compute vpn-tunnels create "${VPN_TUNNEL_1}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --vpn-gateway "${VPN_GATEWAY_NAME}" \
      --interface 1 \
      --peer-external-gateway "${EXTERNAL_VPN_GATEWAY_NAME}" \
      --peer-external-gateway-interface 1 \
      --router "${ROUTER_NAME}" \
      --ike-version 2 \
      --shared-secret "${VPN_SHARED_SECRET_1}"
  else
    log "VPN tunnel already exists: ${VPN_TUNNEL_1}"
  fi

  if ! router_status_has "${ROUTER_INTERFACE_0}"; then
    run gcloud compute routers add-interface "${ROUTER_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --interface-name "${ROUTER_INTERFACE_0}" \
      --ip-address "${HUSSH_BGP_IP_0}" \
      --mask-length 30 \
      --vpn-tunnel "${VPN_TUNNEL_0}"
  else
    log "Router interface already exists: ${ROUTER_INTERFACE_0}"
  fi

  if ! router_status_has "${ROUTER_INTERFACE_1}"; then
    run gcloud compute routers add-interface "${ROUTER_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --interface-name "${ROUTER_INTERFACE_1}" \
      --ip-address "${HUSSH_BGP_IP_1}" \
      --mask-length 30 \
      --vpn-tunnel "${VPN_TUNNEL_1}"
  else
    log "Router interface already exists: ${ROUTER_INTERFACE_1}"
  fi

  if ! router_status_has "${BGP_PEER_0}"; then
    run gcloud compute routers add-bgp-peer "${ROUTER_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --peer-name "${BGP_PEER_0}" \
      --interface "${ROUTER_INTERFACE_0}" \
      --peer-ip-address "${MULESOFT_BGP_IP_0}" \
      --peer-asn "${MULESOFT_ASN}" \
      --advertisement-mode=custom \
      --set-advertisement-ranges="${SERVICE_SUBNET_CIDR}"
  else
    log "BGP peer already exists: ${BGP_PEER_0}"
  fi

  if ! router_status_has "${BGP_PEER_1}"; then
    run gcloud compute routers add-bgp-peer "${ROUTER_NAME}" \
      --project "${PROJECT_ID}" \
      --region "${REGION}" \
      --peer-name "${BGP_PEER_1}" \
      --interface "${ROUTER_INTERFACE_1}" \
      --peer-ip-address "${MULESOFT_BGP_IP_1}" \
      --peer-asn "${MULESOFT_ASN}" \
      --advertisement-mode=custom \
      --set-advertisement-ranges="${SERVICE_SUBNET_CIDR}"
  else
    log "BGP peer already exists: ${BGP_PEER_1}"
  fi
}

require_cmd gcloud
ensure_action
ensure_phase

log "mode: env=${ENV}, action=${ACTION}, phase=${PHASE}, project=${PROJECT_ID}, region=${REGION}"

if [[ "${PHASE}" == "foundation" || "${PHASE}" == "all" ]]; then
  ensure_foundation
fi

if [[ "${PHASE}" == "vpn" || "${PHASE}" == "all" ]]; then
  ensure_vpn
fi

if [[ "${ACTION}" == "plan" ]]; then
  log "Plan mode only. Re-run with ACTION=apply after review."
fi
