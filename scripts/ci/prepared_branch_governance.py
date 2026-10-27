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
import subprocess
from urllib.parse import quote


def protection_payload(policy: dict) -> dict:
    return {
        "required_status_checks": {
            "strict": bool(policy["require_strict_status_checks"]),
            "checks": [{"context": policy["required_status_check"], "app_id": 15368}],
        },
        "enforce_admins": True,
        "required_pull_request_reviews": {
            "dismiss_stale_reviews": False,
            "require_code_owner_reviews": False,
            "required_approving_review_count": policy["required_approving_reviews"],
            "require_last_push_approval": policy["require_last_push_approval"],
            "bypass_pull_request_allowances": {
                "users": sorted(policy["review_bypass_users"]),
                "teams": [policy["review_bypass_team_slug"]],
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


def _assert_no_unowned_protection(current: dict) -> None:
    """Do not weaken controls absent from the selected authored policy."""
    reviews = current.get("required_pull_request_reviews") or {}
    bypass = reviews.get("bypass_pull_request_allowances") or {}
    if current.get("restrictions") or bypass.get("apps") or reviews.get("dismissal_restrictions"):
        raise SystemExit("Existing push/review restrictions require explicit reconciliation")
    if reviews.get("dismiss_stale_reviews") or reviews.get("require_code_owner_reviews"):
        raise SystemExit("Existing stronger review policy requires explicit reconciliation")
    for key in ("required_linear_history", "required_signatures", "block_creations",
                "lock_branch", "allow_fork_syncing"):
        if (current.get(key) or {}).get("enabled"):
            raise SystemExit(f"Existing {key} requires explicit reconciliation")


def reconcile(policy: dict, branches: list[str], *, repo: str, read, raw, apply: bool) -> None:
    prepared = policy["branch_flow"]["prepared_branches"]
    # Validate the entire request before any API call or mutation.
    if not branches or any(branch not in prepared for branch in branches):
        raise SystemExit("Select only declared prepared branches with --branch")
    rulesets = read(["api", f"repos/{repo}/rulesets?per_page=100", "--paginate"])
    plans = []
    for branch in dict.fromkeys(branches):
        config = prepared[branch]
        source = policy[config["policy_key"]]
        name = config["merge_queue_ruleset_name"]
        matches = [r for r in rulesets if r["name"] == name]
        templates = [r for r in rulesets if r["name"] == source["merge_queue_ruleset_name"]]
        if len(matches) > 1 or len(templates) != 1:
            raise SystemExit(f"Ambiguous or missing queue ruleset for {branch}")
        template = read(["api", f"repos/{repo}/rulesets/{templates[0]['id']}"])
        queue = [r for r in template["rules"] if r["type"] == "merge_queue"]
        if template["enforcement"] != "active" or len(queue) != 1 or not queue[0].get("parameters"):
            raise SystemExit(f"Unqualified queue template for {branch}")
        team = read(["api", f"orgs/{repo.split('/')[0]}/teams/{source['merge_queue_bypass_team_slug']}"])
        desired_queue = {
            "name": name, "target": "branch", "enforcement": "active",
            "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
            "bypass_actors": [{"actor_id": team["id"], "actor_type": "Team", "bypass_mode": "pull_request"}],
            "rules": copy.deepcopy(queue),
        }
        current_queue = None
        if matches:
            current_queue = read(["api", f"repos/{repo}/rulesets/{matches[0]['id']}"])
            if current_queue.get("target") != "branch" or current_queue.get("conditions") != desired_queue["conditions"]:
                raise SystemExit(f"Refusing to retarget existing ruleset {name}")
            if any(r["type"] != "merge_queue" for r in current_queue["rules"]):
                raise SystemExit(f"Refusing to replace unrelated rules in {name}")
        endpoint = f"repos/{repo}/branches/{quote(branch, safe='')}/protection"
        code, output, error = raw(["api", endpoint], check=False)
        if code and "(HTTP 404)" not in error:
            raise SystemExit(f"Cannot inspect protection for {branch}: {error.strip()}")
        # A missing branch is not permission to create one during reconciliation.
        read(["api", f"repos/{repo}/git/ref/heads/{quote(branch, safe='')}"])
        current = json.loads(output) if not code else {}
        _assert_no_unowned_protection(current)
        desired = protection_payload(source)
        plans.append((branch, endpoint, desired, current, desired_queue, current_queue, matches))
    for branch, endpoint, desired, current, queue, previous, matches in plans:
        protection_changed = not _same_protection(current, desired)
        queue_changed = previous is None or any(previous.get(k) != v for k, v in queue.items())
        print(f"  {branch}: protection_change={protection_changed}, queue_change={queue_changed}")
        if not apply:
            continue
        if protection_changed:
            _write(endpoint, desired, "PUT")
        if queue_changed:
            suffix = f"/{matches[0]['id']}" if matches else ""
            _write(f"repos/{repo}/rulesets{suffix}", queue, "PUT" if matches else "POST")
