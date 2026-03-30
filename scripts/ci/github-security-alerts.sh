#!/usr/bin/env bash
set -euo pipefail

STRICT_MODE="${REQUIRE_GITHUB_ALERTS_CLEAN:-0}"

strict_fail() {
  echo "$1"
  if [ "$STRICT_MODE" = "1" ]; then
    exit 1
  fi
  exit 0
}

if ! command -v gh >/dev/null 2>&1; then
  strict_fail "GitHub security alert parity check unavailable: gh CLI not installed."
fi

if ! gh auth status >/dev/null 2>&1; then
  strict_fail "GitHub security alert parity check unavailable: gh CLI not authenticated."
fi

resolve_repo() {
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    printf "%s" "$GITHUB_REPOSITORY"
    return
  fi

  REPO_FROM_GH="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
  if [ -n "$REPO_FROM_GH" ]; then
    printf "%s" "$REPO_FROM_GH"
    return
  fi

  REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
  case "$REMOTE_URL" in
    https://github.com/*)
      printf "%s" "${REMOTE_URL#https://github.com/}" | sed 's/\.git$//'
      return
      ;;
    git@github.com:*)
      printf "%s" "${REMOTE_URL#git@github.com:}" | sed 's/\.git$//'
      return
      ;;
  esac
}

REPO="$(resolve_repo)"
if [ -z "$REPO" ]; then
  strict_fail "GitHub security alert parity check unavailable: could not resolve repository."
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

SECRET_ALERTS_JSON="$TMPDIR/secret-alerts.json"
DEPENDABOT_ALERTS_JSON="$TMPDIR/dependabot-alerts.json"

if ! gh api -H 'Accept: application/vnd.github+json' \
  "/repos/${REPO}/secret-scanning/alerts?state=open&per_page=100" >"$SECRET_ALERTS_JSON" 2>"$TMPDIR/secret-errors.log"; then
  echo "GitHub security alert parity check failed: unable to read secret-scanning alerts."
  sed 's/^/  /' "$TMPDIR/secret-errors.log" || true
  if grep -q "Resource not accessible by integration" "$TMPDIR/secret-errors.log"; then
    echo "  Hint: set a repo secret like GH_SECURITY_ALERTS_TOKEN with a PAT that can read secret-scanning and Dependabot alerts."
  fi
  if [ "$STRICT_MODE" = "1" ]; then
    exit 1
  fi
  exit 0
fi

if ! gh api -H 'Accept: application/vnd.github+json' \
  "/repos/${REPO}/dependabot/alerts?state=open&per_page=100" >"$DEPENDABOT_ALERTS_JSON" 2>"$TMPDIR/dependabot-errors.log"; then
  echo "GitHub security alert parity check failed: unable to read dependabot alerts."
  sed 's/^/  /' "$TMPDIR/dependabot-errors.log" || true
  if grep -q "Resource not accessible by integration" "$TMPDIR/dependabot-errors.log"; then
    echo "  Hint: set a repo secret like GH_SECURITY_ALERTS_TOKEN with a PAT that can read secret-scanning and Dependabot alerts."
  fi
  if [ "$STRICT_MODE" = "1" ]; then
    exit 1
  fi
  exit 0
fi

python3 - <<'PY' "$SECRET_ALERTS_JSON" "$DEPENDABOT_ALERTS_JSON"
import json
import sys
from pathlib import Path

secret_alerts = json.loads(Path(sys.argv[1]).read_text())
dependabot_alerts = json.loads(Path(sys.argv[2]).read_text())

print(f"GitHub secret scanning open alerts: {len(secret_alerts)}")
for alert in secret_alerts[:5]:
    location = alert.get("first_location_detected") or {}
    location_summary = (
        location.get("path")
        or location.get("pull_request_body_url")
        or location.get("blob_url")
        or "<unknown>"
    )
    print(
        f"  - #{alert.get('number')} {alert.get('secret_type_display_name')}"
        f" @ {location_summary}"
    )
if len(secret_alerts) > 5:
    print(f"  ... {len(secret_alerts) - 5} more secret-scanning alerts")

print(f"GitHub dependabot open alerts: {len(dependabot_alerts)}")
for alert in dependabot_alerts[:8]:
    dependency = ((alert.get("dependency") or {}).get("package") or {}).get("name") or "<unknown>"
    severity = (((alert.get("security_advisory") or {}).get("severity")) or "<unknown>").upper()
    summary = ((alert.get("security_advisory") or {}).get("summary") or "").strip()
    print(f"  - #{alert.get('number')} {dependency} [{severity}] {summary}")
if len(dependabot_alerts) > 8:
    print(f"  ... {len(dependabot_alerts) - 8} more dependabot alerts")
PY

if [ "${REQUIRE_GITHUB_ALERTS_CLEAN:-0}" = "1" ]; then
  SECRET_COUNT="$(python3 - <<'PY' "$SECRET_ALERTS_JSON"
import json, sys
from pathlib import Path
print(len(json.loads(Path(sys.argv[1]).read_text())))
PY
)"
  DEPENDABOT_COUNT="$(python3 - <<'PY' "$DEPENDABOT_ALERTS_JSON"
import json, sys
from pathlib import Path
print(len(json.loads(Path(sys.argv[1]).read_text())))
PY
)"
  if [ "$SECRET_COUNT" -gt 0 ] || [ "$DEPENDABOT_COUNT" -gt 0 ]; then
    echo "GitHub security alert parity check failed: open alerts remain."
    exit 1
  fi
fi
