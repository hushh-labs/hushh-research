#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/../.." rev-parse --show-toplevel)"
PROFILE="${APP_RUNTIME_MODE:-${APP_RUNTIME_PROFILE:-uat}}"

while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --mode)
      PROFILE="${2:-$PROFILE}"
      shift 2
      ;;
    --mode=*)
      PROFILE="${1#--mode=}"
      shift
      ;;
    --profile)
      PROFILE="${2:-$PROFILE}"
      shift 2
      ;;
    --profile=*)
      PROFILE="${1#--profile=}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

exec bash "$REPO_ROOT/scripts/env/doctor.sh" "$PROFILE"
