#!/usr/bin/env bash
set -euo pipefail

# The worker was verified before backend traffic shifted. If the paired app
# release later fails, restore its exact prior Scheduler set and worker traffic.
readonly PROJECT_ID="hushh-pda"
readonly REGION="us-central1"
readonly SERVICE="consent-protocol-drive-worker"
readonly SNAPSHOT="/tmp/prod-drive-scheduler-before.json"

previous_revision="${1:-}"
worker_url="${2:?worker URL required}"
if [[ "${GCP_PROJECT_ID:-}" != "${PROJECT_ID}" \
  || ! -f "${SNAPSHOT}" \
  || ( -n "${previous_revision}" && ! "${previous_revision}" =~ ^consent-protocol-drive-worker-[a-z0-9-]+$ ) \
  || ! "${worker_url}" =~ ^https://consent-protocol-drive-worker-[a-z0-9-]+\.a\.run\.app$ ]]; then
  echo "Production Drive rollback inputs are outside the reviewed boundary" >&2
  exit 1
fi

restore_failed=false
if ! python3 deploy/drive/work_drain_scheduler_snapshot_prod.py restore \
  --snapshot "${SNAPSHOT}" --worker-origin "${worker_url}"; then
  restore_failed=true
fi
if [[ "${restore_failed}" == true ]]; then
  # Preserve the old worker revision even when the exact scheduler snapshot
  # cannot be restored. Quarantine jobs first so no new work reaches it.
  python3 deploy/drive/work_drain_scheduler_snapshot_prod.py quarantine || true
  gcloud run services remove-iam-policy-binding "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --member="serviceAccount:drive-work-drain-sched@hushh-pda.iam.gserviceaccount.com" \
    --role=roles/run.invoker --quiet >/dev/null 2>&1 || true
fi

if [[ -n "${previous_revision}" ]]; then
  gcloud run revisions describe "${previous_revision}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format=json \
    | EXPECTED_REVISION="${previous_revision}" python3 -c '
import json, os, sys
data = json.load(sys.stdin)
metadata = data.get("metadata") or {}
conditions = (data.get("status") or {}).get("conditions") or []
if metadata.get("name") != os.environ["EXPECTED_REVISION"] or not any(
    row.get("type") == "Ready" and row.get("status") == "True" for row in conditions
):
    raise SystemExit("Previous production Drive worker revision is not ready")
'
  gcloud run services update-traffic "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --to-revisions="${previous_revision}=100" --quiet
  actual="$(gcloud run services describe "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format=json \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); t=(d.get("status") or {}).get("traffic") or []; r=[x.get("revisionName") for x in t if x.get("percent")==100]; print(r[0] if len(r)==1 else "")')"
  if [[ "${actual}" != "${previous_revision}" ]]; then
    echo "Production Drive worker traffic restoration could not be verified" >&2
    exit 1
  fi
elif [[ "${restore_failed}" == false ]]; then
  # A first release has no prior worker; the exact jobs are now absent and
  # the idle service remains private. Remove its Scheduler invoker grant.
  gcloud run services remove-iam-policy-binding "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --member="serviceAccount:drive-work-drain-sched@hushh-pda.iam.gserviceaccount.com" \
    --role=roles/run.invoker --quiet >/dev/null
fi

if [[ "${restore_failed}" == true ]]; then
  echo "Production Drive scheduler restoration failed; fixed jobs quarantined" >&2
  exit 1
fi
echo "Restored production Drive scheduler and worker to the pre-release state"
