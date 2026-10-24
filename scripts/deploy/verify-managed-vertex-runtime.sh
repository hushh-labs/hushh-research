#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Candidate probe logic; Cloud Build supplies its explicit environment.

set -euo pipefail
finish_provider_probe() {
  probe_status=$?
  trap - EXIT
  record_status=0
  READINESS_STEP_EXIT="${probe_status}" python3 scripts/ci/managed_provider_readiness.py record --provider=vertex --job="${job_name:-}" || record_status=$?
  if [[ -n "${job_name:-}" ]]; then
    gcloud run jobs delete "${job_name}" --project="$PROJECT_ID" --region="${_REGION}" --quiet >/dev/null 2>&1 || true
  fi
  # UAT's required aggregate validates both collected providers after deployment.
  # Other environments retain their original predeployment Vertex gate.
  if [[ "${_DEPLOY_ENV}" == "uat" ]]; then exit 0; fi
  if [[ "${record_status}" != "0" ]]; then exit "${record_status}"; fi
  exit "${probe_status}"
}
trap finish_provider_probe EXIT
if [[ "${_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE:-false}" == "true" ]]; then
  echo "WARNING: user-authorized one-time UAT Vertex probe skip; managed Chat and Voice are unverified by this release gate."
  exit 0
fi
case "${_VERIFY_MANAGED_VERTEX_RUNTIME}" in
  true) probe_mode=full ;;
  false)
    echo "Skipping managed Vertex candidate probe: live model checks were not requested."
    exit 0
    ;;
  *)
    echo "_VERIFY_MANAGED_VERTEX_RUNTIME must be true or false." >&2
    exit 1
    ;;
esac
genai_project_id="${_GENAI_PROJECT_ID}"
if [[ -z "${genai_project_id}" ]]; then
  genai_project_id="$(python3 -c 'import json,sys; print(json.load(open("consent-protocol/config/managed-ai-runtime.json"))["environments"][sys.argv[1]]["project"])' "${_DEPLOY_ENV}")"
fi
image_reference="${_IMAGE_REFERENCE}"
if [[ -z "${image_reference}" ]]; then
  image_reference="gcr.io/$PROJECT_ID/consent-protocol:${_IMAGE_TAG}"
fi
# One job per Cloud Build keeps a concurrent execution from replacing
# this build's verdict while Cloud Logging is ingesting it.
job_name="genai-ready-${BUILD_ID}"
# Only the configured signing/vault references required by packaged imports;
# no inherited secrets, customer prompts or state enter this synthetic probe.
gcloud run jobs deploy "${job_name}" \
  --project="$PROJECT_ID" \
  --region="${_REGION}" \
  --image="${image_reference}" \
  --service-account="${_RUNTIME_SERVICE_ACCOUNT}" \
  --set-secrets="APP_SIGNING_KEY=${_APP_SIGNING_KEY_SECRET}:latest,VAULT_DATA_KEY=${_VAULT_DATA_KEY_SECRET}:latest" \
  --command="python3" \
  --args="scripts/verify_managed_vertex_runtime.py" \
  --set-env-vars="^|^HUSHH_GENAI_AUTH_MODE=vertex_adc|GOOGLE_GENAI_USE_VERTEXAI=true|GOOGLE_CLOUD_PROJECT=${PROJECT_ID}|GENAI_GOOGLE_CLOUD_PROJECT=${genai_project_id}|HUSHH_ONE_CHAT_VERTEX_PROJECT=${_HUSHH_ONE_CHAT_VERTEX_PROJECT}|HUSHH_ONE_VOICE_VERTEX_PROJECT=${_HUSHH_ONE_VOICE_VERTEX_PROJECT}|HUSHH_MANAGED_VERTEX_PROBE_MODE=${probe_mode}|HUSHH_UAT_MANAGED_AI_PROVIDER=vertex|HUSHH_UAT_MANAGED_TEXT_PROVIDER=vertex|ENVIRONMENT=${_DEPLOY_ENV}|HUSSH_GEMINI_TEXT_MODEL=${_HUSSH_GEMINI_TEXT_MODEL}|ONE_VOICE_LIVE_ENABLED=${_ONE_VOICE_LIVE_ENABLED}|VERTEX_LIVE_MODEL_ID=${_VERTEX_LIVE_MODEL_ID}|VERTEX_LIVE_LOCATION=${_VERTEX_LIVE_LOCATION}" \
  --cpu=2 \
  --memory=2Gi \
  --max-retries=0 \
  --task-timeout=420s \
  --quiet
set +e
gcloud run jobs execute "${job_name}" \
  --project="$PROJECT_ID" \
  --region="${_REGION}" \
  --wait \
  --quiet
execute_status=$?
set -e
# `gcloud run jobs execute` surfaces the execution's exit STATUS only --
# the probe's stdout lands in Cloud Logging, not in this build log. So
# the verdict has to be read back from the job's logs before we can tell
# a provider outage from a candidate defect.
#
# The job name is unique to this build. Scope the read to its execution:
# Cloud Logging ingestion lags the job's exit by seconds, so a job-name
# only query could otherwise recover an earlier retry's verdict.
# Observed 2026-08-20: a run whose 9 probes all classified
# provider_unavailable was failed on the prior run's application_broken.
execution_name="$(gcloud run jobs executions list \
  --job="${job_name}" \
  --project="$PROJECT_ID" \
  --region="${_REGION}" \
  --limit=1 \
  --sort-by='~metadata.creationTimestamp' \
  --format='value(metadata.name)' 2>/dev/null || true)"

probe_line=""
if [[ -n "${execution_name}" ]]; then
  # Ingestion lag is normally a few seconds; wait bounded rather than
  # guessing, because an empty read is treated as blocking below.
  for _attempt in 1 2 3 4 5 6; do
    probe_line="$(gcloud logging read \
      "resource.type=cloud_run_job AND labels.\"run.googleapis.com/execution_name\"=\"${execution_name}\" AND textPayload:managed_vertex_probe_result" \
      --project="$PROJECT_ID" \
      --limit=1 \
      --format='value(textPayload)' \
      --freshness=1h 2>/dev/null || true)"
    if [[ -n "${probe_line}" ]]; then
      break
    fi
    sleep 10
  done
fi
echo "Probe execution: ${execution_name:-unknown}"
classification="$(
  PROBE_LINE="${probe_line}" python3 - <<'PY'
import json
import os

line = os.environ.get("PROBE_LINE", "")
marker = "managed_vertex_probe_result"
payload = line.split(marker, 1)[1].strip() if marker in line else line
try:
    verdict = json.loads(payload)
except json.JSONDecodeError:
    print("")
else:
    print(str(verdict.get("classification") or ""))
PY
)"

# Keep main's tightly qualified Azure UAT resource-exhaustion disposition. This
# is not a general provider-outage waiver; the receipt evaluator checks every probe.
if [[ "${_DEPLOY_ENV}" == "uat" && "$PROJECT_ID" == "hushh-pda-uat" &&
      "${_CLOUD_RUN_NO_TRAFFIC:-false}" == "true" &&
      "${_DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER:-gemini}" == "azure_openai" &&
      "${_DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED:-false}" == "true" &&
      "${genai_project_id}" != "$PROJECT_ID" ]]; then
  pwm_provider="$(python3 - <<'PYCONFIG'
import json
from pathlib import Path
config = json.loads(Path("consent-protocol/config/managed-ai-runtime.json").read_text())
print(config.get("pwm_research_uat", config["pwm_research"])["provider"])
PYCONFIG
  )"
  if [[ "${pwm_provider}" == "azure_openai_web_search" || "${pwm_provider}" == "azure_openai_tavily" ]]; then
    disposition="$(DEPLOY_ENV="${_DEPLOY_ENV}" PROBE_LINE="${probe_line}" EXPECTED_CONFIG_HASH="${_MANAGED_AI_CONFIG_HASH}" \
      EXPECTED_CHAT_PROJECT="${genai_project_id}" VOICE_ENABLED="${_ONE_VOICE_LIVE_ENABLED}" \
      EXPECTED_VOICE_MODEL="${_VERTEX_LIVE_MODEL_ID}" EXPECTED_VOICE_LOCATION="${_VERTEX_LIVE_LOCATION}" \
      EXECUTE_STATUS="${execute_status}" AZURE_UAT_RESOURCE_EXHAUSTION=true \
      python3 scripts/ci/assert_uat_managed_vertex_probe.py)"
    if [[ "${disposition}" == "resource_exhausted" ]]; then
      echo "UAT Azure receipt accepted; Vertex remains unverified due to explicit resource exhaustion."
      exit 0
    fi
  fi
fi

# A successful release must prove that production's enabled One Voice
# can open its pinned Live session before the candidate gets traffic.
# The general provider-outage advisory still applies to other probes.
if [[ "${_DEPLOY_ENV}" == "production" && "${_ONE_VOICE_LIVE_ENABLED}" == "true" ]]; then
  printf '%s\n' "${probe_line}" | python3 scripts/ci/assert_one_voice_live_probe.py \
    --model "${_VERTEX_LIVE_MODEL_ID}" \
    --location "${_VERTEX_LIVE_LOCATION}"
fi
if [[ -n "${_MANAGED_AI_CONFIG_HASH}" ]]; then
  DEPLOY_ENV="${_DEPLOY_ENV}" PROBE_LINE="${probe_line}" EXPECTED_CONFIG_HASH="${_MANAGED_AI_CONFIG_HASH}" EXPECTED_CHAT_PROJECT="${_GENAI_PROJECT_ID}" python3 - <<'PY'
import json
import os

line = os.environ.get("PROBE_LINE", "")
marker = "managed_vertex_probe_result"
try:
    verdict = json.loads(line.split(marker, 1)[1].strip())
except (IndexError, json.JSONDecodeError):
    raise SystemExit("One chat Vertex readiness verdict is missing") from None
if verdict.get("config_hash") != os.environ["EXPECTED_CONFIG_HASH"]:
    raise SystemExit("Candidate image managed AI profile does not match deployment")
scope_field = "drive_document_requests_probe_ok" if os.environ["DEPLOY_ENV"] == "uat" else "one_chat_probe_ok"
if verdict.get("one_chat_project") != os.environ["EXPECTED_CHAT_PROJECT"] or verdict.get(scope_field) is not True:
    raise SystemExit("Vertex target did not pass its scoped runtime-identity probe")
PY
fi
if [[ "${_ONE_VOICE_LIVE_ENABLED}" == "true" ]]; then
  PROBE_LINE="${probe_line}" EXPECTED_VOICE_PROJECT="${_GENAI_PROJECT_ID}" EXPECTED_VOICE_MODEL="${_VERTEX_LIVE_MODEL_ID}" EXPECTED_VOICE_LOCATION="${_VERTEX_LIVE_LOCATION}" python3 - <<'PY'
import json
import os

line = os.environ.get("PROBE_LINE", "")
marker = "managed_vertex_probe_result"
try:
    verdict = json.loads(line.split(marker, 1)[1].strip())
except (IndexError, json.JSONDecodeError):
    raise SystemExit("One voice Vertex readiness verdict is missing") from None
if (
    verdict.get("one_voice_project") != os.environ["EXPECTED_VOICE_PROJECT"]
    or verdict.get("live_model") != os.environ["EXPECTED_VOICE_MODEL"]
    or verdict.get("live_location") != os.environ["EXPECTED_VOICE_LOCATION"]
    or verdict.get("one_voice_probe_ok") is not True
):
    raise SystemExit("One voice Vertex target did not pass its runtime-identity probe")
PY
fi
# This lane replaces cross-project administrative reads with positive
# capability evidence. It must never accept the legacy outage advisory.
if [[ "${_DEPLOY_ENV}" == "uat" && "${genai_project_id}" != "$PROJECT_ID" ]]; then
  if [[ "${execute_status}" -ne 0 ]]; then
    echo "Required UAT runtime-identity probe execution failed." >&2
    exit 1
  fi
  PROBE_LINE="${probe_line}" python3 - <<'PY'
import json
import os

try:
    verdict = json.loads(os.environ["PROBE_LINE"].split("managed_vertex_probe_result", 1)[1].strip())
except (IndexError, json.JSONDecodeError):
    raise SystemExit("Required UAT runtime probe verdict is missing") from None
probes = verdict.get("probes")
if (
    verdict.get("check") != "managed_vertex_runtime"
    or verdict.get("ok") is not True
    or verdict.get("classification") != "dependency_ok"
    or verdict.get("candidate_models_exercised") is not True
    or not isinstance(probes, list)
    or not probes
    or any(not isinstance(probe, dict) or probe.get("ok") is not True
           or probe.get("classification") != "dependency_ok" for probe in probes)
):
    raise SystemExit("Required UAT runtime probe did not fully pass")
PY
fi
if [[ "${execute_status}" -eq 0 ]]; then
  echo "Managed Vertex candidate probe passed."
  exit 0
fi

if [[ "${classification}" == "provider_unavailable" ]]; then
  echo "::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::"
  echo "WARNING  Managed Vertex is UNAVAILABLE (provider-side)."
  echo "         The candidate image built; deployment remains gated. The"
  echo "         provider refused every probe. Release CONTINUES in"
  echo "         degraded mode. Vertex-backed capabilities will not work"
  echo "         until the provider recovers."
  echo "         Probe verdict: ${probe_line}"
  echo "         NOTE: a provider denial is returned before model"
  echo "         validation, so this run did NOT clear the candidate's"
  echo "         model configuration. Re-probe once the provider is back."
  echo "::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::"
  exit 0
fi

echo "Managed Vertex candidate probe FAILED and the cause is not a provider outage." >&2
if [[ -n "${probe_line}" ]]; then
  echo "Probe verdict: ${probe_line}" >&2
else
  echo "No probe verdict was recoverable from the job logs; treating as blocking." >&2
fi
exit 1
