#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ci/orchestrate.sh <secret|web|protocol|integration|all|advisory>

Environment flags:
  INCLUDE_ADVISORY_CHECKS=1   Also run advisory checks when stage=all

Description:
  Canonical CI stage orchestrator used by GitHub Actions and local CI wrappers.
  The default "all" stage mirrors only the blocking CI surface.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -lt 1 ]; then
  usage
  exit 0
fi

STAGE="${1:-}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

run_stage() {
  local stage="$1"
  case "$stage" in
    secret)
      scripts/ci/secret-scan.sh
      ;;
    web)
      scripts/ci/web-check.sh
      ;;
    protocol)
      scripts/ci/protocol-check.sh
      ;;
    integration)
      scripts/ci/integration-check.sh
      ;;
    advisory)
      scripts/ci/docs-parity-check.sh
      scripts/ci/subtree-sync-check.sh
      scripts/ci/github-security-alerts.sh
      scripts/ci/verify-production-environment-governance.sh
      ./bin/hushh codex audit --text
      ;;
    *)
      echo "Unknown stage: $stage" >&2
      usage
      exit 1
      ;;
  esac
}

case "$STAGE" in
  secret|web|protocol|integration|advisory)
    run_stage "$STAGE"
    ;;
  all)
    echo "== CI Parity (Local) =="
    echo "Running blocking CI stages: secret, web, protocol, integration."
    run_stage secret
    run_stage web
    run_stage protocol
    run_stage integration
    if [ "${INCLUDE_ADVISORY_CHECKS:-0}" = "1" ]; then
      echo "Including advisory checks (docs parity + subtree sync + Codex OS audit)."
      run_stage advisory
    else
      echo "Skipping advisory checks. Set INCLUDE_ADVISORY_CHECKS=1 to include."
    fi
    echo "✅ Local CI parity checks passed."
    ;;
  *)
    echo "Unknown stage: $STAGE" >&2
    usage
    exit 1
    ;;
esac
