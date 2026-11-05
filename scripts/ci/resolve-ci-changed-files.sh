#!/usr/bin/env bash
# Reuse the existing exact review-base resolver; never invent a second diff.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
head="$(git rev-parse --verify "${CI_IMPACT_HEAD_SHA:-HEAD}^{commit}")"
base="${CI_IMPACT_BASE_SHA:-}"
if [ -z "$base" ]; then base="$(python3 scripts/ci/resolve-ui-contract-base.py)"; fi
if [ -z "$base" ] && [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ]; then
  # Manual UI validation keeps its own receipts, but CI still needs the exact
  # branch delta. Reuse the protected-edit resolver's pinned, unambiguous base.
  base="$(python3 - "$head" <<'PY'
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

head = sys.argv[1]
def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()

if head != os.environ["GITHUB_SHA"] or head != git("rev-parse", "HEAD"):
    raise SystemExit("Manual CI change input requires the exact dispatched checkout")
event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
branch = event["repository"]["default_branch"]
subprocess.run(["git", "check-ref-format", f"refs/heads/{branch}"], check=True)
target = git("rev-parse", "--verify", f"refs/remotes/origin/{branch}^{{commit}}")
sys.path.insert(0, str(Path("scripts/ci").resolve()))
guard = runpy.run_path("scripts/ci/verify-protected-pipeline-edits.py")
print(guard["authored_change_base"](target, head, repository_root=Path.cwd()))
PY
)"
fi
git rev-parse --verify "${base}^{commit}" >/dev/null
git rev-parse --verify "${head}^{commit}" >/dev/null
file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/hushh-ci-changed-files-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
umask 077
git diff --name-only "$base" "$head" > "$file"
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'CI_CHANGED_FILES_FILE=%s\n' "$file" >> "$GITHUB_ENV"
else
  printf '%s\n' "$file"
fi
