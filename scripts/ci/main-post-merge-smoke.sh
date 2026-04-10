#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/hushh-webapp"
PROTOCOL_DIR="$REPO_ROOT/consent-protocol"
NODE_VERSION_MIN="${NODE_VERSION_MIN:-20}"

cd "$WEB_DIR"

node --version
node -e "const v = process.version.match(/^v(\d+)\./); if (!v || parseInt(v[1], 10) < ${NODE_VERSION_MIN}) throw new Error('Node.js ${NODE_VERSION_MIN}+ required')"

test -f package-lock.json || (echo "❌ ERROR: package-lock.json not found. Run 'npm install' to generate it." && exit 1)
test -f next.config.ts || (echo "❌ ERROR: next.config.ts not found" && exit 1)

npm --version
npm ci --prefer-offline --no-audit --progress=false
npm run verify:docs

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

cd "$REPO_ROOT"
bash "$REPO_ROOT/scripts/ci/no-ria-feature-flags.sh"
bash "$REPO_ROOT/scripts/ci/runtime-contract-check.sh"
bash "$REPO_ROOT/scripts/ci/pkm-upgrade-gate.sh"

cd "$PROTOCOL_DIR"
python3 - <<'PY'
import os

os.environ.setdefault("TESTING", "true")
os.environ.setdefault("SECRET_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault(
    "VAULT_ENCRYPTION_KEY",
    "0000000000000000000000000000000000000000000000000000000000000000",
)
os.environ.setdefault("HUSHH_DEVELOPER_TOKEN", "test_hushh_developer_token_for_ci")

import server  # noqa: E402

route_count = len(server.app.routes)
if route_count <= 0:
    raise SystemExit("FastAPI smoke failed: no routes were registered.")
print(f"Protocol smoke passed with {route_count} registered routes.")
PY
