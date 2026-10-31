#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "config" / "ci-governance.json"
MANAGED_AI_CONFIG_PATH = REPO_ROOT / "consent-protocol" / "config" / "managed-ai-runtime.json"
DEFAULT_REPO = "hushh-labs/hushh-research"
# Deliberate SECOND KEY on production deploy authority. This list is duplicated
# from config/ci-governance.json -> production.manual_dispatch_users on purpose:
# widening the production cohort must be an explicit two-file edit, so a grant
# cannot ride in as a one-line JSON diff nobody reads closely.
#
# THEREFORE: any PR that edits production.manual_dispatch_users MUST mirror the
# change here in the same PR, or this check fails.
#
# It drifted twice because that rule was implicit (845a456bd added RGlodAkshat +
# DamriaNeelesh on 2026-08-07 and left this stale for three weeks; the imsharukhan
# grant on 2026-08-28 widened the gap to 5-vs-2). Stated explicitly now.
PRODUCTION_MANUAL_DISPATCH_USERS = [
    "kushaltrivedi5",
    # Manish Sainani's second GitHub account, granted parity with `kushaltrivedi5`
    # on 2026-09-04 at the founder's request after `msainani` became the pushing
    # actor and every protected-surface edit on the workstream branch went red.
    # Mirrored here deliberately, which is what this constant exists to force: a
    # production-dispatch grant is stated twice or not at all.
    "msainani",
    "RGlodAkshat",
    "ankitkumarsingh1702",
    "DamriaNeelesh",
    "imsharukhan",
]


def _gh_json(*args: str) -> dict:
    return json.loads(
        subprocess.run(  # noqa: S603 - fixed gh executable with repo-owned API paths
            ["gh", "api", *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )


def _reviewer_logins(payload: dict) -> list[str]:
    logins: list[str] = []
    for rule in payload.get("protection_rules") or []:
        if rule.get("type") != "required_reviewers":
            continue
        for reviewer in rule.get("reviewers") or []:
            entity = reviewer.get("reviewer") or {}
            login = (entity.get("login") or "").strip()
            if login:
                logins.append(login)
    return sorted(set(logins))


def _assert_surface(surface: str, repo: str, policy: dict) -> list[str]:
    surface_policy = policy[surface]
    env_name = surface_policy["environment"] if surface == "uat" else surface_policy["owner_environment"]
    payload = _gh_json(f"repos/{repo}/environments/{env_name}")
    variables_payload = _gh_json(f"repos/{repo}/environments/{env_name}/variables")
    branch_policy = payload.get("deployment_branch_policy") or {}
    reviewers = _reviewer_logins(payload)
    configured_variable_names = {
        str(variable.get("name") or "").strip()
        for variable in variables_payload.get("variables") or []
        if str(variable.get("name") or "").strip()
    }
    required_variable_names = {
        str(name).strip()
        for name in surface_policy.get("required_environment_variables") or []
        if str(name).strip()
    }
    errors: list[str] = []

    if reviewers:
        errors.append(f"{env_name} should not require reviewers, found {reviewers}")
    if bool(payload.get("can_admins_bypass")):
        errors.append(f"{env_name} still allows admin bypass")
    if branch_policy.get("protected_branches") is not True:
        errors.append(f"{env_name} should allow protected branches only")
    if branch_policy.get("custom_branch_policies") is not False:
        errors.append(f"{env_name} should not use custom branch policies")

    missing_variable_names = sorted(required_variable_names - configured_variable_names)
    if missing_variable_names:
        errors.append(
            f"{env_name} is missing required environment variables: {missing_variable_names}"
        )

    allowed_users = surface_policy.get("manual_dispatch_users") or []
    if surface == "production" and allowed_users != PRODUCTION_MANUAL_DISPATCH_USERS:
        errors.append(
            "production manual dispatch policy drifted: "
            f"expected {PRODUCTION_MANUAL_DISPATCH_USERS}, got {allowed_users}"
        )

    # UAT dispatch authority must equal the merge cohort (main.review_bypass_users).
    # Invariant: anyone trusted to land code on `main` is trusted to validate that
    # code in the hosted UAT sandbox -- no more, no less. This keeps the two lists
    # in lockstep and fails CI if either is widened or narrowed independently
    # (e.g. a maintainer quietly adding only themselves to UAT dispatch).
    if surface == "uat":
        merge_cohort = sorted(set(policy.get("main", {}).get("review_bypass_users") or []))
        uat_cohort = sorted(set(allowed_users))
        if uat_cohort != merge_cohort:
            errors.append(
                "uat manual dispatch policy drifted from the merge cohort: "
                f"expected {merge_cohort} (main.review_bypass_users), got {uat_cohort}"
            )

    summary = (
        f"{surface} environment summary: env={env_name}, "
        f"reviewers={reviewers}, can_admins_bypass={payload.get('can_admins_bypass')}, "
        f"protected_branches={branch_policy.get('protected_branches')}, "
        f"custom_branch_policies={branch_policy.get('custom_branch_policies')}, "
        f"required_variables_configured={not missing_variable_names}, "
        f"manual_dispatch_users={allowed_users}"
    )
    print(summary)
    return errors


def _assert_readiness_exam(repo: str, policy: dict, accounts: dict) -> list[str]:
    """Once a probe app trusts the exam environment's subject, it must admit only main.

    GitHub recreates a missing referenced environment without protection, so a
    deleted or loosened environment would let any branch's job claim the subject.
    """
    env_name = policy["readiness_exam"]["environment"]
    trusted = sorted(
        name for name, item in accounts.items() if item.get("readiness_exam_client_id")
    )
    if not trusted:
        print(f"readiness exam environment summary: env={env_name}, no probe identity")
        return []
    try:
        payload = _gh_json(f"repos/{repo}/environments/{env_name}")
        branches = _gh_json(f"repos/{repo}/environments/{env_name}/deployment-branch-policies")
        secrets = _gh_json(f"repos/{repo}/environments/{env_name}/secrets")
    except subprocess.CalledProcessError:
        return [f"{env_name} is unreadable or missing while {trusted} trust its subject"]
    admitted = sorted(
        f"{item.get('type')}:{item.get('name')}" for item in branches.get("branch_policies") or []
    )
    errors = []
    if payload.get("deployment_branch_policy") != {
        "protected_branches": False,
        "custom_branch_policies": True,
    } or admitted != ["branch:main"]:
        errors.append(f"{env_name} must admit exactly the main branch, found {admitted}")
    if secrets.get("total_count"):
        errors.append(f"{env_name} must hold no secrets; the exam exchanges OIDC tokens")
    print(
        f"readiness exam environment summary: env={env_name}, "
        f"trusted_by={trusted}, admitted={admitted}"
    )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify live GitHub deployment environment governance for UAT and production."
    )
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument(
        "--surface", choices=("uat", "production", "readiness-exam", "all"), default="all"
    )
    args = parser.parse_args()

    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    surfaces = ["uat", "production"] if args.surface == "all" else [args.surface]
    errors: list[str] = []
    for surface in (item for item in surfaces if item != "readiness-exam"):
        errors.extend(_assert_surface(surface, args.repo, policy))
    if args.surface in ("readiness-exam", "all"):
        runtime = json.loads(MANAGED_AI_CONFIG_PATH.read_text(encoding="utf-8"))
        accounts = (runtime.get("managed_azure_accounts") or {}).get("accounts") or {}
        errors.extend(_assert_readiness_exam(args.repo, policy, accounts))

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print("✅ Live deployment environment governance matches the documented contract.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
