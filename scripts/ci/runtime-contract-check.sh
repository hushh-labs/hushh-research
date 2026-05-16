#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

backend_helper="$REPO_ROOT/hushh-webapp/app/api/_utils/backend.ts"
frontend_cloudbuild="$REPO_ROOT/deploy/frontend.cloudbuild.yaml"
ria_proxy_route="$REPO_ROOT/hushh-webapp/app/api/ria/[...path]/route.ts"

if grep -q 'consent-protocol-rpphvsc3tq-uc.a.run.app' "$backend_helper"; then
  echo "❌ backend route helper still hardcodes a production backend fallback."
  exit 1
fi

if ! grep -q 'do not guess a backend origin' "$backend_helper"; then
  echo "❌ backend route helper is missing the hosted fail-fast contract."
  exit 1
fi

if ! grep -q 'BACKEND_URL=BACKEND_URL:latest' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Run deploy must inject BACKEND_URL at runtime."
  exit 1
fi

if ! grep -q 'DEVELOPER_API_URL=BACKEND_URL:latest' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Run deploy must inject DEVELOPER_API_URL at runtime."
  exit 1
fi

if ! grep -q -- '--set-env-vars=NEXT_PUBLIC_APP_ENV=' "$frontend_cloudbuild"; then
  echo "❌ frontend Cloud Run deploy must inject NEXT_PUBLIC_APP_ENV at runtime."
  exit 1
fi

frontend_timeout_seconds="$(
  grep -Eo -- '--timeout=[0-9]+' "$frontend_cloudbuild" | head -n 1 | cut -d= -f2
)"
if [ -z "$frontend_timeout_seconds" ]; then
  echo "❌ frontend Cloud Run deploy must declare an explicit request timeout."
  exit 1
fi

if [ "$frontend_timeout_seconds" -lt 120 ]; then
  echo "❌ frontend Cloud Run timeout must be at least 120s for long-running RIA verification."
  exit 1
fi

if ! grep -q 'process.env.RIA_ONBOARDING_PROXY_TIMEOUT_MS' "$ria_proxy_route"; then
  echo "❌ RIA onboarding proxy must read RIA_ONBOARDING_PROXY_TIMEOUT_MS."
  exit 1
fi

onboarding_proxy_timeout_ms="$(
  grep -Eo 'RIA_ONBOARDING_PROXY_TIMEOUT_MS=[0-9]+' "$frontend_cloudbuild" | head -n 1 | cut -d= -f2
)"
if [ -z "$onboarding_proxy_timeout_ms" ]; then
  echo "❌ frontend Cloud Run deploy must inject RIA_ONBOARDING_PROXY_TIMEOUT_MS."
  exit 1
fi

if [ "$((frontend_timeout_seconds * 1000))" -le "$onboarding_proxy_timeout_ms" ]; then
  echo "❌ frontend Cloud Run timeout must be greater than the RIA onboarding proxy timeout."
  exit 1
fi

echo "✅ Runtime contract check passed."
