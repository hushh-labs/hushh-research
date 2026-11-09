#!/usr/bin/env python3
"""Focused contracts for governance validation-level selection."""

from __future__ import annotations

import json
import importlib.util
import contextlib
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from repo_governance_plan import (
    CHECKS,
    MAX_CHANGED_BYTES,
    Check,
    REGRESSION_GROUPS,
    _run_checks,
    build_selection,
)


ROOT = Path(__file__).resolve().parents[2]


def test_unconfigured_local_run_preserves_diagnostic_plan() -> None:
    selection = build_selection({})
    ids = set(selection.check_ids)
    assert selection.level == "diagnostic"
    assert selection.error is None
    assert {"skill-lint", "architecture-fitness-baseline", "docs-verify", "agent-fleet-audit"} <= ids
    assert len(selection.check_ids) == len(CHECKS)


def test_focused_selection_runs_only_known_affected_regression_groups() -> None:
    selection = build_selection(
        {
            "CI_VALIDATION_LEVEL": "focused",
            "CI_CHANGED_FILES": "scripts/ci/test_cloudrun_retention.py\n.agents/routing/route.py\n",
        }
    )
    assert selection.error is None
    assert selection.groups == ("retention", "agent")
    assert "cloudrun-retention" in selection.check_ids
    assert "route-request-tests" in selection.check_ids
    assert "production-verification" not in selection.check_ids
    assert "skill-lint" not in selection.check_ids


def test_explicit_ci_control_scripts_are_controller_owned() -> None:
    for path in (
        "scripts/ci/assert-governed-actor.py",
        "scripts/ci/promotion_approval.py",
        "scripts/ci/github_team_authority.py",
        "scripts/ci/main-post-merge-smoke.sh",
        "scripts/ci/integration-check.sh",
        "scripts/ci/orchestrate.sh",
        "scripts/ci/account-deletion-check.sh",
        "scripts/ci/backend-check.sh",
        "scripts/ci/validation-results.sh",
        "scripts/ci/check-dco-signoff.sh",
        "scripts/ci/verify-pr-base-policy.py",
        "scripts/ci/runtime-contract-check.sh",
        "scripts/ci/secret-scan.sh",
        "scripts/ci/test_secret_scan_ranges.py",
        "scripts/ci/tag-last-known-good.sh",
        "scripts/ci/verify-predecessor-acceptance.py",
        "scripts/ops/audit_env_toggles.py",
        "scripts/ops/sync_backend_runtime_secrets.py",
    ):
        selection = build_selection(
            {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": path}
        )
        assert selection.error is None
        assert selection.groups == ("controller",)
        assert "ci-path-ownership" in selection.check_ids
        assert {
            "runtime-config-contract", "deploy-secret-coverage", "protected-pipeline-edits"
        } <= set(selection.check_ids)


def test_production_emergency_authority_test_selects_controller_owner() -> None:
    path = "consent-protocol/tests/test_production_emergency.py"
    selection = build_selection(
        {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": path}
    )
    assert selection.error is None
    assert selection.groups == ("controller",)
    selected = {
        check.check_id: check
        for check in CHECKS
        if check.check_id in selection.check_ids
    }
    assert "production-emergency-authority" in selected
    assert "protocol-check" not in selected
    assert selected["production-emergency-authority"].argv == (
        "uv", "run", "--frozen", "--project", "consent-protocol",
        "python", "-m", "pytest", "-q", path,
    )


def test_document_delivery_ci_contract_paths_select_controller_owner() -> None:
    paths = (
        "consent-protocol/tests/helpers/document_delivery_ci.py",
        "consent-protocol/tests/test_uat_deploy_parallelism.py",
    )
    for path in paths:
        selection = build_selection(
            {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": path}
        )
        assert selection.error is None
        assert selection.groups == ("controller",)
        selected = {
            check.check_id: check
            for check in CHECKS
            if check.check_id in selection.check_ids
        }
        assert "uat-deploy-parallelism" in selected
        assert "protocol-check" not in selected
        assert selected["uat-deploy-parallelism"].argv == (
            "uv", "run", "--frozen", "--project", "consent-protocol",
            "python", "-m", "pytest", "-q",
            "consent-protocol/tests/test_uat_deploy_parallelism.py",
        )


def test_restoration_fixture_paths_select_controller_owner_and_history_consumers() -> None:
    changed = (
        "consent-protocol/tests/helpers/production_release_tools.py",
        "consent-protocol/tests/test_production_restoration_operation.py",
    )
    selection = build_selection(
        {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": "\n".join(changed)}
    )
    assert selection.error is None
    assert selection.groups == ("controller",)
    selected = {
        check.check_id: check
        for check in CHECKS
        if check.check_id in selection.check_ids
    }
    owner = selected["production-restoration-fixture-owner"]
    assert owner.argv == (
        "uv", "run", "--frozen", "--project", "consent-protocol",
        "python", "-m", "pytest", "-q",
        "consent-protocol/tests/test_production_restoration_operation.py",
        "consent-protocol/tests/test_phone_schema_origin.py",
        "consent-protocol/tests/test_phone_schema_history_compatibility.py",
        "consent-protocol/tests/test_prod_drive_deploy_contract.py::test_older_target_keeps_release_tooling_but_cannot_enable_drive",
    )
    assert "cloudrun-retention" not in selection.check_ids


def test_known_product_path_does_not_expand_critical_groups() -> None:
    selection = build_selection(
        {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": "hushh-webapp/app/page.tsx"}
    )
    assert selection.error is None
    assert selection.groups == ()
    assert "cloudrun-retention" not in selection.check_ids
    assert "agent-orchestration" not in selection.check_ids
    assert "web-lane-partition" not in selection.check_ids
    # Owning package/fixture changes retain the topology check without turning
    # ordinary package edits into the entire release-controller regression group.
    from repo_governance_plan import WEB_LANE_INPUTS
    for path in WEB_LANE_INPUTS:
        selected = build_selection({"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": path})
        assert selected.error is None
        assert "web-lane-partition" in selected.check_ids
        if path == "hushh-webapp/package.json":
            assert "release-controller-contracts" not in selected.check_ids
    for level, path in (("release", "hushh-webapp/app/page.tsx"),
                        ("focused", "unknown-root/runtime.py"),
                        ("focused", ".github/workflows/ci.yml")):
        selected = build_selection({"CI_VALIDATION_LEVEL": level, "CI_CHANGED_FILES": path})
        assert "web-lane-partition" in selected.check_ids


def test_affected_unit_selector_test_is_a_controller_owner() -> None:
    path = "hushh-webapp/scripts/testing/affected-tests.test.mjs"
    selection = build_selection(
        {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": f"{path}\n"}
    )
    assert selection.error is None
    assert selection.groups == ("controller",)
    selected = next(
        check for check in CHECKS if check.check_id == "affected-tests-selector-contract"
    )
    assert selected.argv == (
        "node",
        "--test",
        "hushh-webapp/scripts/testing/affected-tests.test.mjs",
    )
    assert selected.check_id in selection.check_ids


def test_release_always_adds_core_authority_checks_and_only_affected_regressions() -> None:
    selection = build_selection(
        {
            "CI_VALIDATION_LEVEL": "release",
            "CI_CHANGED_FILES": ".github/workflows/deploy-uat.yml\n",
        }
    )
    ids = set(selection.check_ids)
    assert selection.error is None
    assert selection.groups == ("controller", "release")
    assert {"deployment-environment-governance", "release-cadence", "uat-exact-ci"} <= ids
    assert "cloudrun-retention" not in ids
    assert "agent-orchestration" not in ids
    assert "production-verification" in ids


def test_bad_or_missing_change_list_fails_conservatively() -> None:
    for env in (
        {"CI_VALIDATION_LEVEL": "focused"},
        {"CI_VALIDATION_LEVEL": "release", "CI_CHANGED_FILES": "unknown-root/file.py"},
        {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES": "scripts/ci/new-owner-contract.py"},
        {
            "CI_VALIDATION_LEVEL": "focused",
            "CI_CHANGED_FILES": "docs/readme.md",
            "CI_CHANGED_FILES_FILE": "/tmp/also-set",
        },
    ):
        selection = build_selection(env)
        assert selection.error
        assert all(group in selection.groups for group in REGRESSION_GROUPS)
        assert set(REGRESSION_GROUPS) <= {
            group for check in CHECKS for group in check.groups if check.check_id in selection.check_ids
        }


def test_changed_file_input_is_bounded_and_rejects_traversal() -> None:
    with tempfile.TemporaryDirectory() as raw:
        path = Path(raw) / "files.txt"
        path.write_text("scripts/ci/../../outside.py\n", encoding="utf-8")
        selection = build_selection(
            {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES_FILE": str(path)}
        )
        assert selection.error and "non-canonical" in selection.error
        assert all(group in selection.groups for group in REGRESSION_GROUPS)
        path.write_bytes(b"x" * (MAX_CHANGED_BYTES + 1))
        oversized = build_selection(
            {"CI_VALIDATION_LEVEL": "focused", "CI_CHANGED_FILES_FILE": str(path)}
        )
    assert oversized.error and "exceeds" in oversized.error
    assert all(group in oversized.groups for group in REGRESSION_GROUPS)


def test_cli_commands_group_is_machine_readable_and_static() -> None:
    old = os.environ.copy()
    try:
        os.environ.pop("CI_CHANGED_FILES", None)
        os.environ.pop("CI_CHANGED_FILES_FILE", None)
        output: list[str] = []
        # Invoke the CLI in a subprocess to exercise its public JSON contract.
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/ci/repo_governance_plan.py"), "--commands-group", "operations"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        output.extend(json.loads(result.stdout))
        assert output
        assert {"protected-pipeline-edits", "deploy-secret-coverage"} <= {
            item["id"] for item in output
        }
        assert all(isinstance(item["argv"], list) for item in output)
    finally:
        os.environ.clear()
        os.environ.update(old)


def test_runner_reports_every_failure_instead_of_stopping_early() -> None:
    checks = (
        Check("first-failure", (sys.executable, "-c", "raise SystemExit(7)")),
        Check("second-failure", (sys.executable, "-c", "raise SystemExit(9)")),
    )
    output_stream = io.StringIO()
    with contextlib.redirect_stderr(output_stream):
        status = _run_checks(checks)
    output = output_stream.getvalue()
    assert status == 1
    assert "first-failure (exit 7)" in output
    assert "second-failure (exit 9)" in output
    # Failed assertions collect; missing tools and process cancellation stop.
    from unittest.mock import patch
    for result in (-15, 124, 127, 130):
        with patch("repo_governance_plan.subprocess.run", return_value=subprocess.CompletedProcess([], result)) as run:
            with contextlib.redirect_stderr(io.StringIO()):
                assert _run_checks(checks) == (128 - result if result < 0 else result)
            assert run.call_count == 1


def test_local_preflight_preserves_ci_ownership_and_hosted_browser_boundary() -> None:
    from unittest.mock import patch
    source = ROOT / ".agents/skills/repo-operations/scripts/pre_pr_readiness.py"
    spec = importlib.util.spec_from_file_location("local_readiness", source)
    assert spec and spec.loader
    local = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(local)
    assert local._lanes([".github/workflows/ci.yml"], None) == (
        {"frontend": False, "backend": False}, None
    )
    assert local._lanes(["hushh-webapp/app/page.tsx"], None) == (
        {"frontend": True, "backend": False}, None
    )
    with patch.object(local, "_workflow_filters", side_effect=ValueError("unknown syntax")):
        lanes, warning = local._lanes(["new/runtime"], None)
        assert all(lanes.values()) and warning
    observed = []
    def run(argv, **kwargs):
        observed.append((argv, kwargs.get("env", {})))
        return {"ok": True}
    with tempfile.TemporaryDirectory() as raw, patch.object(local, "_run", side_effect=run), \
         patch.object(local, "_protected", return_value=(True, "approved")), \
         patch.object(local, "_validate_body"):
        context = {"number": 1, "body": "reviewed", "author": "owner", "base_ref": "main",
                   "base": "a" * 40, "head_ref": "fix/change", "head": "b" * 40,
                   "repository": "owner/repo", "files_path": Path(raw) / "files",
                   "files": ["hushh-webapp/app/page.tsx"], "lanes": {"frontend": True, "backend": False}}
        local._focused(None, context, Path(raw), stream=False)
    targeted = [env for argv, env in observed if argv[-1] == "web-targeted"]
    assert len(targeted) == 1 and targeted[0]["WEB_TARGETED_PART"] == "node"
    assert not any(argv[-1] == "integration" for argv, _ in observed)
    assert targeted[0]["CI_ACCOUNT_DELETION_CLIENT_OWNED"] == "0"
    # The operator report must not instruct agents to run a retired required lane.
    context.update(branch="fix/change", url=None, lane_warning=None)
    output = io.StringIO()
    with patch.object(sys, "argv", ["pre-pr", "--base-ref", "main", "--json"]), \
         patch.object(local, "_context", return_value=context), \
         patch.object(local, "_focused", return_value=({"local": {"ok": True}}, [])), \
         contextlib.redirect_stdout(output):
        assert local.main() == 0
    report = json.loads(output.getvalue())
    assert "functional browser contracts" not in report["hosted_required"]
    assert report["browser_validation"] == "explicit diagnostic only; not executed locally"


def test_validation_results_collect_independent_failures_and_preserve_stops() -> None:
    helper = ROOT / "scripts/ci/validation-results.sh"
    sequence = """
set -euo pipefail
source "$1"
validation_check first bash -c 'echo first; exit 1'
validation_check second bash -c 'echo second; exit 2'
validation_check third bash -c 'echo third'
validation_finish
"""
    result = subprocess.run(["bash", "-c", sequence, "_", str(helper)], capture_output=True, text=True)
    assert result.returncode == 1
    assert "third" in result.stdout
    assert "first (exit 1)" in result.stderr and "second (exit 2)" in result.stderr
    for code in (124, 126, 127, 130, 143):
        script = f"""set -euo pipefail
source "$1"
validation_check interrupted bash -c 'exit {code}'
echo must-not-run
"""
        result = subprocess.run(["bash", "-c", script, "_", str(helper)], capture_output=True, text=True)
        assert result.returncode == code
        assert "must-not-run" not in result.stdout
    # An external script's prerequisite still stops its dependent command.
    script = """set -euo pipefail
source "$1"
validation_check fixture bash -e -c 'false; echo unsafe-dependent'
validation_check independent bash -c 'echo independent'
validation_finish
"""
    result = subprocess.run(["bash", "-c", script, "_", str(helper)], capture_output=True, text=True)
    assert result.returncode == 1
    assert "unsafe-dependent" not in result.stdout and "independent" in result.stdout

    # One stale offline fixture must not hide the next environment failure.
    spec = importlib.util.spec_from_file_location("environment_failure_collection",
        ROOT / "scripts/ci/test_verify_deployment_environment_governance.py")
    environment = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(environment)
    seen = []
    for name in vars(environment).copy():
        if name.startswith("test_"):
            setattr(environment, name, lambda name=name: seen.append(name))
    def failed():
        seen.append("first-failed")
        raise KeyError("intentional offline regression")
    environment.test_exact_branch_inventory_refuses_wildcards_and_incomplete_reads = failed
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        assert environment.main() == 1
    assert "first-failed" in seen
    assert "test_capacity_clock_refuses_to_queue_before_its_wait" in seen


def main() -> int:
    tests = (
        test_local_preflight_preserves_ci_ownership_and_hosted_browser_boundary,
        test_unconfigured_local_run_preserves_diagnostic_plan,
        test_focused_selection_runs_only_known_affected_regression_groups,
        test_explicit_ci_control_scripts_are_controller_owned,
        test_production_emergency_authority_test_selects_controller_owner,
        test_restoration_fixture_paths_select_controller_owner_and_history_consumers,
        test_known_product_path_does_not_expand_critical_groups,
        test_affected_unit_selector_test_is_a_controller_owner,
        test_release_always_adds_core_authority_checks_and_only_affected_regressions,
        test_bad_or_missing_change_list_fails_conservatively,
        test_changed_file_input_is_bounded_and_rejects_traversal,
        test_cli_commands_group_is_machine_readable_and_static,
        test_runner_reports_every_failure_instead_of_stopping_early,
        test_validation_results_collect_independent_failures_and_preserve_stops,
    )
    for test in tests:
        test()
        print(f"ok {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
