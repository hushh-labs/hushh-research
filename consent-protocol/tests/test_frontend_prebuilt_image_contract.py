"""Contract for the parallel, digest-pinned frontend image build.

Every deploy lane starts ``deploy/frontend-image.cloudbuild.yaml`` next to the
backend image build, pins the pushed image to an immutable digest right before
the frontend deploy, and deploys that digest through
``deploy/frontend.cloudbuild.yaml`` with ``_SKIP_IMAGE_BUILD=true``. These tests
run the real step bodies with guarded ``gcloud``/``docker`` stand-ins, so a
regression shows up as a behaviour change rather than a missing string.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_BUILD = ROOT / "deploy" / "frontend.cloudbuild.yaml"
FRONTEND_IMAGE_BUILD = ROOT / "deploy" / "frontend-image.cloudbuild.yaml"
AWAIT_SCRIPT = ROOT / "scripts" / "ci" / "await-prebuilt-image.sh"
LANES = {
    "uat": (".github/workflows/deploy-uat.yml", "hushh-pda-uat"),
    "production": (".github/workflows/deploy-production.yml", "hushh-pda"),
    "dev": (".github/workflows/deploy-dev.yml", "hushh-pda-dev"),
}
DIGEST = "sha256:" + "a" * 64
BUILD_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"


def _bash() -> str:
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required to run the deploy step bodies"
    return bash


def _steps(path: Path) -> dict[str, dict]:
    config = yaml.safe_load(path.read_text(encoding="utf-8"))
    return {step["id"]: step for step in config["steps"]}


def _body(step: dict) -> str:
    assert step["entrypoint"] == "bash"
    assert step["args"][0] == "-c"
    return str(step["args"][1])


def _without_first_line(script: str) -> str:
    first, _, rest = script.partition("\n")
    assert first == "set -euo pipefail"
    return rest


def _substitute(script: str, values: dict[str, str]) -> str:
    """Apply Cloud Build's simple ${_NAME} substitution, nothing else."""

    def replace(match: re.Match[str]) -> str:
        return values[match.group(1)]

    return re.sub(r"\$\{(_[A-Z0-9_]+)\}", replace, script)


def _run(script: str, *, env: dict[str, str] | None = None, cwd: Path = ROOT):
    environment = os.environ.copy()
    environment.pop("BASH_ENV", None)
    environment.update(env or {})
    return subprocess.run(  # noqa: S603 - trusted repo scripts, fixed inputs, guarded commands
        [_bash(), "-c", script],
        cwd=cwd,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


# --- Cloud Build configs -----------------------------------------------------


def test_image_build_steps_stay_identical_to_the_combined_build() -> None:
    combined = _steps(FRONTEND_BUILD)
    image_only = _steps(FRONTEND_IMAGE_BUILD)
    assert list(image_only) == ["resolve-google-contacts-client-config", "build-frontend-image"]
    assert "deploy-frontend" in combined

    for step_id in image_only:
        shared = _without_first_line(_body(image_only[step_id]))
        # The combined config may only PREPEND checks (Cloud Run sizing, the
        # prebuilt guard); the build logic itself must be byte-identical.
        assert _body(combined[step_id]).endswith(shared), step_id
        for key in ("name", "secretEnv"):
            assert image_only[step_id].get(key) == combined[step_id].get(key), (step_id, key)

    image_config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text(encoding="utf-8"))
    combined_config = yaml.safe_load(FRONTEND_BUILD.read_text(encoding="utf-8"))
    assert image_config["availableSecrets"] == combined_config["availableSecrets"]
    assert image_config["options"] == combined_config["options"]
    assert image_config["timeout"] == combined_config["timeout"]
    assert "images" not in image_config
    for name, default in image_config["substitutions"].items():
        if name != "_IMAGE_TAG":
            assert combined_config["substitutions"][name] == default, name


def test_image_build_config_never_deploys() -> None:
    config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text(encoding="utf-8"))
    bodies = [_body(step) for step in config["steps"]]
    assert not any("gcloud run" in body for body in bodies)
    assert not any("${_SKIP_IMAGE_BUILD}" in body for body in bodies)
    assert "_SKIP_IMAGE_BUILD" not in config["substitutions"]
    assert "--push" in bodies[-1]


@pytest.mark.parametrize(
    ("lane", "native_result", "expected_code", "enabled"),
    [
        ("dev", "configured", 0, "true"),
        ("dev", "missing", 0, "false"),
        ("dev", "denied", 1, None),
        ("uat", "configured", 0, "false"),
        ("production", "configured", 0, "false"),
    ],
)
def test_native_public_clients_resolve_only_in_dev_and_fail_closed(
    tmp_path: Path, lane: str, native_result: str, expected_code: int, enabled: str | None
) -> None:
    """Run the real resolver/build bodies; absence must differ from denied access."""
    config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text(encoding="utf-8"))
    values = {name: str(value) for name, value in config["substitutions"].items()}
    values.update({"_DEPLOY_ENV": lane, "_APP_ENV": lane})
    client = "123456789012-synthetic.apps.googleusercontent.com"
    trace = tmp_path / "secret-names"
    pins = {
        "NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID": client,
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID": client,
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI": "com.hussh.app:/oauth2redirect",
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED": "true",
    }
    cases = []
    for name, value in pins.items():
        if native_result == "configured":
            command = f"printf '%s' {shlex.quote(value)}"
        else:
            error = "NOT_FOUND" if native_result == "missing" else "PERMISSION_DENIED"
            command = f"echo '{error}: synthetic refusal' >&2; return 1"
        cases.append(f"{name}) {command} ;;")
    guard = (
        "gcloud() { local secret=''; for arg in \"$@\"; do "
        'case "$arg" in --secret=*) secret="${arg#--secret=}" ;; esac; done; '
        f'printf "%s\\n" "$secret" >> {shlex.quote(str(trace))}; '
        'case "$secret" in '
        f"NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID) printf '%s' {shlex.quote(client)} ;; "
        + " ".join(cases)
        + " *) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;; esac; };\n"
    )
    resolver = _substitute(
        _body(_steps(FRONTEND_IMAGE_BUILD)["resolve-google-contacts-client-config"]), values
    )
    resolver = resolver.replace("$$", "$").replace("/workspace", str(tmp_path))
    origin = {"dev": "dev.one.hushh.ai", "uat": "uat.one.hushh.ai", "production": "one.hushh.ai"}[
        lane
    ]
    result = _run(
        guard + resolver,
        env={"APP_FRONTEND_ORIGIN_VAL": f"https://{origin}", "PROJECT_ID": "synthetic-project"},
    )
    assert result.returncode == expected_code, result.stderr
    assert client not in result.stdout + result.stderr
    assert "UNEXPECTED_CLOUD_COMMAND" not in result.stdout + result.stderr
    requested = trace.read_text().splitlines()
    if lane != "dev":
        assert requested == ["NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID"]
    if expected_code:
        assert "Unable to access native Google" in result.stderr
        return
    directory = tmp_path / ".google-native-connectors"
    assert (directory / "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED").read_text() == enabled
    if native_result == "missing" or lane != "dev":
        assert (directory / "NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID").read_text() == ""

    # The actual Docker command consumes these resolved pins, without echoing them.
    capture = tmp_path / "docker-args"
    build_guard = (
        "gcloud() { return 0; };\n"
        "docker() { if [ \"$1 $2\" = 'buildx build' ]; then "
        f"printf '%s\\n' \"$@\" > {shlex.quote(str(capture))}; fi; }};\n"
    )
    build = _substitute(_body(_steps(FRONTEND_IMAGE_BUILD)["build-frontend-image"]), values)
    build = build.replace("$$", "$").replace("/workspace", str(tmp_path))
    environment = {
        name: "synthetic"
        for name in _steps(FRONTEND_IMAGE_BUILD)["build-frontend-image"]["secretEnv"]
    }
    environment.update(
        {"APP_FRONTEND_ORIGIN_VAL": f"https://{origin}", "PROJECT_ID": "synthetic-project"}
    )
    built = _run(build_guard + build, env=environment)
    assert built.returncode == 0, built.stderr
    args = capture.read_text().splitlines()
    assert f"NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED={enabled}" in args
    expected_client = client if lane == "dev" and native_result == "configured" else ""
    for name in (
        "NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID",
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID",
    ):
        assert f"{name}={expected_client}" in args
    assert client not in built.stdout + built.stderr


@pytest.mark.parametrize(
    ("skip_build", "image_reference", "expected_code", "expected_message"),
    [
        ("true", "gcr.io/hushh-pda-uat/hushh-webapp@" + DIGEST, 0, "Using prebuilt"),
        ("true", "", 1, "requires an immutable _IMAGE_REFERENCE digest"),
        ("true", "gcr.io/hushh-pda-uat/hushh-webapp:latest", 1, "requires an immutable"),
        ("maybe", "gcr.io/hushh-pda-uat/hushh-webapp@" + DIGEST, 1, "must be true or false"),
    ],
)
def test_prebuilt_mode_has_no_build(
    skip_build: str, image_reference: str, expected_code: int, expected_message: str
) -> None:
    script = _body(_steps(FRONTEND_BUILD)["build-frontend-image"])
    script = script.replace("${_SKIP_IMAGE_BUILD}", skip_build)
    script = script.replace("${_IMAGE_REFERENCE}", image_reference)
    guards = (
        "docker() { echo UNEXPECTED_BUILD_COMMAND >&2; return 95; }; "
        "gcloud() { echo UNEXPECTED_CLOUD_COMMAND >&2; return 96; };\n"
    )
    result = _run(guards + script)
    output = result.stdout + result.stderr
    assert result.returncode == expected_code, output
    assert expected_message in output
    assert "UNEXPECTED_" not in output


def _run_deploy_step(tmp_path: Path, overrides: dict[str, str]):
    config = yaml.safe_load(FRONTEND_BUILD.read_text(encoding="utf-8"))
    values = {name: str(value) for name, value in config["substitutions"].items()}
    values.update(overrides)
    script = _substitute(_body(_steps(FRONTEND_BUILD)["deploy-frontend"]), values)
    capture = tmp_path / "gcloud-run-deploy.txt"
    guards = (
        "gcloud() { "
        'if [ "$1 $2" = "secrets describe" ]; then return 1; fi; '
        f'if [ "$1 $2" = "run deploy" ]; then printf "%s\\n" "$@" > "{capture}"; return 0; fi; '
        "echo UNEXPECTED_CLOUD_COMMAND >&2; return 95; };\n"
    )
    result = _run(guards + script, env={"PROJECT_ID": "hushh-pda-uat"})
    args = capture.read_text().splitlines() if capture.exists() else []
    return result, args


def test_prebuilt_mode_deploys_exactly_the_pinned_digest(tmp_path: Path) -> None:
    reference = "gcr.io/hushh-pda-uat/hushh-webapp@" + DIGEST
    result, args = _run_deploy_step(
        tmp_path,
        {"_SKIP_IMAGE_BUILD": "true", "_IMAGE_REFERENCE": reference, "_IMAGE_TAG": "uat-x"},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"--image={reference}" in args
    assert not any("hushh-webapp:" in arg for arg in args)
    assert "--no-traffic" not in args  # default substitution keeps traffic flag off


def test_prebuilt_mode_refuses_a_mutable_reference(tmp_path: Path) -> None:
    result, args = _run_deploy_step(
        tmp_path,
        {
            "_SKIP_IMAGE_BUILD": "true",
            "_IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/hushh-webapp:uat-x",
        },
    )
    assert result.returncode == 1
    assert "requires an immutable sha256 image digest" in result.stderr
    assert args == []


def test_combined_mode_still_deploys_the_tag_it_built(tmp_path: Path) -> None:
    result, args = _run_deploy_step(tmp_path, {"_IMAGE_TAG": "uat-abc"})
    assert result.returncode == 0, result.stdout + result.stderr
    assert "--image=gcr.io/hushh-pda-uat/hushh-webapp:uat-abc" in args


# --- await-prebuilt-image.sh ---------------------------------------------------


def _manifest_index() -> tuple[str, str, str]:
    child = "sha256:" + "c" * 64
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": "sha256:" + "b" * 64,
                    "size": 10,
                    "platform": {"os": "unknown", "architecture": "unknown"},
                    "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": child,
                    "size": 10,
                    "platform": {"os": "linux", "architecture": "amd64"},
                },
            ],
        }
    )
    return manifest, "sha256:" + hashlib.sha256(manifest.encode()).hexdigest(), child


def _await(tmp_path: Path, statuses: list[str], build_id: str = BUILD_ID):
    manifest, index_digest, child = _manifest_index()
    repository = "gcr.io/hushh-pda-uat/hushh-webapp"
    status_file = tmp_path / "statuses"
    status_file.write_text("\n".join(statuses) + "\n")
    guards = (
        'gcloud() { case "$1 $2" in '
        "'builds log') echo streamed-log ;; "
        f"'builds describe') head -n 1 '{status_file}'; "
        f"if [ \"$(wc -l < '{status_file}')\" -gt 1 ]; then sed -i.bak 1d '{status_file}'; fi ;; "
        f"'container images') printf '%s' '{index_digest}' ;; "
        "'auth configure-docker') return 0 ;; "
        "*) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;; esac; };\n"
        "docker() { "
        f"if [[ \"$*\" != *'{repository}@{index_digest}'* ]]; then "
        "echo UNEXPECTED_MUTABLE_LOOKUP >&2; return 96; fi; "
        f"printf '%s' '{manifest}'; }};\n"
        f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
        "export -f gcloud docker python3;\n"
    )
    command = (
        f"bash '{AWAIT_SCRIPT}' --project hushh-pda-uat --build-id '{build_id}' "
        f"--image-repository {repository} --image-tag uat-{'f' * 40} --sha {'f' * 40} "
        f"--manifest-json '{tmp_path / 'manifest.json'}' "
        f"--json-output '{tmp_path / 'image.json'}' --poll-seconds 0"
    )
    return _run(guards + command), f"{repository}@{child}"


def test_await_pins_the_executable_digest_after_success(tmp_path: Path) -> None:
    result, expected = _await(tmp_path, ["WORKING", "WORKING", "SUCCESS"])
    assert "UNEXPECTED_" not in result.stdout + result.stderr
    assert result.returncode == 0, result.stderr
    # stdout is exactly the pinned reference; the build log went to stderr.
    assert result.stdout.strip() == expected
    assert "streamed-log" in result.stderr
    assert json.loads((tmp_path / "image.json").read_text())["image_reference"] == expected


@pytest.mark.parametrize("terminal", ["FAILURE", "CANCELLED", "TIMEOUT", "INTERNAL_ERROR", ""])
def test_await_fails_closed_on_any_non_success(tmp_path: Path, terminal: str) -> None:
    result, _ = _await(tmp_path, ["QUEUED", terminal])
    assert result.returncode == 1
    assert result.stdout.strip() == ""
    assert "not SUCCESS" in result.stderr


def test_await_rejects_a_value_that_is_not_a_build_id(tmp_path: Path) -> None:
    result, _ = _await(tmp_path, ["SUCCESS"], build_id="$(touch pwned)")
    assert result.returncode == 2
    assert result.stdout.strip() == ""
    assert not (ROOT / "pwned").exists()


# --- Deploy lanes --------------------------------------------------------------


def _workflow_steps(lane: str) -> list[dict]:
    path, _ = LANES[lane]
    workflow = yaml.safe_load((ROOT / path).read_text(encoding="utf-8"))
    return workflow["jobs"]["deploy"]["steps"]


def _lane_step(lane: str, name: str) -> dict:
    for step in _workflow_steps(lane):
        if step.get("name") == name:
            return step
    raise AssertionError(f"{lane}: missing step {name}")


@pytest.mark.parametrize("lane", sorted(LANES))
def test_lane_overlaps_the_web_build_and_keeps_the_deploy_position(lane: str) -> None:
    names = [str(step.get("name") or "") for step in _workflow_steps(lane)]
    order = [
        "Sync canonical hosted runtime secrets",
        "Start frontend image build in parallel",
        "Build and pin backend image before lifecycle migration",
        "Deploy backend using Cloud Build",
        "Wait for frontend image and pin its digest",
        "Deploy frontend using Cloud Build",
        "Resolve deployed candidate revisions",
    ]
    positions = [names.index(name) for name in order]
    assert positions == sorted(positions), lane
    # The wait sits immediately before the deploy it feeds.
    assert names.index("Deploy frontend using Cloud Build") == (
        names.index("Wait for frontend image and pin its digest") + 1
    )

    start = _lane_step(lane, "Start frontend image build in parallel")
    assert start["id"] == "start-frontend-image-build"
    assert start["if"] == "steps.scope.outputs.deploy_frontend == 'true'"
    assert "--async" in start["run"]
    assert "--config=deploy/frontend-image.cloudbuild.yaml" in start["run"]

    wait = _lane_step(lane, "Wait for frontend image and pin its digest")
    assert wait["id"] == "build-frontend-image"
    assert "steps.start-frontend-image-build.outputs.prebuilt == 'true'" in wait["if"]
    assert "scripts/ci/await-prebuilt-image.sh" in wait["run"]
    assert "hushh-webapp@sha256:[0-9a-f]{64}$" in wait["run"]

    deploy = _lane_step(lane, "Deploy frontend using Cloud Build")
    assert deploy["id"] == "deploy-frontend"
    assert deploy["env"]["FRONTEND_IMAGE_REFERENCE"] == (
        "${{ steps.build-frontend-image.outputs.image_reference }}"
    )


@pytest.mark.parametrize("lane", sorted(LANES))
def test_backend_only_scope_builds_no_web_image(lane: str) -> None:
    for name in (
        "Start frontend image build in parallel",
        "Wait for frontend image and pin its digest",
        "Deploy frontend using Cloud Build",
    ):
        assert "steps.scope.outputs.deploy_frontend == 'true'" in _lane_step(lane, name)["if"]


def _deploy_script(lane: str, tmp_path: Path) -> tuple[str, Path]:
    _, project = LANES[lane]
    run = str(_lane_step(lane, "Deploy frontend using Cloud Build")["run"])
    run = run.replace("${{ env.GCP_PROJECT_ID }}", project)
    run = re.sub(r"\$\{\{[^}]*\}\}", "fixture", run)
    assert "${{" not in run
    capture = tmp_path / "gcloud.txt"
    guards = (
        f"export GITHUB_OUTPUT='{tmp_path / 'github-output'}';\n"
        "gcloud() { "
        f'if [ "$1 $2" = "builds submit" ]; then printf "%s\\n" "$@" > "{capture}"; return 0; fi; '
        "echo UNEXPECTED_CLOUD_COMMAND >&2; return 95; };\n"
    )
    return guards + run, capture


BUILD_SUBS = "_APP_ENV=x,_DEPLOY_ENV=x,_IMAGE_TAG=t"


@pytest.mark.parametrize("lane", sorted(LANES))
@pytest.mark.parametrize(
    "reference",
    [
        "",
        "gcr.io/{project}/hushh-webapp:latest",
        "gcr.io/{project}/hushh-webapp@sha256:" + "a" * 63,
        "gcr.io/some-other-project/hushh-webapp@" + DIGEST,
        "gcr.io/{project}/hushh-webapp@" + DIGEST + ",_DEPLOY_SHA=forged",
    ],
)
def test_deploy_refuses_a_missing_or_malformed_digest(
    lane: str, reference: str, tmp_path: Path
) -> None:
    script, capture = _deploy_script(lane, tmp_path)
    result = _run(
        script,
        env={
            "FRONTEND_PREBUILT": "true",
            "FRONTEND_IMAGE_REFERENCE": reference.format(project=LANES[lane][1]),
            "FRONTEND_BUILD_SUBSTITUTIONS": BUILD_SUBS,
        },
    )
    assert result.returncode == 1
    assert "missing or malformed" in result.stderr
    assert not capture.exists(), "nothing may be submitted without a valid digest"


@pytest.mark.parametrize("lane", sorted(LANES))
def test_deploy_submits_the_pinned_digest_without_source(lane: str, tmp_path: Path) -> None:
    project = LANES[lane][1]
    reference = f"gcr.io/{project}/hushh-webapp@{DIGEST}"
    script, capture = _deploy_script(lane, tmp_path)
    result = _run(
        script,
        env={
            "FRONTEND_PREBUILT": "true",
            "FRONTEND_IMAGE_REFERENCE": reference,
            "FRONTEND_BUILD_SUBSTITUTIONS": BUILD_SUBS,
        },
    )
    assert "UNEXPECTED_" not in result.stdout + result.stderr
    assert result.returncode == 0, result.stderr
    args = capture.read_text().splitlines()
    assert args[2] == "--no-source"
    assert "--config=deploy/frontend.cloudbuild.yaml" in args
    substitutions = next(arg for arg in args if arg.startswith("--substitutions="))
    assert f",_SKIP_IMAGE_BUILD=true,_IMAGE_REFERENCE={reference}" in substitutions
    assert f",{BUILD_SUBS}," in substitutions


@pytest.mark.parametrize("lane", sorted(LANES))
def test_deploy_keeps_the_combined_path_for_a_sha_before_the_split(
    lane: str, tmp_path: Path
) -> None:
    script, capture = _deploy_script(lane, tmp_path)
    result = _run(
        script,
        env={
            "FRONTEND_PREBUILT": "false",
            "FRONTEND_IMAGE_REFERENCE": "",
            "FRONTEND_BUILD_SUBSTITUTIONS": BUILD_SUBS,
        },
    )
    assert result.returncode == 0, result.stderr
    args = capture.read_text().splitlines()
    assert args[2] == "."
    substitutions = next(arg for arg in args if arg.startswith("--substitutions="))
    assert "_SKIP_IMAGE_BUILD" not in substitutions
    assert substitutions.endswith(BUILD_SUBS)


@pytest.mark.parametrize("lane", sorted(LANES))
@pytest.mark.parametrize("prebuilt", ["", "TRUE", "yes"])
def test_deploy_refuses_an_unresolved_mode(lane: str, prebuilt: str, tmp_path: Path) -> None:
    script, capture = _deploy_script(lane, tmp_path)
    result = _run(
        script,
        env={
            "FRONTEND_PREBUILT": prebuilt,
            "FRONTEND_IMAGE_REFERENCE": "",
            "FRONTEND_BUILD_SUBSTITUTIONS": BUILD_SUBS,
        },
    )
    assert result.returncode == 1
    assert not capture.exists()


@pytest.mark.parametrize("lane", sorted(LANES))
def test_web_build_values_are_defined_once_per_lane(lane: str) -> None:
    start = str(_lane_step(lane, "Start frontend image build in parallel")["run"])
    deploy = str(_lane_step(lane, "Deploy frontend using Cloud Build")["run"])
    for name in ("_APP_ENV=", "_DEPLOY_ENV=", "_IMAGE_TAG="):
        assert name in start
        assert name not in deploy, f"{lane}: {name} must come from the start step only"
    for name in (
        "_ONE_WALLET_CARD_ENABLED=",
        "_ONE_LOCATION_NEARBY_CHECK_IN=",
        "_LOCATION_MAP_DEMO=",
    ):
        assert name not in deploy, f"{lane}: {name} must come from the start step only"
    assert "_LOCATION_MAP_DEMO=true" not in start


def test_uat_and_production_verify_the_candidate_runs_the_pinned_digest() -> None:
    for lane in ("uat", "production"):
        names = [str(step.get("name") or "") for step in _workflow_steps(lane)]
        verify = "Verify frontend candidate runs the pinned image digest"
        assert names.index("Resolve deployed candidate revisions") < names.index(verify)
        promote = next(name for name in names if name.startswith("Promote deployed revisions"))
        assert names.index(verify) < names.index(promote)
        run = str(_lane_step(lane, verify)["run"])
        assert "spec.containers[0].image" in run
        assert '"${deployed_image}" != "${EXPECTED_IMAGE_REFERENCE}"' in run
