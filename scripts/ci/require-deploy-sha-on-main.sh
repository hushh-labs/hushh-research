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
  curl -fsSL --connect-timeout 10 --max-time 30 -G \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    --data-urlencode "check_name=${name}" \
    --data-urlencode "per_page=100" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}/check-runs" \
    -o "$PAYLOAD_DIR/$index.json"
done

python3 - "$TARGET_SHA" "$REQUIRED_BRANCH" "$REQUIRED_CHECK_NAME" "$PAYLOAD_DIR" <<'PY'
import json
import os
import subprocess
import sys
from urllib.parse import urlencode
from datetime import datetime
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

# A label from a different App or diagnostic build cannot authorize release.
producers = {
    "CI Status Gate": [("ci.yml", "pull_request"), ("queue-validation.yml", "merge_group")],
    "Queue Validation": [("queue-validation.yml", "merge_group")],
    "Branch Validation Gate": [("ci.yml", "workflow_dispatch")],
    "Main Post-Merge Smoke Gate": [("main-post-merge-smoke.yml", "push"),
                                   ("main-post-merge-smoke.yml", "workflow_dispatch")],
}
api = f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}"
cache = {}


def request_json(path):
    if path not in cache:
        output = Path(payload_dir) / f"authority-{len(cache)}.json"
        response = subprocess.run(
            ["curl", "-fsSL", "--connect-timeout", "10", "--max-time", "30", "-H", "Accept: application/vnd.github+json",
             "-H", f"Authorization: Bearer {os.environ['GITHUB_TOKEN']}",
             api + path, "-o", str(output)], capture_output=True, text=True,
        )
        if response.returncode:
            raise SystemExit("Refusing deploy: check authority lookup failed.")
        try:
            cache[path] = json.loads(output.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise SystemExit("Refusing deploy: malformed check authority response.")
    return cache[path]



def current_jobs(run):
    attempt = run.get("run_attempt")
    if type(attempt) is not int or attempt <= 0:
        raise SystemExit("Refusing deploy: current attempt is missing.")
    inventory = request_json(f"/actions/runs/{run['id']}/attempts/{attempt}/jobs?per_page=100")
    jobs = inventory.get("jobs")
    if (not isinstance(jobs, list) or type(inventory.get("total_count")) is not int
            or inventory["total_count"] != len(jobs)):
        raise SystemExit("Refusing deploy: incomplete current-attempt job inventory.")
    return jobs


def separate_recovery(run, name):
    # Recovery validates another application SHA. Its distinct verdict neither
    # authorizes normal promotion nor invalidates a normal smoke verdict.
    if (name != "Main Post-Merge Smoke Gate" or run.get("event") != "workflow_dispatch"
            or run.get("head_branch") != "main"):
        return False
    jobs = current_jobs(run)
    return (len(jobs) == 1 and jobs[0].get("name") == "Production Recovery Validation Gate"
            and jobs[0].get("run_id") == run["id"]
            and jobs[0].get("head_sha") == run["head_sha"])


def attempt_order(run):
    try:
        times = [datetime.fromisoformat(run[key].replace("Z", "+00:00"))
                 for key in ("run_started_at", "updated_at")]
        if any(value.tzinfo is None for value in times):
            raise ValueError("missing timezone")
        return max(times), run["id"]
    except (KeyError, TypeError, ValueError):
        raise SystemExit("Refusing deploy: attempt chronology cannot be verified.")


def unchanged_runs(runs):
    fields = ("id", "head_sha", "path", "event", "check_suite_id", "run_attempt",
              "status", "conclusion", "head_branch", "run_started_at", "updated_at")
    for run in runs:
        path = f"/actions/runs/{run['id']}"
        cache.pop(path, None)
        fresh = request_json(path)
        if any(fresh.get(key) != run.get(key) for key in fields):
            return False
    return True


def verified_check(check):
    name = check.get("name")
    if (check.get("head_sha") != sha or check.get("status") != "completed"
            or check.get("conclusion") != "success"
            or check.get("app", {}).get("id") != 15368
            or check.get("app", {}).get("slug") != "github-actions"):
        return False
    suite = check.get("check_suite", {}).get("id")
    if type(suite) is not int or suite <= 0 or type(check.get("id")) is not int:
        return False
    candidates = []
    for workflow, event in producers.get(name, []):
        query = urlencode({"event": event, "head_sha": sha, "per_page": 100})
        inventory = request_json(f"/actions/workflows/{workflow}/runs?{query}")
        runs = inventory.get("workflow_runs")
        if (not isinstance(runs, list) or type(inventory.get("total_count")) is not int
                or inventory["total_count"] != len(runs) or len(runs) > 100):
            raise SystemExit("Refusing deploy: incomplete bounded workflow-run inventory.")
        candidates.extend(run for run in runs if run.get("head_sha") == sha
                      and run.get("path") == f".github/workflows/{workflow}"
                      and run.get("event") == event and type(run.get("id")) is int)
    observed = candidates
    candidates = [run for run in observed if not separate_recovery(run, name)]
    if not candidates:
        return False
    # Run IDs do not change on rerun. A later attempt of an older run must
    # invalidate stale green evidence, including while the rerun is pending.
    run = max(candidates, key=attempt_order)
    workflow = run["path"].rsplit("/", 1)[-1]
    event = run["event"]
    attempt = run.get("run_attempt")
    if (run.get("check_suite_id") != suite or run.get("status") != "completed"
            or run.get("conclusion") != "success"
            or type(attempt) is not int or attempt <= 0
            or workflow == "main-post-merge-smoke.yml" and run.get("head_branch") != "main"):
        return False
    for job in current_jobs(run):
        if (job.get("name") != name or job.get("status") != "completed"
                or job.get("conclusion") != "success"
                or job.get("check_run_url") != api + f"/check-runs/{check['id']}"):
            continue
        if name == "Main Post-Merge Smoke Gate" and event == "workflow_dispatch":
            # Old dispatches could test another checkout than the SHA
            # receiving the check. Only the guarded producer qualifies.
            if not any(step.get("name") == "Verify smoke source identity"
                       and step.get("conclusion") == "success"
                       for step in job.get("steps", [])):
                continue
        return unchanged_runs(observed)
    return False


successful = [run for run in matches if verified_check(run)]
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
