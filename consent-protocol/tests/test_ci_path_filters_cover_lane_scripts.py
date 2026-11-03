"""CI path-filter contracts: lane closure and exact auth-health focus."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from functools import cache
from pathlib import Path

import pathspec
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"
ORCHESTRATOR = "scripts/ci/orchestrate.sh"
SCRIPTS_CI = "scripts/ci/"
AUTH_HEALTH_SOURCE = "deploy/observability/auth_health_job.py"
AUTH_HEALTH_TESTS = (
    "consent-protocol/tests/test_auth_health_deployment.py",
    "consent-protocol/tests/test_auth_health_inventory.py",
    "consent-protocol/tests/test_auth_health_lease_rest.py",
    "consent-protocol/tests/test_auth_health_uat_activation.py",
    "consent-protocol/tests/test_auth_health_uat_installation.py",
    "consent-protocol/tests/test_auth_health_wif_scopes.py",
    "consent-protocol/tests/test_phone_list_health.py",
)
AUTH_HEALTH_PATHS = frozenset(
    (
        AUTH_HEALTH_SOURCE,
        "deploy/observability/auth_health_inventory.py",
        "deploy/observability/setup_auth_health.py",
        "deploy/observability/auth_health_uat_common.py",
        "deploy/observability/auth_health_uat_job_install.py",
        "deploy/observability/auth_health_uat_timer_activation.py",
        "deploy/observability/auth_health_uat_installer.py",
        "consent-protocol/tests/auth_health_uat_cloud_fakes.py",
        "consent-protocol/tests/auth_health_uat_installer_fixtures.py",
        *AUTH_HEALTH_TESTS,
    )
)
WORKFLOW_EXPRESSION_RE = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")

LANE_OUTPUT_RE = re.compile(r"outputs\.(frontend|backend|document)\s*==\s*'true'")
STAGE_ARM_RE = re.compile(r"^    ([\w|-]+)\)\n(.*?)^      ;;", re.MULTILINE | re.DOTALL)
ORCHESTRATE_RE = re.compile(r"orchestrate\.sh\s+([\w-]+)")
# The jobs this guard must find; if the `if:` shape changes and discovery
# returns nothing, the guard would pass vacuously.
EXPECTED_JOBS = {
    "web-core-check": {"frontend"},
    "web-targeted-check": {"frontend"},
    "web-targeted-browser": {"frontend"},
    "web-full-suite-check": {"frontend"},
    "document-webkit-check": {"document"},
    "protocol-check": {"backend"},
    "protocol-database-check": {"backend"},
    "protocol-database-check-two": {"backend"},
    "mcp-package-check": {"backend"},
    "integration-check": {"frontend", "backend", "document"},
}

# Actual shared runtime/image inputs used by the governed environment releases.
# Application flags, policy and SQL already fall under consent-protocol/**.
# Workflow-only changes use the focused controller owner below.
DELETION_RELEASE_WORKFLOWS = (
    ".github/workflows/deploy-dev.yml",
    ".github/workflows/deploy-uat.yml",
    ".github/workflows/deploy-production.yml",
)
DELETION_RELEASE_INPUTS = (
    "deploy/drive/rollback_after_worker_failure.sh",
    "deploy/backend.cloudbuild.yaml",
    "deploy/backend-image.cloudbuild.yaml",
    "deploy/frontend.cloudbuild.yaml",
    "deploy/frontend-image.cloudbuild.yaml",
    "deploy/dev.autodeploy.backend.cloudbuild.yaml",
    "scripts/ops/sync_backend_runtime_secrets.py",
    "scripts/ops/runtime_config_retention.py",
    "scripts/ops/scope_commerce_runtime_policy.py",
    "scripts/ops/shared_files_runtime_policy.py",
    "scripts/ops/passkey_domain_policy.py",
    "scripts/ops/upsert_gcp_secret.py",
    "scripts/ops/sync_frontend_runtime_secrets.py",
    "config/runtime-capacity.json",
)
RESTORATION_FIXTURE_INPUTS = (
    "consent-protocol/tests/helpers/production_release_tools.py",
    "consent-protocol/tests/test_production_restoration_operation.py",
)
RESTORATION_FIXTURE_OWNER_TESTS = (
    "consent-protocol/tests/test_production_restoration_operation.py",
    "consent-protocol/tests/test_phone_schema_origin.py",
    "consent-protocol/tests/test_phone_schema_history_compatibility.py",
    "consent-protocol/tests/test_prod_drive_deploy_contract.py::test_older_target_keeps_release_tooling_but_cannot_enable_drive",
)


class _Filter:
    def __init__(self, patterns: list[str]) -> None:
        self.includes = [p for p in patterns if not p.startswith("!")]
        self.excludes = [p[1:] for p in patterns if p.startswith("!")]
        self._include = pathspec.PathSpec.from_lines("gitignore", self.includes)
        self._exclude = pathspec.PathSpec.from_lines("gitignore", self.excludes)

    def match_file(self, path: str) -> bool:
        return self._include.match_file(path) and not self._exclude.match_file(path)


@cache
def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _paths_filter_step() -> dict:
    for step in _workflow()["jobs"]["paths"]["steps"]:
        if str(step.get("uses") or "").startswith("dorny/paths-filter"):
            return step
    raise AssertionError("The paths job no longer uses dorny/paths-filter")


def _filter_patterns() -> dict[str, list[str]]:
    filters = yaml.safe_load(_paths_filter_step()["with"]["filters"])
    return {name: [str(p) for p in patterns] for name, patterns in filters.items()}


def _filters(patterns: dict[str, list[str]] | None = None) -> dict[str, _Filter]:
    source = _filter_patterns() if patterns is None else patterns
    return {name: _Filter(list(lines)) for name, lines in source.items()}


def _resolve_path_outputs(
    event: str, filter_outputs: dict[str, str], tmp_path: Path, *, override: bool
) -> dict[str, str]:
    """Run the workflow's real resolver with bounded synthetic filter outputs."""
    step = next(
        item for item in _workflow()["jobs"]["paths"]["steps"] if item.get("id") == "resolve"
    )
    override_outputs = {
        "frontend": "true",
        "backend": "true",
        "ios": "true",
        "android": "true",
        "editor": "true",
    }
    values = {
        "steps.override.outcome": "success" if override else "skipped",
        **{f"steps.override.outputs.{name}": value for name, value in override_outputs.items()},
        **{f"steps.filter.outputs.{name}": value for name, value in filter_outputs.items()},
    }

    def replace_expression(match: re.Match[str]) -> str:
        expression = match.group(1)
        assert expression in values, f"unmodelled path resolver input: {expression}"
        return values[expression]

    script = WORKFLOW_EXPRESSION_RE.sub(replace_expression, step["run"])
    output = tmp_path / "path-outputs"
    env = {
        "GITHUB_OUTPUT": str(output),
        "EVENT_NAME": event,
        "AUTH_HEALTH_FILTER": filter_outputs.get("auth_health", ""),
        "NON_AUTH_HEALTH_FILTER": filter_outputs.get("non_auth_health", ""),
    }
    completed = subprocess.run(  # noqa: S603 - executes the workflow's real resolver
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],  # noqa: S607
        cwd=ROOT,
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return dict(line.split("=", 1) for line in output.read_text().splitlines())


def _governance_plan(paths: tuple[str, ...]) -> dict:
    env = {
        **os.environ,
        "CI_VALIDATION_LEVEL": "focused",
        "CI_CHANGED_FILES": "\n".join(paths),
    }
    env.pop("CI_CHANGED_FILES_FILE", None)
    result = subprocess.run(  # noqa: S603 - invokes the repository's fixed governance selector
        [sys.executable, str(ROOT / "scripts/ci/repo_governance_plan.py"), "--plan"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode in (0, 2), result.stderr
    return yaml.safe_load(result.stdout)


@cache
def _tracked_files() -> tuple[str, ...]:
    listing = subprocess.run(  # noqa: S603 - fixed argv, read-only
        ["git", "ls-files", "-z"],  # noqa: S607
        cwd=ROOT,
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8")
    return tuple(path for path in listing.split("\0") if path)


@cache
def _scripts_ci_files() -> tuple[str, ...]:
    return tuple(
        path
        for path in _tracked_files()
        if path.startswith(SCRIPTS_CI) and "/" not in path[len(SCRIPTS_CI) :]
    )


@cache
def _reference_re() -> re.Pattern[str]:
    names = sorted((Path(p).name for p in _scripts_ci_files()), key=len, reverse=True)
    return re.compile(r"(?<![\w.-])(" + "|".join(re.escape(n) for n in names) + r")(?![\w.-])")


def _referenced_scripts(text: str) -> set[str]:
    return {SCRIPTS_CI + name for name in _reference_re().findall(text)}


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8", errors="replace")


@cache
def _stage_scripts() -> dict[str, frozenset[str]]:
    stages: dict[str, frozenset[str]] = {}
    for names, body in STAGE_ARM_RE.findall(_read(ORCHESTRATOR)):
        for name in names.split("|"):
            stages[name] = frozenset(_referenced_scripts(body))
    assert {"web-core", "web-targeted", "protocol", "integration"} <= set(stages), (
        f"Could not read orchestrate.sh's run_stage arms; found {sorted(stages)}"
    )
    return stages


def _closure(entry: set[str]) -> set[str]:
    # orchestrate.sh names every stage, so its text is never followed; its
    # stages are resolved explicitly from the orchestrate.sh <stage> call.
    seen: set[str] = set()
    pending = list(entry)
    while pending:
        script = pending.pop()
        if script in seen:
            continue
        seen.add(script)
        if script == ORCHESTRATOR:
            continue
        pending.extend(_referenced_scripts(_read(script)) - seen)
    return seen


def _lane_jobs() -> dict[str, set[str]]:
    jobs: dict[str, set[str]] = {}
    for name, job in _workflow()["jobs"].items():
        lanes = set(LANE_OUTPUT_RE.findall(str(job.get("if") or "")))
        if lanes:
            jobs[name] = lanes
    return jobs


def _job_scripts(job: str) -> set[str]:
    entry: set[str] = set()
    for step in _workflow()["jobs"][job]["steps"]:
        run = str(step.get("run") or "")
        entry |= _referenced_scripts(run)
        for stage in ORCHESTRATE_RE.findall(run):
            entry |= _stage_scripts()[stage]
    return _closure(entry)


def test_negated_patterns_use_the_exclusion_aware_quantifier() -> None:
    # Under the default 'some', a '!' pattern MATCHES every file it does not
    # name, which would schedule that lane for almost any change.
    negated = [p for lines in _filter_patterns().values() for p in lines if p.startswith("!")]
    if negated:
        quantifier = _paths_filter_step()["with"].get("predicate-quantifier")
        assert quantifier == "some-with-excludes", (
            f"Filters use negated patterns {negated} but predicate-quantifier is {quantifier!r}"
        )


def _auth_health_decision(paths, tmp_path, event="pull_request", override=False):
    filters = _filters()
    outputs = {
        name: str(any(filters[name].match_file(path) for path in paths)).lower()
        for name in _filter_patterns()
    }
    return outputs, _resolve_path_outputs(event, outputs, tmp_path, override=override)


def test_auth_health_paths_are_exact_and_schedule_registered_tests(
    tmp_path: Path,
) -> None:
    patterns = _filter_patterns()
    assert set(patterns["auth_health"]) == AUTH_HEALTH_PATHS
    assert {
        pattern[1:] for pattern in patterns["non_auth_health"] if pattern.startswith("!")
    } == AUTH_HEALTH_PATHS

    for changed_paths in ((path,) for path in sorted(AUTH_HEALTH_PATHS)):
        outputs, resolved = _auth_health_decision(changed_paths, tmp_path)
        assert outputs["auth_health"] == "true", changed_paths
        assert outputs["non_auth_health"] == "false", changed_paths
        assert resolved["auth_health_only"] == "true", changed_paths
        if (
            changed_paths[0] in AUTH_HEALTH_TESTS
            and changed_paths[0] != "consent-protocol/tests/test_auth_health_inventory.py"
        ):
            assert outputs["backend"] == "true", changed_paths


def test_auth_health_selection_falls_back_for_mixed_unknown_and_non_pr_paths(
    tmp_path: Path,
) -> None:
    mixed = (
        AUTH_HEALTH_SOURCE,
        "hushh-webapp/app/page.tsx",
        "hushh-webapp/package-lock.json",
        "consent-protocol/db/schema.sql",
        "consent-protocol/migrations/0001_example.sql",
        "consent-protocol/pyproject.toml",
        "consent-protocol/uv.lock",
        ".github/workflows/ci.yml",
        "docs/unknown-health-neighbor.md",
    )
    for changed_paths in ((), mixed):
        outputs, resolved = _auth_health_decision(changed_paths, tmp_path)
        assert resolved["auth_health_only"] == "false", changed_paths
        if changed_paths:
            assert outputs["non_auth_health"] == "true", changed_paths
            assert outputs["backend"] == "true", changed_paths

    unknown_code = ("scripts/ci/unknown-health-neighbor.py",)
    outputs, resolved = _auth_health_decision(unknown_code, tmp_path)
    assert outputs["auth_health"] == "false"
    assert outputs["non_auth_health"] == "true"
    assert outputs["backend"] == "false"
    assert resolved["auth_health_only"] == "false"
    plan = _governance_plan(unknown_code)
    assert "unrecognized scripts owner path" in plan["selection_error"]
    assert set(plan["selected_groups"]) >= {"controller", "retention", "agent"}

    for event in ("push", "workflow_dispatch", "merge_group"):
        _, resolved = _auth_health_decision((AUTH_HEALTH_SOURCE,), tmp_path, event)
        assert resolved["auth_health_only"] == "false", event


def test_auth_health_focus_runs_through_required_governance(tmp_path: Path) -> None:
    exact_outputs, _ = _auth_health_decision((AUTH_HEALTH_SOURCE,), tmp_path)
    dispatch = _resolve_path_outputs("workflow_dispatch", exact_outputs, tmp_path, override=True)
    assert dispatch["auth_health_only"] == "false"
    assert all(
        dispatch[lane] == "true" for lane in ("frontend", "backend", "ios", "android", "editor")
    )
    jobs = _workflow()["jobs"]
    governance = jobs["repo-governance"]
    assert governance["needs"] == ["paths"]
    assert governance["if"] == "always()"
    steps = governance["steps"]
    setup = next(
        i
        for i, step in enumerate(steps)
        if step.get("uses") == "./consent-protocol/.github/actions/setup-python-uv"
    )
    focused = next(step for step in steps if step.get("name") == "Run exact auth-health contracts")
    assert setup < steps.index(focused)
    assert focused["if"] == "needs.paths.outputs.auth_health == 'true'"
    assert set(focused["run"].split()[4:]) == {
        path.removeprefix("consent-protocol/") for path in AUTH_HEALTH_TESTS
    }
    assert jobs["paths"]["outputs"]["auth_health"] == "${{ steps.filter.outputs.auth_health }}"

    # A CI edit must not hide the observer owner or select unrelated DB suites.
    mixed_outputs, mixed = _auth_health_decision(
        (
            "deploy/observability/auth_health_inventory.py",
            "consent-protocol/tests/test_auth_health_inventory.py",
            ".github/workflows/ci.yml",
        ),
        tmp_path,
    )
    assert mixed["auth_health_only"] == "false"
    assert mixed_outputs["auth_health"] == "true"
    assert mixed_outputs["backend"] == "false"
    auto_outputs, auto = _auth_health_decision(
        ("deploy/observability/auth_health_inventory.py",), tmp_path, "workflow_dispatch"
    )
    assert auto_outputs["auth_health"] == "true"
    assert auto["auth_health_only"] == "false"
    schema_outputs, schema = _auth_health_decision(
        ("consent-protocol/tests/test_auth_health_inventory.py", "consent-protocol/db/schema.sql"),
        tmp_path,
    )
    assert schema_outputs["backend"] == "true"
    assert schema["auth_health_only"] == "false"

    backend_output = jobs["preflight-gate"]["outputs"]["backend"]
    assert "needs.paths.outputs.auth_health_only == 'true'" in backend_output
    assert jobs["preflight-gate"]["needs"] == [
        "ui-contracts",
        "secret-scan",
        "dco-check",
        "pr-base-policy",
        "repo-governance",
        "paths",
    ]


def test_browser_prose_does_not_hide_backend_contract_changes() -> None:
    backend = _filters()["backend"]
    reference = "consent-protocol/docs/reference/private-browser-runtime.md"
    runtime = "consent-protocol/hushh_mcp/services/pod_binding_service.py"
    assert not backend.match_file(reference)
    for path in (
        "consent-protocol/docs/reference/env-vars.md",
        "consent-protocol/docs/reference/future-document.md",
        "consent-protocol/docs/example.py",
        "consent-protocol/docs/schema.json",
        runtime,
    ):
        assert backend.match_file(path), path
    assert any(backend.match_file(path) for path in (reference, runtime))
    assert not backend.match_file("scripts/ci/protocol-check.sh")
    assert not backend.match_file(".github/workflows/ci.yml")


def _uncovered_deletion_release_inputs(filters: dict[str, _Filter]) -> set[str]:
    paths = set(DELETION_RELEASE_INPUTS) | {
        path for path in _tracked_files() if path.startswith("deploy/account-deletion/")
    }
    assert any(path.startswith("deploy/account-deletion/") for path in paths)
    assert all((ROOT / path).is_file() for path in paths)
    return {path for path in paths if not filters["backend"].match_file(path)}


def test_environment_only_deletion_inputs_schedule_the_required_backend_lane() -> None:
    missing = _uncovered_deletion_release_inputs(_filters())
    assert not missing, (
        f"Deletion runtime/release edits can skip Protocol and Integration: {missing}"
    )


def test_deploy_workflow_edits_select_controller_contract_without_backend_lane() -> None:
    backend = _filters()["backend"]
    for path in DELETION_RELEASE_WORKFLOWS:
        assert not backend.match_file(path), path
        plan = _governance_plan((path,))
        assert plan["selection_error"] is None
        assert plan["selected_groups"] == ["controller"]
        selected = {row["id"] for row in plan["commands"]}
        assert "account-deletion-release-workflow" in selected

    promotion_plan = _governance_plan(("scripts/ci/promotion_approval.py",))
    assert promotion_plan["selection_error"] is None
    assert promotion_plan["selected_groups"] == ["controller"]
    assert "account-deletion-release-workflow" in {row["id"] for row in promotion_plan["commands"]}


def test_production_emergency_authority_test_is_controller_owned_not_backend() -> None:
    path = "consent-protocol/tests/test_production_emergency.py"
    backend = _filters()["backend"]
    assert not backend.match_file(path)
    assert backend.match_file("consent-protocol/tests/test_server_startup_guards.py")

    manifest = (ROOT / "consent-protocol/scripts/test-ci.manifest.txt").read_text()
    assert "tests/test_production_emergency.py" in manifest.splitlines()

    plan = _governance_plan((path,))
    assert plan["selection_error"] is None
    assert plan["selected_groups"] == ["controller"]
    commands = {row["id"]: row["argv"] for row in plan["commands"]}
    assert commands["production-emergency-authority"] == [
        "uv",
        "run",
        "--frozen",
        "--project",
        "consent-protocol",
        "python",
        "-m",
        "pytest",
        "-q",
        path,
    ]
    assert "protocol-check" not in commands


def test_restoration_fixture_inputs_select_transitive_controller_owner_only() -> None:
    backend = _filters()["backend"]
    for path in RESTORATION_FIXTURE_INPUTS:
        assert not backend.match_file(path), path
    for path in (
        "consent-protocol/tests/test_phone_schema_origin.py",
        "consent-protocol/tests/test_phone_schema_history_compatibility.py",
        "consent-protocol/tests/test_prod_drive_deploy_contract.py",
        "consent-protocol/hushh_mcp/services/account_deletion_service.py",
        "consent-protocol/db/schema.sql",
        "consent-protocol/migrations/20261001_example.sql",
    ):
        assert backend.match_file(path), path

    plan = _governance_plan(RESTORATION_FIXTURE_INPUTS)
    assert plan["selection_error"] is None
    assert plan["selected_groups"] == ["controller"]
    commands = {row["id"]: row["argv"] for row in plan["commands"]}
    assert commands["production-restoration-fixture-owner"] == [
        "uv",
        "run",
        "--frozen",
        "--project",
        "consent-protocol",
        "python",
        "-m",
        "pytest",
        "-q",
        *RESTORATION_FIXTURE_OWNER_TESTS,
    ]
    assert "protocol-check" not in commands
    assert "cloudrun-retention" not in commands


def test_document_delivery_ci_contract_paths_select_controller_owner_not_backend() -> None:
    paths = (
        "consent-protocol/tests/helpers/document_delivery_ci.py",
        "consent-protocol/tests/test_uat_deploy_parallelism.py",
    )
    backend = _filters()["backend"]
    manifest = (ROOT / "consent-protocol/scripts/test-ci.manifest.txt").read_text()
    assert "tests/test_uat_deploy_parallelism.py" in manifest.splitlines()

    for path in paths:
        assert not backend.match_file(path), path
        plan = _governance_plan((path,))
        assert plan["selection_error"] is None
        assert plan["selected_groups"] == ["controller"]
        commands = {row["id"]: row["argv"] for row in plan["commands"]}
        assert commands["uat-deploy-parallelism"] == [
            "uv",
            "run",
            "--frozen",
            "--project",
            "consent-protocol",
            "python",
            "-m",
            "pytest",
            "-q",
            "consent-protocol/tests/test_uat_deploy_parallelism.py",
        ]
        assert "protocol-check" not in commands

    # The actual browser behavior owner stays in the application backend lane.
    assert backend.match_file("consent-protocol/tests/services/test_document_delivery_browser.py")


def test_deletion_selection_guard_rejects_excluded_release_and_runtime_inputs() -> None:
    excluded = {
        "deploy/account-deletion/activate_release.py",
        "deploy/backend.cloudbuild.yaml",
        "scripts/ops/sync_backend_runtime_secrets.py",
    }
    patterns = _filter_patterns()
    patterns["backend"] += ["!" + path for path in sorted(excluded)]
    assert _uncovered_deletion_release_inputs(_filters(patterns)) == excluded


def test_lane_discovery_finds_every_path_filtered_lane() -> None:
    jobs = _lane_jobs()
    for job, lanes in EXPECTED_JOBS.items():
        assert jobs.get(job) == lanes, (
            f"{job} should be scheduled by {lanes}, found {jobs.get(job)}"
        )
    assert _job_scripts("web-targeted-check") >= {
        ORCHESTRATOR,
        "scripts/ci/web-targeted-check.sh",
        "scripts/ci/web-common.sh",
    }
    assert _job_scripts("web-full-suite-check") >= {
        ORCHESTRATOR,
        "scripts/ci/web-full-suite-check.sh",
        "scripts/ci/web-common.sh",
    }
    assert _job_scripts("integration-check") >= {
        "scripts/ci/integration-check.sh",
        "scripts/ci/account-deletion-check.sh",
        "scripts/ci/resolve-uat-verification-plan.py",
        "scripts/ci/pkm-upgrade-gate.sh",
        "scripts/ci/pkm-runtime-audit.sh",
    }


def test_ci_helpers_use_source_aware_governance_instead_of_broad_app_lanes() -> None:
    filters = _filters()
    scripts = _scripts_ci_files()
    assert scripts
    assert not any(
        filters[lane].match_file(path) for path in scripts for lane in ("frontend", "backend")
    ), "CI-only helpers must not fan out into application lanes"

    plan = _governance_plan(scripts)
    if plan["selection_error"]:
        # Any unclassified helper forces the full regression set; it cannot
        # disappear just because it is no longer a frontend/backend trigger.
        assert set(plan["selected_groups"]) >= {"controller", "retention", "agent"}
    else:
        assert set(plan["selected_groups"]) <= {"controller", "retention", "agent"}


def test_unknown_ci_helper_is_a_fail_closed_negative_control() -> None:
    plan = _governance_plan(("scripts/ci/new-unowned-check.py",))
    assert (
        plan["selection_error"]
        == "unrecognized scripts owner path: scripts/ci/new-unowned-check.py"
    )
    assert set(plan["selected_groups"]) == {"controller", "retention", "agent"}


def test_release_controller_fixtures_keep_coverage_without_backend_database_lanes() -> None:
    paths = (
        "consent-protocol/tests/test_dco_history_sync.py",
        "consent-protocol/tests/test_managed_vertex_readiness_script.py",
        "consent-protocol/tests/test_one_chat_service_only_release.py",
        "consent-protocol/tests/test_deployment_security.py",
    )
    backend = _filters()["backend"]
    assert all(not backend.match_file(path) for path in paths)
    assert backend.match_file("consent-protocol/tests/test_account_deletion_service.py")
    assert backend.match_file("consent-protocol/hushh_mcp/services/account_deletion_service.py")
    plan = _governance_plan(paths)
    assert plan["selection_error"] is None
    assert plan["selected_groups"] == ["controller"]
    commands = {row["id"]: row["argv"] for row in plan["commands"]}
    assert commands["release-controller-contracts"] == [
        "uv",
        "run",
        "--frozen",
        "--project",
        "consent-protocol",
        "python",
        "-m",
        "pytest",
        "-q",
        *paths,
    ]
