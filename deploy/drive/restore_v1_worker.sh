#!/usr/bin/env bash
set -euo pipefail

# Restore the isolated V1 lane after its rollout or a later paired release fails.
# Existing generic worker and the three operator-paused jobs are never touched.
readonly PROJECT_ID="hushh-pda-uat"
readonly REGION="us-central1"
readonly SERVICE="consent-protocol-drive-v1-worker"
readonly SCHEDULER_ID="drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
snapshot="${1:?V1 scheduler snapshot required}"
previous_revision="${2:-}"
if [[ ! -s "${snapshot}" ]] || [[ -n "${previous_revision}" && ! "${previous_revision}" =~ ^consent-protocol-drive-v1-worker-[a-z0-9-]+$ ]]; then
  echo "V1 rollback inputs are invalid" >&2
  exit 1
fi

# Stop new dispatch before changing serving traffic. The snapshot restorer
# resumes the job only if it was enabled before this release.
python3 deploy/drive/v1_scheduler_state.py quarantine
if [[ -n "${previous_revision}" ]]; then
  gcloud run services update-traffic "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --to-revisions="${previous_revision}=100" --quiet >/dev/null
  actual_revision="$(gcloud run services describe "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format=json \
    | python3 -c 'import json,sys; traffic=(json.load(sys.stdin).get("status") or {}).get("traffic") or []; serving=[row.get("revisionName") for row in traffic if row.get("percent")==100]; print(serving[0] if len(serving)==1 else "")')"
  if [[ "${actual_revision}" != "${previous_revision}" ]]; then
    echo "V1 worker prior serving revision was not restored" >&2
    exit 1
  fi
else
  # A first release has no prior revision; leave the private candidate idle.
  # Revoke the sole scheduler invoker grant before deleting the new job.
  gcloud run services remove-iam-policy-binding "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" \
    --member="serviceAccount:${SCHEDULER_ID}" \
    --role=roles/run.invoker --quiet >/dev/null 2>&1 || true
  gcloud run services get-iam-policy "${SERVICE}" \
    --project="${PROJECT_ID}" --region="${REGION}" --format=json \
    | python3 -c 'import json,sys; p=json.load(sys.stdin); m="serviceAccount:drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"; assert not any(b.get("role")=="roles/run.invoker" and m in b.get("members",[]) for b in p.get("bindings",[])), "V1 scheduler invoker grant remains"'
fi
python3 deploy/drive/v1_scheduler_state.py restore --snapshot "${snapshot}"
echo "V1 worker and scheduler returned to their pre-release state"
