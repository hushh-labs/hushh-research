#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [ "${SKIP_SECRET_SCAN:-0}" = "1" ]; then
  echo "Skipping secret scan because SKIP_SECRET_SCAN=1"
  exit 0
fi

export REQUIRE_GITHUB_ALERTS_CLEAN="${REQUIRE_GITHUB_ALERTS_CLEAN:-1}"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is required for CI parity. Install it or set SKIP_SECRET_SCAN=1 for local-only runs."
  exit 1
fi

if [ -n "${GITLEAKS_LOG_OPTS:-}" ]; then
  LOG_OPTS="${GITLEAKS_LOG_OPTS}"
else
  DEFAULT_BRANCH="${GITLEAKS_DEFAULT_BRANCH:-}"
  if [ -z "$DEFAULT_BRANCH" ]; then
    DEFAULT_BRANCH="$(
      git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true
    )"
  fi

  if [ -z "$DEFAULT_BRANCH" ]; then
    DEFAULT_BRANCH="$(
      git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' | head -n 1 || true
    )"
  fi

  if [ -z "$DEFAULT_BRANCH" ]; then
    DEFAULT_BRANCH="main"
  fi

  if [ -n "$DEFAULT_BRANCH" ] && git rev-parse "origin/$DEFAULT_BRANCH" >/dev/null 2>&1; then
    MERGE_BASE="$(git merge-base "origin/$DEFAULT_BRANCH" HEAD)"
    LOG_OPTS="--ancestry-path ${MERGE_BASE}..HEAD"
  else
    LOG_OPTS="HEAD"
  fi
fi

CONFIG_ARGS=()
if [ -f "$REPO_ROOT/.gitleaks.toml" ]; then
  CONFIG_ARGS+=(--config "$REPO_ROOT/.gitleaks.toml")
fi

echo "Running gitleaks with log opts: ${LOG_OPTS}"
EXIT_CODE=0
gitleaks git --redact --no-banner --exit-code 1 "${CONFIG_ARGS[@]}" --log-opts="${LOG_OPTS}" || EXIT_CODE=$?

scan_pull_request_body() {
  local tmpdir pr_number body_file
  tmpdir="$(mktemp -d)"
  body_file="$tmpdir/pull-request-body.md"

  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH:-}" ]; then
    python3 - <<'PY' "${GITHUB_EVENT_PATH}" "$body_file"
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
body = ((payload.get("pull_request") or {}).get("body") or "").strip()
Path(sys.argv[2]).write_text(body, encoding="utf-8")
PY
  elif command -v gh >/dev/null 2>&1 && [ -n "${SECRET_SCAN_PR_NUMBER:-}" ]; then
    gh pr view "${SECRET_SCAN_PR_NUMBER}" --json body --jq .body >"$body_file"
  else
    rm -rf "$tmpdir"
    return 0
  fi

  if [ ! -s "$body_file" ]; then
    rm -rf "$tmpdir"
    return 0
  fi

  echo "Running gitleaks against pull request body metadata..."
  gitleaks dir --redact --no-banner --exit-code 1 "${CONFIG_ARGS[@]}" "$tmpdir" || EXIT_CODE=$?
  rm -rf "$tmpdir"
}

if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] || [ -n "${SECRET_SCAN_PR_NUMBER:-}" ]; then
  scan_pull_request_body
fi

if [ -x "$REPO_ROOT/scripts/ci/github-security-alerts.sh" ]; then
  "$REPO_ROOT/scripts/ci/github-security-alerts.sh" || EXIT_CODE=$?
fi

exit "$EXIT_CODE"
