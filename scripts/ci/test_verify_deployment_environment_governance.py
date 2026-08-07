# ruff: noqa: S101

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import patch


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


def _policy() -> dict:
    return {
        "main": {
            "review_bypass_users": ["maintainer"],
        },
        "uat": {
            "environment": "uat",
            "manual_dispatch_users": ["maintainer", "uat-only-operator"],
            "required_environment_variables": [
                "GCP_WORKLOAD_IDENTITY_PROVIDER",
                "GCP_DEPLOY_SERVICE_ACCOUNT",
            ],
        },
        "production": {
            "owner_environment": "production",
            "manual_dispatch_users": ["maintainer"],
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


def test_required_environment_variables_are_enforced() -> None:
    module = _module()

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {
                "variables": [
                    {"name": "GCP_WORKLOAD_IDENTITY_PROVIDER"},
                    {"name": "GCP_DEPLOY_SERVICE_ACCOUNT"},
                ]
            }
        return _environment_payload()

    with patch.object(module, "_gh_json", fake_gh_json):
        assert module._assert_surface("production", "owner/repo", _policy()) == []


def test_missing_environment_variable_fails_verification() -> None:
    module = _module()

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {"variables": [{"name": "GCP_WORKLOAD_IDENTITY_PROVIDER"}]}
        return _environment_payload()

    with patch.object(module, "_gh_json", fake_gh_json):
        errors = module._assert_surface("production", "owner/repo", _policy())

    assert errors == [
        "production is missing required environment variables: "
        "['GCP_DEPLOY_SERVICE_ACCOUNT']"
    ]


def test_empty_production_dispatch_cohort_fails_verification() -> None:
    module = _module()
    policy = _policy()
    policy["production"]["manual_dispatch_users"] = []

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {
                "variables": [
                    {"name": "GCP_WORKLOAD_IDENTITY_PROVIDER"},
                    {"name": "GCP_DEPLOY_SERVICE_ACCOUNT"},
                ]
            }
        return _environment_payload()

    with patch.object(module, "_gh_json", fake_gh_json):
        assert module._assert_surface("production", "owner/repo", policy) == [
            "production manual dispatch policy must name at least one user"
        ]


def test_production_dispatch_cohort_must_be_within_uat_cohort() -> None:
    module = _module()
    policy = _policy()
    policy["production"]["manual_dispatch_users"] = ["unapproved-operator"]

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {
                "variables": [
                    {"name": "GCP_WORKLOAD_IDENTITY_PROVIDER"},
                    {"name": "GCP_DEPLOY_SERVICE_ACCOUNT"},
                ]
            }
        return _environment_payload()

    with patch.object(module, "_gh_json", fake_gh_json):
        assert module._assert_surface("production", "owner/repo", policy) == [
            "production manual dispatch users must be a subset of the UAT "
            "maintainer cohort: ['unapproved-operator']"
        ]


def test_duplicate_production_dispatch_user_fails_verification() -> None:
    module = _module()
    policy = _policy()
    policy["production"]["manual_dispatch_users"] = ["maintainer", "maintainer"]

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {
                "variables": [
                    {"name": "GCP_WORKLOAD_IDENTITY_PROVIDER"},
                    {"name": "GCP_DEPLOY_SERVICE_ACCOUNT"},
                ]
            }
        return _environment_payload()

    with patch.object(module, "_gh_json", fake_gh_json):
        assert module._assert_surface("production", "owner/repo", policy) == [
            "production manual dispatch policy must not contain duplicate users"
        ]


def test_production_dispatch_cohort_must_be_strictly_smaller_than_uat() -> None:
    module = _module()
    policy = _policy()
    policy["production"]["manual_dispatch_users"] = policy["uat"]["manual_dispatch_users"]

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {
                "variables": [
                    {"name": "GCP_WORKLOAD_IDENTITY_PROVIDER"},
                    {"name": "GCP_DEPLOY_SERVICE_ACCOUNT"},
                ]
            }
        return _environment_payload()

    with patch.object(module, "_gh_json", fake_gh_json):
        assert module._assert_surface("production", "owner/repo", policy) == [
            "production manual dispatch users must be a strict subset of the UAT "
            "maintainer cohort"
        ]


def main() -> None:
    tests = (
        test_required_environment_variables_are_enforced,
        test_missing_environment_variable_fails_verification,
        test_empty_production_dispatch_cohort_fails_verification,
        test_production_dispatch_cohort_must_be_within_uat_cohort,
        test_duplicate_production_dispatch_user_fails_verification,
        test_production_dispatch_cohort_must_be_strictly_smaller_than_uat,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")


if __name__ == "__main__":
    main()
