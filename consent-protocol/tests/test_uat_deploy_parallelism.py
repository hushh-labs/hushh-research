"""Release-duration regressions must preserve readiness and browser gates."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


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
