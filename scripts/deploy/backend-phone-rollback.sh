#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Validate and stage the independent production phone reader before a primary.

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
    python3 deploy/phone/cold_fallback.py "${fallback_sha}" "${fallback_image}"
}
