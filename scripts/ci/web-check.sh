#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
NODE_VERSION_MIN="${NODE_VERSION_MIN:-20}"

cd "$WEB_DIR"

node --version
node -e "const v = process.version.match(/^v(\d+)\./); if (!v || parseInt(v[1], 10) < ${NODE_VERSION_MIN}) throw new Error('Node.js ${NODE_VERSION_MIN}+ required')"

test -f package-lock.json || (echo "❌ ERROR: package-lock.json not found. Run 'npm install' to generate it." && exit 1)
node -e "JSON.parse(require('fs').readFileSync('package-lock.json'))" || (echo "❌ ERROR: package-lock.json is not valid JSON" && exit 1)
test -f next.config.ts || (echo "❌ ERROR: next.config.ts not found" && exit 1)

npm --version

rm -rf node_modules
npm ci

npm run typecheck
npm run lint
npm run test:ci

NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-https://api.example.com}" \
NEXT_PUBLIC_DEVELOPER_API_URL="${NEXT_PUBLIC_DEVELOPER_API_URL:-https://api.example.com}" \
NEXT_PUBLIC_APP_ENV="${NEXT_PUBLIC_APP_ENV:-development}" \
NEXT_PUBLIC_FIREBASE_API_KEY="${NEXT_PUBLIC_FIREBASE_API_KEY:-test-api-key}" \
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-dummy-project.firebaseapp.com}" \
NEXT_PUBLIC_FIREBASE_PROJECT_ID="${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-dummy-project}" \
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:-dummy-project.appspot.com}" \
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="${NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:-123456789}" \
NEXT_PUBLIC_FIREBASE_APP_ID="${NEXT_PUBLIC_FIREBASE_APP_ID:-1:123456789:web:abcdef123456}" \
npm run build
