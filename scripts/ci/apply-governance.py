#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Apply config/ci-governance.json to live GitHub state — the SINGLE command.

This is the write-side counterpart to verify-main-branch-protection.sh (which is
read-only / drift-detection). Editing config/ci-governance.json is the ONLY
action a maintainer needs: this script pushes that intent to GitHub so the live
state matches the committed policy.

WHAT IT SYNCS (all idempotent — safe to re-run):
  1. repository `allow_auto_merge`
       <- repository.allow_auto_merge
     (required for `gh pr merge` to enqueue merge-queue PRs instead of failing
      with enablePullRequestAutoMerge when review is still pending.)
  2. main and integration/pr-train branch-protection `review_bypass_users`
       <- main.review_bypass_users / pr_train.review_bypass_users
     (the list that was silently drifting: editing the JSON never reached GitHub,
      so a maintainer added to the JSON still couldn't approve/merge to main.)
  3. Org team membership for every capability in MANAGED_TEAMS
       <- the matching list in config/ci-governance.json
     One team per capability: maintainers, pipeline editors, and one per deploy
     lane. The teams are a DERIVED MIRROR, so people can be found and @-mentioned
     in one place. They are never what the gate reads: assert-governed-actor.py
     reads this JSON at workflow runtime, so the gate stays offline, deterministic,
     and needs no org-scoped credential.

     The direction matters. Config -> team means widening access costs a reviewed
     PR touching a protected path, editable by protected_pipeline_edit_users only,
     and leaves a diff in git log. Reading teams live would invert that: any org
     owner or team maintainer could grant production deploy with no PR at all.

     Members are added at role=member for the same reason — see TEAM_MEMBER_ROLE.

USAGE:
  python3 scripts/ci/apply-governance.py            # dry-run: show the plan, change nothing
  python3 scripts/ci/apply-governance.py --apply    # actually push to GitHub

After --apply, verify both `main` and `integration/pr-train` branch protection.

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
# Every capability in config/ci-governance.json that is also materialised as a
# real GitHub team. The config file stays the source of truth and the only thing
# the runtime gate reads; a team is a derived mirror, so people can be managed
# and @-mentioned in one place without the gate ever depending on a network call
# or an org-scoped credential.
#
# role=member is deliberate and load-bearing. A GitHub team *maintainer* can add
# members to their own team, and `allowed-maintainers-to-approve` sits in main's
# branch-protection bypass_teams — so granting that role to members would let any
# of them hand a 15th person review bypass on main with no PR, no review and no
# trace in this repo, routing straight around protected_pipeline_edit_users.
# Membership changes must cost a reviewed edit to the config file.
TEAM_MEMBER_ROLE = "member"

MANAGED_TEAMS: tuple[dict, ...] = (
    {
        "slug": "allowed-maintainers-to-approve",
        "purpose": "merge-queue and review bypass actors",
        # The union so a maintainer declared on either governed branch is
        # fully represented.
        "select": lambda p: sorted(
            set().union(*(
                set(p[k]["review_bypass_users"]) | set(p[k]["merge_queue_bypass_users"])
                for k in ("main", "pr_train")
            ))
        ),
        "is_maintainer_set": True,
    },
    {
        "slug": "pipeline-editors",
        "purpose": "may edit protected pipeline paths",
        "select": lambda p: sorted(p["main"]["protected_pipeline_edit_users"]),
    },
    {
        "slug": "deploy-dev",
        "purpose": "may dispatch a dev deploy",
        "select": lambda p: sorted(p["dev"]["manual_dispatch_users"]),
    },
    {
        "slug": "deploy-uat",
        "purpose": "may dispatch a UAT deploy",
        "select": lambda p: sorted(p["uat"]["manual_dispatch_users"]),
    },
    {
        "slug": "deploy-production",
        "purpose": "may dispatch a production deploy",
        "select": lambda p: sorted(p["production"]["manual_dispatch_users"]),
    },
)

TEAM_SLUG = MANAGED_TEAMS[0]["slug"]
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


def desired_review_bypass(policy: dict, policy_key: str) -> list[str]:
    return sorted(set(policy[policy_key]["review_bypass_users"]))


def desired_allow_auto_merge(policy: dict) -> bool:
    repository_policy = policy.get("repository") or {}
    return bool(repository_policy.get("allow_auto_merge", True))


def current_allow_auto_merge() -> bool:
    data = gh_json(["api", f"repos/{REPO}"]) or {}
    return bool(data.get("allow_auto_merge", False))


def apply_repository_settings(policy: dict, *, apply: bool) -> bool:
    desired = desired_allow_auto_merge(policy)
    current = current_allow_auto_merge()
    if current == desired:
        print(f"  ✓ allow_auto_merge already in sync: {desired}")
        return False
    print(f"  Δ allow_auto_merge: {current}  ->  {desired}")
    if not apply:
        return True

    proc = subprocess.run(
        [
            "gh",
            "api",
            "--method",
            "PATCH",
            f"repos/{REPO}",
            "--input",
            "-",
        ],
        input=json.dumps({"allow_auto_merge": desired}),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"Failed to update repository settings:\n{proc.stderr.strip()}")
    print("  ✅ repository allow_auto_merge updated on GitHub")
    return True


def current_review_bypass(branch: str) -> list[str]:
    data = gh_json(["api", f"repos/{REPO}/branches/{branch}/protection"])
    users = (
        (data or {})
        .get("required_pull_request_reviews", {})
        .get("bypass_pull_request_allowances", {})
        .get("users", [])
    )
    return sorted(u["login"] for u in users if u.get("login"))


def team_exists(slug: str) -> bool:
    code, _, _ = gh(["api", f"orgs/{ORG}/teams/{slug}"], check=False)
    return code == 0


def current_team_members(slug: str = TEAM_SLUG) -> list[str]:
    members = gh_json(["api", f"orgs/{ORG}/teams/{slug}/members", "--paginate"]) or []
    return sorted(m["login"] for m in members if m.get("login"))


def apply_review_bypass(branch: str, desired: list[str], *, apply: bool) -> bool:
    """PUT the full required_pull_request_reviews object with the desired user
    bypass list. We preserve every other review setting read from live state so
    nothing else is reset. Returns True if a change was (or would be) made."""
    cur = current_review_bypass(branch)
    if cur == desired:
        print(f"  ✓ {branch} review_bypass_users already in sync: {desired}")
        return False
    print(f"  Δ {branch} review_bypass_users: {cur}  ->  {desired}")
    if not apply:
        return True

    # Read the live review object to preserve all sibling settings.
    data = gh_json(["api", f"repos/{REPO}/branches/{branch}/protection"]) or {}
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
         f"repos/{REPO}/branches/{branch}/protection/required_pull_request_reviews",
         "--input", "-"],
        input=json.dumps(payload), capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"Failed to update review bypass:\n{proc.stderr.strip()}")
    print(f"  ✅ {branch} review_bypass_users updated on GitHub")
    return True


def apply_team_membership(slug: str, desired: list[str], *, apply: bool) -> bool:
    """Make one managed team's membership match the config exactly."""
    if not team_exists(slug):
        print(f"  Δ team '{slug}' does not exist yet -> create with {sorted(desired)}")
        if not apply:
            return True
        gh(["api", "--method", "POST", f"orgs/{ORG}/teams",
            "-f", f"name={slug}", "-f", "privacy=closed"])
        print(f"  ✅ created team {slug}")

    cur = set(current_team_members(slug))
    want = set(desired)
    to_add = sorted(want - cur)
    to_remove = sorted(cur - want)

    # A member sitting at role=maintainer can add people to the team, which is a
    # grant path that never touches this repo. Demote as part of every sync, not
    # only when the membership set itself changed.
    over_privileged = sorted(
        login for login in (want & cur)
        if (gh_json(["api", f"orgs/{ORG}/teams/{slug}/memberships/{login}"]) or {})
        .get("role") != TEAM_MEMBER_ROLE
    )

    if not to_add and not to_remove and not over_privileged:
        print(f"  ✓ team '{slug}' already in sync: {sorted(want)}")
        return False
    if to_add:
        print(f"  Δ team add: {to_add}")
    if to_remove:
        print(f"  Δ team remove: {to_remove}")
    if over_privileged:
        print(f"  Δ demote to '{TEAM_MEMBER_ROLE}': {over_privileged}")
    if not apply:
        return True
    for login in sorted(set(to_add) | set(over_privileged)):
        gh(["api", "--method", "PUT",
            f"orgs/{ORG}/teams/{slug}/memberships/{login}",
            "-f", f"role={TEAM_MEMBER_ROLE}"])
        print(f"  ✅ {login} is a '{TEAM_MEMBER_ROLE}' of {slug}")
    for login in to_remove:
        gh(["api", "--method", "DELETE",
            f"orgs/{ORG}/teams/{slug}/memberships/{login}"])
        print(f"  ✅ removed {login} from {slug}")
    return True


def assert_teams_are_subsets_of_maintainers(policy: dict) -> None:
    """No capability may be held by someone who cannot merge.

    Every deploy lane and the pipeline-editor set are meant to be narrower than
    the maintainer cohort. A name that appears in one of them and not in the
    maintainer list is a grant nobody intended, so refuse to mirror it to GitHub
    rather than quietly creating a team that encodes the mistake.
    """
    maintainers = set(MANAGED_TEAMS[0]["select"](policy))
    problems = []
    for team in MANAGED_TEAMS:
        if team.get("is_maintainer_set"):
            continue
        extra = sorted(set(team["select"](policy)) - maintainers)
        if extra:
            problems.append(f"  {team['slug']}: {extra}")
    if problems:
        raise SystemExit(
            "Refusing to sync: these actors hold a capability without being "
            "maintainers.\n" + "\n".join(problems)
        )


def sync_managed_teams(policy: dict, *, apply: bool) -> bool:
    """Mirror every capability list in the config onto its GitHub team."""
    assert_teams_are_subsets_of_maintainers(policy)
    changed = False
    for team in MANAGED_TEAMS:
        print(f"\n  team '{team['slug']}' — {team['purpose']}")
        changed |= apply_team_membership(
            team["slug"], team["select"](policy), apply=apply
        )
    return changed


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

    print("1. repository settings")
    changed_repo = apply_repository_settings(policy, apply=args.apply)

    train_branch = policy["branch_flow"]["train_branch"]
    print("\n2. governed branch protection review_bypass_users")
    changed_main = apply_review_bypass(
        "main", desired_review_bypass(policy, "main"), apply=args.apply
    )
    changed_train = apply_review_bypass(
        train_branch, desired_review_bypass(policy, "pr_train"), apply=args.apply
    )

    print("\n3. org team membership, mirrored from config/ci-governance.json")
    changed_b = sync_managed_teams(policy, apply=args.apply)

    print()
    if not args.apply and (changed_repo or changed_main or changed_train or changed_b):
        print("Plan has changes. Re-run with --apply to push them to GitHub.")
        return 0
    if args.apply:
        print("✅ Governance applied. Verify main and integration/pr-train branch protection.")
    else:
        print("✅ Live GitHub state already matches config/ci-governance.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
