#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then
  echo "Usage: cloudrun-retention.sh <service> [region] [keep_count] [protected_revision]"
  exit 0
fi

SERVICE="${1:-}"
REGION="${2:-us-central1}"
KEEP_COUNT="${3:-10}"
PROJECT="${GCP_PROJECT_ID:-}"
PROTECTED_REVISION="${4:-}"

if [[ -z "$SERVICE" ]]; then
  echo "Usage: $0 <service> [region] [keep_count] [protected_revision]"
  exit 1
fi

if ! [[ "$KEEP_COUNT" =~ ^[0-9]+$ ]] || [[ "$KEEP_COUNT" -lt 1 ]]; then
  echo "keep_count must be a positive integer, got: $KEEP_COUNT"
  exit 1
fi

LIST_CMD=(gcloud run revisions list --service "$SERVICE" --region "$REGION" --sort-by="~metadata.creationTimestamp" --format="value(metadata.name)")
if [[ -n "$PROJECT" ]]; then
  LIST_CMD+=(--project "$PROJECT")
fi

echo "Applying revision retention for service '$SERVICE' in region '$REGION' (keep latest $KEEP_COUNT)"

REVISIONS="$("${LIST_CMD[@]}")"
TOTAL_REVISIONS="$(printf '%s\n' "$REVISIONS" | sed '/^$/d' | wc -l | tr -d ' ')"

if [[ -z "$TOTAL_REVISIONS" ]]; then
  TOTAL_REVISIONS=0
fi

if [[ "$TOTAL_REVISIONS" -le "$KEEP_COUNT" ]]; then
  echo "No cleanup needed. Existing revisions: $TOTAL_REVISIONS"
  exit 0
fi

deleted=0
skipped=0
index=0

while IFS= read -r rev; do
  [[ -z "$rev" ]] && continue
  index=$((index + 1))
  if [[ "$index" -le "$KEEP_COUNT" || "$rev" == "$PROTECTED_REVISION" ]]; then
    continue
  fi

  DELETE_CMD=(gcloud run revisions delete "$rev" --region "$REGION" --quiet)
  if [[ -n "$PROJECT" ]]; then
    DELETE_CMD+=(--project "$PROJECT")
  fi

  if "${DELETE_CMD[@]}" >/dev/null 2>&1; then
    deleted=$((deleted + 1))
    echo "Deleted revision: $rev"
  else
    skipped=$((skipped + 1))
    echo "Skipped revision: $rev (likely traffic-assigned or already removed)"
  fi
done <<< "$REVISIONS"

echo "Retention summary for $SERVICE: deleted=$deleted skipped=$skipped total=$TOTAL_REVISIONS kept=$KEEP_COUNT"
