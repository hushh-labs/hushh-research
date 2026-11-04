#!/usr/bin/env bash
# Personal entrypoint; stack lifecycle remains owned by the repository launcher.
set -euo pipefail

case "${1:-}" in
  --help|-h)
    cat <<'HELP'
Usage: ./Personal_Tasks/run-main-local.sh [--check]

Build the current working tree and run the optimized local frontend + backend.
Frontend: https://localhost:3000 (HTTPS is required by the configured Google origin).
The repository launcher starts/reuses the Cloud SQL proxy and owns shutdown.
This mode has no hot reload. For development, use the three commands in README.md.

--check validates installed prerequisites and runs the local environment doctor.
It does not fetch, install, activate profiles, build, or start servers.

First-time setup or dependency refresh: ./bin/hushh bootstrap --mode local
Local edits and feature branches are supported; no fetch or branch reset occurs.
HELP
    exit 0 ;;
  --check) CHECK_ONLY=true ;;
  '') CHECK_ONLY=false ;;
  *) echo "Unknown option: $1 (use --help)" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "Use --help for supported arguments." >&2; exit 2; }

TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$TASK_DIR" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# The frontend currently requires Node >=22.12; Node 24 is recommended.
node_supported() {
  command -v node >/dev/null && node -e '
    const current = process.versions.node.split(".").map(Number);
    const minimum = require("./hushh-webapp/package.json").engines.node.replace(/^>=/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (current[i] !== minimum[i]) process.exit(current[i] > minimum[i] ? 0 : 1);
    }
  '
}
if ! node_supported; then
  NVM_INIT="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ -s "$NVM_INIT" ]; then
    . "$NVM_INIT"
    nvm use 24 || nvm use 22
  fi
fi

for tool in git python3 uv npm node curl lsof jq; do
  command -v "$tool" >/dev/null || { echo "Required tool missing: $tool" >&2; exit 1; }
done
if ! node_supported; then
  echo "Use Node >=22.12 (nvm use 24), then rerun this script." >&2
  exit 1
fi

for file in consent-protocol/.env hushh-webapp/.env.local.local consent-protocol/.venv/bin/python hushh-webapp/node_modules/.bin/next; do
  if [ ! -f "$file" ]; then
    echo "Missing $file. Run: ./bin/hushh bootstrap --mode local" >&2
    exit 1
  fi
done

if ! (cd consent-protocol && uv sync --frozen --group dev --check); then
  echo "Backend dependencies need a refresh. Run: ./bin/hushh bootstrap --mode local" >&2
  exit 1
fi

if [ "$CHECK_ONLY" = true ]; then
  bash "$TASK_DIR/setup-local-https.sh" --check
  exec ./bin/hushh doctor --mode local
fi

for port in 3000 3001 8000; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is occupied. Stop its existing app terminal with Ctrl-C first." >&2
    exit 1
  fi
done
bash "$TASK_DIR/setup-local-https.sh"

printf 'Working tree: %s (%s), including local edits\n' "$(git branch --show-current)" "$(git rev-parse --short HEAD)"
echo "Frontend: https://localhost:3000; Python backend: http://localhost:8000."
echo "Database, authentication, and model providers still require network access."

# Prevent ambient hosted/proxy/build settings from redirecting the local stack.
unset NODE_ENV CAPACITOR_BUILD HUSHH_DEPLOY_ENV K_SERVICE K_REVISION
unset HUSHH_UAT_MANAGED_AI_PROVIDER HUSHH_UAT_MANAGED_TEXT_PROVIDER
export PYTHON_API_URL=http://127.0.0.1:8000
export BACKEND_URL=http://127.0.0.1:8000
export NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
export NEXT_PUBLIC_APP_URL=https://localhost:3000
export APP_FRONTEND_ORIGIN=https://localhost:3000

# Account admission and concurrent bootstrap/status reads share these pools.
# Keep this personal stack bounded, with no SQL overflow, while avoiding the
# canonical contributor defaults' two-connection SQL queue on remote UAT.
export DB_POOL_MAX_SIZE="${DB_POOL_MAX_SIZE:-8}"
export DB_SQLALCHEMY_POOL_SIZE="${DB_SQLALCHEMY_POOL_SIZE:-8}"
export DB_SQLALCHEMY_MAX_OVERFLOW=0

# Keep the build heap scoped to compilation and start backend workers afterward.
echo "Building fresh frontend before starting backend workers (Node heap: 4096 MB)..."
./bin/hushh env use --mode local
./bin/hushh doctor --mode local
(
  cd hushh-webapp
  NEXT_DIST_DIR=.next-local-fast \
    NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096" npm run build
)

echo "Build passed. Starting both local servers; Ctrl-C stops the stack."
# This output was built immediately above; never reuse an earlier failed build.
exec bash "$REPO_ROOT/scripts/runtime/run_local_fast.sh" --https --skip-build
