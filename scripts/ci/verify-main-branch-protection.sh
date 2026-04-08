#!/usr/bin/env bash
set -euo pipefail

REPO="${GITHUB_REPO:-hushh-labs/hushh-research}"
BRANCH="${GITHUB_BRANCH:-main}"
REQUIRED_CHECKS="${GITHUB_REQUIRED_CHECKS:-${GITHUB_REQUIRED_CHECK:-CI Status Gate}}"
MIN_APPROVALS="${GITHUB_MIN_APPROVALS:-1}"
REQUIRE_STRICT="${GITHUB_REQUIRE_STRICT:-false}"
REQUIRE_MERGE_QUEUE="${GITHUB_REQUIRE_MERGE_QUEUE:-true}"

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ GitHub CLI (gh) is required to verify live branch protection."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "❌ GitHub CLI is not authenticated. Run 'gh auth login' first."
  exit 1
fi

PROTECTION_JSON="$(gh api "repos/${REPO}/branches/${BRANCH}/protection")"
RULESETS_JSON="$(gh api "repos/${REPO}/rules/branches/${BRANCH}" || echo '[]')"
export PROTECTION_JSON RULESETS_JSON

python3 - "$REQUIRED_CHECKS" "$MIN_APPROVALS" "$REQUIRE_STRICT" "$REQUIRE_MERGE_QUEUE" <<'PY'
import json
import os
import sys

required_checks = [item.strip() for item in sys.argv[1].split(",") if item.strip()]
min_approvals = int(sys.argv[2])
require_strict = sys.argv[3].lower() == "true"
require_merge_queue = sys.argv[4].lower() == "true"
data = json.loads(os.environ["PROTECTION_JSON"])
rulesets = json.loads(os.environ["RULESETS_JSON"])

checks = []
checks.extend(data.get("required_status_checks", {}).get("contexts", []))
checks.extend(
    check.get("context")
    for check in data.get("required_status_checks", {}).get("checks", [])
    if check.get("context")
)
checks = sorted(set(checks))
strict_checks = data.get("required_status_checks", {}).get("strict", False)

approvals = (
    data.get("required_pull_request_reviews", {}).get("required_approving_review_count", 0)
)
force_pushes = data.get("allow_force_pushes", {}).get("enabled", False)
deletions = data.get("allow_deletions", {}).get("enabled", False)
admins_enforced = data.get("enforce_admins", {}).get("enabled", False)
merge_queue_enabled = any(
    item.get("type") == "merge_queue" and item.get("parameters")
    for item in rulesets
)

errors = []
for required_check in required_checks:
    if required_check not in checks:
        errors.append(f"required status check missing: {required_check}")
if approvals < min_approvals:
    errors.append(f"required approvals too low: {approvals} < {min_approvals}")
if require_strict and not strict_checks:
    errors.append("required status checks are not strict/up-to-date")
if force_pushes:
    errors.append("force pushes are allowed")
if deletions:
    errors.append("branch deletions are allowed")
if require_merge_queue and not merge_queue_enabled:
    errors.append("merge queue rule is not enabled on the branch")

print(f"Branch protection summary: checks={checks}, approvals={approvals}, "
      f"strict={strict_checks}, enforce_admins={admins_enforced}, allow_force_pushes={force_pushes}, "
      f"allow_deletions={deletions}, merge_queue_enabled={merge_queue_enabled}")

if errors:
    for error in errors:
        print(f"ERROR: {error}")
    sys.exit(1)
PY

python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ["RULESETS_JSON"])
if not data:
    print("Rulesets: none attached to this branch.")
else:
    names = [f"{item.get('name', '<unnamed>')} ({item.get('type', 'unknown')})" for item in data]
    print(f"Rulesets: {names}")
PY

echo "✅ Live branch protection matches the documented minimum contract."
