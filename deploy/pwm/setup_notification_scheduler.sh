#!/usr/bin/env bash
set -euo pipefail
# UAT-only metadata outbox wake. Model/key authority never goes to Scheduler.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IFS=$'\t' read -r PWM_PROJECT PWM_ORIGIN PWM_ACCOUNT PWM_JOB PWM_LOCATION < <(
  python3 - "$ROOT/consent-protocol" <<'PYCONFIG'
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('pwm_config', pathlib.Path(sys.argv[1]) / 'hushh_mcp' / 'managed_ai_config.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
s = module.load_pwm_policy()['notification_scheduler']
print('\t'.join(s[k] for k in ('project','audience','service_account','job','location')))
PYCONFIG
)
: "${PWM_PROJECT:?Missing scheduler configuration}"
ARGS=(--project="$PWM_PROJECT" --location="$PWM_LOCATION")
COMMON=("${ARGS[@]}" --schedule='* * * * *' --time-zone=Etc/UTC --uri="$PWM_ORIGIN/api/internal/pwm-notifications/drain" --http-method=POST --oidc-service-account-email="$PWM_ACCOUNT" --oidc-token-audience="$PWM_ORIGIN" --attempt-deadline=180s --max-retry-attempts=3 --min-backoff=10s --max-backoff=120s)
if [[ "${DRY_RUN:-0}" == 1 ]]; then
  printf '%s\n' "PWM scheduler: $PWM_JOB, $PWM_ORIGIN, OIDC $PWM_ACCOUNT, enabled=${ONE_PROFILE_RESEARCH_ENABLED:-false}"
  exit 0
fi
# A failed list is an error; only a successful empty response means absence.
STATE="$(gcloud scheduler jobs list "${ARGS[@]}" --filter="name=projects/$PWM_PROJECT/locations/$PWM_LOCATION/jobs/$PWM_JOB" --format='value(state)')"
if [[ "${ONE_PROFILE_RESEARCH_ENABLED:-false}" != true ]]; then
  if [[ -n "$STATE" ]]; then
    if [[ "$STATE" != PAUSED ]]; then
      gcloud scheduler jobs pause "$PWM_JOB" "${ARGS[@]}" >/dev/null
    fi
    ACTUAL="$(gcloud scheduler jobs describe "$PWM_JOB" "${ARGS[@]}" --format='value(state)')"
    [[ "$ACTUAL" == PAUSED ]] || { echo 'PWM scheduler pause verification failed' >&2; exit 1; }
  fi
  echo "PWM notification scheduler disabled (state=${STATE:-absent})."
  exit 0
fi
if ! gcloud iam service-accounts describe "$PWM_ACCOUNT" --project="$PWM_PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${PWM_ACCOUNT%%@*}" --project="$PWM_PROJECT" --display-name='PWM notification scheduler' >/dev/null
fi
if [[ -n "$STATE" ]]; then
  gcloud scheduler jobs update http "$PWM_JOB" "${COMMON[@]}" --update-headers='Content-Type=application/json' >/dev/null
else
  gcloud scheduler jobs create http "$PWM_JOB" "${COMMON[@]}" --headers='Content-Type=application/json' >/dev/null
fi
if [[ "$STATE" == PAUSED ]]; then
  gcloud scheduler jobs resume "$PWM_JOB" "${ARGS[@]}" >/dev/null
fi
ACTUAL="$(gcloud scheduler jobs describe "$PWM_JOB" "${ARGS[@]}" --format='value(state,httpTarget.uri,httpTarget.oidcToken.serviceAccountEmail,httpTarget.oidcToken.audience,httpTarget.httpMethod,schedule,timeZone)')"
EXPECTED="ENABLED"$'\t'"$PWM_ORIGIN/api/internal/pwm-notifications/drain"$'\t'"$PWM_ACCOUNT"$'\t'"$PWM_ORIGIN"$'\t'"POST"$'\t'"* * * * *"$'\t'"Etc/UTC"
[[ "$ACTUAL" == "$EXPECTED" ]] || { echo 'PWM scheduler verification failed' >&2; exit 1; }
gcloud scheduler jobs describe "$PWM_JOB" "${ARGS[@]}" --format=json
echo 'PWM notification scheduler configured and verified.'
