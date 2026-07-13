#!/usr/bin/env bash
# Poll an HTTP endpoint until it is *stably* healthy or the time budget is spent.
#
# A crash-looping Cloud Run revision passes its TCP startup probe (so the
# control plane reports it "healthy") yet fails when it actually serves
# requests, flapping between 200 and 503. Requiring several *consecutive*
# successes distinguishes a genuinely healthy revision from a flapping one,
# while the attempt budget tolerates a normal cold-start warmup.
#
# Usage:
#   cloudrun-http-health.sh <base_url> [path] [need_consecutive] [max_attempts] [sleep_seconds] [expected_status]
#
# Defaults: path=/health need_consecutive=5 max_attempts=30 sleep_seconds=5 expected_status=200
# Exit 0 when <need_consecutive> consecutive <expected_status> responses are observed; exit 1 otherwise.
set -euo pipefail

BASE_URL="${1:-}"
PATH_SUFFIX="${2:-/health}"
NEED_CONSECUTIVE="${3:-5}"
MAX_ATTEMPTS="${4:-30}"
SLEEP_SECONDS="${5:-5}"
EXPECTED_STATUS="${6:-200}"

if [[ "$BASE_URL" == "-h" || "$BASE_URL" == "--help" ]]; then
  echo "Usage: $0 <base_url> [path] [need_consecutive] [max_attempts] [sleep_seconds] [expected_status]" >&2
  exit 0
fi

if [[ -z "$BASE_URL" ]]; then
  echo "Usage: $0 <base_url> [path] [need_consecutive] [max_attempts] [sleep_seconds] [expected_status]" >&2
  exit 1
fi

url="${BASE_URL%/}${PATH_SUFFIX}"
consecutive=0
attempt=0
last_code="none"

echo "Probing ${url}: need ${NEED_CONSECUTIVE} consecutive ${EXPECTED_STATUS} within ${MAX_ATTEMPTS} attempts (${SLEEP_SECONDS}s apart)"

while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null || echo 000)"
  last_code="$code"
  if [ "$code" = "$EXPECTED_STATUS" ]; then
    consecutive=$((consecutive + 1))
    echo "  attempt ${attempt}/${MAX_ATTEMPTS}: ${code} (consecutive ${consecutive}/${NEED_CONSECUTIVE})"
    if [ "$consecutive" -ge "$NEED_CONSECUTIVE" ]; then
      echo "HEALTHY: ${url} returned ${EXPECTED_STATUS} ${NEED_CONSECUTIVE} times in a row"
      exit 0
    fi
  else
    if [ "$consecutive" -gt 0 ]; then
      echo "  attempt ${attempt}/${MAX_ATTEMPTS}: ${code} (streak reset from ${consecutive})"
    else
      echo "  attempt ${attempt}/${MAX_ATTEMPTS}: ${code}"
    fi
    consecutive=0
  fi
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    sleep "$SLEEP_SECONDS"
  fi
done

echo "UNHEALTHY: ${url} never reached ${NEED_CONSECUTIVE} consecutive ${EXPECTED_STATUS} responses (last=${last_code})" >&2
exit 1
