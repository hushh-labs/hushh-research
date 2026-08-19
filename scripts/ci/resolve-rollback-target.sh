#!/usr/bin/env bash
# scripts/ci/resolve-rollback-target.sh
#
# Resolves which Cloud Run revision rollback.yml should restore traffic to,
# for one service lane. An explicit revision always wins. Otherwise, falls
# back to the revision recorded in the "last known good" tag written by
# scripts/ci/tag-last-known-good.sh — so an operator dispatching a rollback
# doesn't need to already know the revision name.
#
# Usage:
#   resolve-rollback-target.sh <environment> <backend|frontend> [explicit-revision]
#
# Prints the resolved revision name to stdout. Exits non-zero with a clear
# message if nothing can be resolved (no explicit input AND no
# deployed/<environment>-latest tag exists yet).
set -euo pipefail

ENVIRONMENT="${1:?usage: resolve-rollback-target.sh <environment> <backend|frontend> [explicit-revision]}"
LANE="${2:?usage: resolve-rollback-target.sh <environment> <backend|frontend> [explicit-revision]}"
EXPLICIT="${3:-}"

if [ -n "$EXPLICIT" ]; then
  echo "$EXPLICIT"
  exit 0
fi

TAG="deployed/${ENVIRONMENT}-latest"

if ! git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "[resolve-rollback-target] No explicit ${LANE} revision given and refs/tags/${TAG} does not exist yet (no healthy deploy has been tagged for ${ENVIRONMENT})." >&2
  echo "[resolve-rollback-target] Pass the revision explicitly — read it with:" >&2
  echo "  gcloud run services describe <service> --project=<project> --region=us-central1 --format='value(status.traffic[0].revisionName)'" >&2
  exit 1
fi

REVISION="$(git for-each-ref --format='%(contents)' "refs/tags/${TAG}" | grep -E "^${LANE}_revision:" | head -1 | sed -E "s/^${LANE}_revision:[[:space:]]*//")"

if [ -z "$REVISION" ]; then
  echo "[resolve-rollback-target] refs/tags/${TAG} exists but has no ${LANE}_revision line — pass the revision explicitly." >&2
  exit 1
fi

echo "$REVISION"
