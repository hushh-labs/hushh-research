"""Release-duration regressions must preserve readiness and browser gates."""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]


def _frontend_release():
    return {
        "_FRONTEND_RUNTIME_SERVICE_ACCOUNT": "hushh-webapp-runtime@hushh-pda-uat.iam.gserviceaccount.com",
        "_APP_ENV": "uat",
        "_DEPLOY_ENV": "uat",
        "_DEPLOY_SOURCE": "deploy-uat",
        "_DEPLOY_SHA": "a" * 40,
        "_GITHUB_RUN_ID": "42",
        "_GITHUB_RUN_ATTEMPT": "1",
        "_SKIP_IMAGE_BUILD": "true",
        "_CLOUD_RUN_NO_TRAFFIC": "true",
        "_IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/hushh-webapp@sha256:" + "b" * 64,
        "_CLOUD_RUN_MEMORY": "1Gi",
        "_CLOUD_RUN_MIN_INSTANCES": "2",
        "_CLOUD_RUN_MAX_INSTANCES": "10",
        "_CLOUD_RUN_CONCURRENCY": "10",
        "_CLOUD_RUN_TIMEOUT_SECONDS": "300",
        "_REGION": "us-central1",
    }


def test_ready_frontend_overlaps_providers_without_replacing_any_gate_or_backend_setting():
    module = _uat_build_module()
    backend = module.candidate_parallel_config(
        yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    )
    frontend = yaml.safe_load(_read("deploy/frontend.cloudbuild.yaml"))
    release = _frontend_release()
    backend_values = {key: release[key] for key in module.SHARED_SUBSTITUTIONS}
    config = module.frontend_parallel_config(backend, frontend, backend_values, release)
    assert config["steps"][: len(backend["steps"])] == backend["steps"]
    for key in backend.keys() - {"steps", "substitutions"}:
        assert config[key] == backend[key]
    assert all(
        config["substitutions"][key] == value for key, value in backend["substitutions"].items()
    )
    assert config["substitutions"]["_WEB_CLOUD_RUN_MIN_INSTANCES"] == "2"
    assert config["substitutions"]["_WEB_IMAGE_REFERENCE"] == release["_IMAGE_REFERENCE"]
    # The original three steps, including secret/configuration checks, are
    # preserved. Only custom substitution names and explicit ordering change.
    remap = {
        key: key if key in module.SHARED_SUBSTITUTIONS else "_WEB_" + key[1:]
        for key in frontend["substitutions"]
    }

    def restore(value):
        if isinstance(value, str):
            for key, renamed in remap.items():
                value = value.replace("${" + renamed + "}", "${" + key + "}")
            return value
        if isinstance(value, dict):
            return {key: restore(item) for key, item in value.items()}
        if isinstance(value, list):
            return [restore(item) for item in value]
        return value

    for index, original in enumerate(frontend["steps"]):
        step = deepcopy(config["steps"][len(backend["steps"]) + index])
        assert step.pop("waitFor") == (
            ["build-backend-image", "verify-runtime-iam"]
            if index == 0
            else [module.FRONTEND_STEPS[index - 1]]
        )
        assert restore(step) == original
        assert not step.get("allowFailure") and not step.get("allowExitCodes")
    assert restore(config["availableSecrets"]) == frontend["availableSecrets"]
    # Catch the real Cloud Build argument/env-limit outage on this generated
    # config too, after substitution, with the existing 500-character margin.
    for step in config["steps"]:
        assert len(step.get("env", [])) <= 100
        for value in step.get("args", []) + step.get("env", []):
            rendered = module.CUSTOM_SUBSTITUTION.sub(
                lambda match: config["substitutions"][match[1]], value
            )
            assert len(rendered) <= 9500


@pytest.mark.parametrize(
    "key,value",
    [
        ("_DEPLOY_SHA", "c" * 40),
        ("_DEPLOY_ENV", "production"),
        ("_SKIP_IMAGE_BUILD", "false"),
        ("_CLOUD_RUN_NO_TRAFFIC", "false"),
        ("_FRONTEND_RUNTIME_SERVICE_ACCOUNT", "another@hushh-pda-uat.iam.gserviceaccount.com"),
        ("_IMAGE_REFERENCE", "gcr.io/hushh-pda-uat/hushh-webapp:latest"),
        ("_GITHUB_RUN_ATTEMPT", ""),
        ("_SECRET_PREFIX", "FOREIGN_"),
        ("_MAIL_API_ENDPOINT", "${_OTHER}"),
    ],
)
def test_combined_frontend_refuses_unpinned_traffic_or_different_release(key, value):
    module = _uat_build_module()
    release = _frontend_release()
    backend_values = {name: release[name] for name in module.SHARED_SUBSTITUTIONS}
    release[key] = value
    with pytest.raises(ValueError, match="Parallel frontend"):
        module.frontend_parallel_config(
            module.candidate_parallel_config(
                yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
            ),
            yaml.safe_load(_read("deploy/frontend.cloudbuild.yaml")),
            backend_values,
            release,
        )


@pytest.mark.parametrize("mutation", ["missing_check", "optional_check", "dynamic", "ordering"])
def test_combined_frontend_refuses_missing_or_weakened_template_checks(mutation):
    module = _uat_build_module()
    frontend = yaml.safe_load(_read("deploy/frontend.cloudbuild.yaml"))
    if mutation == "missing_check":
        frontend["steps"].pop(0)
    elif mutation == "optional_check":
        frontend["steps"][0]["allowFailure"] = True
    elif mutation == "dynamic":
        frontend["substitutions"]["_MAIL_API_ENDPOINT"] = "${_OTHER}"
    else:
        frontend["steps"][0]["waitFor"] = ["-"]
    release = _frontend_release()
    with pytest.raises(ValueError, match="complete compatible"):
        module.frontend_parallel_config(
            module.candidate_parallel_config(
                yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
            ),
            frontend,
            {key: release[key] for key in module.SHARED_SUBSTITUTIONS},
            release,
        )


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _uat_build_module():
    spec = importlib.util.spec_from_file_location(
        "uat_build_config", REPO_ROOT / "scripts/ci/uat_backend_build_config.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "backend,status,pin_status,parallel",
    [
        (True, "SUCCESS", 0, True),
        (True, "WORKING", 0, False),
        (False, "SUCCESS", 0, False),
        (True, "SUCCESS", 7, False),
    ],
)
def test_frontend_overlap_requires_a_ready_pinned_image_and_keeps_cold_fallback(
    tmp_path, backend, status, pin_status, parallel
):
    steps = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))["jobs"]["deploy"]["steps"]
    script = next(step["run"] for step in steps if step.get("id") == "prepare-frontend-rollout")
    release = _frontend_release()
    expressions = {
        "env.GCP_PROJECT_ID": "hushh-pda-uat",
        "env.GCP_REGION": "us-central1",
        "env.FRONTEND_SERVICE": "hushh-webapp",
        "env.FRONTEND_RUNTIME_SERVICE_ACCOUNT": release["_FRONTEND_RUNTIME_SERVICE_ACCOUNT"],
        "steps.resolve-sha.outputs.sha": release["_DEPLOY_SHA"],
        "github.run_id": "42",
        "github.run_attempt": "1",
        "steps.scope.outputs.deploy_backend": str(backend).lower(),
        "steps.start-frontend-image-build.outputs.prebuilt": "true",
    }
    script = re.sub(
        r"\$\{\{\s*(.*?)\s*\}\}", lambda match: expressions.get(match[1], "fixture"), script
    )
    helper = tmp_path / "scripts/ci/await-prebuilt-image.sh"
    helper.parent.mkdir(parents=True)
    helper.write_text(
        'echo pin >> "$CALLS"\n[ "$PIN_STATUS" = 0 ] || exit "$PIN_STATUS"\n'
        'printf "%s\\n" "$PINNED_IMAGE"\n'
    )
    output, calls = tmp_path / "output", tmp_path / "calls"
    result = subprocess.run(  # noqa: S603 - authored admission step, synthetic cloud/image commands.
        [
            shutil.which("bash") or "bash",
            "-c",
            'gcloud() { echo describe >> "$CALLS"; printf "%s\\n" "$BUILD_STATUS"; };\n' + script,
        ],
        cwd=tmp_path,
        env={
            **os.environ,
            "GITHUB_OUTPUT": str(output),
            "CALLS": str(calls),
            "PIN_STATUS": str(pin_status),
            "PINNED_IMAGE": release["_IMAGE_REFERENCE"],
            "BUILD_STATUS": status,
            "FRONTEND_BUILD_SUBSTITUTIONS": "_APP_ENV=uat,_DEPLOY_ENV=uat,_IMAGE_TAG=uat-fixture",
            "FRONTEND_IMAGE_BUILD_ID": "fixture",
            "FRONTEND_IMAGE_TAG": "uat-fixture",
        },
        text=True,
        capture_output=True,
        timeout=5,
    )
    assert result.returncode == pin_status, result.stderr
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert (outputs["parallel"] == "true") is parallel
    observed = calls.read_text().splitlines() if calls.exists() else []
    assert observed == (
        ["describe", "pin"] if backend and status == "SUCCESS" else ["describe"] if backend else []
    )
    if parallel:
        assert outputs["image_reference"] == release["_IMAGE_REFERENCE"]
        module = _uat_build_module()
        # Validate the actual workflow's assembled values, not another fixture
        # copy of its service identity, zero-traffic or exact-release settings.
        module.frontend_parallel_config(
            module.candidate_parallel_config(
                yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
            ),
            yaml.safe_load(_read("deploy/frontend.cloudbuild.yaml")),
            {key: release[key] for key in module.SHARED_SUBSTITUTIONS},
            module.substitutions(
                outputs["substitutions"]
                + ",_SKIP_IMAGE_BUILD=true,_IMAGE_REFERENCE="
                + outputs["image_reference"],
                ",",
            ),
        )


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
