#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "usage: $0 <project> <region> <revision> <expected-service-account>" >&2
  exit 2
fi

project="$1"
region="$2"
revision="$3"
expected="$4"

if [[ -z "${revision}" || -z "${expected}" ]]; then
  echo "revision and expected service account are required" >&2
  exit 2
fi

actual="$(gcloud run revisions describe "${revision}" \
  --project="${project}" \
  --region="${region}" \
  --format='value(spec.serviceAccountName)')"

if [[ "${actual}" != "${expected}" ]]; then
  echo "Runtime identity mismatch for ${revision}: expected '${expected}', got '${actual:-unset}'." >&2
  exit 1
fi

echo "Verified runtime identity for ${revision}: ${actual}"
