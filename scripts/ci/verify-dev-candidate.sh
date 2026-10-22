#!/usr/bin/env bash
# Verify one exact no-traffic revision before the workflow promotes either service.
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: verify-dev-candidate.sh <project> <region> <service> <revision> <image-reference> <sha> <run-id> <tag> <probe-path>"
  echo "Commerce preview requires CANDIDATE_ID_TOKEN from the workflow's workload identity."
  exit 0
fi
project="${1:?project}"; region="${2:?region}"; service="${3:?service}"
revision="${4:?revision}"; image="${5:?image}"; sha="${6:?sha}"
run_id="${7:?run id}"; tag="${8:?tag}"; probe_path="${9:?probe path}"
python_bin="${PROTOCOL_PYTHON:-python3}"
report="/tmp/dev-candidate-${service}.json"
verify=("$python_bin" scripts/ci/verify-cloudrun-revision-provenance.py
  --project "$project" --region "$region" --service "$service"
  --candidate-revision "$revision" --expected-image-reference "$image"
  --expected-env dev --expected-source deploy-dev --expected-sha "$sha"
  --expected-run-id "$run_id" --report-path "$report")
"${verify[@]}"
# Tag updates do not change traffic weights. Never use --to-latest here.
gcloud run services update-traffic "$service" --project="$project" --region="$region" \
  --update-tags="${tag}=${revision}" --quiet
"${verify[@]}" --candidate-tag "$tag"
candidate_url="$($python_bin -c 'import json,sys; print(json.load(open(sys.argv[1]))["candidate_url"])' "$report")"
authentication="anonymous"
if [[ "${DEV_TARGET:-shared-dev}" == "scope-commerce-sandbox" ]]; then
  [[ "$project" == hushh-pda-dev && "$region" == us-central1 &&
    ( "$service" == consent-protocol-commerce-sandbox || "$service" == hushh-webapp-commerce-sandbox ) &&
    -n "${CANDIDATE_ID_TOKEN:-}" ]] || { echo "Preview probe identity missing or target invalid." >&2; exit 1; }
  [[ "$CANDIDATE_ID_TOKEN" != *$'\n'* && "$CANDIDATE_ID_TOKEN" != *$'\r'* &&
    "$CANDIDATE_ID_TOKEN" != *'"'* && "$CANDIDATE_ID_TOKEN" != *'\\'* ]] || exit 1
  authentication="workload_identity"
elif [[ -n "${CANDIDATE_ID_TOKEN:-}" ]]; then
  echo "Refusing identity token outside the fixed preview." >&2; exit 1
fi
record_health() {
  "$python_bin" -c 'import json,sys; from pathlib import Path
p=Path(sys.argv[1]); report=json.loads(p.read_text())
report["http_health"]={"status_code":sys.argv[2],"attempts":int(sys.argv[3]),"authentication":sys.argv[4]}
if sys.argv[2] != "200": report.update(ok=False,status="blocked")
p.write_text(json.dumps(report,indent=2,sort_keys=True))' "$report" "$code" "$attempt" "$authentication"
}
for attempt in 1 2 3 4 5; do
  # A redirect is not proof of candidate health. Do not follow it to the live service.
  # Pass the token through stdin, never command arguments, traces or receipts.
  code="$(if [[ "$authentication" == workload_identity ]]; then
    printf 'header = "X-Serverless-Authorization: Bearer %s"\n' "$CANDIDATE_ID_TOKEN"
  fi | curl --config - --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' \
    "${candidate_url%/}${probe_path}" || true)"
  if [[ "$code" == 200 ]]; then
    record_health
    exit 0
  fi
  if [[ "$attempt" != 5 ]]; then sleep 3; fi
done
record_health
echo "Candidate HTTP health failed for ${service}." >&2
exit 1
