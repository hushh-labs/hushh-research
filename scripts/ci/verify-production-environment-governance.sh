#!/usr/bin/env bash
set -euo pipefail

REPO="${GITHUB_REPO:-hushh-labs/hushh-research}"
PRODUCTION_OWNER="${PRODUCTION_DEPLOY_OWNER:-kushaltrivedi5}"
APPROVAL_ENV="${PRODUCTION_APPROVAL_ENV:-production-approval}"
OWNER_BYPASS_ENV="${PRODUCTION_OWNER_BYPASS_ENV:-production-owner-bypass}"

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ GitHub CLI (gh) is required to verify live production environment governance."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "❌ GitHub CLI is not authenticated. Run 'gh auth login' first."
  exit 1
fi

APPROVAL_JSON="$(gh api "repos/${REPO}/environments/${APPROVAL_ENV}")"
OWNER_JSON="$(gh api "repos/${REPO}/environments/${OWNER_BYPASS_ENV}")"
export APPROVAL_JSON OWNER_JSON

python3 - "$PRODUCTION_OWNER" "$APPROVAL_ENV" "$OWNER_BYPASS_ENV" <<'PY'
import json
import os
import sys

owner = sys.argv[1]
approval_env = sys.argv[2]
owner_env = sys.argv[3]
approval = json.loads(os.environ["APPROVAL_JSON"])
owner_lane = json.loads(os.environ["OWNER_JSON"])

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

approval_reviewers = reviewer_logins(approval)
owner_reviewers = reviewer_logins(owner_lane)
approval_admin_bypass = bool(approval.get("can_admins_bypass"))
owner_admin_bypass = bool(owner_lane.get("can_admins_bypass"))

errors = []
if owner not in approval_reviewers:
    errors.append(
        f"{approval_env} missing required reviewer '{owner}'"
    )
if owner_reviewers:
    errors.append(
        f"{owner_env} should not require reviewers, found: {owner_reviewers}"
    )
if approval_admin_bypass:
    errors.append(
        f"{approval_env} still allows admin bypass; disable it so only '{owner}' can approve production."
    )
if owner_admin_bypass:
    errors.append(
        f"{owner_env} still allows admin bypass; keep access constrained by workflow actor instead."
    )

print(
    f"Production environment summary: approval_reviewers={approval_reviewers}, "
    f"approval_can_admins_bypass={approval_admin_bypass}, "
    f"owner_bypass_reviewers={owner_reviewers}, owner_bypass_can_admins_bypass={owner_admin_bypass}"
)

if errors:
    for error in errors:
        print(f"ERROR: {error}")
    sys.exit(1)
PY

echo "✅ Live production environment governance matches the documented contract."
