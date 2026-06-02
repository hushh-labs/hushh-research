#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${MULESOFT_ENV_FILE:-${HOME}/.codex/secrets/mulesoft-mcp.env}"
ANYPOINT_ORG_ID="${ANYPOINT_ORG_ID:-e01e108f-3e47-4f8c-9c62-688593a501d5}"
ANYPOINT_BASE_URL="${ANYPOINT_BASE_URL:-https://anypoint.mulesoft.com}"

NONPROD_SPACE_ID="${NONPROD_SPACE_ID:-af4e41bb-c477-4cbe-af63-c6f3d980d227}"
NONPROD_SPACE_NAME="${NONPROD_SPACE_NAME:-hussh-ps-non-prod-east1}"
NONPROD_SPACE_REGION="${NONPROD_SPACE_REGION:-us-east-2}"
NONPROD_MULESOFT_CIDR="${NONPROD_MULESOFT_CIDR:-10.81.0.0/22}"
NONPROD_DNS_RESOLVER="${NONPROD_DNS_RESOLVER:-10.88.0.2}"
NONPROD_DNS_DOMAIN="${NONPROD_DNS_DOMAIN:-np.hushh-gateway.private}"
NONPROD_HUSSH_ASN="${NONPROD_HUSSH_ASN:-64520}"
NONPROD_HUSSH_VPN_IPS="${NONPROD_HUSSH_VPN_IPS:-34.157.35.157,34.157.163.69}"

PROD_SPACE_ID="${PROD_SPACE_ID:-3c663688-2a9c-461a-936d-b3e21294006a}"
PROD_SPACE_NAME="${PROD_SPACE_NAME:-hussh-ps-prod-east1}"
PROD_SPACE_REGION="${PROD_SPACE_REGION:-us-east-2}"
PROD_MULESOFT_CIDR="${PROD_MULESOFT_CIDR:-10.91.0.0/22}"
PROD_DNS_RESOLVER="${PROD_DNS_RESOLVER:-10.98.0.2}"
PROD_DNS_DOMAIN="${PROD_DNS_DOMAIN:-prod.hushh-gateway.private}"
PROD_HUSSH_ASN="${PROD_HUSSH_ASN:-64521}"
PROD_HUSSH_VPN_IPS="${PROD_HUSSH_VPN_IPS:-34.157.32.171,34.157.160.164}"

REQUIRE_VPN_READY="${REQUIRE_VPN_READY:-false}"

failures=0
warnings=0

log() {
  echo "[mulesoft-verify] $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

check_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"

  if [[ "${actual}" == "${expected}" ]]; then
    log "OK: ${label}=${actual}"
  else
    log "ERROR: ${label} expected ${expected}, actual ${actual:-<empty>}"
    failures=$((failures + 1))
  fi
}

warn_if_not_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"

  if [[ "${actual}" == "${expected}" ]]; then
    log "OK: ${label}=${actual}"
  else
    log "WARN: ${label} expected ${expected}, actual ${actual:-<empty>}"
    warnings=$((warnings + 1))
  fi
}

fetch_token() {
  curl -sS --fail \
    -X POST "${ANYPOINT_BASE_URL}/accounts/api/v2/oauth2/token" \
    -H "Content-Type: application/json" \
    --data @- <<EOF | jq -r ".access_token"
{"grant_type":"client_credentials","client_id":"${ANYPOINT_CLIENT_ID}","client_secret":"${ANYPOINT_CLIENT_SECRET}"}
EOF
}

fetch_space() {
  local token="$1"
  local space_id="$2"

  curl -sS --fail \
    "${ANYPOINT_BASE_URL}/runtimefabric/api/organizations/${ANYPOINT_ORG_ID}/privatespaces/${space_id}" \
    -H "Authorization: Bearer ${token}"
}

fetch_spaces() {
  local token="$1"

  curl -sS --fail \
    "${ANYPOINT_BASE_URL}/runtimefabric/api/organizations/${ANYPOINT_ORG_ID}/privatespaces" \
    -H "Authorization: Bearer ${token}"
}

verify_space() {
  local env_name="$1"
  local space_file="$2"
  local list_file="$3"
  local expected_name="$4"
  local expected_region="$5"
  local expected_cidr="$6"
  local expected_dns="$7"
  local expected_domain="$8"
  local expected_asn="$9"
  local expected_hussh_ips="${10}"

  log "Inspecting ${env_name}: ${expected_name}"

  local actual_name actual_region actual_status actual_version actual_cidr actual_dns actual_domain app_count
  actual_name="$(jq -r ".name // \"\"" "${space_file}")"
  actual_region="$(jq -r ".region // \"\"" "${space_file}")"
  actual_status="$(jq -r ".status // \"\"" "${space_file}")"
  actual_version="$(jq -r ".version // \"\"" "${space_file}")"
  actual_cidr="$(jq -r ".network.cidrBlock // \"\"" "${space_file}")"
  actual_dns="$(jq -r ".network.internalDns.dnsServers[0] // \"\"" "${space_file}")"
  actual_domain="$(jq -r ".network.internalDns.specialDomains[0] // \"\"" "${space_file}")"
  app_count="$(jq -r ".muleAppDeploymentCount // 0" "${space_file}")"

  check_equal "${env_name}.name" "${expected_name}" "${actual_name}"
  check_equal "${env_name}.region" "${expected_region}" "${actual_region}"
  check_equal "${env_name}.status" "Active" "${actual_status}"
  check_equal "${env_name}.cidr" "${expected_cidr}" "${actual_cidr}"
  check_equal "${env_name}.dns_resolver" "${expected_dns}" "${actual_dns}"
  check_equal "${env_name}.dns_domain" "${expected_domain}" "${actual_domain}"
  log "OK: ${env_name}.version=${actual_version}"
  log "OK: ${env_name}.muleAppDeploymentCount=${app_count}"

  IFS="," read -r -a ips <<< "${expected_hussh_ips}"
  for ip in "${ips[@]}"; do
    local matches vpn_status tunnel_count tunnel_ready remote_asn local_asn
    matches="$(jq -r \
      --arg space "${expected_name}" \
      --arg ip "${ip}" \
      '[.content[] | select(.name == $space) | .connections.vpns[]?.vpns[]? | select(.remoteIpAddress == $ip)] | length' \
      "${list_file}")"

    if [[ "${matches}" == "0" ]]; then
      log "ERROR: ${env_name}.vpn_remote_ip missing ${ip}"
      failures=$((failures + 1))
      continue
    fi

    vpn_status="$(jq -r \
      --arg space "${expected_name}" \
      --arg ip "${ip}" \
      '.content[] | select(.name == $space) | .connections.vpns[]?.vpns[]? | select(.remoteIpAddress == $ip) | .vpnConnectionStatus' \
      "${list_file}" | head -n 1)"
    tunnel_count="$(jq -r \
      --arg space "${expected_name}" \
      --arg ip "${ip}" \
      '.content[] | select(.name == $space) | .connections.vpns[]?.vpns[]? | select(.remoteIpAddress == $ip) | (.vpnTunnels // [] | length)' \
      "${list_file}" | head -n 1)"
    tunnel_ready="$(jq -r \
      --arg space "${expected_name}" \
      --arg ip "${ip}" \
      '.content[] | select(.name == $space) | .connections.vpns[]?.vpns[]? | select(.remoteIpAddress == $ip) | ((.vpnTunnels // []) | all(((.ptpCidr // "") != "") and ((.psk // "") != "")))' \
      "${list_file}" | head -n 1)"
    remote_asn="$(jq -r \
      --arg space "${expected_name}" \
      --arg ip "${ip}" \
      '.content[] | select(.name == $space) | .connections.vpns[]?.vpns[]? | select(.remoteIpAddress == $ip) | .remoteAsn' \
      "${list_file}" | head -n 1)"
    local_asn="$(jq -r \
      --arg space "${expected_name}" \
      --arg ip "${ip}" \
      '.content[] | select(.name == $space) | .connections.vpns[]?.vpns[]? | select(.remoteIpAddress == $ip) | .localAsn' \
      "${list_file}" | head -n 1)"

    check_equal "${env_name}.vpn.${ip}.remote_asn" "${expected_asn}" "${remote_asn}"
    check_equal "${env_name}.vpn.${ip}.local_asn" "64512" "${local_asn}"
    warn_if_not_equal "${env_name}.vpn.${ip}.status" "available" "${vpn_status}"
    warn_if_not_equal "${env_name}.vpn.${ip}.tunnel_count" "2" "${tunnel_count}"

    if [[ "${tunnel_ready}" == "true" ]]; then
      log "OK: ${env_name}.vpn.${ip}.tunnel_details_present=true"
    else
      log "WARN: ${env_name}.vpn.${ip}.tunnel_details_present=false"
      warnings=$((warnings + 1))
      if [[ "${REQUIRE_VPN_READY}" == "true" ]]; then
        failures=$((failures + 1))
      fi
    fi
  done
}

require_cmd curl
require_cmd jq

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

: "${ANYPOINT_CLIENT_ID:?Set ANYPOINT_CLIENT_ID or provide ${ENV_FILE}}"
: "${ANYPOINT_CLIENT_SECRET:?Set ANYPOINT_CLIENT_SECRET or provide ${ENV_FILE}}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

token="$(fetch_token)"
if [[ -z "${token}" || "${token}" == "null" ]]; then
  echo "ERROR: Anypoint token request did not return an access token" >&2
  exit 1
fi

fetch_spaces "${token}" > "${tmp_dir}/spaces.json"
fetch_space "${token}" "${NONPROD_SPACE_ID}" > "${tmp_dir}/nonprod.json"
fetch_space "${token}" "${PROD_SPACE_ID}" > "${tmp_dir}/prod.json"

verify_space \
  "nonprod" \
  "${tmp_dir}/nonprod.json" \
  "${tmp_dir}/spaces.json" \
  "${NONPROD_SPACE_NAME}" \
  "${NONPROD_SPACE_REGION}" \
  "${NONPROD_MULESOFT_CIDR}" \
  "${NONPROD_DNS_RESOLVER}" \
  "${NONPROD_DNS_DOMAIN}" \
  "${NONPROD_HUSSH_ASN}" \
  "${NONPROD_HUSSH_VPN_IPS}"

verify_space \
  "prod" \
  "${tmp_dir}/prod.json" \
  "${tmp_dir}/spaces.json" \
  "${PROD_SPACE_NAME}" \
  "${PROD_SPACE_REGION}" \
  "${PROD_MULESOFT_CIDR}" \
  "${PROD_DNS_RESOLVER}" \
  "${PROD_DNS_DOMAIN}" \
  "${PROD_HUSSH_ASN}" \
  "${PROD_HUSSH_VPN_IPS}"

if (( failures > 0 )); then
  log "FAILED: ${failures} blocking mismatch(es), ${warnings} warning(s)"
  exit 1
fi

log "PASSED: 0 blocking mismatches, ${warnings} warning(s)"
