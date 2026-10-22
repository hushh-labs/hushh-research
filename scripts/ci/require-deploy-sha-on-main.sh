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

# The payload goes to a FILE, never to argv. Linux caps a single argument
# string at MAX_ARG_STRLEN (32 * PAGE_SIZE = 128 KiB), and this response has
# no bound that respects it: it is every check run on the commit, at up to 100
# per page, each carrying the full `app` object. A commit with ~30 checks
# already lands within ~10% of the ceiling, and one that crosses it kills
# python3 with "Argument list too long" (exit 126) BEFORE any check is read.
# That is a deploy gate failing for a reason unrelated to the deploy — observed
# on the dev lane, 2026-08-07, run 31145632745. Every release lane calls this
# script, so the same commit would have blocked uat, production and both iOS
# lanes identically.
PAYLOAD_DIR="$(mktemp -d)"
trap 'rm -rf "$PAYLOAD_DIR"' EXIT

# One request per accepted name, filtered by GitHub (check_name). The
# unfiltered list is newest first and is never de-duplicated across workflow
# runs, so its first page of 100 can fill with newer checks on an idle main
# head (each Capacity Maintenance pass adds its jobs there) and lose the push-
# time "Main Post-Merge Smoke Gate" entirely.
index=0
IFS=',' read -r -a requested_names <<< "$REQUIRED_CHECK_NAME"
for requested in "${requested_names[@]}"; do
  name="$(printf '%s' "$requested" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$name" ] || continue
  index=$((index + 1))
  curl -fsSL -G \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    --data-urlencode "check_name=${name}" \
    --data-urlencode "per_page=100" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}/check-runs" \
    -o "$PAYLOAD_DIR/$index.json"
done

# Dev may explicitly accept a full manual branch verdict. Bind that new label
# to the canonical Actions workflow/event and check suite; never trust its name
# or follow a caller-controlled details_url. Other release names stay unchanged.
for requested in "${requested_names[@]}"; do
  name="$(printf '%s' "$requested" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ "$name" = "Branch Validation Gate" ] || continue
  mkdir -p "$PAYLOAD_DIR/provenance"
  curl -fsSL -G \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    --data-urlencode "event=workflow_dispatch" \
    --data-urlencode "head_sha=${TARGET_SHA}" \
    --data-urlencode "per_page=100" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs" \
    -o "$PAYLOAD_DIR/provenance/branch.json"
  break
done

python3 - "$TARGET_SHA" "$REQUIRED_BRANCH" "$REQUIRED_CHECK_NAME" "$PAYLOAD_DIR" <<'PY'
import json
import sys
from pathlib import Path

sha, branch, check_name, payload_dir = sys.argv[1:]

# REQUIRED_CHECK_NAME accepts a comma-separated any-of list because the
# authoritative full-CI check differs by commit kind: PR heads carry
# "CI Status Gate", merge-queue train heads carry "Queue Validation", and
# main merge commits carry "Main Post-Merge Smoke Gate". A single-name
# value keeps the historical exact-match behavior.
accepted_names = [name.strip() for name in check_name.split(",") if name.strip()]

check_runs = []
for page in sorted(Path(payload_dir).glob("*.json")):
    check_runs.extend(json.loads(page.read_text(encoding="utf-8")).get("check_runs", []))
matches = [run for run in check_runs if run.get("name") in accepted_names]
if not matches:
    available = ", ".join(sorted({str(run.get("name")) for run in check_runs if run.get("name")})) or "<none>"
    raise SystemExit(
        f"Refusing deploy: none of the required checks {accepted_names} found for {sha} on {branch}. "
        f"Available checks: {available}"
    )

def verified_branch_check(check):
    if check.get("name") != "Branch Validation Gate":
        return True
    if (
        check.get("head_sha") != sha
        or check.get("status") != "completed"
        or check.get("app", {}).get("id") != 15368
        or check.get("app", {}).get("slug") != "github-actions"
    ):
        return False
    suite = check.get("check_suite", {}).get("id")
    if type(suite) is not int or suite <= 0:
        return False
    payload = Path(payload_dir) / "provenance/branch.json"
    # A bounded API page can refuse an old run, never authorize an unobserved
    # one. A fresh full dispatch supplies a current receipt if the page is full.
    runs = json.loads(payload.read_text(encoding="utf-8")).get("workflow_runs", [])
    return any(
        run.get("head_sha") == sha
        and run.get("check_suite_id") == suite
        and run.get("path") == ".github/workflows/ci.yml"
        and run.get("event") == "workflow_dispatch"
        and run.get("status") == "completed"
        and run.get("conclusion") == "success"
        for run in runs
    )


successful = [
    run for run in matches
    if run.get("conclusion") == "success" and verified_branch_check(run)
]
if not successful:
    conclusions = ", ".join(
        f"{run.get('name')}={run.get('conclusion') or 'unknown'}" for run in matches
    )
    raise SystemExit(
        f"Refusing deploy: no required check in {accepted_names} is successful for {sha} on {branch}. "
        f"Observed: {conclusions}"
    )

passed = sorted({str(run.get("name")) for run in successful})
print(f"Deploy SHA preflight passed: {sha} is on origin/{branch}; successful check(s): {', '.join(passed)}.")
PY
