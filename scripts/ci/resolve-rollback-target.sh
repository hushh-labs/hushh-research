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

# A tag is a record of what WAS live, not a promise it still exists. Cloud Run
# revisions are pruned (scripts/ci/cloudrun-retention.sh), so a tag that has
# stopped moving — because the deploy step that writes it broke, which is
# exactly what happened between 2026-08-19 and this restore — ages into
# naming a revision that has since been deleted. Resolving it anyway hands
# cloudrun-rollback.sh a dead name and produces a gcloud error in the middle
# of an incident, at the one moment nobody has attention to spare for it.
# Check here instead, and say what IS still available.
VERIFY_SERVICE="${ROLLBACK_VERIFY_SERVICE:-}"
VERIFY_REGION="${ROLLBACK_VERIFY_REGION:-}"
VERIFY_PROJECT="${ROLLBACK_VERIFY_PROJECT:-}"

if [ -n "$VERIFY_SERVICE" ] && [ -n "$VERIFY_REGION" ] && command -v gcloud >/dev/null 2>&1; then
  # --project explicitly rather than leaning on ambient `gcloud config` state:
  # the wrong project answers with an empty list, which this code reads as
  # "lookup failed, stay quiet" — a silent skip of the very check being added.
  set -- --service="$VERIFY_SERVICE" --region="$VERIFY_REGION" \
         --format='value(metadata.name)' --limit=200
  [ -n "$VERIFY_PROJECT" ] && set -- "$@" --project="$VERIFY_PROJECT"

  SURVIVING="$(gcloud run revisions list "$@" 2>/dev/null || true)"

  # An empty list means the lookup itself failed (no credentials, wrong
  # project, API hiccup). That is not evidence the revision is gone, so fall
  # through and let the rollback step surface the real error.
  if [ -n "$SURVIVING" ] && ! printf '%s\n' "$SURVIVING" | grep -qxF "$REVISION"; then
    TAGGED_AT="$(git for-each-ref --format='%(contents)' "refs/tags/${TAG}" | grep -E '^tagged_at:' | sed -E 's/^tagged_at:[[:space:]]*//')"
    {
      echo "[resolve-rollback-target] refs/tags/${TAG} names ${LANE} revision '${REVISION}',"
      echo "but that revision no longer exists on ${VERIFY_SERVICE} in ${VERIFY_REGION}."
      echo ""
      echo "  tag last written: ${TAGGED_AT:-unknown}"
      echo ""
      echo "The tag is stale — it has not been updated since the revision it names was"
      echo "pruned. Re-dispatch with an explicit revision from the ones still available:"
      printf '%s\n' "$SURVIVING" | head -10 | sed 's/^/  /'
    } >&2
    exit 1
  fi
fi

echo "$REVISION"
