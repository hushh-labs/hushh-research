#!/usr/bin/env bash

runtime_profiles() {
  printf '%s\n' "local-uatdb" "uat-remote" "prod-remote"
}

runtime_profiles_csv() {
  printf 'local-uatdb, uat-remote, prod-remote'
}

normalize_runtime_profile() {
  local raw="${1:-}"
  local normalized
  normalized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | xargs)"

  case "$normalized" in
    local-uatdb|uat-remote|prod-remote)
      printf '%s' "$normalized"
      ;;
    *)
      return 1
      ;;
  esac
}

runtime_profile_backend_mode() {
  case "${1:-}" in
    local-uatdb) printf 'local' ;;
    uat-remote|prod-remote) printf 'remote' ;;
    *) return 1 ;;
  esac
}

runtime_profile_frontend_mode() {
  case "${1:-}" in
    local-uatdb|uat-remote|prod-remote) printf 'local' ;;
    *) return 1 ;;
  esac
}

runtime_profile_backend_environment() {
  case "${1:-}" in
    local-uatdb) printf 'development' ;;
    uat-remote) printf 'uat' ;;
    prod-remote) printf 'production' ;;
    *) return 1 ;;
  esac
}

runtime_profile_frontend_environment() {
  runtime_profile_backend_environment "$1"
}

runtime_profile_resource_target() {
  case "${1:-}" in
    local-uatdb|uat-remote) printf 'uat' ;;
    prod-remote) printf 'production' ;;
    *) return 1 ;;
  esac
}

runtime_profile_description() {
  case "${1:-}" in
    local-uatdb)
      printf 'local frontend + local backend, backed by UAT cloud resources'
      ;;
    uat-remote)
      printf 'local frontend only, pointed at deployed UAT backend'
      ;;
    prod-remote)
      printf 'local frontend only, pointed at deployed production backend'
      ;;
    *)
      return 1
      ;;
  esac
}

runtime_profile_backend_source() {
  printf '.env.%s.local' "${1:-}"
}

runtime_profile_frontend_source() {
  printf '.env.%s.local' "${1:-}"
}
