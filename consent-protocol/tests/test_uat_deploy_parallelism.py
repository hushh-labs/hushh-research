"""Release-duration regressions must preserve readiness and browser gates."""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _uat_build_module():
    spec = importlib.util.spec_from_file_location(
        "uat_build_config", REPO_ROOT / "scripts/ci/uat_backend_build_config.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_uat_candidate_warms_in_parallel_and_aggregate_still_joins_every_gate():
    source = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    config = _uat_build_module().candidate_parallel_config(source)
    original = {step["id"]: step for step in source["steps"]}
    steps = {step["id"]: step for step in config["steps"]}
    assert original["deploy-backend"]["waitFor"][-1] == "verify-managed-vertex-runtime"
    assert steps["deploy-backend"]["waitFor"] == [
        "resolve-pod-image-digest",
        "publish-azure-pod-release",
        "verify-runtime-iam",
    ]
    # No provider, deployment setting, aggregate policy or evidence field changes.
    for key in source.keys() - {"steps"}:
        assert config[key] == source[key]
    for step_id, original_step in original.items():
        if step_id == "deploy-backend":
            assert {
                key: value
                for key, value in steps[step_id].items()
                if key not in {"waitFor", "args"}
            } == {
                key: value for key, value in original_step.items() if key not in {"waitFor", "args"}
            }
        else:
            assert steps[step_id] == original_step
    # Missing probes or a weakened aggregate must refuse the scheduling overlay.
    for step_id, key, value in [
        ("verify-managed-provider-readiness", "waitFor", ["deploy-backend"]),
        ("verify-managed-provider-readiness", "allowFailure", True),
        ("verify-managed-provider-readiness", "allowExitCodes", [1]),
        ("verify-managed-vertex-runtime", "waitFor", ["build-backend-image"]),
    ]:
        broken = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
        next(step for step in broken["steps"] if step["id"] == step_id)[key] = value
        with pytest.raises(ValueError, match="complete known readiness DAG"):
            _uat_build_module().candidate_parallel_config(broken)


@pytest.mark.parametrize(
    "override,allowed",
    [
        ({}, True),
        ({"PROJECT_ID": "hushh-pda"}, False),
        ({"_DEPLOY_ENV": "production"}, False),
        ({"_DEPLOY_SOURCE": "manual"}, False),
        ({"_BACKEND_SERVICE": "another-service"}, False),
        ({"_CLOUD_RUN_CAPACITY": "no_traffic=false"}, False),
        ({"_CLOUD_RUN_CAPACITY": "not_no_traffic=true"}, False),
        (
            {
                "_CLOUD_RUN_CAPACITY": "max=5,min=2,cpu=2,concurrency=20,no_traffic=true,no_traffic=false"
            },
            False,
        ),
        (
            {
                "_IMAGE_SETTINGS": "true|gcr.io/hushh-pda-uat/consent-protocol:latest|account-deletion-42|false|"
            },
            False,
        ),
        (
            {
                "_IMAGE_SETTINGS": "true|gcr.io/hushh-pda-uat/consent-protocol@sha256:"
                + "a" * 64
                + "|foreign-tag|false|"
            },
            False,
        ),
    ],
)
def test_parallel_candidate_refuses_other_environments_or_traffic(tmp_path, override, allowed):
    deploy = tmp_path / "scripts/deploy/backend-deploy.sh"
    deploy.parent.mkdir(parents=True)
    deploy.write_text('echo admitted > "$MARKER"\n')
    (deploy.parent / "backend-capacity-settings.sh").write_text(
        _read("scripts/deploy/backend-capacity-settings.sh")
    )
    marker = tmp_path / "admitted"
    environment = {
        **os.environ,
        "PROJECT_ID": "hushh-pda-uat",
        "_DEPLOY_ENV": "uat",
        "_DEPLOY_SOURCE": "deploy-uat",
        "_BACKEND_SERVICE": "consent-protocol",
        "_GITHUB_RUN_ID": "42",
        "_IMAGE_SETTINGS": "true|gcr.io/hushh-pda-uat/consent-protocol@sha256:"
        + "a" * 64
        + "|account-deletion-42|false|",
        "_CLOUD_RUN_CAPACITY": "max=5,min=2,no_traffic=true,cpu=2,concurrency=20",
        "MARKER": str(marker),
        **override,
    }
    module = _uat_build_module()
    config = module.candidate_parallel_config(
        yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    )
    command = next(step for step in config["steps"] if step["id"] == "deploy-backend")["args"][1]
    assert command == module.UAT_CANDIDATE_COMMAND.replace("$", "$$")
    result = subprocess.run(  # noqa: S603 - generated guard with synthetic deploy stub.
        [shutil.which("bash") or "bash", "-c", command.replace("$$", "$")],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert (result.returncode == 0) is allowed, result.stderr
    assert marker.exists() is allowed


def test_parallel_build_keeps_release_and_readiness_before_deployment():
    """Independent work can overlap; no deploy can outrun its authority gates."""
    config = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    dependencies = {}
    preceding = []
    for step in config["steps"]:
        required = step.get("waitFor", preceding)  # Cloud Build's implicit ordering.
        assert all(parent == "-" or parent in preceding for parent in required)
        dependencies[step["id"]] = set(required) - {"-"}
        preceding.append(step["id"])

    def ancestors(step_id):
        direct = dependencies[step_id]
        return direct | {ancestor for parent in direct for ancestor in ancestors(parent)}

    assert {"resolve-pod-image-digest", "verify-managed-vertex-runtime"} <= ancestors(
        "deploy-backend"
    )
    assert {"build-backend-image", "verify-runtime-iam"} <= ancestors(
        "verify-managed-vertex-runtime"
    )
    assert "build-pod-image" in ancestors("resolve-pod-image-digest")
    assert "build-backend-image" in ancestors("build-pod-image")
    assert "build-pod-image" not in ancestors("verify-managed-vertex-runtime")
    providers = {"verify-azure-pwm-runtime", "verify-managed-vertex-runtime"}
    for provider in providers:
        required = ancestors(provider)
        assert {"build-backend-image", "verify-runtime-iam"} <= required
        assert not (providers - {provider}) & required, "Provider probes must overlap"
        assert "deploy-backend" not in required, "Image probes must not wait for rollout"
    assert providers | {"deploy-backend"} <= ancestors("verify-managed-provider-readiness")


@pytest.mark.parametrize(
    "frontend,protected,pwm",
    [
        (True, False, False),
        (False, True, False),
        (False, False, True),
        (True, True, True),
        (False, False, False),
    ],
)
def test_uat_browser_consumers_share_one_required_install(frontend, protected, pwm):
    steps = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))["jobs"]["deploy"]["steps"]
    installs = [step for step in steps if "npm ci" in step.get("run", "")]
    assert len(installs) == 1, "Analytics and protected verification must reuse one install"
    install = installs[0]
    condition = install["if"].replace(
        "steps.scope.outputs.deploy_frontend == 'true'", str(frontend)
    )
    condition = condition.replace(
        "steps.verification-plan.outputs.requires_web_dependencies == 'true'", str(protected)
    )
    condition = condition.replace("inputs.run_pwm_acceptance", str(pwm))
    assert all(term.strip() in {"True", "False"} for term in condition.split("||"))
    assert any(term.strip() == "True" for term in condition.split("||")) == (
        frontend or protected or pwm
    )
    for step in steps:
        if step.get("uses", "").startswith("actions/setup-node@"):
            assert step["if"] == install["if"]
    for consumer in (
        "verify-pkm-preservation",
        "verify-analytics-uat",
        "verify-reviewer-byok",
        "verify-pwm-acceptance",
    ):
        assert steps.index(install) < next(
            i for i, step in enumerate(steps) if step.get("id") == consumer
        )
    assert install["timeout-minutes"] == 8
    cache = next(step for step in steps if step.get("uses", "").startswith("actions/cache@"))
    assert "uat-chromium" in cache["with"]["key"]


@pytest.mark.parametrize(
    "npm_status,failures,expected", [(0, 0, 0), (0, 1, 0), (0, 2, 1), (9, 0, 9)]
)
def test_uat_browser_install_retries_and_blocks_on_failure(
    tmp_path, npm_status, failures, expected
):
    steps = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))["jobs"]["deploy"]["steps"]
    install = next(step for step in steps if step.get("id") == "install-browser-dependencies")
    (tmp_path / "hushh-webapp").mkdir()
    mirrors = tmp_path / "apt-mirrors.txt"
    mirrors.write_text(
        "http://azure.archive.ubuntu.com/ubuntu/ 10\nhttp://archive.ubuntu.com/ubuntu/ 20\nhttp://security.ubuntu.com/ubuntu/ 30\n"
    )
    script = install["run"].replace("/etc/apt/apt-mirrors.txt", str(mirrors))
    # Execute the authored installer with no package downloads or privilege changes.
    stubs = (
        'npm() { echo npm >> "$CALLS"; return "$NPM_STATUS"; }; '
        'sudo() { [ "$1 $2" = "sed -i" ] || return 1; '
        'sed "$3" "$4" > "$4.filtered" && mv "$4.filtered" "$4"; }; '
        "sleep() { :; }; "
        'npx() { local n=0; [ ! -f "$ATTEMPTS" ] || read -r n < "$ATTEMPTS"; '
        'n=$((n+1)); echo "$n" > "$ATTEMPTS"; echo "$*" >> "$CALLS"; [ "$n" -gt "$FAILURES" ]; };\n'
    )
    calls, attempts = tmp_path / "calls", tmp_path / "attempts"
    result = subprocess.run(  # noqa: S603 - actual installer with synthetic package commands only.
        [shutil.which("bash") or "bash", "-c", stubs + script],
        cwd=tmp_path,
        env={
            **os.environ,
            "CALLS": str(calls),
            "ATTEMPTS": str(attempts),
            "NPM_STATUS": str(npm_status),
            "FAILURES": str(failures),
        },
        capture_output=True,
        text=True,
    )
    assert result.returncode == expected, result.stderr
    assert calls.read_text().splitlines().count("npm") == 1
    if npm_status:
        assert not attempts.exists()
    else:
        assert int(attempts.read_text()) == min(failures + 1, 2)
        assert "azure.archive" not in mirrors.read_text()
        assert (
            "archive.ubuntu.com" in mirrors.read_text()
            and "security.ubuntu.com" in mirrors.read_text()
        )
