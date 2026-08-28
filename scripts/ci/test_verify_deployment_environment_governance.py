#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Unit checks for scripts/ci/verify-deployment-environment-governance.py.

Written in the repo's self-running CI-test style (an explicit `main()` plus
`if __name__ == "__main__"`), matching test_resolve_deploy_scope.py and friends.

This file previously used pytest's `monkeypatch` fixture and was invoked as
`python3 <file>`, which merely defined the test functions and exited 0 without
running any of them. It was also absent from scripts/ci/repo-governance-check.sh.
So it was dead: it reported success while asserting nothing, which is how the
production-cohort tripwire below drifted twice without anyone noticing.
"""

# ruff: noqa: S101

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


def _module():
    path = Path(__file__).with_name("verify-deployment-environment-governance.py")
    spec = importlib.util.spec_from_file_location(
        "verify_deployment_environment_governance",
        path,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _policy(module) -> dict:
    # Derive the production cohort from the module constant rather than repeating
    # it: this fixture used to hardcode a copy, so updating the real tripwire would
    # have broken these tests for the wrong reason. Drift between the constant and
    # the committed JSON is asserted by
    # test_production_tripwire_matches_committed_policy.
    return {
        "main": {
            "review_bypass_users": ["maintainer"],
        },
        "uat": {
            "environment": "uat",
            "manual_dispatch_users": ["maintainer"],
            "required_environment_variables": [
                "GCP_WORKLOAD_IDENTITY_PROVIDER",
                "GCP_DEPLOY_SERVICE_ACCOUNT",
            ],
        },
        "production": {
            "owner_environment": "production",
            "manual_dispatch_users": list(module.PRODUCTION_MANUAL_DISPATCH_USERS),
            "required_environment_variables": [
                "GCP_WORKLOAD_IDENTITY_PROVIDER",
                "GCP_DEPLOY_SERVICE_ACCOUNT",
            ],
        },
    }


def _environment_payload() -> dict:
    return {
        "can_admins_bypass": False,
        "deployment_branch_policy": {
            "protected_branches": True,
            "custom_branch_policies": False,
        },
        "protection_rules": [],
    }


def _stub_gh_json(module, *, variables: list[str]) -> None:
    """Point the module's GitHub reader at a fixture instead of the live API.

    Each test loads its own module instance, so this needs no teardown.
    """

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {"variables": [{"name": name} for name in variables]}
        return _environment_payload()

    module._gh_json = fake_gh_json


def test_required_environment_variables_are_enforced() -> None:
    module = _module()
    _stub_gh_json(
        module,
        variables=["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_DEPLOY_SERVICE_ACCOUNT"],
    )

    assert module._assert_surface("production", "owner/repo", _policy(module)) == []


def test_missing_environment_variable_fails_verification() -> None:
    module = _module()
    _stub_gh_json(module, variables=["GCP_WORKLOAD_IDENTITY_PROVIDER"])

    errors = module._assert_surface("production", "owner/repo", _policy(module))

    assert errors == [
        "production is missing required environment variables: "
        "['GCP_DEPLOY_SERVICE_ACCOUNT']"
    ]


def test_production_cohort_drift_is_reported() -> None:
    """The tripwire must fire when the JSON widens past the constant.

    This is the regression that went unnoticed twice: production dispatch
    authority was widened in config/ci-governance.json without mirroring the
    change into the constant, and nothing failed loudly enough to be acted on.
    """
    module = _module()
    _stub_gh_json(
        module,
        variables=["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_DEPLOY_SERVICE_ACCOUNT"],
    )

    policy = _policy(module)
    policy["production"]["manual_dispatch_users"] = [
        *module.PRODUCTION_MANUAL_DISPATCH_USERS,
        "unauthorized-newcomer",
    ]

    errors = module._assert_surface("production", "owner/repo", policy)

    assert len(errors) == 1, errors
    assert "production manual dispatch policy drifted" in errors[0]
    assert "unauthorized-newcomer" in errors[0]


def test_production_tripwire_matches_committed_policy() -> None:
    """The constant must equal the live committed policy.

    Fails the moment someone edits production.manual_dispatch_users in
    config/ci-governance.json without mirroring it into the tripwire — exactly
    how this drifted on 2026-08-07 and again on 2026-08-28. Unlike
    _assert_surface, this needs no GitHub API access, so it runs in the ordinary
    blocking Governance gate rather than only in the advisory stage.
    """
    module = _module()
    policy = json.loads(module.POLICY_PATH.read_text(encoding="utf-8"))

    assert policy["production"]["manual_dispatch_users"] == (
        module.PRODUCTION_MANUAL_DISPATCH_USERS
    ), (
        "config/ci-governance.json -> production.manual_dispatch_users and "
        "PRODUCTION_MANUAL_DISPATCH_USERS in "
        "scripts/ci/verify-deployment-environment-governance.py must be updated "
        "in the same PR"
    )


def main() -> int:
    tests = [
        test_required_environment_variables_are_enforced,
        test_missing_environment_variable_fails_verification,
        test_production_cohort_drift_is_reported,
        test_production_tripwire_matches_committed_policy,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
