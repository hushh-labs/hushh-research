#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Reconcile repository release safeguards without changing GitHub team rosters.

GitHub teams own membership. This command manages repository settings, review
and queue rules; neither dry-run nor --apply adds, removes or promotes team
members. Runtime team authorization is composed through the protected Main
broker. A source policy or old checkout must never restore a retired member.

Use --apply only for an approved safeguard change, then verify live readback.
The application is never deployed by this command.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = "hushh-labs/hushh-research"
ORG = "hushh-labs"
# Historical policy projections remain readable during the team-authority transition.
# They must never be used to write a GitHub membership roster.
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
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    if policy.get("authorization", {}).get("native_teams"):
        from github_team_authority import local_policy
        return local_policy(policy)
    return policy


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
    """Teams own their membership; applying release rules must never rewrite it."""
    assert_teams_are_subsets_of_maintainers(policy)
    print("  GitHub team membership is authoritative; no roster writes are performed.")
    return False


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
            or sorted(owners) != sorted(main["review_bypass_users"])):
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
    actors = [{"actor_id": team["id"], "actor_type": "Team", "bypass_mode": "pull_request"}]
    # Keep the installed original pair and its eight-path supplement unchanged.
    # New entrypoints get new partitions; never reshuffle installed coverage.
    if len(paths) < 38 or len(paths) != len(set(paths)):
        raise SystemExit("Protected review requires the original 30 distinct paths")
    def pattern(path):
        return "/" + path + ("**" if path.endswith("/") else "")
    original = sorted(pattern(path) for path in paths[:30])
    installed_supplement = sorted(pattern(path) for path in paths[30:38])
    supplemental = sorted(pattern(path) for path in paths[38:])
    chunks = [original[:15], original[15:], installed_supplement] + [supplemental[i:i + 15] for i in range(0, len(supplemental), 15)]
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
        principals = owners
        if policy.get("authorization", {}).get("native_teams"):
            # Native review authority comes from the verified team and its
            # repository grant below. Only a settings mutation needs an admin.
            if not apply:
                return
            principals = [actor.get("login")]
        for owner in principals:
            permission = read(["api", f"repos/{REPO}/collaborators/{owner}/permission"])
            if permission.get("permission") != "admin" or permission.get("user", {}).get("login") != owner:
                raise SystemExit("Reviewer settings changes require a repository admin" if policy.get("authorization", {}).get("native_teams")
                                 else "Reviewer team grants require all configured protected owners to be repository admins")

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


def pipeline_team_actor(read):
    team = read(["api", f"orgs/{ORG}/teams/pipeline-editors"])
    if team.get("slug") != "pipeline-editors" or type(team.get("id")) is not int or team["id"] <= 0:
        raise SystemExit("Pipeline editor team identity is unavailable")
    return {"actor_id": team["id"], "actor_type": "Team", "bypass_mode": "pull_request"}


def main_owner_admin_ruleset(policy: dict, *, read=gh_json, branch="main") -> dict:
    """Native PR-only and strict CI guard for the configured protected Admin operators.

    Other Main mergers bypass only this additional freshness layer. They still
    require the queue, baseline CI and GitHub's independent review controls.
    """
    if branch == "main":
        main = policy["main"]
    else:
        from prepared_branch_governance import branch_policy
        main = branch_policy(policy, branch)
    owners = sorted(main.get("merge_queue_bypass_users", []))
    mergers = sorted(main.get("merge_users", []))
    if (
        not main.get("owner_admin_ruleset_name")
        or not owners
        or owners != sorted(main["protected_pipeline_edit_users"])
        or owners != sorted(main["review_bypass_users"])
        or not set(owners) <= set(mergers)
        or (main.get("merge_queue_bypass_team_slug") and not policy.get("authorization", {}).get("native_teams"))
    ):
        raise SystemExit(
            "Owner Admin route requires only the configured protected owners"
        )
    actors = []
    if not policy.get("authorization", {}).get("native_teams"):
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
            raise SystemExit(
                "Owner Admin strict CI/PR-only authority differs; refusing replacement"
            )
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
    owners = sorted(main["protected_pipeline_edit_users"])
    if not name or sorted(main["review_bypass_users"]) != owners or main.get("review_bypass_team_slug"):
        raise SystemExit("Main review ruleset must name only the protected owners")
    if policy.get("authorization", {}).get("native_teams"):
        actors = [pipeline_team_actor(read)]
    else:
        actors = []
        for login in owners:
            user = read(["api", f"users/{login}"])
            if user.get("login") != login or user.get("type") != "User" or not isinstance(user.get("id"), int):
                raise SystemExit("Main review owner identity could not be verified")
            actors.append({"actor_id": user["id"], "actor_type": "User", "bypass_mode": "pull_request"})
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
    if queue.get("bypass_actors"):
        if sorted(queue["bypass_actors"], key=lambda a: a.get("actor_id", 0)) != sorted(
                desired["bypass_actors"], key=lambda a: a.get("actor_id", 0)):
            raise SystemExit("Main queue bypass must name only the approved protected owners")
        reconcile_owner_admin_ruleset(policy, verify_only=True, read=gh_json)
    existing = (
        gh_json(["api", f"repos/{REPO}/rulesets/{matches[0]['id']}"])
        if matches
        else None
    )
    if existing and not same_review_ruleset(existing, desired):
        raise SystemExit(
            "Existing Main review ruleset differs; refusing unreviewed replacement"
        )
    changed = existing is None or classic is not None
    print(
        f"  Main review ruleset: create={existing is None}, retire_classic={classic is not None}"
    )
    if not apply:
        return changed
    if existing is None:
        _write(f"repos/{REPO}/rulesets", desired, "POST")
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


def reconcile_main_merge_policy(policy: dict, *, apply: bool) -> bool:
    """Narrow Main merger authority with explicit owner self-approval and required CI.

    This is an explicit rollout operation, after combined-result validation is
    qualified. Keep unrelated branch checks and ruleset rules verbatim.
    """
    main = policy["main"]
    restrict_writers = main.get("restrict_writes_to_merge_users", True)
    if type(restrict_writers) is not bool:
        raise SystemExit("Main writer policy must be an explicit boolean")
    users = sorted(main.get("merge_users", []))
    owner_reviews = sorted(main.get("protected_pipeline_edit_users", []))
    if (
        not users
        or not owner_reviews
        or sorted(main["review_bypass_users"]) != owner_reviews
        or main.get("review_bypass_team_slug")
    ):
        raise SystemExit("Main review exception must name only the protected owners")
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
    from prepared_branch_governance import _same_actors, _same_queue, queue_rules

    desired_rules = queue_rules(policy, queue["rules"])
    desired = {"users": users, "teams": [], "apps": []} if restrict_writers else None
    current = protection.get("restrictions") or {}
    restricted = {
        key: sorted(row[field] for row in current.get(key, []))
        for key, field in (("users", "login"), ("teams", "slug"), ("apps", "slug"))
    }
    writer_authority = None
    if not restrict_writers:
        if apply:
            import base64
            writer_authority = gh_json(["api", f"repos/{REPO}/git/ref/heads/main"])
            revision = writer_authority.get("object", {}).get("sha", "")
            if not re.fullmatch(r"[0-9a-f]{40}", revision):
                raise SystemExit("Main writer authority source is unavailable")
            observed = gh_json(["api", f"repos/{REPO}/contents/config/ci-governance.json?ref={revision}"])
            if json.loads(base64.b64decode(observed.get("content", ""))) != policy:
                raise SystemExit("Reviewed Main policy must land before native writer activation")
        # Native PR/CI/review boundaries remain independent of requester checks.
        reconcile_protected_pipeline_review(policy, verify_only=True, read=gh_json)
        reconcile_owner_admin_ruleset(policy, branch="main", verify_only=True, read=gh_json)
        if not protection.get("required_conversation_resolution", {}).get("enabled") or not any(
            row.get("context") == main["required_status_check"] and row.get("app_id") == 15368
            for row in checks.get("checks", [])
        ):
            raise SystemExit("Main conversation or GitHub Actions check boundary differs")
        if current and restricted != {"users": users, "teams": [], "apps": []}:
            raise SystemExit("Main writer configuration has unreviewed changes; inspect before removal")
    print(
        f"  Main: merger restrictions={restricted} -> {desired}; strict={checks.get('strict')} -> false"
    )
    bypass = []
    if policy.get("authorization", {}).get("native_teams"):
        reconcile_owner_admin_ruleset(policy, apply=apply, read=gh_json)
        bypass = [pipeline_team_actor(gh_json)]
    elif main.get("merge_queue_bypass_users"):
        # Install and read back the native strict CI/PR-only guard BEFORE granting
        # direct merge authority. Ordinary queue users never inherit this exception.
        if restrict_writers:
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
    if not restrict_writers and not _same_actors(queue.get("bypass_actors"), bypass):
        raise SystemExit("Main queue exceptions differ; reconcile before writer activation")
    writer_change = (restricted != desired if restrict_writers
                     else protection.get("restrictions") is not None)
    changed = (
        writer_change
        or checks.get("strict") is not False
        or not _same_actors(queue.get("bypass_actors"), bypass)
        or observed_scope != main_scope
        or queue["rules"] != desired_rules
    )
    if not apply:
        print(
            "  Main uses queue validation; named owner Admin merges additionally require strict CI and a PR."
            if bypass
            else "  Main merges require the verified queue result; no direct queue bypass is enabled."
        )
        return changed
    from prepared_branch_governance import _write

    if restrict_writers and writer_change:
        for key in ("users", "teams", "apps"):
            if restricted[key] != desired[key]:
                _write(f"{endpoint}/restrictions/{key}", desired[key], "PUT")
    if not _same_actors(queue.get("bypass_actors"), bypass) or observed_scope != main_scope or queue["rules"] != desired_rules:
        body = {
            key: queue[key]
            for key in ("name", "target", "enforcement", "conditions", "rules")
        }
        body["conditions"] = main_scope
        body["rules"] = desired_rules
        body["bypass_actors"] = bypass
        _write(queue_endpoint, body, "PUT")
    if checks.get("strict") is not False:
        _write(
            f"{endpoint}/required_status_checks",
            {"strict": False, "checks": checks["checks"]},
            "PATCH",
        )
    if not restrict_writers and writer_change:
        # Remove the human-only writer filter LAST. It blocks GitHub's native
        # queue writer; an empty user array is still a restrictive configuration.
        expected = json.loads(json.dumps(protection))
        expected["required_status_checks"]["strict"] = False
        if gh_json(["api", endpoint]) != expected:
            raise SystemExit("Main protection changed; writer restriction retained")
        observed_queue = gh_json(["api", queue_endpoint])
        expected_queue = dict(queue, conditions=main_scope, rules=desired_rules, bypass_actors=bypass)
        if not _same_queue(observed_queue, expected_queue, snapshot=True):
            raise SystemExit("Main queue changed; writer restriction retained")
        reconcile_protected_pipeline_review(policy, verify_only=True, read=gh_json)
        reconcile_owner_admin_ruleset(policy, branch="main", verify_only=True, read=gh_json)
        if gh_json(["api", f"repos/{REPO}/git/ref/heads/main"]) != writer_authority:
            raise SystemExit("Main authority advanced; writer restriction retained")
        gh(["api", "--method", "DELETE", f"{endpoint}/restrictions"])
        after = gh_json(["api", endpoint])
        without_restrictions = {key: value for key, value in expected.items() if key != "restrictions"}
        # GitHub omits the removed subresource; some API fixtures return null.
        # Accept only those two representations, with every other field exact.
        if after not in (without_restrictions, dict(expected, restrictions=None)):
            raise SystemExit("Main writer readback differs; inspect before any further operation")
    return changed


def reconcile_queue_timeouts(policy: dict, *, apply: bool) -> bool:
    """Repair reviewed queue limits without changing membership or merge protections."""
    from prepared_branch_governance import _write, queue_rules

    index = gh_json(["api", f"repos/{REPO}/rulesets?per_page=100"])
    if not isinstance(index, list) or len(index) >= 100:
        raise SystemExit("Queue ruleset inventory is incomplete")
    plans = []
    for branch in ("main", "dev", "uat"):
        name = (policy["main"]["merge_queue_ruleset_name"] if branch == "main" else
                policy["branch_flow"]["prepared_branches"][branch]["merge_queue_ruleset_name"])
        matches = [row for row in index if row.get("name") == name]
        if len(matches) != 1:
            raise SystemExit(f"Queue ruleset is ambiguous for {branch}")
        endpoint = f"repos/{REPO}/rulesets/{matches[0]['id']}"
        current = gh_json(["api", endpoint])
        refs = current.get("conditions", {}).get("ref_name", {})
        if (current.get("target") != "branch" or current.get("enforcement") != "active"
                or refs != {"include": [f"refs/heads/{branch}"], "exclude": []}):
            raise SystemExit(f"Queue scope differs for {branch}; inspect before repair")
        desired = {key: current[key] for key in
                   ("name", "target", "enforcement", "conditions", "rules", "bypass_actors")}
        desired["rules"] = queue_rules(policy, current["rules"])
        plans.append((branch, endpoint, current, desired))
    changed = False
    for branch, endpoint, before, desired in plans:
        differs = before["rules"] != desired["rules"]
        changed |= differs
        print(f"  {branch}: queue limit change={differs}")
        if apply and differs:
            # Never replace another operator's intervening policy change.
            if gh_json(["api", endpoint]) != before:
                raise SystemExit("Queue changed before repair; no replacement performed")
            _write(endpoint, desired, "PUT")
            after = gh_json(["api", endpoint])
            if any(after.get(key) != value for key, value in desired.items()):
                raise SystemExit("Queue repair readback differs; reconcile before retry")
    return changed


def transition_native_teams(policy, previous, *, apply=False, read=gh_json, authority_sha=None):
    """One-way, exact historical-policy transition; never restore revoked users."""
    from prepared_branch_governance import _write, _same_actors, branch_policy, protection_payload
    if not policy.get("authorization", {}).get("native_teams") or previous.get("authorization", {}).get("native_teams"):
        raise SystemExit("Native team transition requires explicit old-to-team policy")
    actor = read(["api", "user"])
    members = read(["api", f"orgs/{ORG}/teams/pipeline-editors/members?per_page=100"])
    if (not isinstance(members, list) or not 0 < len(members) < 100
            or any(row.get("type") != "User" for row in members)
            or actor.get("login") not in {row.get("login") for row in members}):
        raise SystemExit("Native transition requires a current pipeline editor")
    permission = read(["api", f"repos/{REPO}/collaborators/{actor['login']}/permission"])
    if permission.get("permission") != "admin":
        raise SystemExit("Native transition requires repository administration")
    old_owners = set(previous["main"]["protected_pipeline_edit_users"])
    if not {row.get("login") for row in members} <= old_owners:
        raise SystemExit("Native transition cannot widen the historical exception")
    inventory = read(["api", f"repos/{REPO}/rulesets?per_page=100"])
    if not isinstance(inventory, list) or len(inventory) >= 100:
        raise SystemExit("Native transition inventory is incomplete")
    team = pipeline_team_actor(read)
    plans = []
    def capture(desired, legacy, compare):
        matches = [row for row in inventory if row.get("name") == desired["name"]]
        if len(matches) != 1:
            raise SystemExit("Native transition requires one existing named rule")
        path = f"repos/{REPO}/rulesets/{matches[0]['id']}"
        before = read(["api", path])
        if not (compare(before, legacy) or compare(before, desired)):
            raise SystemExit(f"Native transition refuses changed authority: {desired['name']}")
        # Preserve all API-owned/default fields and every rule. This operation
        # changes actors only; no review/status/queue parameter can be relaxed.
        after = {key: before[key] for key in ("name", "target", "enforcement", "conditions", "rules", "bypass_actors")}
        after["bypass_actors"] = desired["bypass_actors"]
        plans.append((path, before, after, "PUT"))
    capture(main_review_ruleset(policy, read=read), main_review_ruleset(previous, read=read), same_review_ruleset)
    for branch in ("main", "dev", "uat", "uat-isolated"):
        capture(main_owner_admin_ruleset(policy, read=read, branch=branch),
                main_owner_admin_ruleset(previous, read=read, branch=branch), same_owner_admin_ruleset)
        name = (policy["main"]["merge_queue_ruleset_name"] if branch == "main"
                else policy["branch_flow"]["prepared_branches"][branch]["merge_queue_ruleset_name"])
        matches = [row for row in inventory if row.get("name") == name]
        if len(matches) != 1:
            raise SystemExit("Native transition queue is ambiguous")
        path = f"repos/{REPO}/rulesets/{matches[0]['id']}"
        before = read(["api", path])
        old = previous["main"] if branch == "main" else branch_policy(previous, branch)
        users = []
        for login in old["merge_queue_bypass_users"]:
            user = read(["api", f"users/{login}"])
            if user.get("login") != login or user.get("type") != "User" or type(user.get("id")) is not int:
                raise SystemExit("Historical queue identity is unavailable")
            users.append({"actor_id": user["id"], "actor_type": "User", "bypass_mode": "pull_request"})
        if (before.get("enforcement") != "active" or before.get("target") != "branch"
                or before.get("conditions") != {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}}
                or len(before.get("rules", [])) != 1 or before["rules"][0].get("type") != "merge_queue"
                or not (_same_actors(before.get("bypass_actors"), users)
                        or _same_actors(before.get("bypass_actors"), [team]))):
            raise SystemExit("Native transition refuses an unknown queue exception")
        after = {key: before[key] for key in ("name", "target", "enforcement", "conditions", "rules", "bypass_actors")}
        after["bypass_actors"] = [team]
        plans.append((path, before, after, "PUT"))
        if branch != "main":
            path = f"repos/{REPO}/branches/{branch}/protection/required_pull_request_reviews"
            before = read(["api", path])
            wanted = protection_payload(branch_policy(policy, branch))["required_pull_request_reviews"]
            legacy = protection_payload(branch_policy(previous, branch))["required_pull_request_reviews"]
            def bypass(value):
                actual = value.get("bypass_pull_request_allowances", {})
                return {kind: sorted(row[field] for row in actual.get(kind, [])) for kind, field in
                        (("users", "login"), ("teams", "slug"), ("apps", "slug"))}
            if bypass(before) not in [legacy["bypass_pull_request_allowances"], wanted["bypass_pull_request_allowances"]]:
                raise SystemExit("Native transition refuses unknown classic review exceptions")
            after = {key: before[key] for key in ("dismiss_stale_reviews", "require_code_owner_reviews",
                    "require_last_push_approval", "required_approving_review_count")}
            if before.get("dismissal_restrictions"):
                raise SystemExit("Native transition preserves independent dismissal restrictions")
            after["bypass_pull_request_allowances"] = wanted["bypass_pull_request_allowances"]
            plans.append((path, before, after, "PATCH"))
    result = []
    for path, before, after, method in plans:
        changed = (before.get("bypass_actors") != after.get("bypass_actors") if method == "PUT"
                   else bypass(before) != after["bypass_pull_request_allowances"])
        print(f"Native team transition: {path} change={changed}")
        if apply and changed:
            if authority_sha and read(["api", f"repos/{REPO}/git/ref/heads/main"]).get("object", {}).get("sha") != authority_sha:
                raise SystemExit("Main authority advanced during native transition")
            if read(["api", path]) != before or read(["api", f"orgs/{ORG}/teams/pipeline-editors/members?per_page=100"]) != members:
                raise SystemExit("Native authority changed during transition; no replacement performed")
            _write(path, after, method)
            observed = read(["api", path])
            if method == "PUT":
                if any(observed.get(key) != value for key, value in after.items()):
                    raise SystemExit("Native team transition outcome is unconfirmed")
            elif (bypass(observed) != after["bypass_pull_request_allowances"] or
                  any(observed.get(key) != value for key, value in after.items() if key != "bypass_pull_request_allowances")):
                raise SystemExit("Classic team transition outcome is unconfirmed")
        result.append({"path": path, "changed": changed, "applied": apply and changed})
    return result


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
    ap.add_argument("--native-team-transition", metavar="PREVIOUS_MAIN_SHA",
                    help="Reconcile exact historical user exceptions to current pipeline-editor Team; preserves all controls.")
    ap.add_argument("--queue-timeouts", action="store_true",
                    help="Reconcile reviewed queue response/build limits; preserve merge and review authority.")
    args = ap.parse_args()

    if not POLICY_PATH.exists():
        raise SystemExit(f"Policy file not found: {POLICY_PATH}")
    policy = load_policy()
    if args.apply:
        operator = gh_json(["api", "user"]).get("login")
        permissions = gh_json(["api", f"repos/{REPO}"]).get("permissions", {})
        if operator not in policy["main"]["protected_pipeline_edit_users"] or permissions.get("admin") is not True:
            raise SystemExit("Governance changes require current pipeline-editor membership and repository administration")
    if args.native_team_transition:
        prior = args.native_team_transition
        if not re.fullmatch(r"[a-f0-9]{40}", prior):
            raise SystemExit("Native transition requires an immutable preceding Main SHA")
        current = gh_json(["api", f"repos/{REPO}/git/ref/heads/main"])["object"]["sha"]
        subprocess.run(["git", "merge-base", "--is-ancestor", prior, current], check=True, timeout=30)
        if args.apply and subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() != current:
            raise SystemExit("Native transition must execute from the landed Main revision")
        if args.apply:
            from github_team_authority import local_policy
            if policy != local_policy(json.loads(subprocess.check_output(["git", "show", f"{current}:config/ci-governance.json"], text=True))):
                raise SystemExit("Native transition policy differs from landed Main")
            subprocess.run(["git", "diff", "--exit-code", current, "--", "scripts/ci/apply-governance.py",
                            "scripts/ci/prepared_branch_governance.py", "config/ci-governance.json"], check=True)
        previous = json.loads(subprocess.check_output(["git", "show", f"{prior}:config/ci-governance.json"], text=True))
        transition_native_teams(policy, previous, apply=args.apply, authority_sha=current)
        return 0
    if args.queue_timeouts:
        if args.branch or args.main_review_policy or args.main_merge_policy or args.protected_pipeline_review_policy:
            raise SystemExit("Queue limit repair cannot be combined with another governance operation")
        reconcile_queue_timeouts(policy, apply=args.apply)
        return 0

    mode = "APPLY" if args.apply else "DRY-RUN (no changes — pass --apply to push)"
    print(f"=== apply-governance [{mode}] — source: config/ci-governance.json ===\n")

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

    print("\n3. preserve authoritative GitHub team membership")
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
