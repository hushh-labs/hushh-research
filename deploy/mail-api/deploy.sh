#!/usr/bin/env bash
# Scoped candidate deployment for the existing standalone service.
set -euo pipefail

if [ "${MAIL_API_APPROVED_PRODUCTION:-}" != "1" ]; then
  echo "Obtain explicit production deployment authority before running this helper." >&2
  exit 1
fi
if [ -z "${MAIL_API_REVISION_SUFFIX:-}" ]; then
  echo "Set MAIL_API_REVISION_SUFFIX to an unused, reviewed revision suffix." >&2
  exit 1
fi
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="hushh-tech-prod"
REGION="us-central1"
SERVICE="hushh-mail-api"

# Preserve all existing secret bindings, runtime identity, IAM and resource knobs.
# This creates a candidate only. Verification and traffic promotion are separate.
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" >/dev/null
gcloud run deploy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --source="$SOURCE_DIR" --update-env-vars=MAIL_ONE_DELEGATED_ENABLED=true \
  --revision-suffix="$MAIL_API_REVISION_SUFFIX" --no-traffic --tag=one-otp-candidate

echo "Candidate created without default traffic. Verify before an authorized promotion."
