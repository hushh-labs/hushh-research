#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Validate and stage the independent production phone reader before a primary.

phone_deploy_phase_valid() {
  [[ "$1" == standard || "$1" == cold ]]
}

validate_phone_recovery_boolean() {
  [[ "$1" == true || "$1" == false ]] || {
    echo "Phone recovery requires an explicit boolean." >&2; return 1;
  }
}

validate_phone_rollback_image() {
  local fallback_sha="$1" fallback_image="$2"
  [[ -n "${fallback_sha}${fallback_image}" ]] || return 0
  [[ "${fallback_sha}" =~ ^[0-9a-f]{40}$ &&
     "${fallback_image}" =~ ^gcr\.io/hushh-pda/consent-protocol@sha256:[0-9a-f]{64}$ ]] || {
    echo "Invalid phone rollback image identity." >&2; return 1;
  }
}

stage_phone_rollback() {
  local fallback_sha="$1" fallback_image="$2" deploy_env="$3" project="$4" no_traffic="$5"
  shift 5
  [[ -n "${fallback_sha}" ]] || return 0
  [[ "${deploy_env}" == production && "${project}" == hushh-pda && "${no_traffic}" == true ]] || {
    echo "Phone fallback staging requires the governed production candidate lane." >&2; return 1;
  }
  python3 -c 'import json,sys; json.dump(sys.argv[1:],sys.stdout)' "$@" |
    python3 deploy/phone/cold_fallback.py "${fallback_sha}" "${fallback_image}" "${_PHONE_DEPLOY_PHASE:-standard}"
}

deploy_phone_phase() {
  local phase="$1" fallback_sha="$2" fallback_image="$3" deploy_env="$4" project="$5" no_traffic="$6"
  shift 6
  phone_deploy_phase_valid "${phase}" || {
    echo "Invalid phone deployment phase." >&2; return 1;
  }
  if [[ "${phase}" == cold ]]; then
    [[ -n "${fallback_sha}" && "${deploy_env}" == production && "${project}" == hushh-pda && "${no_traffic}" == true ]] || {
      echo "Cold qualification requires an independent production fallback." >&2; return 1;
    }
  fi
  _PHONE_DEPLOY_PHASE="${phase}" stage_phone_rollback "${fallback_sha}" "${fallback_image}" "${deploy_env}" "${project}" "${no_traffic}" "$@"
  # A qualified cold reader is a checkpoint, never permission to create primary.
  if [[ "${phase}" == cold ]]; then return 0; fi
  "$@"
}
