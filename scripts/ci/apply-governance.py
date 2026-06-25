#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Apply config/ci-governance.json to live GitHub state — the SINGLE command.

This is the write-side counterpart to verify-main-branch-protection.sh (which is
read-only / drift-detection). Editing config/ci-governance.json is the ONLY
action a maintainer needs: this script pushes that intent to GitHub so the live
state matches the committed policy.

WHAT IT SYNCS (all idempotent — safe to re-run):
  1. main branch protection `review_bypass_users`
       <- main.review_bypass_users
     (the list that was silently drifting: editing the JSON never reached GitHub,
      so a maintainer added to the JSON still couldn't approve/merge to main.)
  2. The `allowed-maintainers-to-approve` org team membership
       <- union(main.review_bypass_users, main.merge_queue_bypass_users)
     (this team is the merge-queue bypass actor list; membership IS the allowlist.)
  3. UAT / production deploy allowlists need NO GitHub action — assert-governed-actor.py
     reads uat.manual_dispatch_users / production.manual_dispatch_users from this
     same JSON at workflow runtime. This script just reports them for transparency.

USAGE:
  python3 scripts/ci/apply-governance.py            # dry-run: show the plan, change nothing
  python3 scripts/ci/apply-governance.py --apply    # actually push to GitHub

After --apply, scripts/ci/verify-main-branch-protection.sh should pass clean.

Requires: gh CLI authenticated with org admin (to edit team membership) and
repo admin (to edit branch protection).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = "hushh-labs/hushh-research"
ORG = "hushh-labs"
TEAM_SLUG = "allowed-maintainers-to-approve"
BRANCH = "main"
REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "config" / "ci-governance.json"


def gh(args: list[str], *, check: bool = True) -> tuple[int, str, str]:
    p = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and p.returncode != 0:
        raise SystemExit(f"gh {' '.join(args)} failed:\n{p.stderr.strip()}")
    return p.returncode, p.stdout, p.stderr


def gh_json(args: list[str]):
    _, out, _ = gh(args)
    return json.loads(out) if out.strip() else None


def load_policy() -> dict:
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


def desired_review_bypass(policy: dict) -> list[str]:
    return sorted(set(policy["main"]["review_bypass_users"]))


def desired_team_members(policy: dict) -> list[str]:
    # The team backs merge-queue bypass; keep it the union of both main allowlists
    # so a maintainer added to either list is fully empowered (approve + queue).
    m = policy["main"]
    return sorted(set(m["review_bypass_users"]) | set(m["merge_queue_bypass_users"]))


def current_review_bypass() -> list[str]:
    data = gh_json(["api", f"repos/{REPO}/branches/{BRANCH}/protection"])
    users = (
        (data or {})
        .get("required_pull_request_reviews", {})
        .get("bypass_pull_request_allowances", {})
        .get("users", [])
    )
    return sorted(u["login"] for u in users if u.get("login"))


def current_team_members() -> list[str]:
    members = gh_json(["api", f"orgs/{ORG}/teams/{TEAM_SLUG}/members", "--paginate"]) or []
    return sorted(m["login"] for m in members if m.get("login"))


def apply_review_bypass(desired: list[str], *, apply: bool) -> bool:
    """PUT the full required_pull_request_reviews object with the desired user
    bypass list. We preserve every other review setting read from live state so
    nothing else is reset. Returns True if a change was (or would be) made."""
    cur = current_review_bypass()
    if cur == desired:
        print(f"  ✓ review_bypass_users already in sync: {desired}")
        return False
    print(f"  Δ review_bypass_users: {cur}  ->  {desired}")
    if not apply:
        return True

    # Read the live review object to preserve all sibling settings.
    data = gh_json(["api", f"repos/{REPO}/branches/{BRANCH}/protection"]) or {}
    rpr = data.get("required_pull_request_reviews", {})
    bp = rpr.get("bypass_pull_request_allowances", {})
    team_slugs = [t["slug"] for t in bp.get("teams", []) if t.get("slug")]
    app_slugs = [a.get("slug") for a in bp.get("apps", []) if a.get("slug")]

    payload = {
        "dismiss_stale_reviews": bool(rpr.get("dismiss_stale_reviews", False)),
        "require_code_owner_reviews": bool(rpr.get("require_code_owner_reviews", False)),
        "require_last_push_approval": bool(rpr.get("require_last_push_approval", False)),
        "required_approving_review_count": int(rpr.get("required_approving_review_count", 1)),
        "bypass_pull_request_allowances": {
            "users": desired,
            "teams": team_slugs,
            "apps": app_slugs,
        },
    }
    # PATCH only the required_pull_request_reviews sub-resource (leaves status
    # checks, enforce_admins, etc. untouched).
    proc = subprocess.run(
        ["gh", "api", "--method", "PATCH",
         f"repos/{REPO}/branches/{BRANCH}/protection/required_pull_request_reviews",
         "--input", "-"],
        input=json.dumps(payload), capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"Failed to update review bypass:\n{proc.stderr.strip()}")
    print("  ✅ review_bypass_users updated on GitHub")
    return True


def apply_team_membership(desired: list[str], *, apply: bool) -> bool:
    cur = set(current_team_members())
    want = set(desired)
    to_add = sorted(want - cur)
    to_remove = sorted(cur - want)
    if not to_add and not to_remove:
        print(f"  ✓ team '{TEAM_SLUG}' membership already in sync: {sorted(want)}")
        return False
    if to_add:
        print(f"  Δ team add: {to_add}")
    if to_remove:
        print(f"  Δ team remove: {to_remove}")
    if not apply:
        return True
    for login in to_add:
        gh(["api", "--method", "PUT",
            f"orgs/{ORG}/teams/{TEAM_SLUG}/memberships/{login}",
            "-f", "role=maintainer"])
        print(f"  ✅ added {login} to {TEAM_SLUG}")
    for login in to_remove:
        gh(["api", "--method", "DELETE",
            f"orgs/{ORG}/teams/{TEAM_SLUG}/memberships/{login}"])
        print(f"  ✅ removed {login} from {TEAM_SLUG}")
    return True


def report_deploy_allowlists(policy: dict) -> None:
    uat = policy.get("uat", {}).get("manual_dispatch_users", [])
    prod = policy.get("production", {}).get("manual_dispatch_users", [])
    print("\nDeploy allowlists (config-driven — no GitHub sync needed; "
          "assert-governed-actor.py reads these at workflow runtime):")
    print(f"  UAT  manual_dispatch_users:        {sorted(uat)}")
    print(f"  PROD manual_dispatch_users:        {sorted(prod)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="Push changes to GitHub. Without this, runs dry (plan only).")
    args = ap.parse_args()

    if not POLICY_PATH.exists():
        raise SystemExit(f"Policy file not found: {POLICY_PATH}")
    policy = load_policy()

    mode = "APPLY" if args.apply else "DRY-RUN (no changes — pass --apply to push)"
    print(f"=== apply-governance [{mode}] — source: config/ci-governance.json ===\n")

    print("1. main branch protection review_bypass_users")
    changed_a = apply_review_bypass(desired_review_bypass(policy), apply=args.apply)

    print(f"\n2. org team '{TEAM_SLUG}' membership (merge-queue bypass actors)")
    changed_b = apply_team_membership(desired_team_members(policy), apply=args.apply)

    report_deploy_allowlists(policy)

    print()
    if not args.apply and (changed_a or changed_b):
        print("Plan has changes. Re-run with --apply to push them to GitHub.")
        return 0
    if args.apply:
        print("✅ Governance applied. Run scripts/ci/verify-main-branch-protection.sh to confirm.")
    else:
        print("✅ Live GitHub state already matches config/ci-governance.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
