#!/usr/bin/env bash
set -euo pipefail

SERVICE="${1:-}"
REGION="${2:-us-central1}"
REVISION="${3:-}"
PROJECT="${GCP_PROJECT_ID:-}"

if [[ "$SERVICE" == "-h" || "$SERVICE" == "--help" ]]; then
  echo "Usage: $0 <service> [region] <revision>" >&2
  echo "Environment: optional GCP_PROJECT_ID to target a specific project" >&2
  exit 0
fi

if [[ -z "$SERVICE" || -z "$REVISION" ]]; then
  echo "Usage: $0 <service> [region] <revision>" >&2
  exit 1
fi

if [[ "$SERVICE" == "consent-protocol" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  inspect=(gcloud run revisions describe "$REVISION" "--region=$REGION"
    '--format=value(metadata.labels.deploy-sha)')
  if [[ -n "$PROJECT" ]]; then
    inspect+=("--project=$PROJECT")
  fi
  rollback_sha="$("${inspect[@]}")"
  # v201 alone does not prove Files/provider effects obey the release fence.
  python3 "$REPO_ROOT/deploy/account-deletion/activate_release.py" \
    --qualify-source "$rollback_sha"
fi

cmd=(
  gcloud run services update-traffic "$SERVICE"
  "--region=$REGION"
  "--to-revisions=${REVISION}=100"
)

if [[ -n "$PROJECT" ]]; then
  cmd+=("--project=$PROJECT")
fi

echo "Rolling back service '$SERVICE' in region '$REGION' to revision '$REVISION'"
"${cmd[@]}"
