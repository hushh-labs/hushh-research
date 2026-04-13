#!/usr/bin/env bash
set -euo pipefail

REPO="${GITHUB_REPO:-hushh-labs/hushh-research}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
POLICY_FILE="${GITHUB_CI_GOVERNANCE_FILE:-$REPO_ROOT/config/ci-governance.json}"
PRODUCTION_OWNER="${PRODUCTION_DEPLOY_OWNER:-kushaltrivedi5}"
OWNER_BYPASS_ENV="${PRODUCTION_OWNER_BYPASS_ENV:-production-owner-bypass}"

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ GitHub CLI (gh) is required to verify live production environment governance."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "❌ GitHub CLI is not authenticated. Run 'gh auth login' first."
  exit 1
fi

OWNER_JSON="$(gh api "repos/${REPO}/environments/${OWNER_BYPASS_ENV}")"
export OWNER_JSON POLICY_FILE

python3 - "$PRODUCTION_OWNER" "$OWNER_BYPASS_ENV" <<'PY'
import json
import os
import sys
from pathlib import Path

owner = sys.argv[1]
owner_env = sys.argv[2]
owner_lane = json.loads(os.environ["OWNER_JSON"])
policy = json.loads(Path(os.environ["POLICY_FILE"]).read_text(encoding="utf-8"))
expected_manual_dispatch_users = policy["production"]["manual_dispatch_users"]
expected_owner_env = policy["production"]["owner_environment"]

def reviewer_logins(payload):
    rules = payload.get("protection_rules") or []
    logins = []
    for rule in rules:
        if rule.get("type") != "required_reviewers":
            continue
        for reviewer in rule.get("reviewers") or []:
            entity = reviewer.get("reviewer") or {}
            login = (entity.get("login") or "").strip()
            if login:
                logins.append(login)
    return sorted(set(logins))

owner_reviewers = reviewer_logins(owner_lane)
owner_admin_bypass = bool(owner_lane.get("can_admins_bypass"))

errors = []
if owner_reviewers:
    errors.append(
        f"{owner_env} should not require reviewers, found: {owner_reviewers}"
    )
if owner_admin_bypass:
    errors.append(
        f"{owner_env} still allows admin bypass; keep access constrained by workflow actor instead."
    )
if expected_manual_dispatch_users != [owner]:
    errors.append(
        f"production manual dispatch policy drifted: expected ['{owner}'], got {expected_manual_dispatch_users}"
    )
if expected_owner_env != owner_env:
    errors.append(
        f"production owner environment drifted: expected {owner_env}, got {expected_owner_env}"
    )

print(
    f"Production environment summary: owner_bypass_reviewers={owner_reviewers}, "
    f"owner_bypass_can_admins_bypass={owner_admin_bypass}, "
    f"manual_dispatch_users={expected_manual_dispatch_users}, owner_environment={expected_owner_env}"
)

if errors:
    for error in errors:
        print(f"ERROR: {error}")
    sys.exit(1)
PY

echo "✅ Live production environment governance matches the documented contract."
