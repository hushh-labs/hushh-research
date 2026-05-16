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
