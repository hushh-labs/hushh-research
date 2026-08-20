#!/usr/bin/env bash
# scripts/ci/dispatch-rollback.sh
#
# Dispatches .github/workflows/rollback.yml and watches it to completion.
# The actual mutation (moving Cloud Run traffic) happens entirely inside the
# governed workflow — this is convenience only, mirroring the pattern
# scripts/release/dispatch-ios-appstore.mjs already uses for a different
# release lane ("gh workflow run does not return the run id; grab the
# newest run for this workflow").
#
# Requires `gh` authenticated as an actor in the target environment's
# manual_dispatch_users allowlist (config/ci-governance.json) — the same
# allowlist that already gates deploy-uat.yml / deploy-production.yml
# dispatch. Nobody's permissions change to use this.
set -euo pipefail

REPO="hushh-labs/hushh-research"

usage() {
  cat <<'EOF'
Usage:
  dispatch-rollback.sh <uat|production> [backend|frontend|all] --reason "<reason>" \
      [--backend-revision <revision>] [--frontend-revision <revision>]

Blank --backend-revision/--frontend-revision fall back to the revision
recorded in the deployed/<environment>-latest tag (scripts/ci/tag-last-known-good.sh).
EOF
}

ENVIRONMENT="${1:-}"
case "${ENVIRONMENT}" in
  -h|--help)
    usage
    exit 0
    ;;
  uat|production)
    shift
    ;;
  *)
    echo "Error: first argument must be 'uat' or 'production'." >&2
    usage
    exit 1
    ;;
esac

SCOPE="all"
if [ "$#" -gt 0 ]; then
  case "$1" in
    backend|frontend|all)
      SCOPE="$1"
      shift
      ;;
  esac
fi

REASON=""
BACKEND_REVISION=""
FRONTEND_REVISION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    --backend-revision)
      BACKEND_REVISION="${2:-}"
      shift 2
      ;;
    --frontend-revision)
      FRONTEND_REVISION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

[ -n "$REASON" ] || {
  echo "Error: --reason is required (audit trail for the rollback)." >&2
  usage
  exit 1
}

command -v gh >/dev/null 2>&1 || {
  echo "Error: the 'gh' CLI is required." >&2
  exit 1
}

echo "Dispatching rollback: environment=${ENVIRONMENT} scope=${SCOPE} reason=\"${REASON}\""

BEFORE_RUN_ID="$(gh run list --repo "$REPO" --workflow rollback.yml --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"

gh workflow run rollback.yml --repo "$REPO" --ref main \
  -f "environment=${ENVIRONMENT}" \
  -f "scope=${SCOPE}" \
  -f "reason=${REASON}" \
  -f "backend_revision=${BACKEND_REVISION}" \
  -f "frontend_revision=${FRONTEND_REVISION}"

echo "Dispatched. Locating the run..."

RUN_ID=""
for _ in $(seq 1 10); do
  sleep 3
  RUN_ID="$(gh run list --repo "$REPO" --workflow rollback.yml --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
  if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "$BEFORE_RUN_ID" ]; then
    break
  fi
  RUN_ID=""
done

if [ -z "$RUN_ID" ]; then
  echo "Could not locate the dispatched run automatically. Check:" >&2
  echo "  gh run list --repo $REPO --workflow rollback.yml --limit 5" >&2
  exit 1
fi

echo "Watching run ${RUN_ID}..."
gh run watch "$RUN_ID" --repo "$REPO" --exit-status
