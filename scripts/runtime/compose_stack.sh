#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
BACKEND_ENV="$REPO_ROOT/consent-protocol/.env"

VALID_PROFILES=(backend cache mail db dev)

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ./bin/hushh compose init
  ./bin/hushh compose up [backend|cache|mail|db|dev]
  ./bin/hushh compose down
  ./bin/hushh compose nuke
  ./bin/hushh compose logs [service]
  ./bin/hushh compose ps
  ./bin/hushh compose config
  ./bin/hushh compose health

Defaults:
  up defaults to dev, which starts backend + Redis + Mailhog.

Notes:
  - This is an opt-in local container stack for contributor/devex work.
  - The frontend remains on the canonical ./bin/hushh web path.
  - The local db profile is standalone unless you explicitly point backend env
    values at it; backend otherwise follows consent-protocol/.env.
EOF
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
}

is_valid_profile() {
  local profile="$1"
  for valid in "${VALID_PROFILES[@]}"; do
    [ "$profile" = "$valid" ] && return 0
  done
  return 1
}

require_profile() {
  local profile="$1"
  is_valid_profile "$profile" || die "unknown compose profile '$profile' (valid: ${VALID_PROFILES[*]})"
}

require_backend_env_if_needed() {
  local profile="$1"
  case "$profile" in
    backend|dev)
      [ -f "$BACKEND_ENV" ] || die "missing consent-protocol/.env; run ./bin/hushh bootstrap first"
      ;;
  esac
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

all_profiles_args() {
  printf '%s\n' --profile dev --profile db
}

cmd_init() {
  need_docker
  [ -f "$COMPOSE_FILE" ] || die "missing docker-compose.yml"
  if [ -f "$BACKEND_ENV" ]; then
    echo "ok: consent-protocol/.env present"
  else
    echo "warn: consent-protocol/.env missing; backend/dev profile needs ./bin/hushh bootstrap"
  fi
  docker --version
  docker compose version
}

cmd_up() {
  local profile="${1:-dev}"
  require_profile "$profile"
  need_docker
  require_backend_env_if_needed "$profile"
  compose --profile "$profile" up -d --build
}

cmd_down() {
  need_docker
  compose --profile dev --profile db down
}

cmd_nuke() {
  need_docker
  printf 'This will stop compose services and remove local compose volumes. Type nuke to continue: '
  read -r answer
  [ "$answer" = "nuke" ] || {
    echo "aborted"
    exit 0
  }
  compose --profile dev --profile db down -v
}

cmd_logs() {
  need_docker
  if [ "$#" -gt 0 ]; then
    compose --profile dev --profile db logs -f --tail=200 "$@"
  else
    compose --profile dev --profile db logs -f --tail=100
  fi
}

cmd_ps() {
  need_docker
  compose --profile dev --profile db ps
}

cmd_config() {
  need_docker
  compose --profile dev --profile db config
}

cmd_health() {
  local backend_url="http://localhost:8000/health"
  local mailhog_url="http://localhost:8025"
  echo "backend  $backend_url"
  curl -fsS "$backend_url" || echo "backend not reachable"
  echo
  echo "mailhog  $mailhog_url"
  curl -fsSI "$mailhog_url" | head -1 || echo "mailhog not reachable"
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  init) cmd_init "$@" ;;
  up) cmd_up "$@" ;;
  down) cmd_down "$@" ;;
  nuke) cmd_nuke "$@" ;;
  logs) cmd_logs "$@" ;;
  ps) cmd_ps "$@" ;;
  config) cmd_config "$@" ;;
  health) cmd_health "$@" ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
