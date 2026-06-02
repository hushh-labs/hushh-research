#!/usr/bin/env bash
set -euo pipefail

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

NONPROD_PROJECT="${NONPROD_PROJECT:-hushh-pda-uat}"
PROD_PROJECT="${PROD_PROJECT:-hushh-pda}"
REGION="${REGION:-}"
NONPROD_REGION="${NONPROD_REGION:-${REGION:-us-east5}}"
PROD_REGION="${PROD_REGION:-${REGION:-us-east5}}"
NONPROD_MULESOFT_CIDR="${NONPROD_MULESOFT_CIDR:-10.81.0.0/22}"
NONPROD_MULESOFT_EXTRA_CIDRS="${NONPROD_MULESOFT_EXTRA_CIDRS:-}"
PROD_MULESOFT_CIDR="${PROD_MULESOFT_CIDR:-10.91.0.0/22}"
PROD_MULESOFT_EXTRA_CIDRS="${PROD_MULESOFT_EXTRA_CIDRS:-}"
NONPROD_HUSSH_SERVICE_CIDR="${NONPROD_HUSSH_SERVICE_CIDR:-10.88.0.0/24}"
NONPROD_HUSSH_PROXY_CIDR="${NONPROD_HUSSH_PROXY_CIDR:-10.88.1.0/24}"
NONPROD_HUSSH_SERVICE_SUBNET_NAME="${NONPROD_HUSSH_SERVICE_SUBNET_NAME:-hushh-mulesoft-np-services-us-east5}"
NONPROD_HUSSH_PROXY_SUBNET_NAME="${NONPROD_HUSSH_PROXY_SUBNET_NAME:-hushh-mulesoft-np-proxy-us-east5}"
PROD_HUSSH_SERVICE_CIDR="${PROD_HUSSH_SERVICE_CIDR:-10.98.0.0/24}"
PROD_HUSSH_PROXY_CIDR="${PROD_HUSSH_PROXY_CIDR:-10.98.1.0/24}"
PROD_HUSSH_SERVICE_SUBNET_NAME="${PROD_HUSSH_SERVICE_SUBNET_NAME:-hushh-mulesoft-prod-services-v2-us-east5}"
PROD_HUSSH_PROXY_SUBNET_NAME="${PROD_HUSSH_PROXY_SUBNET_NAME:-hushh-mulesoft-prod-proxy-v2-us-east5}"
NONPROD_DB_INSTANCE="${NONPROD_DB_INSTANCE:-hushh-uat-pg}"
PROD_DB_INSTANCE="${PROD_DB_INSTANCE:-hushh-vault-db}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

log() {
  echo "[mulesoft-inventory] $*"
}

run_or_note() {
  local label="$1"
  shift
  echo
  log "${label}"
  if ! "$@"; then
    log "WARN: ${label} failed or is not enabled for this project"
  fi
}

api_enabled() {
  local project="$1"
  local service="$2"
  gcloud services list \
    --project "${project}" \
    --enabled \
    --filter="config.name=${service}" \
    --format="value(config.name)" | grep -qx "${service}"
}

write_json_or_empty() {
  local path="$1"
  shift
  if "$@" > "${path}" 2>/dev/null; then
    return
  fi
  printf '[]\n' > "${path}"
}

inspect_project() {
  local env_name="$1"
  local project="$2"
  local db_instance="$3"
  local tmp_dir="$4"
  local region="$5"
  local prefix="${tmp_dir}/${env_name}"

  log "Inspecting ${env_name}: project=${project}, region=${region}"

  write_json_or_empty "${prefix}-subnets.json" \
    gcloud compute networks subnets list --project "${project}" --format=json
  write_json_or_empty "${prefix}-routes.json" \
    gcloud compute routes list --project "${project}" --format=json
  write_json_or_empty "${prefix}-addresses.json" \
    gcloud compute addresses list --project "${project}" --format=json
  write_json_or_empty "${prefix}-peerings.json" \
    gcloud compute networks peerings list --network=default --project "${project}" --format=json
  write_json_or_empty "${prefix}-routers.json" \
    gcloud compute routers list --project "${project}" --regions="${region}" --format=json
  write_json_or_empty "${prefix}-vpn-gateways.json" \
    gcloud compute vpn-gateways list --project "${project}" --regions="${region}" --format=json
  write_json_or_empty "${prefix}-vpn-tunnels.json" \
    gcloud compute vpn-tunnels list --project "${project}" --regions="${region}" --format=json

  run_or_note "${env_name} networks" \
    gcloud compute networks list --project "${project}" --format="table(name,autoCreateSubnetworks,routingConfig.routingMode)"
  run_or_note "${env_name} subnets" \
    gcloud compute networks subnets list --project "${project}" --format="table(name,region,network,ipCidrRange,purpose,role,privateIpGoogleAccess)"
  run_or_note "${env_name} routes" \
    gcloud compute routes list --project "${project}" --format="table(name,destRange,nextHopGateway,nextHopVpnTunnel,priority)"
  run_or_note "${env_name} peerings" \
    gcloud compute networks peerings list --network=default --project "${project}" --format="table(name,peerNetwork,state,exportCustomRoutes,importCustomRoutes)"
  run_or_note "${env_name} Cloud SQL ${db_instance}" \
    gcloud sql instances describe "${db_instance}" --project "${project}" --format="table(name,region,settings.ipConfiguration.privateNetwork,ipAddresses[].type,ipAddresses[].ipAddress)"
  run_or_note "${env_name} Cloud Run consent-protocol" \
    gcloud run services describe consent-protocol --project "${project}" --region "${region}" --format="table(metadata.annotations['run.googleapis.com/ingress'],status.url,spec.template.metadata.annotations['run.googleapis.com/cloudsql-instances'])"
  run_or_note "${env_name} Cloud Run hushh-webapp" \
    gcloud run services describe hushh-webapp --project "${project}" --region "${region}" --format="table(metadata.annotations['run.googleapis.com/ingress'],status.url)"

  if api_enabled "${project}" "dns.googleapis.com"; then
    run_or_note "${env_name} Cloud DNS zones" \
      gcloud dns managed-zones list --project "${project}" --format="table(name,dnsName,visibility,privateVisibilityConfig.networks[].networkUrl)"
    run_or_note "${env_name} Cloud DNS policies" \
      gcloud dns policies list --project "${project}" --format="table(name,enableInboundForwarding,networks[].networkUrl)"
  else
    log "${env_name} Cloud DNS API is not enabled"
  fi

  if api_enabled "${project}" "vpcaccess.googleapis.com"; then
    run_or_note "${env_name} Serverless VPC Access connectors" \
      gcloud compute networks vpc-access connectors list --project "${project}" --region "${region}" --format="table(name,region,network,ipCidrRange,state)"
  else
    log "${env_name} Serverless VPC Access API is not enabled"
  fi
}

check_overlaps() {
  local tmp_dir="$1"
  python3 - "$tmp_dir" <<'PY'
import ipaddress
import json
import os
import pathlib
import sys

tmp_dir = pathlib.Path(sys.argv[1])

proposed = {
    "nonprod_mulesoft": os.environ.get("NONPROD_MULESOFT_CIDR", "10.81.0.0/22"),
    "prod_mulesoft": os.environ.get("PROD_MULESOFT_CIDR", "10.91.0.0/22"),
    "nonprod_hussh_service": os.environ.get("NONPROD_HUSSH_SERVICE_CIDR", "10.88.0.0/24"),
    "nonprod_hussh_proxy": os.environ.get("NONPROD_HUSSH_PROXY_CIDR", "10.88.1.0/24"),
    "prod_hussh_service": os.environ.get("PROD_HUSSH_SERVICE_CIDR", "10.98.0.0/24"),
    "prod_hussh_proxy": os.environ.get("PROD_HUSSH_PROXY_CIDR", "10.98.1.0/24"),
}

for idx, cidr in enumerate(filter(None, os.environ.get("NONPROD_MULESOFT_EXTRA_CIDRS", "").split(",")), start=1):
    proposed[f"nonprod_mulesoft_extra_{idx}"] = cidr.strip()

for idx, cidr in enumerate(filter(None, os.environ.get("PROD_MULESOFT_EXTRA_CIDRS", "").split(",")), start=1):
    proposed[f"prod_mulesoft_extra_{idx}"] = cidr.strip()

disallowed = {
    "mulesoft_disallowed_100_64": "100.64.0.0/10",
    "mulesoft_disallowed_198_19": "198.19.0.0/16",
    "mulesoft_disallowed_multicast": "224.0.0.0/4",
    "mulesoft_disallowed_link_local": "169.254.0.0/16",
    "mulesoft_disallowed_loopback": "127.0.0.0/8",
    "mulesoft_disallowed_docker": "172.17.0.0/16",
    "mulesoft_disallowed_this_network": "0.0.0.0/8",
}

current = {}
for path in tmp_dir.glob("*-subnets.json"):
    env = path.name.removesuffix("-subnets.json")
    for item in json.loads(path.read_text() or "[]"):
        cidr = item.get("ipCidrRange")
        name = item.get("name") or "subnet"
        if cidr:
            current[f"{env}_subnet_{name}"] = {
                "type": "subnet",
                "env": env,
                "name": name,
                "cidr": cidr,
            }

for path in tmp_dir.glob("*-routes.json"):
    env = path.name.removesuffix("-routes.json")
    for item in json.loads(path.read_text() or "[]"):
        cidr = item.get("destRange")
        name = item.get("name") or "route"
        if cidr and cidr != "0.0.0.0/0":
            current[f"{env}_route_{name}"] = {
                "type": "route",
                "env": env,
                "name": name,
                "cidr": cidr,
            }

expected_existing_subnets = {
    "nonprod_hussh_service": [
        ("nonprod", os.environ.get("NONPROD_HUSSH_SERVICE_SUBNET_NAME", "hushh-mulesoft-np-services-us-east5")),
        ("nonprod", "hushh-mulesoft-np-services-us-central1"),
    ],
    "nonprod_hussh_proxy": [
        ("nonprod", os.environ.get("NONPROD_HUSSH_PROXY_SUBNET_NAME", "hushh-mulesoft-np-proxy-us-east5")),
        ("nonprod", "hushh-mulesoft-np-proxy-us-central1"),
    ],
    "prod_hussh_service": [
        ("prod", os.environ.get("PROD_HUSSH_SERVICE_SUBNET_NAME", "hushh-mulesoft-prod-services-v2-us-east5")),
    ],
    "prod_hussh_proxy": [
        ("prod", os.environ.get("PROD_HUSSH_PROXY_SUBNET_NAME", "hushh-mulesoft-prod-proxy-v2-us-east5")),
    ],
}

def is_expected_existing_foundation(pname: str, item: dict, pcidr: str) -> bool:
    expected_subnets = expected_existing_subnets.get(pname)
    if not expected_subnets:
        return False

    if item["cidr"] != pcidr:
        return False

    if item["type"] == "subnet" and any(
        item["env"] == expected_env and item["name"] == expected_subnet
        for expected_env, expected_subnet in expected_subnets
    ):
        return True

    # GCP creates an opaque local route for each subnet. An exact route match for
    # the expected subnet CIDR is normal after the foundation has been applied.
    return item["type"] == "route" and any(
        item["env"] == expected_env for expected_env, _ in expected_subnets
    )

failures = []
for pname, pcidr in proposed.items():
    pnet = ipaddress.ip_network(pcidr)
    for dname, dcidr in disallowed.items():
        if pnet.overlaps(ipaddress.ip_network(dcidr)):
            failures.append(f"{pname} {pcidr} overlaps {dname} {dcidr}")
    for cname, item in current.items():
        ccidr = item["cidr"]
        try:
            cnet = ipaddress.ip_network(ccidr)
        except ValueError:
            continue
        if is_expected_existing_foundation(pname, item, pcidr):
            continue
        if pnet.overlaps(cnet):
            failures.append(f"{pname} {pcidr} overlaps current {cname} {ccidr}")

print()
print("[mulesoft-inventory] Proposed CIDR overlap check")
if failures:
    for failure in failures:
        print(f"ERROR: {failure}")
    sys.exit(1)

for name, cidr in proposed.items():
    print(f"OK: {name} {cidr}")
PY
}

require_cmd gcloud
require_cmd python3

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

log "gcloud account/project"
gcloud config list --format="value(core.account,core.project)"

inspect_project "nonprod" "${NONPROD_PROJECT}" "${NONPROD_DB_INSTANCE}" "${TMP_DIR}" "${NONPROD_REGION}"
inspect_project "prod" "${PROD_PROJECT}" "${PROD_DB_INSTANCE}" "${TMP_DIR}" "${PROD_REGION}"
check_overlaps "${TMP_DIR}"
