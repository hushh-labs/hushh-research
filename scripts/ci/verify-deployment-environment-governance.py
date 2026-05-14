#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_PATH = REPO_ROOT / "config" / "ci-governance.json"
DEFAULT_REPO = "hushh-labs/hushh-research"


def _gh_json(*args: str) -> dict:
    return json.loads(
        subprocess.run(
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
    branch_policy = payload.get("deployment_branch_policy") or {}
    reviewers = _reviewer_logins(payload)
    errors: list[str] = []

    if reviewers:
        errors.append(f"{env_name} should not require reviewers, found {reviewers}")
    if bool(payload.get("can_admins_bypass")):
        errors.append(f"{env_name} still allows admin bypass")
    if branch_policy.get("protected_branches") is not True:
        errors.append(f"{env_name} should allow protected branches only")
    if branch_policy.get("custom_branch_policies") is not False:
        errors.append(f"{env_name} should not use custom branch policies")

    allowed_users = surface_policy.get("manual_dispatch_users") or []
    if surface == "production" and allowed_users != ["kushaltrivedi5"]:
        errors.append(
            f"production manual dispatch policy drifted: expected ['kushaltrivedi5'], got {allowed_users}"
        )

    summary = (
        f"{surface} environment summary: env={env_name}, "
        f"reviewers={reviewers}, can_admins_bypass={payload.get('can_admins_bypass')}, "
        f"protected_branches={branch_policy.get('protected_branches')}, "
        f"custom_branch_policies={branch_policy.get('custom_branch_policies')}, "
        f"manual_dispatch_users={allowed_users}"
    )
    print(summary)
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify live GitHub deployment environment governance for UAT and production."
    )
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--surface", choices=("uat", "production", "all"), default="all")
    args = parser.parse_args()

    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    surfaces = ["uat", "production"] if args.surface == "all" else [args.surface]
    errors: list[str] = []
    for surface in surfaces:
        errors.extend(_assert_surface(surface, args.repo, policy))

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print("✅ Live deployment environment governance matches the documented contract.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
