#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/hushh-document-delivery.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

echo '== Protected documents: real browser, SQL, signed payment, preview, download and revoke =='
(
  cd "$REPO_ROOT/hushh-webapp"
  # Qualify actual PDF rendering and downloads in Chromium and Safari's engine.
  # The ordinary Web lanes retain ownership of the broad layout matrix.
  if [ "${CI:-}" = "true" ]; then
    npx playwright install --with-deps chromium webkit
  fi
  node --input-type=module -e 'import fs from "node:fs"; import { chromium, webkit } from "playwright"; for (const engine of [chromium, webkit]) if (!fs.existsSync(engine.executablePath())) throw new Error("Install the pinned headless browsers before this gate");'
)
(
  cd "$REPO_ROOT/consent-protocol"
  TESTING=true DB_OFFLINE=1 OFFLINE_DB_PATH="$test_dir/protocol.db" \
  GOOGLE_CLOUD_PROJECT=hushh-ci-test REQUIRE_CONNECTOR_POSTGRES=1 \
  .venv/bin/python -m pytest -q tests/services/test_document_delivery_browser.py
)
