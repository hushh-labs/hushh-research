#!/usr/bin/env bash
set -euo pipefail

TARGET_SHA="${1:-${DEPLOY_SHA:-}}"
REQUIRED_BRANCH="${REQUIRED_BRANCH:-main}"
REQUIRE_CI_SUCCESS="${REQUIRE_CI_SUCCESS:-0}"
REQUIRED_CHECK_NAME="${REQUIRED_CHECK_NAME:-CI Status Gate}"

if [ -z "$TARGET_SHA" ]; then
  echo "Usage: scripts/ci/require-deploy-sha-on-main.sh <commit-sha>" >&2
  exit 1
fi

git fetch --no-tags origin "$REQUIRED_BRANCH"

if ! git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null; then
  git fetch --no-tags origin "$TARGET_SHA" >/dev/null 2>&1 || true
fi

if ! git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null; then
  echo "Refusing deploy: commit '$TARGET_SHA' is not available in the local clone." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$TARGET_SHA" "origin/$REQUIRED_BRANCH"; then
  echo "Refusing deploy: commit '$TARGET_SHA' is not reachable from origin/$REQUIRED_BRANCH." >&2
  exit 1
fi

if [ "$REQUIRE_CI_SUCCESS" != "1" ]; then
  echo "Deploy SHA preflight passed: '$TARGET_SHA' is on origin/$REQUIRED_BRANCH."
  exit 0
fi

if [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "Refusing deploy: GITHUB_REPOSITORY and GITHUB_TOKEN are required for CI check validation." >&2
  exit 1
fi

PAYLOAD="$(curl -fsSL \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}/check-runs?per_page=100")"

python3 - "$TARGET_SHA" "$REQUIRED_BRANCH" "$REQUIRED_CHECK_NAME" "$PAYLOAD" <<'PY'
import json
import sys

sha, branch, check_name, payload_json = sys.argv[1:]
payload = json.loads(payload_json)

check_runs = payload.get("check_runs", [])
matches = [run for run in check_runs if run.get("name") == check_name]
if not matches:
    available = ", ".join(sorted({str(run.get("name")) for run in check_runs if run.get("name")})) or "<none>"
    raise SystemExit(
        f"Refusing deploy: required check '{check_name}' not found for {sha} on {branch}. "
        f"Available checks: {available}"
    )

successful = [run for run in matches if run.get("conclusion") == "success"]
if not successful:
    conclusions = ", ".join(str(run.get("conclusion") or "unknown") for run in matches)
    raise SystemExit(
        f"Refusing deploy: required check '{check_name}' is not successful for {sha} on {branch}. "
        f"Observed conclusions: {conclusions}"
    )

print(f"Deploy SHA preflight passed: {sha} is on origin/{branch} and '{check_name}' succeeded.")
PY
