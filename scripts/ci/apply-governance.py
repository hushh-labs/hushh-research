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
  python3 scripts/ci/apply-governance.py --queue-response-timeout-policy main dev uat
      # separate budget-only dry-run; add --apply after reviewing the plan

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


_OWNERS_CACHE: set[str] | None = None


def organization_owners() -> set[str]:
    """Logins with org-owner (admin) rights, lowercased. Queried once per run."""
    global _OWNERS_CACHE
    if _OWNERS_CACHE is None:
        members = gh_json(
            ["api", f"orgs/{ORG}/members?role=admin", "--paginate"]
        ) or []
        _OWNERS_CACHE = {str(m.get("login", "")).lower() for m in members if m.get("login")}
    return _OWNERS_CACHE


def team_exists(slug: str) -> bool:
    code, _, _ = gh(["api", f"orgs/{ORG}/teams/{slug}"], check=False)
    return code == 0


def current_team_members(slug: str = TEAM_SLUG) -> list[str]:
    members = gh_json(["api", f"orgs/{ORG}/teams/{slug}/members", "--paginate"]) or []
    return sorted(m["login"] for m in members if m.get("login"))


def apply_review_bypass(
    branch: str, desired: list[str], *, team_slug: str | None, apply: bool,
    require_code_owner_reviews: bool | None = None,
) -> bool:
    """Reconcile authored user/team allowances while preserving other settings."""
    data = gh_json(["api", f"repos/{REPO}/branches/{branch}/protection"]) or {}
    rpr = data.get("required_pull_request_reviews")
    if not isinstance(rpr, dict):
        raise SystemExit(f"Cannot reconcile {branch}: live review settings unavailable")
    bp = rpr.get("bypass_pull_request_allowances", {})
    cur = sorted(u["login"] for u in bp.get("users", []) if u.get("login"))
    current_teams = sorted(t["slug"] for t in bp.get("teams", []) if t.get("slug"))
    team_slugs = [team_slug] if team_slug else []
    owner_review = bool(rpr.get("require_code_owner_reviews", False)) if require_code_owner_reviews is None else require_code_owner_reviews
    if cur == desired and current_teams == team_slugs and bool(rpr.get("require_code_owner_reviews", False)) == owner_review:
        print(f"  ✓ {branch} review bypass already in sync: users={desired}, teams={team_slugs}")
        return False
    print(f"  Δ {branch} review bypass: users={cur} -> {desired}; teams={current_teams} -> {team_slugs}")
    if not apply:
        return True
    app_slugs = [a["slug"] for a in bp.get("apps", []) if a.get("slug")]

    payload = {
        "dismiss_stale_reviews": bool(rpr.get("dismiss_stale_reviews", False)),
        "require_code_owner_reviews": owner_review,
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
    #
    # Org owners are excluded because GitHub reports them as a maintainer of every
    # team they belong to and refuses to demote them there. Trying anyway would
    # make this sync claim drift on every single run and never converge, and a
    # governance tool that always cries drift is one people learn to scroll past
    # -- which is how the UAT cohort sat wrong in the advisory lane for as long as
    # it did. It costs nothing in safety either: an org owner can edit branch
    # protection and team membership directly, so their team role grants them no
    # authority they did not already hold.
    owners = organization_owners()
    over_privileged = sorted(
        login for login in (want & cur)
        if login.lower() not in owners
        and (gh_json(["api", f"orgs/{ORG}/teams/{slug}/memberships/{login}"]) or {})
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


def main_merge_cohorts(policy: dict) -> tuple[list[str], list[str]]:
    """Review and direct-merge exceptions never imply protected editing rights."""
    main = policy["main"]
    reviews = sorted(main.get("review_bypass_users", []))
    direct = sorted(main.get("merge_queue_bypass_users", []))
    mergers = set(main.get("merge_users", []))
    if (not reviews or not set(reviews) <= mergers or not set(direct) <= set(reviews)
            or main.get("review_bypass_team_slug") or main.get("merge_queue_bypass_team_slug")):
        raise SystemExit("Main exceptions must name explicit governed mergers without inherited teams")
    return reviews, direct


def protected_pipeline_review_rulesets(policy: dict, *, read=gh_json) -> list[dict]:
    """Native approval protects candidate-modified queue workflows independently."""
    main = policy["main"]
    owners = main["protected_pipeline_edit_users"]
    name = policy["branch_flow"].get("protected_pipeline_review_ruleset_name")
    if (not isinstance(name, str) or not name or name != name.strip()
            or name == policy["branch_flow"].get("review_rulesets", {}).get("main")
            or not isinstance(owners, list) or not owners
            or any(not isinstance(login, str) or not login for login in owners)
            or len(set(owners)) != len(owners)
            or not set(owners) <= set(main["review_bypass_users"])):
        raise SystemExit("Protected path review requires its own name and exact owner authority")
    paths = main.get("protected_pipeline_paths")
    if not isinstance(paths, list) or not paths or any(
        not isinstance(path, str) or not path or path.startswith("/")
        or any(c in path for c in "!*?[]\\\n\r")
        or any(part in {"", ".", ".."} for part in path.rstrip("/").split("/"))
        for path in paths
    ):
        raise SystemExit("Protected path review requires canonical literal paths")
    if not {".github/workflows/", "scripts/ci/", "config/ci-governance.json"} <= set(paths):
        raise SystemExit("Protected path review must protect workflow and policy authority")
    team = read(["api", f"orgs/{ORG}/teams/pipeline-editors"])
    if team.get("slug") != "pipeline-editors" or type(team.get("id")) is not int or team["id"] <= 0:
        raise SystemExit("Protected reviewer team identity is unavailable")
    # Ordinary Main review exceptions do not become protected-path approvers.
    actors = []
    for login in sorted(owners):
        user = read(["api", f"users/{login}"])
        if (user.get("login") != login or user.get("type") != "User"
                or type(user.get("id")) is not int or user["id"] <= 0):
            raise SystemExit("Protected review bypass requires a verified named user")
        actors.append({"actor_id": user["id"], "actor_type": "User", "bypass_mode": "pull_request"})
    # The installed original pair keeps its exact 30-path assignment. Append
    # supplemental entrypoints; never shift an installed partition while adding one.
    if len(paths) < 30 or len(paths) != len(set(paths)):
        raise SystemExit("Protected review requires the original 30 distinct paths")
    def pattern(path):
        return "/" + path + ("**" if path.endswith("/") else "")
    original = sorted(pattern(path) for path in paths[:30])
    supplemental = sorted(pattern(path) for path in paths[30:])
    chunks = [original[:15], original[15:]] + [supplemental[i:i + 15] for i in range(0, len(supplemental), 15)]
    return [{
        "name": f"{name}{suffix} {index + 1}", "target": "branch", "enforcement": "active",
        "conditions": {"ref_name": {"include": refs, "exclude": []}},
        "bypass_actors": actors,
        "rules": [{"type": "pull_request", "parameters": {
            "required_approving_review_count": 0,
            "dismiss_stale_reviews_on_push": True,
            "require_code_owner_review": False,
            "require_last_push_approval": False,
            "required_review_thread_resolution": False,
            "require_extra_approval_for_unattributed_changes": False,
            "required_reviewers": [{
                "file_patterns": patterns,
                "minimum_approvals": 1,
                "reviewer": {"id": team["id"], "type": "Team"},
            }],
        }}],
    } for suffix, refs in (
        ("", ["refs/heads/main", "refs/heads/dev", "refs/heads/uat"]),
        (" inherited", ["refs/heads/integration/pr-train", "refs/heads/uat-isolated"]),
    ) for index, patterns in enumerate(chunks)]


def reconcile_protected_pipeline_review(policy: dict, *, apply: bool = False, verify_only: bool = False, read=gh_json) -> bool:
    """Stage A adds protection; it never retires native reviews or queue rules."""
    from prepared_branch_governance import _write

    desired_rules = protected_pipeline_review_rulesets(policy, read=read)
    owners = sorted(policy["main"]["protected_pipeline_edit_users"])
    actor = read(["api", "user"])
    if apply and verify_only:
        raise SystemExit("Native review verification cannot mutate settings")
    if not verify_only and (actor.get("type") != "User" or actor.get("login") not in owners):
        raise SystemExit("Only a protected owner may install native pipeline review")
    def verify_admins():
        for owner in owners:
            permission = read(["api", f"repos/{REPO}/collaborators/{owner}/permission"])
            if permission.get("permission") != "admin" or permission.get("user", {}).get("login") != owner:
                raise SystemExit("Reviewer team grants require both existing owners to be repository admins")

    verify_admins()
    team_id = desired_rules[0]["rules"][0]["parameters"]["required_reviewers"][0]["reviewer"]["id"]
    team_path = f"orgs/{ORG}/teams/pipeline-editors"
    grant_path = f"{team_path}/repos/{REPO}"

    def verify_members():
        members = read(["api", f"{team_path}/members?per_page=100"])
        if (not isinstance(members, list) or len(members) >= 100
                or any(not isinstance(row, dict) or row.get("type") != "User" for row in members)
                or sorted(row.get("login", "") for row in members) != owners):
            raise SystemExit("Protected reviewer team membership differs from exact owners")

    def grant():
        rows = read(["api", f"repos/{REPO}/teams?per_page=100"])
        if not isinstance(rows, list) or len(rows) >= 100 or any(not isinstance(row, dict) for row in rows):
            raise SystemExit("Repository team inventory is unavailable or incomplete")
        matches = [row for row in rows if row.get("id") == team_id or row.get("slug") == "pipeline-editors"]
        if len(matches) > 1 or any(row.get("id") != team_id or row.get("slug") != "pipeline-editors" for row in matches):
            raise SystemExit("Protected reviewer repository grant has conflicting identity")
        return matches[0].get("permission") if matches else None

    verify_members()
    previous_grant = grant()
    if previous_grant not in {None, "pull", "triage", "push", "maintain", "admin"}:
        raise SystemExit("Protected reviewer repository permission is unrecognized")
    needs_grant = previous_grant not in {"push", "maintain", "admin"}
    endpoint = f"repos/{REPO}/rulesets"
    inventory = read(["api", f"{endpoint}?per_page=100"])
    if not isinstance(inventory, list) or len(inventory) >= 100:
        raise SystemExit("Native review ruleset inventory is unavailable or incomplete")
    if any(row.get("name") == policy["branch_flow"]["protected_pipeline_review_ruleset_name"] for row in inventory):
        raise SystemExit("Legacy unpartitioned protected review requires explicit reconciliation")
    existing_rules = {}
    for desired in desired_rules:
        matches = [row for row in inventory if row.get("name") == desired["name"]]
        if len(matches) > 1:
            raise SystemExit("Native protected review ruleset is ambiguous")
        existing = read(["api", f"{endpoint}/{matches[0]['id']}"]) if matches else None
        if existing and not same_review_ruleset(existing, desired):
            raise SystemExit("Existing protected review differs; explicit reconciliation is required")
        if existing:
            existing_rules[desired["name"]] = existing
    protections = {branch: read(["api", f"repos/{REPO}/branches/{branch}/protection"])
                   for branch in ("main", "dev", "uat")}
    guards = {row["id"]: read(["api", f"{endpoint}/{row['id']}"])
              for row in inventory if row.get("target") == "branch"}
    missing = len(desired_rules) - len(existing_rules)
    print(f"Stage A: native protected review create={missing}; owner-team write={needs_grant}. Existing safeguards retained.")
    if verify_only and (missing or needs_grant):
        raise SystemExit("Exact native protected review and owner-team write must be installed first")
    if not apply:
        return bool(missing or needs_grant)
    created_rules = {}
    installed_ids = {}
    uncertain_creation = None
    grant_attempted = False
    grant_confirmed = False
    try:
        if needs_grant:
            if grant() != previous_grant:
                raise SystemExit("Reviewer-team grant changed before mutation; concurrent permission retained")
            # GitHub uses an unconditional PUT, not compare-and-swap. Recheck
            # observed drift, and serialize operator applies across machines.
            grant_attempted = True
            _write(grant_path, {"permission": "push"}, "PUT")
            grant_confirmed = True
        verify_members()
        verify_admins()
        if grant() not in {"push", "maintain", "admin"}:
            raise SystemExit("Protected reviewer team write access was not confirmed")
        for desired in desired_rules:
            existing = existing_rules.get(desired["name"])
            if existing is None:
                uncertain_creation = desired["name"]
                result = subprocess.run(
                    ["gh", "api", "--method", "POST", endpoint, "--input", "-"],
                    input=json.dumps(desired), capture_output=True, text=True,
                )
                if result.returncode:
                    raise SystemExit(f"Native review creation failed: {result.stderr.strip()}")
                created = json.loads(result.stdout)
                if (type(created.get("id")) is not int or created["id"] <= 0
                        or created.get("name") != desired["name"]
                        or created["id"] in created_rules
                        or any(row.get("id") == created["id"] for row in inventory)):
                    raise SystemExit("Native review creation returned no verified rule ID")
                created_rules[created["id"]] = desired
                uncertain_creation = None
            rule_id = existing["id"] if existing else created["id"]
            installed_ids[desired["name"]] = rule_id
            installed = read(["api", f"{endpoint}/{rule_id}"])
            if not same_review_ruleset(installed, desired):
                raise SystemExit("Native protected review readback differs from approved policy")
            final_inventory = read(["api", f"{endpoint}?per_page=100"])
            if (not isinstance(final_inventory, list) or len(final_inventory) >= 100
                    or [row.get("id") for row in final_inventory if row.get("name") == desired["name"]] != [rule_id]):
                raise SystemExit("Native protected review inventory became ambiguous")
        # Recheck the whole installed pair: a peer can change partition one
        # while partition two is being created or read back.
        final_inventory = read(["api", f"{endpoint}?per_page=100"])
        if not isinstance(final_inventory, list) or len(final_inventory) >= 100:
            raise SystemExit("Native protected review final inventory is incomplete")
        for desired in desired_rules:
            rule_id = installed_ids[desired["name"]]
            if ([row.get("id") for row in final_inventory if row.get("name") == desired["name"]] != [rule_id]
                    or not same_review_ruleset(read(["api", f"{endpoint}/{rule_id}"]), desired)):
                raise SystemExit("Native protected review pair changed during installation")
        verify_members()
        verify_admins()
        if grant() not in {"push", "maintain", "admin"}:
            raise SystemExit("Protected reviewer team write access changed")
        if any(read(["api", f"repos/{REPO}/branches/{branch}/protection"]) != before
               for branch, before in protections.items()) or any(
            read(["api", f"{endpoint}/{rule_id}"]) != before for rule_id, before in guards.items()
        ):
            raise SystemExit("Existing native safeguards changed during Stage A")
    except (Exception, SystemExit) as error:
        repair = []
        rule_absent = not uncertain_creation
        try:
            if uncertain_creation:
                raise SystemExit(f"Rule creation outcome uncertain ({uncertain_creation}); retained for inspection and resume")
            for created_id, desired in reversed(list(created_rules.items())):
                if not same_review_ruleset(read(["api", f"{endpoint}/{created_id}"]), desired):
                    raise SystemExit("New rule changed; refusing to delete another operation's work")
                _write(f"{endpoint}/{created_id}", {}, "DELETE")
                after = read(["api", f"{endpoint}?per_page=100"])
                if not isinstance(after, list) or len(after) >= 100 or any(row.get("id") == created_id for row in after):
                    raise SystemExit("New rule absence is unconfirmed")
            if grant_attempted and rule_absent and grant() == "push":
                if not grant_confirmed:
                    raise SystemExit("Reviewer-team grant outcome uncertain; retained for inspection")
                after = read(["api", f"{endpoint}?per_page=100"])
                if (not isinstance(after, list) or len(after) >= 100
                        or any(row.get("id") not in {item.get("id") for item in inventory} for row in after)):
                    raise SystemExit("Ruleset inventory changed; owner-team grant retained for inspection")
                if grant() != "push":
                    raise SystemExit("Reviewer-team grant changed before rollback; concurrent permission retained")
                _write(grant_path, {"permission": previous_grant} if previous_grant else {},
                       "PUT" if previous_grant else "DELETE")
                if grant() != previous_grant:
                    raise SystemExit("Original reviewer-team access was not restored")
            elif grant_attempted and rule_absent and grant() != previous_grant:
                repair.append("reviewer-team grant changed; concurrent permission retained for inspection")
        except (Exception, SystemExit) as rollback_error:
            repair.append(str(rollback_error))
        raise SystemExit(f"Stage A failed: {error}. Rollback: {'; '.join(repair) if repair else 'task-owned changes restored'}. This operation did not write existing safeguards.") from error
    print("Verified native protected review rulesets for all governed branches; existing safeguards retained.")
    return bool(missing or needs_grant)


def main_exception_actors(logins: list[str], *, read=gh_json) -> list[dict]:
    actors = []
    for login in logins:
        user = read(["api", f"users/{login}"])
        if user.get("login") != login or user.get("type") != "User" or type(user.get("id")) is not int:
            raise SystemExit("Main exception identity could not be verified")
        actors.append({"actor_id": user["id"], "actor_type": "User", "bypass_mode": "pull_request"})
    return actors


def legacy_owner_policy(policy: dict) -> dict:
    """Recognize only the existing coupled-owner rollout, not arbitrary live drift."""
    owners = policy["main"]["protected_pipeline_edit_users"]
    return {**policy, "main": {**policy["main"], "review_bypass_users": owners,
                              "merge_queue_bypass_users": owners}}


def main_owner_admin_ruleset(policy: dict, *, read=gh_json, branch="main") -> dict:
    """Native PR-only and strict CI guard for explicitly selected direct operators.

    Other Main mergers bypass only this additional freshness layer. Their queue,
    baseline CI and explicitly configured review controls remain active.
    """
    if branch == "main":
        main = policy["main"]
        _, owners = main_merge_cohorts(policy)
    else:
        from prepared_branch_governance import branch_policy
        main = branch_policy(policy, branch)
        owners = sorted(main.get("merge_queue_bypass_users", []))
    mergers = sorted(main.get("merge_users", []))
    if (
        not main.get("owner_admin_ruleset_name")
        or not owners
        or (branch != "main" and (
            owners != sorted(main["protected_pipeline_edit_users"])
            or owners != sorted(main["review_bypass_users"])))
        or not set(owners) <= set(mergers)
        or main.get("merge_queue_bypass_team_slug")
    ):
        raise SystemExit(
            "Validated direct merge requires explicit operators and a native strict CI guard"
        )
    actors = []
    for login in sorted(set(mergers) - set(owners)):
        user = read(["api", f"users/{login}"])
        if (
            user.get("login") != login
            or user.get("type") != "User"
            or type(user.get("id")) is not int
        ):
            raise SystemExit("Owner freshness exception identity could not be verified")
        actors.append(
            {
                "actor_id": user["id"],
                "actor_type": "User",
                "bypass_mode": "pull_request",
            }
        )
    return {
        "name": main["owner_admin_ruleset_name"],
        "target": "branch",
        "enforcement": "active",
        "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
        "bypass_actors": actors,
        "rules": [
            {
                "type": "required_status_checks",
                "parameters": {
                    "strict_required_status_checks_policy": True,
                    "do_not_enforce_on_create": False,
                    "required_status_checks": [
                        {
                            "context": main["required_status_check"],
                            "integration_id": 15368,
                        }
                    ],
                },
            },
            {
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "require_code_owner_review": False,
                    "require_last_push_approval": False,
                    "dismiss_stale_reviews_on_push": False,
                    "required_review_thread_resolution": True,
                    "require_extra_approval_for_unattributed_changes": False,
                    "allowed_merge_methods": ["merge"],
                },
            },
        ],
    }


def same_owner_admin_ruleset(observed: dict, desired: dict) -> bool:
    for key in ("name", "target", "enforcement", "conditions"):
        if observed.get(key) != desired[key]:
            return False
    if sorted(
        observed.get("bypass_actors", []), key=lambda x: json.dumps(x, sort_keys=True)
    ) != sorted(desired["bypass_actors"], key=lambda x: json.dumps(x, sort_keys=True)):
        return False
    actual = observed.get("rules", [])
    if len(actual) != 2 or {r.get("type") for r in actual} != {
        "pull_request",
        "required_status_checks",
    }:
        return False
    defaults = {
        "required_reviewers": [],
        "allowed_merge_methods": ["merge", "squash", "rebase"],
        "dismissal_restriction": {"enabled": False, "allowed_actors": []},
        "require_extra_approval_for_unattributed_changes": False,
    }
    for wanted in desired["rules"]:
        params = next(r for r in actual if r["type"] == wanted["type"]).get(
            "parameters", {}
        )
        if any(params.get(k) != v for k, v in wanted["parameters"].items()):
            return False
        if any(
            k not in defaults or defaults[k] != v
            for k, v in params.items()
            if k not in wanted["parameters"]
        ):
            return False
    return True


def reconcile_owner_admin_ruleset(
    policy: dict, *, apply=False, verify_only=False, read=gh_json, repo=REPO, branch="main"
) -> bool:
    desired = main_owner_admin_ruleset(policy, read=read, branch=branch)
    rows = read(["api", f"repos/{repo}/rulesets?per_page=100"])
    if not isinstance(rows, list) or len(rows) >= 100:
        raise SystemExit("Owner Admin ruleset inventory is incomplete")
    matches = [r for r in rows if r.get("name") == desired["name"]]
    if len(matches) > 1:
        raise SystemExit("Owner Admin strict CI authority is ambiguous")
    if matches:
        current = read(["api", f"repos/{repo}/rulesets/{matches[0]['id']}"])
        if not same_owner_admin_ruleset(current, desired):
            if branch != "main":
                raise SystemExit("Owner Admin strict CI/PR-only authority differs; refusing replacement")
            legacy = main_owner_admin_ruleset(legacy_owner_policy(policy), read=read)
            if (verify_only or not same_owner_admin_ruleset(current, legacy)
                    or not all(actor in current.get("bypass_actors", []) for actor in desired["bypass_actors"])):
                raise SystemExit("Owner Admin strict CI/PR-only authority differs; refusing replacement")
            print("  Strengthen strict CI guard before granting the authored direct operators")
            if apply:
                from prepared_branch_governance import _write

                endpoint = f"repos/{repo}/rulesets/{matches[0]['id']}"
                if read(["api", endpoint]) != current:
                    raise SystemExit("Strict CI guard changed during reconciliation")
                _write(endpoint, desired, "PUT")
                reconcile_owner_admin_ruleset(policy, verify_only=True, read=read, repo=repo, branch=branch)
            return True
        return False
    if verify_only:
        raise SystemExit("Owner Admin strict CI/PR-only authority is missing")
    print(
        "  Owner Admin guard: create strict CI and PR-only boundary before admitting owner direct merges"
    )
    if apply:
        from prepared_branch_governance import _write

        _write(f"repos/{repo}/rulesets", desired, "POST")
        reconcile_owner_admin_ruleset(policy, verify_only=True, read=read, repo=repo, branch=branch)
    return True


def main_review_ruleset(policy: dict, *, read=gh_json) -> dict:
    """Resolve only explicitly authored Main review authority, never inherited lanes."""
    name = policy.get("branch_flow", {}).get("review_rulesets", {}).get("main")
    main = policy["main"]
    reviews, _ = main_merge_cohorts(policy)
    if not name:
        raise SystemExit("Main review ruleset must have an explicit name")
    actors = main_exception_actors(reviews, read=read)
    return {
        "name": name, "target": "branch", "enforcement": "active",
        "conditions": {"ref_name": {"include": ["refs/heads/main"], "exclude": []}},
        "bypass_actors": actors,
        "rules": [{"type": "pull_request", "parameters": {
            "dismiss_stale_reviews_on_push": False,
            "require_code_owner_review": bool(main["require_code_owner_reviews"]),
            "require_last_push_approval": bool(main["require_last_push_approval"]),
            "require_extra_approval_for_unattributed_changes": True,
            "required_approving_review_count": main["required_approving_reviews"],
            # Conversation resolution remains independently enforced in classic protection.
            "required_review_thread_resolution": False,
        }}],
    }


def verify_main_review_ruleset(policy: dict, *, read=gh_json, repo: str = REPO) -> dict:
    desired = main_review_ruleset(policy, read=read)
    rows = read(["api", f"repos/{repo}/rulesets?per_page=100"])
    if not isinstance(rows, list) or len(rows) >= 100:
        raise SystemExit("Main review ruleset inventory is incomplete")
    matches = [r for r in rows if r.get("name") == desired["name"]]
    if len(matches) != 1:
        raise SystemExit("Main review ruleset is missing or ambiguous")
    observed = read(["api", f"repos/{repo}/rulesets/{matches[0]['id']}"])
    if not same_review_ruleset(observed, desired):
        raise SystemExit("Main review ruleset differs from authored owner authority")
    return observed


def same_review_ruleset(observed: dict, desired: dict) -> bool:
    for key in ("name", "target", "enforcement", "conditions"):
        if observed.get(key) != desired[key]:
            return False
    actors = observed.get("bypass_actors", [])
    if sorted(actors, key=lambda a: json.dumps(a, sort_keys=True)) != sorted(
            desired["bypass_actors"], key=lambda a: json.dumps(a, sort_keys=True)):
        return False
    rules = observed.get("rules", [])
    if len(rules) != 1 or rules[0].get("type") != "pull_request":
        return False
    actual = rules[0].get("parameters", {})
    wanted = desired["rules"][0]["parameters"]
    # Refuse unowned review controls; GitHub may serialize empty optional defaults.
    extras = {k: v for k, v in actual.items() if k not in wanted}
    defaults = {"required_reviewers": [], "allowed_merge_methods": ["merge", "squash", "rebase"],
                "dismissal_restriction": {"enabled": False, "allowed_actors": []}}
    return all(actual.get(k) == v for k, v in wanted.items()) and all(
        k in defaults and v == defaults[k] for k, v in extras.items())


def reconcile_main_review_ruleset(policy: dict, *, apply: bool) -> bool:
    """Install/read back replacement before retiring only classic review controls."""
    from prepared_branch_governance import _write

    desired = main_review_ruleset(policy, read=gh_json)
    endpoint = f"repos/{REPO}/branches/main/protection"
    protection = gh_json(["api", endpoint])
    classic = protection.get("required_pull_request_reviews")
    checks = protection.get("required_status_checks") or {}
    if (
        not protection.get("enforce_admins", {}).get("enabled")
        or not protection.get("required_conversation_resolution", {}).get("enabled")
        or not any(
            c.get("context") == policy["main"]["required_status_check"]
            and c.get("app_id") == 15368
            for c in checks.get("checks", [])
        )
    ):
        raise SystemExit(
            "Independent Main CI/admin/conversation protections must remain enabled"
        )
    if classic and (
        classic.get("dismiss_stale_reviews")
        or classic.get("dismissal_restrictions")
        or classic.get("required_approving_review_count", 0)
        > policy["main"]["required_approving_reviews"]
    ):
        raise SystemExit(
            "Stronger classic review controls require explicit reconciliation"
        )
    rows = gh_json(["api", f"repos/{REPO}/rulesets?per_page=100"])
    if not isinstance(rows, list) or len(rows) >= 100:
        raise SystemExit("Main review ruleset inventory is incomplete")
    queues = [
        r for r in rows if r.get("name") == policy["main"]["merge_queue_ruleset_name"]
    ]
    matches = [r for r in rows if r.get("name") == desired["name"]]
    if len(queues) != 1 or len(matches) > 1:
        raise SystemExit("Main review/queue inventory is ambiguous")
    queue = gh_json(["api", f"repos/{REPO}/rulesets/{queues[0]['id']}"])
    if (
        queue.get("bypass_actors")
        and not policy["main"].get("owner_admin_ruleset_name")
        or queue.get("enforcement") != "active"
        or queue.get("conditions") != desired["conditions"]
        or not any(r.get("type") == "merge_queue" for r in queue.get("rules", []))
    ):
        raise SystemExit(
            "Remove and verify Main queue bypass before migrating review enforcement"
        )
    strict_changed = False
    if queue.get("bypass_actors"):
        _, direct = main_merge_cohorts(policy)
        _, legacy_direct = main_merge_cohorts(legacy_owner_policy(policy))
        observed = sorted(queue["bypass_actors"], key=lambda a: json.dumps(a, sort_keys=True))
        if not any(observed == sorted(main_exception_actors(users, read=gh_json),
                                     key=lambda a: json.dumps(a, sort_keys=True))
                   for users in (direct, legacy_direct)):
            raise SystemExit("Main queue bypass must match the authored or legacy direct operators")
        strict_changed = reconcile_owner_admin_ruleset(policy, read=gh_json)
    existing = (
        gh_json(["api", f"repos/{REPO}/rulesets/{matches[0]['id']}"])
        if matches
        else None
    )
    if existing and not same_review_ruleset(existing, desired):
        legacy = main_review_ruleset(legacy_owner_policy(policy), read=gh_json)
        if not same_review_ruleset(existing, legacy):
            raise SystemExit("Existing Main review ruleset differs; refusing unreviewed replacement")
    update_existing = existing is not None and not same_review_ruleset(existing, desired)
    if queue.get("bypass_actors") or update_existing:
        # Validate all existing boundaries before strengthening the strict guard.
        strict_changed |= reconcile_owner_admin_ruleset(policy, apply=apply, read=gh_json)
    changed = existing is None or classic is not None or update_existing or strict_changed
    print(
        f"  Main review ruleset: create={existing is None}, retire_classic={classic is not None}, strict_guard_change={strict_changed}"
    )
    if not apply:
        return changed
    if existing is None:
        _write(f"repos/{REPO}/rulesets", desired, "POST")
    elif update_existing:
        endpoint_review = f"repos/{REPO}/rulesets/{matches[0]['id']}"
        if (gh_json(["api", endpoint_review]) != existing
                or gh_json(["api", endpoint]) != protection
                or gh_json(["api", f"repos/{REPO}/rulesets/{queues[0]['id']}"]) != queue):
            raise SystemExit("Main review authority changed during reconciliation")
        reconcile_owner_admin_ruleset(policy, verify_only=True, read=gh_json)
        _write(endpoint_review, desired, "PUT")
    verify_main_review_ruleset(policy, read=gh_json)
    if classic is not None:
        # Recheck independent boundaries and concurrent classic edits before deletion.
        if (
            gh_json(["api", endpoint]) != protection
            or gh_json(["api", f"repos/{REPO}/rulesets/{queues[0]['id']}"]) != queue
        ):
            raise SystemExit(
                "Main protection changed during review migration; classic review retained"
            )
        verify_main_review_ruleset(policy, read=gh_json)
        gh(["api", "--method", "DELETE", f"{endpoint}/required_pull_request_reviews"])
        verify_main_review_ruleset(policy, read=gh_json)
        after = gh_json(["api", endpoint])
        if after.get("required_pull_request_reviews") is not None or any(
            after.get(k) != v
            for k, v in protection.items()
            if k != "required_pull_request_reviews"
        ):
            raise SystemExit(
                "Main review migration readback differs; inspect before continuing"
            )
    return changed


def reconcile_queue_response_timeout(policy: dict, branches: list[str], *, apply: bool) -> bool:
    """Repair queue timing without changing review, bypass or source-parity policy.

    This separate operation can precede Stage B: the longer queue budget must
    allow application/source-sync PRs to validate before review migration.
    """
    from prepared_branch_governance import _same_queue, _write, queue_response_timeout, queue_timeout_payload

    minutes = queue_response_timeout(policy)
    names = {"main": policy["main"]["merge_queue_ruleset_name"]}
    names.update({branch: item["merge_queue_ruleset_name"]
                  for branch, item in policy["branch_flow"]["prepared_branches"].items()})
    if not branches or any(branch not in names for branch in branches):
        raise SystemExit("Select only authored branches for queue check-response timeout reconciliation")
    inventory_endpoint = f"repos/{REPO}/rulesets?per_page=100&includes_parents=false"

    def selected_id(inventory, name):
        if (not isinstance(inventory, list) or len(inventory) >= 100
                or any(not isinstance(row, dict) for row in inventory)):
            raise SystemExit("Queue ruleset inventory is incomplete or malformed")
        matches = [row for row in inventory if row.get("name") == name]
        if len(matches) != 1 or type(matches[0].get("id")) is not int or matches[0]["id"] <= 0:
            raise SystemExit(f"Missing or ambiguous named queue ruleset: {name}")
        return matches[0]["id"]

    inventory = gh_json(["api", inventory_endpoint])
    plans = []
    # Qualify every selected destination before making any write.
    for branch in dict.fromkeys(branches):
        name = names[branch]
        ruleset_id = selected_id(inventory, name)
        endpoint = f"repos/{REPO}/rulesets/{ruleset_id}"
        current = gh_json(["api", endpoint])
        if not isinstance(current, dict) or current.get("id") != ruleset_id:
            raise SystemExit(f"Queue ruleset identity is unproven for {branch}")
        desired = queue_timeout_payload(current, branch=branch, name=name, minutes=minutes)
        before = next(rule for rule in current["rules"] if rule["type"] == "merge_queue")["parameters"][
            "check_response_timeout_minutes"]
        print(f"  {branch}: queue check-response timeout {before} -> {minutes} minutes")
        if not _same_queue(current, desired):
            plans.append((branch, ruleset_id, endpoint, current, desired))
    if apply:
        for branch, ruleset_id, endpoint, current, desired in plans:
            if (selected_id(gh_json(["api", inventory_endpoint]), names[branch]) != ruleset_id
                    or not _same_queue(gh_json(["api", endpoint]), current, snapshot=True)):
                raise SystemExit(f"Queue rules changed for {branch}; replan before writing")
            _write(endpoint, desired, "PUT")
            after = gh_json(["api", endpoint])
            if (not isinstance(after, dict) or after.get("id") != ruleset_id
                    or not _same_queue(after, desired)):
                raise SystemExit(f"Queue timeout readback differs for {branch}; inspect before continuing")
        print("Queue timeout reconciliation verified; review and merge authority are unchanged.")
    return bool(plans)


def reconcile_main_merge_policy(policy: dict, *, apply: bool) -> bool:
    """Narrow Main merger authority with explicit owner self-approval and required CI.

    This is an explicit rollout operation, after combined-result validation is
    qualified. Keep unrelated branch checks and ruleset rules verbatim.
    """
    main = policy["main"]
    users = sorted(main.get("merge_users", []))
    owner_reviews, _ = main_merge_cohorts(policy)
    if (
        not users
        or not owner_reviews
        or main.get("review_bypass_team_slug")
    ):
        raise SystemExit("Main review exceptions must name explicit governed mergers")
    if users != sorted(policy["production"]["manual_dispatch_users"]):
        raise SystemExit("Main merge users must match the approved production cohort")
    endpoint = f"repos/{REPO}/branches/main/protection"
    protection = gh_json(["api", endpoint])
    reviews = protection.get("required_pull_request_reviews") or {}
    review_bypass = reviews.get("bypass_pull_request_allowances") or {}
    if protection.get("required_pull_request_reviews") is None and policy.get(
        "branch_flow", {}
    ).get("review_rulesets", {}).get("main"):
        verify_main_review_ruleset(policy, read=gh_json)
        reviews = {
            "require_code_owner_reviews": True,
            "require_last_push_approval": True,
            "required_approving_review_count": main["required_approving_reviews"],
        }
        review_bypass = {"users": [{"login": owner} for owner in owner_reviews]}
    if (
        sorted(row.get("login", "") for row in review_bypass.get("users", []))
        != owner_reviews
        or any(review_bypass.get(key) for key in ("teams", "apps"))
        or not reviews.get("require_code_owner_reviews")
        or not reviews.get("require_last_push_approval")
        or reviews.get("required_approving_review_count", 0) < 1
        or not protection.get("enforce_admins", {}).get("enabled")
    ):
        raise SystemExit(
            "Reconcile required Main review and admin enforcement before queue rollout"
        )
    checks = protection.get("required_status_checks") or {}
    if not any(
        row.get("context") == main["required_status_check"]
        for row in checks.get("checks", [])
    ):
        raise SystemExit("Main's required combined-result check is missing")
    rulesets = gh_json(["api", f"repos/{REPO}/rulesets?per_page=100"])
    if not isinstance(rulesets, list) or len(rulesets) >= 100:
        raise SystemExit("Main ruleset inventory is incomplete")
    matches = [
        row for row in rulesets if row.get("name") == main["merge_queue_ruleset_name"]
    ]
    if len(matches) != 1:
        raise SystemExit("Main merge queue ruleset is ambiguous")
    queue_endpoint = f"repos/{REPO}/rulesets/{matches[0]['id']}"
    queue = gh_json(["api", queue_endpoint])
    main_scope = {"ref_name": {"include": ["refs/heads/main"], "exclude": []}}
    observed_scope = queue.get("conditions", {})
    # Older rulesets use GitHub's default-branch alias. Resolve it before
    # narrowing to Main; never reinterpret an alias pointing at another branch.
    default_scope = {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}}
    if observed_scope == default_scope:
        repository = gh_json(["api", f"repos/{REPO}"])
        if (
            not isinstance(repository, dict)
            or repository.get("default_branch") != "main"
        ):
            raise SystemExit("Main queue default-branch alias does not resolve to Main")
    if (
        queue.get("enforcement") != "active"
        or observed_scope not in (main_scope, default_scope)
        or not any(row.get("type") == "merge_queue" for row in queue.get("rules", []))
    ):
        raise SystemExit("Main queue configuration is not the reviewed active boundary")
    desired = {"users": users, "teams": [], "apps": []}
    current = protection.get("restrictions") or {}
    restricted = {
        key: sorted(row[field] for row in current.get(key, []))
        for key, field in (("users", "login"), ("teams", "slug"), ("apps", "slug"))
    }
    print(
        f"  Main: merger restrictions={restricted} -> {desired}; strict={checks.get('strict')} -> false"
    )
    bypass = []
    if main.get("merge_queue_bypass_users"):
        # Install and read back the native strict CI/PR-only guard BEFORE granting
        # direct merge authority. Ordinary queue users never inherit this exception.
        reconcile_owner_admin_ruleset(policy, apply=apply, read=gh_json)
        for login in sorted(main["merge_queue_bypass_users"]):
            user = gh_json(["api", f"users/{login}"])
            if (
                user.get("login") != login
                or user.get("type") != "User"
                or type(user.get("id")) is not int
            ):
                raise SystemExit("Owner Admin identity could not be verified")
            bypass.append(
                {
                    "actor_id": user["id"],
                    "actor_type": "User",
                    "bypass_mode": "pull_request",
                }
            )
    elif main.get("merge_queue_bypass_team_slug"):
        raise SystemExit("Combined-result enforcement forbids team queue bypass")
    changed = (
        restricted != desired
        or checks.get("strict") is not False
        or queue.get("bypass_actors") != bypass
        or observed_scope != main_scope
    )
    if not apply:
        print(
            "  Main uses queue validation; named owner Admin merges additionally require strict CI and a PR."
            if bypass
            else "  Main merges require the verified queue result; no direct queue bypass is enabled."
        )
        return changed
    from prepared_branch_governance import _write

    if restricted != desired:
        for key in ("users", "teams", "apps"):
            if restricted[key] != desired[key]:
                _write(f"{endpoint}/restrictions/{key}", {key: desired[key]}, "PUT")
    if queue.get("bypass_actors") != bypass or observed_scope != main_scope:
        if gh_json(["api", queue_endpoint]) != queue:
            raise SystemExit("Main queue changed during reconciliation")
        if bypass:
            reconcile_owner_admin_ruleset(policy, verify_only=True, read=gh_json)
        body = {
            key: queue[key]
            for key in ("name", "target", "enforcement", "conditions", "rules")
        }
        body["conditions"] = main_scope
        body["bypass_actors"] = bypass
        _write(queue_endpoint, body, "PUT")
    if checks.get("strict") is not False:
        _write(
            f"{endpoint}/required_status_checks",
            {"strict": False, "checks": checks["checks"]},
            "PATCH",
        )
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="Push changes to GitHub. Without this, runs dry (plan only).")
    ap.add_argument("--branch", action="append", choices=("dev", "uat", "uat-isolated", "integration/pr-train"),
                    help="Reconcile only this prepared branch; repeat for multiple branches. Does not create refs or deploy.")
    ap.add_argument("--main-review-policy", action="store_true",
                    help="Migrate Main review authority after the queue has no bypass actors.")
    ap.add_argument("--main-merge-policy", action="store_true",
                    help="Reconcile Main merger/queue restrictions after combined-result qualification.")
    ap.add_argument("--protected-pipeline-review-policy", action="store_true",
                    help="Stage A: add independent native path review while retaining all existing safeguards.")
    ap.add_argument("--queue-response-timeout-policy", nargs="+",
                    choices=["main", "dev", "uat", "uat-isolated", "integration/pr-train"],
                    help="Reconcile only the queue timeout for selected existing governed branches.")
    args = ap.parse_args()

    if not POLICY_PATH.exists():
        raise SystemExit(f"Policy file not found: {POLICY_PATH}")
    policy = load_policy()

    mode = "APPLY" if args.apply else "DRY-RUN (no changes — pass --apply to push)"
    print(f"=== apply-governance [{mode}] — source: config/ci-governance.json ===\n")

    if args.queue_response_timeout_policy:
        if args.branch or args.main_review_policy or args.main_merge_policy or args.protected_pipeline_review_policy:
            raise SystemExit("Queue timeout reconciliation is separate from review and merge policy changes")
        reconcile_queue_response_timeout(policy, args.queue_response_timeout_policy, apply=args.apply)
        return 0

    if args.protected_pipeline_review_policy:
        if args.branch or args.main_review_policy or args.main_merge_policy:
            raise SystemExit("Native protected review installation is a separate Stage A operation")
        reconcile_protected_pipeline_review(policy, apply=args.apply)
        return 0

    if args.main_review_policy:
        if args.branch or args.main_merge_policy:
            raise SystemExit("Select one Main policy operation at a time")
        reconcile_main_review_ruleset(policy, apply=args.apply)
        return 0

    if args.main_merge_policy:
        if args.branch:
            raise SystemExit("Main merge policy and prepared-branch reconciliation are separate operations")
        reconcile_main_merge_policy(policy, apply=args.apply)
        return 0

    if args.branch:
        from prepared_branch_governance import reconcile

        reconcile(policy, args.branch, repo=REPO, read=gh_json, raw=gh, apply=args.apply, governance=sys.modules[__name__])
        print("Verify each selected branch with GITHUB_BRANCH=<branch> verify-main-branch-protection.sh.")
        return 0

    print("1. repository settings")
    changed_repo = apply_repository_settings(policy, apply=args.apply)

    train_branch = policy["branch_flow"]["train_branch"]
    print("\n2. governed branch protection review_bypass_users")
    if policy.get("branch_flow", {}).get("review_rulesets", {}).get("main"):
        changed_main = reconcile_main_review_ruleset(policy, apply=args.apply)
    else:
        changed_main = apply_review_bypass(
            "main", desired_review_bypass(policy, "main"),
            team_slug=policy["main"].get("review_bypass_team_slug"), apply=args.apply,
            require_code_owner_reviews=policy["main"].get("require_code_owner_reviews"),
        )
    changed_train = apply_review_bypass(
        train_branch, desired_review_bypass(policy, "pr_train"),
        team_slug=policy["pr_train"].get("review_bypass_team_slug"), apply=args.apply,
        require_code_owner_reviews=policy["pr_train"].get("require_code_owner_reviews"),
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
