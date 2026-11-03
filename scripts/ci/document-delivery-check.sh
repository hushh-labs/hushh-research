#!/usr/bin/env bash
set -euo pipefail

mode="${1:-all}"
browser_engines=(chromium webkit)
if [ "$#" -gt 1 ]; then echo 'Unexpected document gate arguments.' >&2; exit 64; fi
case "$mode" in
  all) ;;
  --ci-linux-document)
    [ "${CI:-}:${RUNNER_OS:-}" = 'true:Linux' ] || exit 64 ;;
  --ci-macos-webkit)
    [ "${CI:-}:${RUNNER_OS:-}" = 'true:macOS' ] || exit 64
    browser_engines=(webkit) ;;
  *) echo 'Unknown document gate mode.' >&2; exit 64 ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/hushh-document-delivery.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT

echo '== Browser contracts: protected documents and phone recovery through real SQL =='
(
  cd "$REPO_ROOT/hushh-webapp"
  # Qualify actual PDF rendering and downloads in Chromium and Safari's engine.
  # The ordinary Web lanes retain ownership of the broad layout matrix.
  if [ "${CI:-}" = "true" ] && [ "${RUNNER_OS:-}" != 'macOS' ]; then
    # Match the existing Web/UAT installer: retain signed official fallbacks,
    # without the slow preferred mirror that exhausted this lane's job budget.
    if [ -f /etc/apt/apt-mirrors.txt ]; then
      sudo sed -i '\|^http://azure\.archive\.ubuntu\.com/ubuntu/[[:space:]]|d' /etc/apt/apt-mirrors.txt
    fi
    timeout --signal=TERM --kill-after=30s 8m npx playwright install --with-deps "${browser_engines[@]}"
  fi
  node --input-type=module -e 'import fs from "node:fs"; import { chromium, webkit } from "playwright"; const engines = { chromium, webkit }; for (const name of process.argv.slice(1)) if (!fs.existsSync(engines[name].executablePath())) throw new Error(`Install the pinned ${name} browser before this gate`);' "${browser_engines[@]}"
)
(
  cd "$REPO_ROOT/consent-protocol"
  document='tests/services/test_document_delivery_browser.py'
  document_webkit_node="${document}::test_protected_document_browser_payment_preview_download_revoke[webkit]"
  phone_webkit_node='tests/test_account_phone_browser.py::test_recorded_phone_browser_journeys[webkit-apple.com]'
  tests=("$document" tests/test_account_phone_browser.py)
  # Playwright's pinned GTK WebKit drops valid leading-zero X25519 key bytes
  # (WebKit/WebKit#72772). Run this unchanged native-crypto flow on macOS;
  # restore Linux placement only after the pinned engine passes those vectors.
  # No crypto substitution, xfail, retry or general WebKit exclusion is allowed.
  case "$mode" in
    --ci-linux-document)
      tests+=(--deselect "$document_webkit_node" --deselect "$phone_webkit_node")
      ;;
    --ci-macos-webkit)
      tests=(
        "$document_webkit_node"
        "$phone_webkit_node"
      )
      ;;
  esac
  TESTING=true DB_OFFLINE=1 OFFLINE_DB_PATH="$test_dir/protocol.db" \
  GOOGLE_CLOUD_PROJECT=hushh-ci-test REQUIRE_CONNECTOR_POSTGRES=1 REQUIRE_PHONE_TRANSFER_POSTGRES=1 \
  .venv/bin/python -m pytest -q \
    "${tests[@]}"
)
