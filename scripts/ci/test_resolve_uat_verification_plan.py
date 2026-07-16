#!/usr/bin/env python3
"""Unit checks for the changed-surface UAT verification plan."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).with_name("resolve-uat-verification-plan.py")


def load_module():
    spec = importlib.util.spec_from_file_location("resolve_uat_verification_plan", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def plan_for(monkeypatch_files: set[str], *, backend: bool = True, frontend: bool = False):
    resolver = load_module()
    resolver._git_diff = lambda _base, _target: set(monkeypatch_files)
    return resolver.resolve_plan(
        target_sha="target",
        backend_base_sha="backend-base",
        frontend_base_sha="frontend-base",
        deploy_backend=backend,
        deploy_frontend=frontend,
    )


def test_standard_backend_change_uses_lean_gate() -> None:
    plan = plan_for({"consent-protocol/api/routes/health.py"})
    assert plan.pkm_evaluator_runs == 0
    assert plan.run_pkm_upgrade_gate is False
    assert plan.run_reviewer_byok is False
    assert plan.run_pkm_runtime_audit is False


def test_provider_change_does_not_run_pkm_upgrade_evaluator() -> None:
    plan = plan_for({"consent-protocol/hushh_mcp/runtime_providers/factory.py"})
    assert plan.pkm_evaluator_runs == 0
    assert plan.run_pkm_upgrade_gate is False
    assert plan.run_reviewer_byok is False
    assert plan.run_pkm_runtime_audit is False


def test_ordinary_pkm_agent_change_does_not_run_upgrade_gate() -> None:
    plan = plan_for({"consent-protocol/hushh_mcp/services/pkm_agent_lab_service.py"})
    assert plan.pkm_evaluator_runs == 0
    assert plan.run_pkm_upgrade_gate is False
    assert plan.run_pkm_runtime_audit is False


def test_pkm_upgrade_change_keeps_full_zero_loss_gate() -> None:
    plan = plan_for({"consent-protocol/hushh_mcp/services/pkm_upgrade_service.py"})
    assert plan.pkm_evaluator_runs == 1
    assert plan.run_pkm_upgrade_gate is True
    assert plan.run_pkm_runtime_audit is True


def test_frontend_vault_change_requires_byok_browser() -> None:
    plan = plan_for(
        {"hushh-webapp/lib/services/vault-service.ts"}, backend=False, frontend=True
    )
    assert plan.pkm_evaluator_runs == 0
    assert plan.run_reviewer_byok is True
    assert plan.as_dict()["requires_web_dependencies"] is True


def test_missing_deployed_sha_fails_closed() -> None:
    resolver = load_module()
    plan = resolver.resolve_plan(
        target_sha="target",
        backend_base_sha="",
        frontend_base_sha="frontend-base",
        deploy_backend=True,
        deploy_frontend=False,
    )
    assert plan.pkm_evaluator_runs == 1
    assert plan.run_pkm_upgrade_gate is True
    assert plan.run_reviewer_byok is True
    assert plan.run_pkm_runtime_audit is True


def main() -> int:
    tests = [
        test_standard_backend_change_uses_lean_gate,
        test_provider_change_does_not_run_pkm_upgrade_evaluator,
        test_ordinary_pkm_agent_change_does_not_run_upgrade_gate,
        test_pkm_upgrade_change_keeps_full_zero_loss_gate,
        test_frontend_vault_change_requires_byok_browser,
        test_missing_deployed_sha_fails_closed,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
