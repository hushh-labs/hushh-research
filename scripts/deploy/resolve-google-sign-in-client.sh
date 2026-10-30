#!/usr/bin/env bash
# Resolve the optional public Firebase-compatible Google sign-in client.
set -euo pipefail

if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
  echo "Usage: resolve-google-sign-in-client.sh <project> <artifact> [secret-prefix]" >&2
  exit 1
fi

project="$1"
artifact="$2"
secret_prefix="${3:-}"
case "$secret_prefix" in
  ""|SCOPE_COMMERCE_SANDBOX_) ;;
  *) echo "Unsupported frontend secret namespace." >&2; exit 1 ;;
esac
error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

: > "$artifact"
chmod 600 "$artifact"
if gcloud secrets versions access latest \
  --secret="${secret_prefix}NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID" \
  --project="$project" > "$artifact" 2> "$error_file"; then
  client_id="$(tr -d '\r\n' < "$artifact")"
  if ! [[ "$client_id" =~ ^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$ ]]; then
    : > "$artifact"
    echo "Google sign-in OAuth client configuration is empty or invalid." >&2
    exit 1
  fi
  printf '%s' "$client_id" > "$artifact"
elif grep -Eq '(^|[[:space:]])NOT_FOUND(:|[[:space:]])' "$error_file"; then
  : > "$artifact"
  echo "Optional Google sign-in client is absent; retaining Firebase popup authentication."
else
  : > "$artifact"
  echo "Unable to access Google sign-in OAuth client configuration." >&2
  exit 1
fi
