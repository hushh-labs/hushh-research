# ruff: noqa: S101

from __future__ import annotations

import importlib.util
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


def _policy() -> dict:
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
            "manual_dispatch_users": ["kushaltrivedi5", "ankitkumarsingh1702"],
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


def test_required_environment_variables_are_enforced(monkeypatch) -> None:
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

    monkeypatch.setattr(module, "_gh_json", fake_gh_json)

    assert module._assert_surface("production", "owner/repo", _policy()) == []


def test_missing_environment_variable_fails_verification(monkeypatch) -> None:
    module = _module()

    def fake_gh_json(path: str) -> dict:
        if path.endswith("/variables"):
            return {"variables": [{"name": "GCP_WORKLOAD_IDENTITY_PROVIDER"}]}
        return _environment_payload()

    monkeypatch.setattr(module, "_gh_json", fake_gh_json)

    errors = module._assert_surface("production", "owner/repo", _policy())

    assert errors == [
        "production is missing required environment variables: "
        "['GCP_DEPLOY_SERVICE_ACCOUNT']"
    ]
