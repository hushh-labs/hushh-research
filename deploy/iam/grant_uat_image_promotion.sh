#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
# Print a repository-scoped plan; --apply requires separately authorized IAM work.
set -euo pipefail

readonly DEPLOYER="serviceAccount:github-actions-uat-deployer@hushh-pda-uat.iam.gserviceaccount.com"
apply=false
include_writer=false
for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --include-uat-writer) include_writer=true ;;
    *) echo "Usage: $0 [--apply] [--include-uat-writer]" >&2; exit 2 ;;
  esac
done

cat <<EOF
UAT backend image promotion plan for ${DEPLOYER}:

  roles/artifactregistry.reader
    projects/hushh-pda-dev/locations/us/repositories/gcr.io
  roles/artifactregistry.writer (requires --include-uat-writer and separate approval)
    projects/hushh-pda-uat/locations/us/repositories/gcr.io

These standard roles cover every image in each named repository.
No Dev Cloud Run access, Dev writes, secret access, impersonation or production
permission is required. No keys are created. Review existing effective access
before applying: absent direct bindings do not prove inherited access is absent.
Revoke added bindings by removing the same member/role from the same repository.
EOF

if [ "$apply" != true ]; then
  echo "Dry run. IAM changes require separate authorization before --apply."
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || { echo "gcloud is required." >&2; exit 1; }
gcloud artifacts repositories add-iam-policy-binding gcr.io \
  --project=hushh-pda-dev --location=us \
  --member="$DEPLOYER" --role=roles/artifactregistry.reader \
  --quiet --format=none
if [ "$include_writer" = true ]; then
  gcloud artifacts repositories add-iam-policy-binding gcr.io \
    --project=hushh-pda-uat --location=us \
    --member="$DEPLOYER" --role=roles/artifactregistry.writer \
    --quiet --format=none
fi
