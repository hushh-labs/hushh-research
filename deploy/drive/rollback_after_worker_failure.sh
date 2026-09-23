#!/usr/bin/env bash
set -euo pipefail

# A worker failure happens after the ordinary UAT candidate gate. Restore the
# verified pre-release app revision, but never cross the account-deletion
# migration boundary. The worker helper separately restores its scheduler.
readonly PROJECT_ID="hushh-pda-uat"
readonly REGION="us-central1"
readonly SERVICE="${1:?service required}"
readonly REVISION="${2:?last-known-good revision required}"

if [[ "${SERVICE}" != consent-protocol && "${SERVICE}" != hushh-webapp ]] \
  || [[ ! "${REVISION}" =~ ^[a-z][a-z0-9-]{1,62}$ ]] \
  || [[ "${GCP_PROJECT_ID:-}" != "${PROJECT_ID}" ]] \
  || [[ "${PREDEPLOY_DB_GATE_OUTCOME:-}" != success ]]; then
  echo "Refusing late UAT rollback without a fixed service, revision, project and proven DB gate" >&2
  exit 1
fi

gcloud run revisions describe "${REVISION}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format=json \
  | EXPECTED_SERVICE="${SERVICE}" EXPECTED_REVISION="${REVISION}" python3 -c '
import json, os, sys
revision=json.load(sys.stdin)
metadata=revision.get("metadata") or {}
labels=metadata.get("labels") or {}
conditions=(revision.get("status") or {}).get("conditions") or []
ready=any(item.get("type")=="Ready" and item.get("status")=="True" for item in conditions)
service=os.environ["EXPECTED_SERVICE"]
name=metadata.get("name")
if not ready or name!=os.environ["EXPECTED_REVISION"] or not name.startswith(service+"-"):
    raise SystemExit("Rollback revision is not a ready revision of the fixed UAT service")
if service=="consent-protocol" and labels.get("account-deletion-contract")!="v201":
    raise SystemExit("Refusing rollback across the account-deletion migration boundary")'

current="$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format=json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); t=(d.get("status") or {}).get("traffic") or []; r=[x.get("revisionName") for x in t if x.get("percent")==100]; print(r[0] if len(r)==1 else "")')"
if [[ -z "${current}" ]]; then
  echo "Refusing rollback from ambiguous serving traffic" >&2
  exit 1
fi
if [[ "${current}" != "${REVISION}" ]]; then
  gcloud run services update-traffic "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --to-revisions="${REVISION}=100" --quiet
fi
actual="$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" --region="${REGION}" --format=json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); t=(d.get("status") or {}).get("traffic") or []; r=[x.get("revisionName") for x in t if x.get("percent")==100]; print(r[0] if len(r)==1 else "")')"
if [[ "${actual}" != "${REVISION}" ]]; then
  echo "Late UAT rollback did not restore the requested revision" >&2
  exit 1
fi
echo "Verified ${SERVICE} restored to ${REVISION} after Drive worker failure"
