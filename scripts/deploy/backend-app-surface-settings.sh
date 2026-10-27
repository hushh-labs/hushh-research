#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Decode the version-compatible application feature contract.

IFS=',' read -r -a _app_surface_pairs <<< "${_APP_SURFACE_SETTINGS:?missing application surface settings}"
[[ "${#_app_surface_pairs[@]}" == 4 || "${#_app_surface_pairs[@]}" == 5 ]] || { echo "Application surface settings require four keys and optional generation admission." >&2; exit 1; }
_ACCOUNT_GENERATION_ADMISSION_ENABLED=""
_app_surface_seen="|"
for _pair in "${_app_surface_pairs[@]}"; do
  [[ "${_pair}" == *=* ]] || { echo "Invalid application surface setting." >&2; exit 1; }
  _key="${_pair%%=*}"; _value="${_pair#*=}"
  [[ "${_app_surface_seen}" != *"|${_key}|"* ]] || { echo "Duplicate application surface key." >&2; exit 1; }
  _app_surface_seen+="${_key}|"
  case "${_value}" in ""|true|false) ;; *) echo "Invalid application surface boolean." >&2; exit 1 ;; esac
  case "${_key}" in
    review) _APP_REVIEW_MODE="${_value}" ;;
    wallet) _ONE_WALLET_CARD_ENABLED="${_value}" ;;
    card_access) _WALLET_CARD_ACCESS_ENABLED="${_value}" ;;
    generation_admission) _ACCOUNT_GENERATION_ADMISSION_ENABLED="${_value}" ;;
    phone_recovery) validate_phone_recovery_boolean "${_value}"; _AUTH_PHONE_RECOVERY_ENABLED="${_value}" ;;
    *) echo "Unknown application surface key." >&2; exit 1 ;;
  esac
done
for _required in review wallet card_access phone_recovery; do
  [[ "${_app_surface_seen}" == *"|${_required}|"* ]] || {
    echo "Missing required application surface key." >&2; exit 1;
  }
done
