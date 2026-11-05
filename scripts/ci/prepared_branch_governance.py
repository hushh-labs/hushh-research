#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Reconcile only explicitly selected, authored preparation branches.

Branch creation and application deployment are separate operations. Queue
parameters come from the existing governed policy's live ruleset; authority
comes from the authored team, never from an arbitrary template's bypass list.
"""

from __future__ import annotations

import copy
import json
import re
import subprocess
from urllib.parse import quote


def branch_policy(policy: dict, branch: str) -> dict:
    """Project the authored Dev/UAT native-review transition without changing shared cohorts."""
    config = policy["branch_flow"]["prepared_branches"][branch]
    source = copy.deepcopy(policy[config["policy_key"]])
    if config.get("owner_admin_ruleset_name"):
        owners = sorted(policy["main"]["protected_pipeline_edit_users"])
        if (branch not in {"dev", "uat"} or config["owner_admin_ruleset_name"] != f"{branch} owner validated merge"
                or not owners or not set(owners) <= set(source["review_bypass_users"])):
            raise SystemExit("Native prepared review is limited to Dev/UAT and existing protected owners")
        source.update(
            owner_admin_ruleset_name=config["owner_admin_ruleset_name"],
            merge_users=sorted(source["review_bypass_users"]),
            protected_pipeline_edit_users=owners,
            required_approving_reviews=0, require_code_owner_reviews=False,
            require_last_push_approval=False, require_strict_status_checks=False,
            review_bypass_users=owners, review_bypass_team_slug="",
            merge_queue_bypass_users=owners, merge_queue_bypass_team_slug="",
            merge_queue_bypass_team_name="",
        )
    return source


def protection_payload(policy: dict) -> dict:
    return {
        "required_status_checks": {
            "strict": bool(policy["require_strict_status_checks"]),
            "checks": [{"context": policy["required_status_check"], "app_id": 15368}],
        },
        "enforce_admins": True,
        "required_pull_request_reviews": {
            "dismiss_stale_reviews": False,
            "require_code_owner_reviews": bool(policy.get("require_code_owner_reviews", False)),
            "required_approving_review_count": policy["required_approving_reviews"],
            "require_last_push_approval": policy["require_last_push_approval"],
            "bypass_pull_request_allowances": {
                "users": sorted(policy["review_bypass_users"]),
                "teams": [policy["review_bypass_team_slug"]] if policy.get("review_bypass_team_slug") else [],
                "apps": [],
            },
        },
        "restrictions": None,
        "required_linear_history": False,
        "allow_force_pushes": False,
        "allow_deletions": False,
        "required_conversation_resolution": policy["require_conversation_resolution"],
    }


def _write(endpoint: str, payload: dict, method: str) -> None:
    result = subprocess.run(
        ["gh", "api", "--method", method, endpoint, "--input", "-"],
        input=json.dumps(payload), capture_output=True, text=True,
    )
    if result.returncode:
        raise SystemExit(f"Governance write failed ({endpoint}): {result.stderr.strip()}")


def _same_protection(current: dict, desired: dict) -> bool:
    checks = current.get("required_status_checks") or {}
    reviews = current.get("required_pull_request_reviews") or {}
    bypass = reviews.get("bypass_pull_request_allowances") or {}
    wanted_reviews = desired["required_pull_request_reviews"]
    if checks.get("strict") != desired["required_status_checks"]["strict"]:
        return False
    if checks.get("checks") != desired["required_status_checks"]["checks"]:
        return False
    for key in ("dismiss_stale_reviews", "require_code_owner_reviews",
                "required_approving_review_count", "require_last_push_approval"):
        if reviews.get(key) != wanted_reviews[key]:
            return False
    for key, field in (("users", "login"), ("teams", "slug"), ("apps", "slug")):
        if sorted(v[field] for v in bypass.get(key, [])) != wanted_reviews["bypass_pull_request_allowances"][key]:
            return False
    for key in ("enforce_admins", "required_linear_history", "allow_force_pushes",
                "allow_deletions", "required_conversation_resolution"):
        if (current.get(key) or {}).get("enabled", False) != desired[key]:
            return False
    return current.get("restrictions") is None


def _assert_no_unowned_protection(current: dict, desired: dict | None = None) -> None:
    """Do not weaken controls absent from the selected authored policy."""
    reviews = current.get("required_pull_request_reviews") or {}
    bypass = reviews.get("bypass_pull_request_allowances") or {}
    if current.get("restrictions") or bypass.get("apps") or reviews.get("dismissal_restrictions"):
        raise SystemExit("Existing push/review restrictions require explicit reconciliation")
    owner_expected = bool((desired or {}).get("required_pull_request_reviews", {}).get("require_code_owner_reviews"))
    if reviews.get("dismiss_stale_reviews") or (reviews.get("require_code_owner_reviews") and not owner_expected):
        raise SystemExit("Existing stronger review policy requires explicit reconciliation")
    for key in ("required_linear_history", "required_signatures", "block_creations",
                "lock_branch", "allow_fork_syncing"):
        if (current.get(key) or {}).get("enabled"):
            raise SystemExit(f"Existing {key} requires explicit reconciliation")


def _same_actors(actual, expected):
    """GitHub may reorder actors; retain duplicates and compare every field."""
    if not isinstance(actual, list) or not isinstance(expected, list):
        return False
    return sorted(json.dumps(actor, sort_keys=True) for actor in actual) == sorted(
        json.dumps(actor, sort_keys=True) for actor in expected
    )


def _same_queue(actual, expected, *, snapshot=False):
    if not isinstance(actual, dict) or not isinstance(expected, dict):
        return False
    if not _same_actors(actual.get("bypass_actors"), expected.get("bypass_actors")):
        return False
    if snapshot:
        return {k: v for k, v in actual.items() if k != "bypass_actors"} == {
            k: v for k, v in expected.items() if k != "bypass_actors"
        }
    return all(actual.get(k) == v for k, v in expected.items() if k != "bypass_actors")


STAGE_B_AUTHORITY_PATHS = (
    ".github/workflows/ci.yml", ".github/workflows/queue-validation.yml",
    "scripts/ci/queue_combined_result.py", "scripts/ci/verify-protected-pipeline-edits.py",
    "scripts/ci/verify-queue-entry-reuses-pr-validation.py", "scripts/ci/apply-governance.py",
    "scripts/ci/prepared_branch_governance.py", "config/ci-governance.json",
)


def verify_destination_authority(branch: str, *, repo: str, read, expected=None):
    """Never relax reviews while the destination still executes stale queue authority."""
    revisions = {}
    for ref in ("main", branch):
        obj = read(["api", f"repos/{repo}/git/ref/heads/{ref}"]).get("object", {})
        if obj.get("type") != "commit" or not re.fullmatch(r"[a-f0-9]{40}", str(obj.get("sha", ""))):
            raise SystemExit("Queue authority source revision is unproven")
        revisions[ref] = obj["sha"]
    if expected is not None and revisions["main"] != expected:
        raise SystemExit("Main authority advanced; replan before changing protections")
    for path in STAGE_B_AUTHORITY_PATHS:
        objects = []
        for ref in ("main", branch):
            item = read(["api", f"repos/{repo}/contents/{path}?ref={revisions[ref]}"])
            if item.get("path") != path or item.get("type") != "file" or not re.fullmatch(r"[a-f0-9]{40}", str(item.get("sha", ""))):
                raise SystemExit("Queue authority blob is missing or malformed")
            objects.append(item["sha"])
        if objects[0] != objects[1]:
            raise SystemExit(f"Destination queue authority is stale: {path}; source-sync before Stage B")
    return revisions["main"]


def reconcile(policy: dict, branches: list[str], *, repo: str, read, raw, apply: bool, governance=None) -> None:
    prepared = policy["branch_flow"]["prepared_branches"]
    # Validate the entire request before any API call or mutation.
    if not branches or any(branch not in prepared for branch in branches):
        raise SystemExit("Select only declared prepared branches with --branch")
    rulesets = read(["api", f"repos/{repo}/rulesets?per_page=100", "--paginate"])
    plans = []
    for branch in dict.fromkeys(branches):
        config = prepared[branch]
        source = branch_policy(policy, branch)
        name = config["merge_queue_ruleset_name"]
        matches = [r for r in rulesets if r["name"] == name]
        templates = [r for r in rulesets if r["name"] == source["merge_queue_ruleset_name"]]
        if len(matches) > 1 or len(templates) != 1:
            raise SystemExit(f"Ambiguous or missing queue ruleset for {branch}")
        template = read(["api", f"repos/{repo}/rulesets/{templates[0]['id']}"])
        queue = [r for r in template["rules"] if r["type"] == "merge_queue"]
        if template["enforcement"] != "active" or len(queue) != 1 or not queue[0].get("parameters"):
            raise SystemExit(f"Unqualified queue template for {branch}")
        slug = source.get("merge_queue_bypass_team_slug")
        native = bool(config.get("owner_admin_ruleset_name"))
        if native:
            if governance is None:
                raise SystemExit("Native prepared review requires the existing governance verifier")
            governance.reconcile_protected_pipeline_review(policy, verify_only=True, read=read)
            authority = verify_destination_authority(branch, repo=repo, read=read)
        else:
            authority = None
        if not native and source.get("require_strict_status_checks") is False and (slug or source.get("merge_queue_bypass_users")):
            raise SystemExit("Combined-result enforcement requires queue bypass to be disabled")
        team = read(["api", f"orgs/{repo.split('/')[0]}/teams/{slug}"]) if slug else None
        actors = []
        if native:
            for owner in source["merge_queue_bypass_users"]:
                user = read(["api", f"users/{owner}"])
                if user.get("login") != owner or user.get("type") != "User" or type(user.get("id")) is not int:
                    raise SystemExit("Owner queue exception identity is unavailable")
                actors.append({"actor_id": user["id"], "actor_type": "User", "bypass_mode": "pull_request"})
        desired_queue = {
            "name": name, "target": "branch", "enforcement": "active",
            "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
            "bypass_actors": actors if native else ([{"actor_id": team["id"], "actor_type": "Team", "bypass_mode": "pull_request"}] if team else []),
            "rules": copy.deepcopy(queue),
        }
        current_queue = None
        if native and not matches:
            raise SystemExit("Native review transition requires the existing exact-ref queue")
        if matches:
            current_queue = read(["api", f"repos/{repo}/rulesets/{matches[0]['id']}"])
            if current_queue.get("target") != "branch" or current_queue.get("conditions") != desired_queue["conditions"]:
                raise SystemExit(f"Refusing to retarget existing ruleset {name}")
            if any(r["type"] != "merge_queue" for r in current_queue["rules"]):
                raise SystemExit(f"Refusing to replace unrelated rules in {name}")
            if native and not (_same_actors(current_queue.get("bypass_actors", []), [])
                               or _same_actors(current_queue.get("bypass_actors", []), actors)):
                legacy_slug = policy[config["policy_key"]].get("review_bypass_team_slug")
                legacy_team = read(["api", f"orgs/{repo.split('/')[0]}/teams/{legacy_slug}"]) if legacy_slug else {}
                legacy_bypass = [{"actor_id": legacy_team.get("id"), "actor_type": "Team", "bypass_mode": "pull_request"}]
                if not legacy_team.get("id") or not _same_actors(current_queue.get("bypass_actors"), legacy_bypass):
                    raise SystemExit("Unexpected queue bypass actors require explicit reconciliation")
        endpoint = f"repos/{repo}/branches/{quote(branch, safe='')}/protection"
        code, output, error = raw(["api", endpoint], check=False)
        if code and "(HTTP 404)" not in error:
            raise SystemExit(f"Cannot inspect protection for {branch}: {error.strip()}")
        # A missing branch is not permission to create one during reconciliation.
        read(["api", f"repos/{repo}/git/ref/heads/{quote(branch, safe='')}"])
        current = json.loads(output) if not code else {}
        desired = protection_payload(source)
        if native:
            legacy = protection_payload(policy[config["policy_key"]])
            legacy["required_status_checks"]["strict"] = (current.get("required_status_checks") or {}).get("strict")
            _assert_no_unowned_protection(current, legacy)
            if not _same_protection(current, desired) and not _same_protection(current, legacy):
                raise SystemExit("Prepared review protection differs from both exact legacy and replacement policy")
        else:
            _assert_no_unowned_protection(current, desired)
        plans.append((branch, endpoint, desired, current, desired_queue, current_queue, matches, native, authority))
    for branch, endpoint, desired, current, queue, previous, matches, native, authority in plans:
        protection_changed = not _same_protection(current, desired)
        queue_changed = previous is None or not _same_queue(previous, queue)
        print(f"  {branch}: protection_change={protection_changed}, queue_change={queue_changed}")
        if not apply:
            continue
        if native:
            verify_destination_authority(branch, repo=repo, read=read, expected=authority)
            governance.reconcile_owner_admin_ruleset(policy, branch=branch, apply=True, read=read, repo=repo)
            governance.reconcile_protected_pipeline_review(policy, verify_only=True, read=read)
            governance.reconcile_owner_admin_ruleset(policy, branch=branch, verify_only=True, read=read, repo=repo)
            # Do not overwrite a peer's intervening branch or queue changes.
            if read(["api", endpoint]) != current or (previous is not None and
                    not _same_queue(read(["api", f"repos/{repo}/rulesets/{matches[0]['id']}"]), previous, snapshot=True)):
                raise SystemExit("Prepared branch changed during planning; inspect and retry")
        # Remove bypass before relaxing branch-age checks; partial failure must
        # retain the stricter boundary, not permit an unchecked direct merge.
        if queue_changed:
            suffix = f"/{matches[0]['id']}" if matches else ""
            _write(f"repos/{repo}/rulesets{suffix}", queue, "PUT" if matches else "POST")
        if native:
            installed_queue = read(["api", f"repos/{repo}/rulesets/{matches[0]['id']}"])
            if not _same_queue(installed_queue, queue):
                raise SystemExit("Owner-only queue readback failed; classic reviews retained")
            governance.reconcile_protected_pipeline_review(policy, verify_only=True, read=read)
            governance.reconcile_owner_admin_ruleset(policy, branch=branch, verify_only=True, read=read, repo=repo)
            verify_destination_authority(branch, repo=repo, read=read, expected=authority)
            if read(["api", endpoint]) != current:
                raise SystemExit("Classic protection changed before mutation; peer state retained")
        if protection_changed:
            _write(endpoint, desired, "PUT")
        if native and not _same_protection(read(["api", endpoint]), desired):
            raise SystemExit("Prepared protection outcome unconfirmed; inspect before retry")
