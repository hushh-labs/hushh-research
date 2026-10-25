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

if [[ -n "${HUSHH_DOCUMENT_READER_GUARD_REPORT:-}" ]]; then
  "${PROTOCOL_PYTHON:-python3}" deploy/drive/resolve_protected_document_release.py \
    --project "${PROJECT}" --environment "${HUSHH_DOCUMENT_READER_ENVIRONMENT:?reader environment required}" \
    --rollback-report "${HUSHH_DOCUMENT_READER_GUARD_REPORT}" \
    --service "${SERVICE}" --revision "${REVISION}"
fi

manual_reader_guard="${HUSHH_DOCUMENT_MANUAL_ROLLBACK_GUARD:-false}"
case "${manual_reader_guard}" in
  true|false) ;;
  *) echo "Invalid document rollback guard setting" >&2; exit 1 ;;
esac
if [[ "${manual_reader_guard}" == true ]]; then
  [[ "${REGION}" == us-central1 ]] || { echo "Invalid document rollback region" >&2; exit 1; }
  case "${PROJECT}" in
    hushh-pda) reader_environment=production ;;
    hushh-pda-uat) reader_environment=uat ;;
    *) echo "Invalid document rollback project" >&2; exit 1 ;;
  esac
  reader_ancestor="$(git log -1 --diff-filter=A --format=%H -- consent-protocol/api/routes/document_delivery.py)"
  "${PROTOCOL_PYTHON:-python3}" deploy/drive/resolve_protected_document_release.py \
    --project "${PROJECT}" --environment "${reader_environment}" \
    --manual-rollback --required-ancestor "${reader_ancestor}" \
    --service "${SERVICE}" --revision "${REVISION}"
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
