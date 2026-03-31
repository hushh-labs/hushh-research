#!/usr/bin/env bash

runtime_modes() {
  printf '%s\n' "local" "uat" "prod"
}

runtime_profiles() {
  runtime_modes
}

runtime_profiles_csv() {
  printf 'local, uat, prod'
}

normalize_runtime_mode() {
  local raw="${1:-}"
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | xargs)"

  case "$normalized" in
    local|development|dev|local-uatdb)
      printf 'local'
      ;;
    uat|uat-remote)
      printf 'uat'
      ;;
    prod|production|prod-remote)
      printf 'prod'
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_runtime_profile() {
  normalize_runtime_mode "$1"
}

runtime_profile_backend_mode() {
  case "${1:-}" in
    local) printf 'local' ;;
    uat|prod) printf 'remote' ;;
    *) return 1 ;;
  esac
}

runtime_profile_frontend_mode() {
  case "${1:-}" in
    local|uat|prod) printf 'local' ;;
    *) return 1 ;;
  esac
}

runtime_profile_backend_environment() {
  case "${1:-}" in
    local) printf 'development' ;;
    uat) printf 'uat' ;;
    prod) printf 'production' ;;
    *) return 1 ;;
  esac
}

runtime_profile_frontend_environment() {
  runtime_profile_backend_environment "$1"
}

runtime_profile_resource_target() {
  case "${1:-}" in
    local|uat) printf 'uat' ;;
    prod) printf 'production' ;;
    *) return 1 ;;
  esac
}

runtime_profile_description() {
  case "${1:-}" in
    local)
      printf 'local frontend + local backend, backed by UAT cloud resources'
      ;;
    uat)
      printf 'local frontend only, pointed at deployed UAT backend'
      ;;
    prod)
      printf 'local frontend only, pointed at deployed production backend'
      ;;
    *)
      return 1
      ;;
  esac
}

runtime_profile_frontend_source() {
  case "${1:-}" in
    local) printf '.env.local.local' ;;
    uat) printf '.env.uat.local' ;;
    prod) printf '.env.prod.local' ;;
    *) return 1 ;;
  esac
}
