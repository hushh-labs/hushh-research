#!/usr/bin/env bash
set -euo pipefail

REPO="${GITHUB_REPO:-hushh-labs/hushh-research}"
BRANCH="${GITHUB_BRANCH:-main}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
POLICY_FILE="${GITHUB_CI_GOVERNANCE_FILE:-$REPO_ROOT/config/ci-governance.json}"
REQUIRED_CHECKS="${GITHUB_REQUIRED_CHECKS:-${GITHUB_REQUIRED_CHECK:-}}"
MIN_APPROVALS="${GITHUB_MIN_APPROVALS:-}"
REQUIRE_STRICT="${GITHUB_REQUIRE_STRICT:-false}"
REQUIRE_MERGE_QUEUE="${GITHUB_REQUIRE_MERGE_QUEUE:-}"

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
RULESET_LIST_JSON="$(gh api "repos/${REPO}/rulesets?includes_parents=true" || echo '[]')"
export PROTECTION_JSON RULESETS_JSON RULESET_LIST_JSON POLICY_FILE

python3 - "$REQUIRED_CHECKS" "$MIN_APPROVALS" "$REQUIRE_STRICT" "$REQUIRE_MERGE_QUEUE" "$REPO" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

required_checks_arg, min_approvals_arg, require_strict_arg, require_merge_queue_arg, repo = sys.argv[1:]
policy = json.loads(Path(os.environ["POLICY_FILE"]).read_text(encoding="utf-8"))
required_checks = [
    item.strip()
    for item in (required_checks_arg or policy["main"]["required_status_check"]).split(",")
    if item.strip()
]
min_approvals = int(min_approvals_arg or policy["main"]["required_approving_reviews"])
require_strict = require_strict_arg.lower() == "true"
require_merge_queue = (
    require_merge_queue_arg.lower() == "true"
    if require_merge_queue_arg
    else bool(policy["main"]["merge_queue_required"])
)
expected_bypass = sorted(policy["main"]["review_bypass_users"])
expected_queue_bypass = sorted(policy["main"]["merge_queue_bypass_users"])
expected_queue_bypass_team_slug = str(policy["main"].get("merge_queue_bypass_team_slug") or "").strip()
data = json.loads(os.environ["PROTECTION_JSON"])
rulesets = json.loads(os.environ["RULESETS_JSON"])
ruleset_list = json.loads(os.environ["RULESET_LIST_JSON"])

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
bypass_users = sorted(
    user.get("login", "").strip()
    for user in (
        data.get("required_pull_request_reviews", {})
        .get("bypass_pull_request_allowances", {})
        .get("users", [])
    )
    if user.get("login")
)

merge_queue_bypass = []
merge_queue_bypass_team_slugs = []
for ruleset in ruleset_list:
    if ruleset.get("target") != "branch" or ruleset.get("enforcement") != "active":
        continue
    ruleset_id = ruleset.get("id")
    if not ruleset_id:
        continue
    detail = json.loads(
        subprocess.run(
            ["gh", "api", f"repos/{repo}/rulesets/{ruleset_id}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    if detail.get("name") != "main merge queue":
        continue
    for actor in detail.get("bypass_actors") or []:
        actor_name = ""
        actor_type = str(actor.get("actor_type") or "").strip()
        if actor_type == "Team":
            actor_id = actor.get("actor_id")
            if actor_id:
                team_detail = json.loads(
                    subprocess.run(
                        ["gh", "api", f"organizations/140115870/team/{actor_id}"],
                        check=True,
                        capture_output=True,
                        text=True,
                    ).stdout
                )
                team_slug = str(team_detail.get("slug") or "").strip()
                if team_slug:
                    merge_queue_bypass_team_slugs.append(team_slug)
                    memberships = json.loads(
                        subprocess.run(
                            ["gh", "api", f"organizations/140115870/team/{actor_id}/members"],
                            check=True,
                            capture_output=True,
                            text=True,
                        ).stdout
                    )
                    for member in memberships:
                        member_login = str(member.get("login") or "").strip()
                        if member_login:
                            merge_queue_bypass.append(member_login)
        else:
            actor_info = actor.get("actor") or {}
            if isinstance(actor_info, dict):
                actor_name = str(actor_info.get("login") or actor_info.get("name") or "").strip()
            if actor_name:
                merge_queue_bypass.append(actor_name)
merge_queue_bypass = sorted(set(merge_queue_bypass))
merge_queue_bypass_team_slugs = sorted(set(merge_queue_bypass_team_slugs))

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
if bypass_users != expected_bypass:
    errors.append(f"review bypass users drifted: expected {expected_bypass}, got {bypass_users}")
if merge_queue_bypass != expected_queue_bypass:
    errors.append(
        f"merge queue bypass actors drifted: expected {expected_queue_bypass}, got {merge_queue_bypass}"
    )
if expected_queue_bypass_team_slug and merge_queue_bypass_team_slugs != [expected_queue_bypass_team_slug]:
    errors.append(
        f"merge queue bypass team drifted: expected {[expected_queue_bypass_team_slug]}, got {merge_queue_bypass_team_slugs}"
    )

print(f"Branch protection summary: checks={checks}, approvals={approvals}, "
      f"strict={strict_checks}, enforce_admins={admins_enforced}, allow_force_pushes={force_pushes}, "
      f"allow_deletions={deletions}, merge_queue_enabled={merge_queue_enabled}, "
      f"review_bypass_users={bypass_users}, merge_queue_bypass={merge_queue_bypass}, "
      f"merge_queue_bypass_teams={merge_queue_bypass_team_slugs}")

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
