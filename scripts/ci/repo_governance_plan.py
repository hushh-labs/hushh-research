#!/usr/bin/env python3
"""Select and run repository governance checks without discovering a diff."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[2]
MAX_CHANGED_BYTES = 128 * 1024
MAX_CHANGED_PATHS = 2048
MAX_PATH_BYTES = 2048
REGRESSION_GROUPS = ("controller", "retention", "agent")
VALID_LEVELS = ("focused", "release", "diagnostic")


@dataclass(frozen=True)
class Check:
    check_id: str
    argv: tuple[str, ...]
    groups: frozenset[str] = frozenset()
    diagnostic_only: bool = False


def _check(check_id: str, *argv: str, groups: Sequence[str] = (), diagnostic: bool = False) -> Check:
    return Check(check_id, tuple(argv), frozenset(groups), diagnostic)


# Kept in the same order as the former governance entrypoint. Checks without a
# regression group remain in the focused baseline; non-blocking hygiene is
# diagnostic-only, and the named regression groups are selected by changed path.
CHECKS = (
    _check("skill-lint", "python3", ".agents/skills/codex-skill-authoring/scripts/skill_lint.py", diagnostic=True),
    _check("agent-orchestration", "python3", ".agents/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py", groups=("agent",)),
    _check("agent-orchestration-selftest", "python3", ".agents/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py", "--self-test", groups=("agent",)),
    _check("architecture-fitness-selftest", "python3", ".agents/skills/repo-context/scripts/architecture_fitness.py", "--self-test", diagnostic=True),
    _check("architecture-fitness-baseline", "python3", ".agents/skills/repo-context/scripts/architecture_fitness.py", "--baseline", "docs/reference/quality/architecture-fitness-baseline.json", "--limit", "20", diagnostic=True),
    _check("pr-governance-sections", "python3", "scripts/ci/verify-pr-governance-sections.py", groups=("operations",)),
    _check("governance-plan-selection", "python3", "scripts/ci/test_repo_governance_plan.py", groups=("operations",)),
    _check("protected-pipeline-edits", "python3", "scripts/ci/verify-protected-pipeline-edits.py", groups=("operations",)),
    _check("protected-pipeline-selftest", "python3", "scripts/ci/verify-protected-pipeline-edits.py", "--self-test", groups=("operations",)),
    _check("protected-behavior-tests", "python3", "scripts/ci/verify-protected-behavior-tests.py", groups=("operations",)),
    _check("protected-behavior-selftest", "python3", "scripts/ci/verify-protected-behavior-tests.py", "--self-test", groups=("operations",)),
    _check("live-memory-source", "python3", "scripts/ci/live-memory-source-gate.py", groups=("operations",)),
    _check("live-memory-source-selftest", "python3", "scripts/ci/live-memory-source-gate.py", "--self-test", groups=("operations",)),
    _check("live-memory-pr-context", "python3", "scripts/ci/test_live_memory_pr_context.py", groups=("operations",)),
    _check("github-security-authority", "python3", "scripts/ci/test_github_security_authority.py", groups=("operations",)),
    _check("github-security-receipt", "python3", "scripts/ci/test_github_security_receipt.py", groups=("operations",)),
    _check("pr-base-policy", "python3", "scripts/ci/verify-pr-base-policy.py", "--self-test", groups=("operations",)),
    _check("queue-entry-reuse", "python3", "scripts/ci/verify-queue-entry-reuses-pr-validation.py", "--self-test", groups=("operations",)),
    _check("branch-governance-docs", "python3", "scripts/ci/verify-branch-governance-doc-consistency.py", diagnostic=True),
    _check("branch-governance-docs-selftest", "python3", "scripts/ci/verify-branch-governance-doc-consistency.py", "--self-test", diagnostic=True),
    _check("deployment-environment-governance", "python3", "scripts/ci/test_verify_deployment_environment_governance.py", groups=("controller", "release", "operations")),
    _check("readiness-exam-workflow", "python3", "scripts/ci/test_readiness_exam_workflow.py", groups=("controller",)),
    _check("release-cadence", "python3", "scripts/ci/test_release_cadence.py", groups=("controller", "release")),
    _check("release-cadence-qualification", "python3", "scripts/ci/test_release_cadence_qualification.py", groups=("controller", "release")),
    _check("uat-exact-ci", "python3", "scripts/ci/test_uat_exact_ci.py", groups=("controller", "release")),
    _check("release-cadence-maintenance", "python3", "scripts/ci/test_release_cadence_maintenance.py", groups=("controller",)),
    _check("release-cadence-monitor", "python3", "scripts/ci/test_release_cadence_monitor.py", groups=("controller",)),
    _check("release-cadence-checkpoint", "python3", "scripts/ci/test_release_cadence_checkpoint.py", groups=("controller",)),
    _check("protocol-ci-parity", "bash", "scripts/ci/verify-protocol-ci-parity.sh", "--self-test", groups=("operations",)),
    _check("protocol-manifest-transport", "python3", "scripts/ci/test_protocol_manifest_transport.py", groups=("operations",)),
    _check("governance-teams", "python3", "scripts/ci/test_apply_governance_teams.py", groups=("operations",)),
    _check("resolve-deploy-scope", "python3", "scripts/ci/test_resolve_deploy_scope.py", groups=("controller", "release", "operations")),
    _check("cloudrun-retention", "python3", "scripts/ci/test_cloudrun_retention.py", groups=("retention",)),
    _check("uat-per-revision-drain", "python3", "scripts/ci/test_uat_per_revision_drain.py", groups=("retention",)),
    _check("pending-uat-retention", "python3", "scripts/ci/test_pending_uat_retention_state.py", groups=("retention",)),
    _check("retention-preflight-checkpoint", "python3", "scripts/ci/test_retention_preflight_checkpoint.py", groups=("retention",)),
    _check("retention-error-diagnostics", "python3", "scripts/ci/test_retention_error_diagnostics.py", groups=("retention",)),
    _check("retention-preparing", "python3", "scripts/ci/test_retention_preparing.py", groups=("retention",)),
    _check("retention-preflight-evidence", "python3", "scripts/ci/test_retention_preflight_evidence.py", groups=("retention",)),
    _check("retention-production-evidence", "python3", "scripts/ci/test_retention_production_evidence.py", groups=("retention",)),
    _check("retention-production-clock", "python3", "scripts/ci/test_retention_production_clock_evidence.py", groups=("retention",)),
    _check("retention-uat-guard", "python3", "scripts/ci/test_retention_uat_guard_evidence.py", groups=("retention",)),
    _check("wait-uat-capacity", "python3", "scripts/ci/test_wait_uat_capacity.py", groups=("retention",)),
    _check("runtime-capacity-budget", "python3", "scripts/ci/test_runtime_capacity_budget.py", groups=("retention",)),
    _check("runtime-capacity-uat-health", "python3", "scripts/ci/test_runtime_capacity_uat_health_job.py", groups=("retention",)),
    _check("runtime-capacity-inventory", "python3", "scripts/ci/test_runtime_capacity_inventory.py", groups=("retention",)),
    _check("runtime-capacity-volume", "python3", "scripts/ci/test_runtime_capacity_volume.py", groups=("retention",)),
    _check("runtime-capacity-isolated", "python3", "scripts/ci/test_runtime_capacity_isolated.py", groups=("retention",)),
    _check("runtime-capacity-route-secrets", "python3", "scripts/ci/test_runtime_capacity_route_secrets.py", groups=("retention",)),
    _check("production-capacity-bridge", "python3", "scripts/ci/test_production_capacity_bridge.py", groups=("retention",)),
    _check("production-capacity-recovery", "python3", "scripts/ci/test_production_capacity_recovery.py", groups=("retention",)),
    _check("production-verification", "python3", "scripts/ci/test_production_verification.py", groups=("controller", "release")),
    _check("production-verification-workflow", "python3", "scripts/ci/test_production_verification_workflow.py", groups=("controller", "release")),
    _check(
        "account-deletion-release-workflow",
        "uv", "run", "--frozen", "--project", "consent-protocol",
        "python", "-m", "pytest", "-q",
        "consent-protocol/tests/test_account_deletion_release_workflow.py",
        groups=("controller",),
    ),
    _check("passkey-domain-associations", "python3", "scripts/ci/test_verify_passkey_domain_associations.py", groups=("controller",)),
    _check("prod-places-readiness", "python3", "scripts/ci/test_verify_prod_places_readiness.py", groups=("controller",)),
    _check("uat-verification-plan", "python3", "scripts/ci/test_resolve_uat_verification_plan.py"),
    _check("change-aware-verification-wiring", "python3", "scripts/ci/test_change_aware_verification_wiring.py"),
    _check("main-sync", "python3", "scripts/ci/test_check_main_sync.py"),
    _check("ui-contract-gate", "python3", "scripts/ci/test_ui_contract_gate.py"),
    _check("web-lane-partition", "python3", "scripts/ci/test_web_ci_lane_partition.py"),
    _check(
        "affected-tests-selector-contract",
        "node",
        "--test",
        "hushh-webapp/scripts/testing/affected-tests.test.mjs",
        groups=("controller", "operations"),
    ),
    _check("pkm-upgrade-gate-scope", "python3", "scripts/ci/test_pkm_upgrade_gate_scope.py"),
    _check("deploy-identity-provenance-record", "python3", "scripts/ci/verify-deploy-identity-provenance.py", "--record-only", groups=("operations",)),
    _check("deploy-identity-provenance", "python3", "scripts/ci/test_verify_deploy_identity_provenance.py", groups=("operations",)),
    _check("private-native-artifact", "python3", "scripts/ci/test_private_native_artifact.py"),
    _check("ios-appstore-dispatch", "node", "--test", "scripts/release/dispatch-ios-appstore.test.mjs"),
    _check("android-store-dispatch", "node", "--test", "scripts/release/dispatch-android-playstore.test.mjs"),
    _check("ios-build-number", "python3", "scripts/ci/test_resolve_ios_build_number.py"),
    _check("ci-path-ownership", "uv", "run", "--frozen", "--project", "consent-protocol", "python", "-m", "pytest", "-q", "consent-protocol/tests/test_ci_path_filters_cover_lane_scripts.py", "consent-protocol/tests/test_ios_lane_path_filter_covers_native_test_surfaces.py", groups=("controller",)),
    _check("ci-cache-scopes", "python3", "scripts/ci/test_ci_cache_scopes.py"),
    _check("docs-verify", "./bin/hushh", "docs", "verify", diagnostic=True),
    _check("data-model-audit", "./bin/hushh", "codex", "data-model-audit", diagnostic=True),
    _check("runtime-topology-index", "python3", "scripts/ops/generate_runtime_topology_index.py", "--check", diagnostic=True),
    _check("apache-license-surface", "python3", "scripts/licenses/verify_apache_surface.py"),
    _check("runtime-config-contract", "python3", "scripts/ci/verify-runtime-config-contract.py", groups=("operations",)),
    _check("agent-fleet-audit", "python3", ".agents/skills/agent-orchestration-governance/scripts/agent_fleet_audit.py", "--text", diagnostic=True),
    _check("agent-router-smoke", "python3", ".agents/skills/agent-orchestration-governance/scripts/agent_router_smoke.py", diagnostic=True),
    _check("trigger-evals", "python3", ".agents/skills/codex-skill-authoring/scripts/trigger_evals.py", diagnostic=True),
    _check("trigger-eval-tests", "python3", ".agents/skills/codex-skill-authoring/scripts/test_trigger_evals.py", diagnostic=True),
    _check("compact-kernel-smoke", "python3", ".agents/skills/codex-skill-authoring/scripts/compact_kernel_smoke.py", diagnostic=True),
    _check("route-check", "python3", ".agents/routing/scripts/route.py", "--check", diagnostic=True),
    _check("route-request-tests", "python3", ".agents/routing/scripts/test_route_requests.py", groups=("agent",)),
    _check("client-env-parity", "bash", ".agents/skills/client-env-parity/check.sh", groups=("operations",)),
    _check("db-release-contract", "./bin/hushh", "db", "verify-release-contract", groups=("operations",)),
    _check("db-production-posture", "./bin/hushh", "db", "report-prod-posture", groups=("operations",)),
    _check("deploy-secret-coverage", "python3", "scripts/ci/check-deploy-secret-coverage.py", groups=("operations",)),
)


OPERATIONS_IDS = frozenset(
    check.check_id for check in CHECKS if "operations" in check.groups
)
RELEASE_IDS = frozenset(check.check_id for check in CHECKS if "release" in check.groups)
REGRESSION_IDS = {
    group: frozenset(check.check_id for check in CHECKS if group in check.groups)
    for group in REGRESSION_GROUPS
}
DIAGNOSTIC_IDS = frozenset(check.check_id for check in CHECKS if check.diagnostic_only)

KNOWN_ROOTS = frozenset(
    {
        ".agents", ".github", "archive", "artifacts", "bin", "clawhub", "config",
        "consent-protocol", "contracts", "data", "deploy", "docs", "hushh-webapp",
        "ios", "android", "packages", "scripts", "skillsagentic", "tests",
    }
)
KNOWN_ROOT_FILES = frozenset(
    {
        "AGENTS.md", "LICENSE", "LICENSES", "Makefile", "NOTICE", "README.md",
        "REUSE.toml", "SECURITY.md", "TESTING.md", "THIRD_PARTY_NOTICES.md",
        "code_of_conduct.md", "contributing.md", "docker-compose.yml",
        "docker-compose.offline.yml", "getting_started.md", "skills-lock.json",
    }
)


@dataclass(frozen=True)
class Selection:
    level: str
    files: tuple[str, ...]
    groups: tuple[str, ...]
    check_ids: tuple[str, ...]
    error: str | None = None


def _changed_files_from_environment(env: dict[str, str]) -> tuple[tuple[str, ...], str | None]:
    inline = env.get("CI_CHANGED_FILES")
    filename = env.get("CI_CHANGED_FILES_FILE")
    if inline is not None and filename is not None:
        return (), "set only one of CI_CHANGED_FILES or CI_CHANGED_FILES_FILE"
    if filename is not None:
        source = Path(filename)
        try:
            if source.is_symlink() or not source.is_file():
                return (), "CI_CHANGED_FILES_FILE must be a regular non-symlink file"
            if source.stat().st_size > MAX_CHANGED_BYTES:
                return (), f"changed-file list exceeds {MAX_CHANGED_BYTES} bytes"
            raw = source.read_bytes().decode("utf-8")
        except (OSError, UnicodeError) as exc:
            return (), f"cannot read changed-file list: {type(exc).__name__}"
    elif inline is not None:
        raw = inline
        if len(raw.encode("utf-8")) > MAX_CHANGED_BYTES:
            return (), f"changed-file list exceeds {MAX_CHANGED_BYTES} bytes"
    else:
        return (), "changed-file list is required for focused/release validation"
    files = tuple(line for line in raw.splitlines() if line)
    if not files:
        return (), "changed-file list is empty"
    if len(files) > MAX_CHANGED_PATHS:
        return (), f"changed-file list exceeds {MAX_CHANGED_PATHS} paths"
    for path in files:
        if len(path.encode("utf-8")) > MAX_PATH_BYTES:
            return (), "a changed path exceeds the allowed length"
        if path.startswith("/") or "\\" in path or "\x00" in path:
            return (), f"invalid repository-relative path: {path!r}"
        if any(part in ("", ".", "..") for part in path.split("/")):
            return (), f"non-canonical repository-relative path: {path!r}"
    return files, None


def _path_groups(path: str) -> tuple[frozenset[str], str | None]:
    parts = path.split("/")
    root = parts[0]
    if root not in KNOWN_ROOTS and path not in KNOWN_ROOT_FILES:
        return frozenset(), f"unrecognized changed path: {path}"
    if path in {
        "hushh-webapp/scripts/testing/affected-tests.mjs",
        "hushh-webapp/scripts/testing/affected-tests.test.mjs",
        "consent-protocol/tests/test_ci_path_filters_cover_lane_scripts.py",
        "consent-protocol/tests/test_ios_lane_path_filter_covers_native_test_surfaces.py",
    }:
        return frozenset({"controller"}), None
    if root == ".agents":
        return frozenset({"agent"}), None
    if root in {".github", "config", "deploy", "bin"}:
        return frozenset({"controller"}), None
    if root == "scripts":
        if len(parts) < 2:
            return frozenset(), f"unrecognized scripts path: {path}"
        lower = path.lower()
        if parts[1] == "release":
            return frozenset({"controller"}), None
        if parts[1] == "ops" and "runtime_topology" in lower:
            return frozenset(), None
        if path in {"scripts/ci/resolve-ci-changed-files.sh", "scripts/ci/document-delivery-check.sh"}:
            return frozenset({"controller"}), None
        if path in {
            "scripts/ci/promotion_approval.py",
            "scripts/ci/secret-scan.sh",
            "scripts/ci/test_secret_scan_ranges.py",
        }:
            return frozenset({"controller"}), None
        if path in {
            "scripts/ci/repo-governance-check.sh",
            "scripts/ci/repo_governance_plan.py",
            "scripts/ci/test_repo_governance_plan.py",
        }:
            return REGRESSION_GROUPS, None
        if any(token in lower for token in ("retention", "capacity", "wait_uat", "drain")):
            return frozenset({"retention"}), None
        if any(token in lower for token in ("agent", "router", "route_request", "orchestration")):
            return frozenset({"agent"}), None
        controller_tokens = (
            "deploy", "release", "uat", "production", "environment", "identity",
            "security", "governance", "scope", "artifact", "passkey", "places",
            "readiness", "protocol", "queue", "protected", "branch", "main_sync",
            "live_memory", "verification", "rollback",
        )
        if any(token in lower for token in controller_tokens):
            return frozenset({"controller"}), None
        known_nonregression_tokens = ("web", "ui", "cache", "ios", "android", "native", "pkm")
        if any(token in lower for token in known_nonregression_tokens):
            return frozenset(), None
        return frozenset(), f"unrecognized scripts owner path: {path}"
    if root in KNOWN_ROOTS or path in KNOWN_ROOT_FILES:
        return frozenset(), None
    return frozenset(), f"unrecognized changed path: {path}"


def _select_groups(files: tuple[str, ...]) -> tuple[tuple[str, ...], str | None]:
    groups: set[str] = set()
    for path in files:
        owners, error = _path_groups(path)
        if error:
            return REGRESSION_GROUPS, error
        groups.update(owners)
    return tuple(group for group in REGRESSION_GROUPS if group in groups), None


def build_selection(env: dict[str, str]) -> Selection:
    raw_level = env.get("CI_VALIDATION_LEVEL")
    level = raw_level.strip().lower() if raw_level and raw_level.strip() else "diagnostic"
    level_error = None
    if level not in VALID_LEVELS:
        level_error = f"unsupported CI_VALIDATION_LEVEL: {raw_level!r}"
        level = "diagnostic"
    if level == "diagnostic":
        ids = tuple(check.check_id for check in CHECKS)
        return Selection(level, (), (), ids, level_error)

    files, file_error = _changed_files_from_environment(env)
    groups, group_error = _select_groups(files) if file_error is None else (REGRESSION_GROUPS, None)
    selection_error = level_error or file_error or group_error
    if selection_error:
        groups = REGRESSION_GROUPS
    requested_groups = set(groups)
    if level == "release":
        requested_groups.add("release")
    ids = tuple(
        check.check_id
        for check in CHECKS
        if not check.diagnostic_only
        and (
            not check.groups.intersection({"controller", "retention", "agent", "release"})
            or bool(check.groups.intersection(requested_groups))
        )
    )
    return Selection(
        level,
        files,
        tuple(group for group in REGRESSION_GROUPS if group in requested_groups)
        + (("release",) if level == "release" else ()),
        ids,
        selection_error,
    )


def _checks_for_ids(check_ids: Sequence[str]) -> tuple[Check, ...]:
    selected = set(check_ids)
    return tuple(check for check in CHECKS if check.check_id in selected)


def _run_checks(checks: Sequence[Check], selection_error: str | None = None) -> int:
    failures: list[tuple[str, str]] = []
    for check in checks:
        print(f"\n[governance:{check.check_id}] {' '.join(check.argv)}", flush=True)
        try:
            result = subprocess.run(check.argv, cwd=ROOT, check=False)
            status = result.returncode
        except OSError as exc:
            status = 127
            print(f"unable to start check: {type(exc).__name__}: {exc}", file=sys.stderr)
        if status:
            groups = ",".join(sorted(check.groups)) or "baseline"
            failures.append((groups, f"{check.check_id} (exit {status})"))
    if selection_error:
        failures.append(("selection", selection_error))
    if failures:
        print("\nGovernance check failures:", file=sys.stderr)
        for group, message in failures:
            print(f"- [{group}] {message}", file=sys.stderr)
        return 1
    print(f"\nGovernance checks passed: {len(checks)}", flush=True)
    return 0


def _emit_plan(selection: Selection) -> None:
    checks = _checks_for_ids(selection.check_ids)
    payload = {
        "level": selection.level,
        "changed_files": list(selection.files),
        "selected_groups": list(selection.groups),
        "selection_error": selection.error,
        "commands": [
            {"id": check.check_id, "groups": sorted(check.groups), "argv": list(check.argv)}
            for check in checks
        ],
    }
    print(json.dumps(payload, separators=(",", ":")))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--plan", action="store_true", help="print the selected checks as JSON")
    action.add_argument("--commands-group", choices=("operations", "release", *REGRESSION_GROUPS, "diagnostic"), help="print a reusable group command list as JSON")
    action.add_argument("--run-group", choices=("operations", "release", *REGRESSION_GROUPS, "diagnostic"), help="run one named check group")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.commands_group:
        if args.commands_group == "diagnostic":
            selected = CHECKS
        elif args.commands_group == "operations":
            selected = tuple(check for check in CHECKS if check.check_id in OPERATIONS_IDS)
        else:
            tag = "release" if args.commands_group == "release" else args.commands_group
            selected = tuple(check for check in CHECKS if tag in check.groups)
        print(json.dumps([{"id": check.check_id, "argv": list(check.argv)} for check in selected], separators=(",", ":")))
        return 0
    if args.run_group:
        if args.run_group == "diagnostic":
            selected = CHECKS
        elif args.run_group == "operations":
            selected = tuple(check for check in CHECKS if check.check_id in OPERATIONS_IDS)
        else:
            tag = "release" if args.run_group == "release" else args.run_group
            selected = tuple(check for check in CHECKS if tag in check.groups)
        return _run_checks(selected)

    selection = build_selection(dict(os.environ))
    if args.plan:
        _emit_plan(selection)
        return 2 if selection.error else 0
    return _run_checks(_checks_for_ids(selection.check_ids), selection.error)


if __name__ == "__main__":
    raise SystemExit(main())
