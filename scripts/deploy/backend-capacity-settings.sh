#!/usr/bin/env bash
# Sourced by backend-deploy.sh. Decode only shared-backend capacity settings;
# no cloud calls, credentials, provider routing or owner-pod policy.

# The Cloud Run capacity knobs arrive packed in one env entry (Cloud Build caps a
# step at 100 env entries; see deploy/backend.cloudbuild.yaml). Unpack them into
# the _CLOUD_RUN_* names the rest of this script reads, and refuse a missing key
# rather than defaulting it: a silently defaulted --max would resize a lane.
if [[ -n "${_CLOUD_RUN_CAPACITY:-}" ]]; then
  IFS=',' read -r -a _capacity_pairs <<<"${_CLOUD_RUN_CAPACITY}"
  for _pair in "${_capacity_pairs[@]}"; do
    _key="${_pair%%=*}"; _value="${_pair#*=}"
    case "${_key}" in
      max) _CLOUD_RUN_MAX_INSTANCES="${_value}" ;;
      min) _CLOUD_RUN_MIN_INSTANCES="${_value}" ;;
      no_traffic) _CLOUD_RUN_NO_TRAFFIC="${_value}" ;;
      cpu) _CLOUD_RUN_CPU="${_value}" ;;
      concurrency) _CLOUD_RUN_CONCURRENCY="${_value}" ;;
      scaling_target) _CLOUD_RUN_SCALING_CONCURRENCY_TARGET="${_value}" ;;
      *) echo "_CLOUD_RUN_CAPACITY carries an unknown key: ${_key}" >&2; exit 1 ;;
    esac
  done
  for _required in _CLOUD_RUN_MAX_INSTANCES _CLOUD_RUN_MIN_INSTANCES _CLOUD_RUN_NO_TRAFFIC _CLOUD_RUN_CPU _CLOUD_RUN_CONCURRENCY; do
    if [[ -z "${!_required:-}" ]]; then
      echo "_CLOUD_RUN_CAPACITY is missing ${_required}." >&2; exit 1
    fi
  done
  export _CLOUD_RUN_MAX_INSTANCES _CLOUD_RUN_MIN_INSTANCES _CLOUD_RUN_NO_TRAFFIC _CLOUD_RUN_CPU _CLOUD_RUN_CONCURRENCY
fi

target="${_CLOUD_RUN_SCALING_CONCURRENCY_TARGET:-}"
if [[ -n "$target" ]] && ! [[ "$target" =~ ^0\.(1[0-9]?|[2-8][0-9]?|9[0-5]?)$ ]]; then
  echo "Scaling concurrency target must be empty or 0.10 through 0.95 (at most two decimal places)." >&2
  exit 1
fi
