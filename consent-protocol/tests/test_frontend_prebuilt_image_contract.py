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
    assert (
        "!scripts/deploy/resolve-google-sign-in-client.sh"
        in (ROOT / ".gcloudignore").read_text().splitlines()
    )
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


@pytest.mark.parametrize(
    "environment,prefix", [("dev", "dev.one"), ("uat", "uat.one"), ("production", "one")]
)
@pytest.mark.parametrize("domain", ["hushh.ai", "hussh.ai", "hussh.si"])
def test_image_build_accepts_only_registered_environment_origins(environment, prefix, domain):
    step = _body(_steps(FRONTEND_IMAGE_BUILD)["resolve-google-contacts-client-config"])
    # Run the actual catalog guard without cloud calls or writes to /workspace.
    guard = step[step.index('python3 - "${_DEPLOY_ENV}"') : step.index("\nPY_RP") + len("\nPY_RP")]
    guard = guard.replace("${_DEPLOY_ENV}", environment).replace("$$", "$")
    hostname = f"{prefix}.{domain}"
    allowed = _run(
        "set -e\n" + guard + '\nprintf "%s" "$PASSKEY_RP_ID_VAL"',
        env={"PASSKEY_RP_ID_VAL": hostname},
    )
    assert allowed.returncode == 0, allowed.stderr
    assert allowed.stdout == hostname  # Validation must not change an existing RP.
    foreign_prefix = "one" if environment != "production" else "uat.one"
    for hostname in (f"{foreign_prefix}.{domain}", f"evil.{prefix}.{domain}"):
        refused = _run(guard, env={"PASSKEY_RP_ID_VAL": hostname})
        assert refused.returncode != 0
        assert "does not match the deployment environment" in refused.stderr


@pytest.mark.parametrize("mutation", [None, "missing_legacy", "cross_environment"])
def test_runtime_domain_guard_checks_the_catalog_not_removed_shell_branches(tmp_path, mutation):
    script = (ROOT / "scripts/ci/runtime-contract-check.sh").read_text()
    guard = script.split("<<'PY_LEGACY_RP'\n", 1)[1].split("\nPY_LEGACY_RP", 1)[0]
    aliases = json.loads((ROOT / "hushh-webapp/lib/vault/passkey-domain-aliases.json").read_text())
    if mutation == "missing_legacy":
        aliases["production"].remove("one.hushh.ai")
    elif mutation == "cross_environment":
        aliases["uat"].append("one.hushh.ai")
    catalog = tmp_path / "aliases.json"
    catalog.write_text(json.dumps(aliases))
    result = subprocess.run(  # noqa: S603 - actual repo guard, synthetic catalog
        [sys.executable, "-c", guard, str(catalog)],
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )
    assert (result.returncode == 0) == (mutation is None), result.stderr


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_prebuilt_config_resolution_does_not_require_uploaded_source(tmp_path, environment):
    config = yaml.safe_load(FRONTEND_BUILD.read_text())
    values = {name: str(value) for name, value in config["substitutions"].items()}
    values["_SKIP_IMAGE_BUILD"] = "true"
    values["_DEPLOY_ENV"] = environment
    script = _substitute(
        _body(_steps(FRONTEND_BUILD)["resolve-google-contacts-client-config"]), values
    )
    script = script.replace("$$", "$").replace("/workspace/", str(tmp_path) + "/")
    guards = 'gcloud() { printf "%s" "synthetic.apps.googleusercontent.com"; };\n'
    result = _run(
        guards + script,
        env={
            "APP_FRONTEND_ORIGIN_VAL": f"https://{environment}.one.hussh.si",
            "PROJECT_ID": "synthetic-project",
        },
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / ".receipt-logo-url-template").read_text() == ""
    assert (tmp_path / ".google-sign-in-client-id").read_text() == ""


@pytest.mark.parametrize(
    "status,expected_code",
    [("present", 0), ("missing", 0), ("denied", 1), ("invalid", 1), ("empty", 1)],
)
def test_optional_google_sign_in_client_build_boundary(tmp_path, status, expected_code):
    client_id = "123456789-synthetic.apps.googleusercontent.com"
    config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text())
    values = {name: str(value) for name, value in config["substitutions"].items()}
    values["_DEPLOY_ENV"] = "uat"
    script = (
        _substitute(
            _body(_steps(FRONTEND_IMAGE_BUILD)["resolve-google-contacts-client-config"]), values
        )
        .replace("$$", "$")
        .replace("/workspace/", str(tmp_path) + "/")
    )
    guards = """gcloud() {
      case "$*" in
        *--secret=NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID*|*--secret=NEXT_PUBLIC_GTM_ID*)
          printf '%s' 'synthetic' ;;
        *--secret=NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID*)
          printf '%s' 'synthetic.apps.googleusercontent.com' ;;
        *--secret=NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID*)
          case "$TEST_SIGN_IN_STATUS" in
            present) printf '%s\\r\\n' "$TEST_SIGN_IN_CLIENT" ;;
            missing) echo 'NOT_FOUND: synthetic absence' >&2; return 1 ;;
            denied) echo 'PERMISSION_DENIED: synthetic-private-payload' >&2; return 1 ;;
            invalid) printf '%s' 'synthetic-private-payload' ;;
            empty) return 0 ;;
          esac ;;
        *--secret=NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE*)
          echo 'NOT_FOUND: synthetic absence' >&2; return 1 ;;
        *) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;;
      esac
    };
    export -f gcloud;
"""
    guards += f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
    result = _run(
        guards + script,
        env={
            "APP_FRONTEND_ORIGIN_VAL": "https://uat.one.hussh.ai",
            "PROJECT_ID": "synthetic-project",
            "TEST_SIGN_IN_STATUS": status,
            "TEST_SIGN_IN_CLIENT": client_id,
        },
    )
    output = result.stdout + result.stderr
    assert result.returncode == expected_code, output
    assert client_id not in output
    assert "synthetic-private-payload" not in output
    assert "UNEXPECTED_" not in output
    expected = client_id if status == "present" else ""
    artifact = tmp_path / ".google-sign-in-client-id"
    assert artifact.read_text() == expected
    if expected_code:
        assert "Google sign-in OAuth client configuration" in output
        return

    build = _substitute(_body(_steps(FRONTEND_IMAGE_BUILD)["build-frontend-image"]), values)
    build = build.replace("$$", "$").replace("/workspace/", str(tmp_path) + "/")
    capture = tmp_path / "google-sign-in-docker-args.txt"
    build_guards = (
        "gcloud() { return 0; };\n"
        "docker() { "
        f'if [ "$1 $2" = "buildx build" ]; then printf "%s\\n" "$@" > "{capture}"; fi; '
        "return 0; };\n"
    )
    build_env = {
        name: "synthetic"
        for name in _steps(FRONTEND_IMAGE_BUILD)["build-frontend-image"]["secretEnv"]
    }
    build_env["PROJECT_ID"] = "synthetic-project"
    built = _run(build_guards + build, env=build_env)
    assert built.returncode == 0, built.stdout + built.stderr
    assert f"NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID={expected}" in capture.read_text().splitlines()
    assert client_id not in built.stdout + built.stderr
    assert not artifact.exists()
    dockerfile = (ROOT / "hushh-webapp" / "Dockerfile").read_text()
    assert "ARG NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID\n" in dockerfile
    assert (
        "ENV NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID\n"
        in dockerfile
    )


@pytest.mark.parametrize(
    "environment,receipt_status,key_prefix,suffix,expected_code",
    [
        ("uat", "present", "pk_", "&fallback=404&redirect=404", 0),
        ("uat", "missing", "pk_", "&fallback=404&redirect=404", 0),
        ("uat", "denied", "pk_", "&fallback=404&redirect=404", 1),
        ("uat", "present", "sk_", "&fallback=404&redirect=404", 1),
        ("uat", "present", "pk_", "&fallback=monogram&redirect=404", 1),
        ("uat", "present", "pk_", "&fallback=404", 1),
        ("production", "denied", "pk_", "&fallback=404&redirect=404", 0),
        ("dev", "denied", "pk_", "&fallback=404&redirect=404", 0),
    ],
)
def test_receipt_logo_build_boundary(
    tmp_path, environment, receipt_status, key_prefix, suffix, expected_code
):
    # Synthetic credentials only. No provider or deployment is contacted.
    template = "https://img.logo.dev/{domain}?token=" + key_prefix + "x" * 32 + suffix
    config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text())
    values = {name: str(value) for name, value in config["substitutions"].items()}
    values["_DEPLOY_ENV"] = environment
    script = (
        _substitute(
            _body(_steps(FRONTEND_IMAGE_BUILD)["resolve-google-contacts-client-config"]), values
        )
        .replace("$$", "$")
        .replace("/workspace/", str(tmp_path) + "/")
    )
    guards = """gcloud() {
      case "$*" in
        *--secret=NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID*|*--secret=NEXT_PUBLIC_GTM_ID*)
          printf '%s' 'synthetic' ;;
        *--secret=NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID*)
          printf '%s' 'synthetic.apps.googleusercontent.com' ;;
        *--secret=NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID*|\
        *--secret=NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID*|\
        *--secret=NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI*|\
        *--secret=NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED*|\
        *--secret=NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID*)
          echo 'NOT_FOUND: synthetic absence' >&2; return 1 ;;
        *--secret=NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE*)
          case "$TEST_RECEIPT_STATUS" in
            present) printf '%s' "$TEST_RECEIPT_TEMPLATE" ;;
            missing) echo 'NOT_FOUND: synthetic absence' >&2; return 1 ;;
            denied) echo "PERMISSION_DENIED: $TEST_RECEIPT_TEMPLATE" >&2; return 1 ;;
          esac ;;
        *) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;;
      esac
    };
    export -f gcloud;
"""
    guards += f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
    origin = "one.hussh.si" if environment == "production" else f"{environment}.one.hussh.si"
    result = _run(
        guards + script,
        env={
            "APP_FRONTEND_ORIGIN_VAL": "https://" + origin,
            "PROJECT_ID": "synthetic-project",
            "TEST_RECEIPT_STATUS": receipt_status,
            "TEST_RECEIPT_TEMPLATE": template,
        },
    )
    output = result.stdout + result.stderr
    assert result.returncode == expected_code, output
    assert template not in output
    assert key_prefix + "x" * 32 not in output
    assert "UNEXPECTED_" not in output
    if expected_code:
        assert "receipt-logo" in output
        return

    expected = template if environment == "uat" and receipt_status == "present" else ""
    artifact = tmp_path / ".receipt-logo-url-template"
    assert artifact.read_text() == expected
    assert artifact.stat().st_mode & 0o777 == 0o600

    _verify_receipt_logo_image_build(tmp_path, values, template, expected, artifact)
    _verify_receipt_logo_run(expected)


def _verify_receipt_logo_image_build(tmp_path, values, template, expected, artifact) -> None:
    # Execute the real Docker step, capture arguments without running Docker,
    # and prove query separators/braces survive as one build argument.
    build = _substitute(_body(_steps(FRONTEND_IMAGE_BUILD)["build-frontend-image"]), values)
    build = build.replace("$$", "$").replace("/workspace/", str(tmp_path) + "/")
    capture = tmp_path / "docker-args.txt"
    build_guards = (
        "gcloud() { return 0; };\n"
        "docker() { "
        f'if [ "$1 $2" = "buildx build" ]; then printf "%s\\n" "$@" > "{capture}"; fi; '
        "return 0; };\n"
    )
    build_env = {
        name: "synthetic"
        for name in _steps(FRONTEND_IMAGE_BUILD)["build-frontend-image"]["secretEnv"]
    }
    build_env["PROJECT_ID"] = "synthetic-project"
    built = _run(build_guards + build, env=build_env)
    assert built.returncode == 0, built.stdout + built.stderr
    assert f"NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE={expected}" in capture.read_text().splitlines()
    assert template not in built.stdout + built.stderr
    assert not artifact.exists()


def _verify_receipt_logo_run(expected: str) -> None:
    """Execute Docker's build shell while keeping a blank logo truly unset."""
    dockerfile = (ROOT / "hushh-webapp" / "Dockerfile").read_text()
    assert "ARG NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE\n" in dockerfile
    run = re.search(r"^RUN if .*?npm run build$", dockerfile, re.MULTILINE | re.DOTALL)
    assert run is not None
    npm_guards = (
        "npm() { "
        'if [ "$1 $2" != "run build" ]; then return 95; fi; '
        'if [ -n "$TEST_EXPECTED_TEMPLATE" ]; then '
        '[ "$NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE" = "$TEST_EXPECTED_TEMPLATE" ]; '
        'else [ "${NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE+x}" != x ]; fi; };\n'
    )
    next_build = _run(
        npm_guards + run.group(0).removeprefix("RUN "),
        env={"NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE": expected, "TEST_EXPECTED_TEMPLATE": expected},
    )
    assert next_build.returncode == 0, next_build.stdout + next_build.stderr


def test_image_build_config_never_deploys() -> None:
    config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text(encoding="utf-8"))
    bodies = [_body(step) for step in config["steps"]]
    assert not any("gcloud run" in body for body in bodies)
    assert not any("${_SKIP_IMAGE_BUILD}" in body for body in bodies)
    assert "_SKIP_IMAGE_BUILD" not in config["substitutions"]
    assert "--push" in bodies[-1]


def _native_secret_guard(trace: Path, client: str, cases: list[str]) -> str:
    return (
        "gcloud() { local secret=''; for arg in \"$@\"; do "
        'case "$arg" in --secret=*) secret="${arg#--secret=}" ;; esac; done; '
        f'printf "%s\\n" "$secret" >> {shlex.quote(str(trace))}; '
        'case "$secret" in '
        f"NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID) printf '%s' {shlex.quote(client)} ;; "
        + "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID|NEXT_PUBLIC_GTM_ID) printf synthetic ;; "
        + "NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID|NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE) echo 'NOT_FOUND: synthetic absence' >&2; return 1 ;; "
        + " ".join(cases)
        + " *) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;; esac; };\nexport -f gcloud;\n"
    )


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
    guard = _native_secret_guard(trace, client, cases)
    resolver = _substitute(
        _body(_steps(FRONTEND_IMAGE_BUILD)["resolve-google-contacts-client-config"]), values
    )
    resolver = resolver.replace("$$", "$").replace("/workspace", str(tmp_path))
    dev_workflow = yaml.safe_load((ROOT / LANES["dev"][0]).read_text(encoding="utf-8"))
    origin = {
        "dev": dev_workflow["env"]["APP_FRONTEND_ORIGIN"],
        "uat": "https://uat.one.hushh.ai",
        "production": "https://one.hushh.ai",
    }[lane]
    result = _run(
        guard + resolver,
        env={"APP_FRONTEND_ORIGIN_VAL": origin, "PROJECT_ID": "synthetic-project"},
    )
    assert result.returncode == expected_code, result.stderr
    assert client not in result.stdout + result.stderr
    assert "UNEXPECTED_CLOUD_COMMAND" not in result.stdout + result.stderr
    requested = [
        name
        for name in trace.read_text().splitlines()
        if name not in {"NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "NEXT_PUBLIC_GTM_ID"}
    ]
    if lane != "dev":
        expected_requests = [
            "NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID",
            "NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID",
        ]
        if lane == "uat":
            expected_requests.append("NEXT_PUBLIC_RECEIPT_LOGO_URL_TEMPLATE")
        assert requested == expected_requests
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
    environment.update({"APP_FRONTEND_ORIGIN_VAL": origin, "PROJECT_ID": "synthetic-project"})
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


def test_frontend_resolver_rejects_wrong_environment_origin_before_secret_reads(
    tmp_path: Path,
) -> None:
    config = yaml.safe_load(FRONTEND_IMAGE_BUILD.read_text(encoding="utf-8"))
    values = {name: str(value) for name, value in config["substitutions"].items()}
    values.update({"_DEPLOY_ENV": "dev", "_APP_ENV": "dev"})
    resolver = (
        _substitute(
            _body(_steps(FRONTEND_IMAGE_BUILD)["resolve-google-contacts-client-config"]), values
        )
        .replace("$$", "$")
        .replace("/workspace", str(tmp_path))
    )
    result = _run(
        "gcloud() { echo UNEXPECTED_CLOUD_COMMAND >&2; return 1; };\n" + resolver,
        env={
            "APP_FRONTEND_ORIGIN_VAL": "https://uat.one.hussh.si",
            "PROJECT_ID": "synthetic-project",
        },
    )
    assert result.returncode == 1
    assert "APP_FRONTEND_ORIGIN host does not match the deployment environment" in result.stderr
    assert "UNEXPECTED_CLOUD_COMMAND" not in result.stdout + result.stderr


def _native_runtime_profile_fixture(tmp_path: Path, pins: dict[str, str]) -> Path:
    """Copy the real shape verifier and templates; configure only synthetic pins."""
    verifier = tmp_path / "scripts" / "ops" / "verify-runtime-profile-env-shape.py"
    verifier.parent.mkdir(parents=True)
    shutil.copyfile(ROOT / "scripts" / "ops" / verifier.name, verifier)
    backend = tmp_path / "consent-protocol"
    backend.mkdir()
    for filename in (".env.example", ".env"):
        shutil.copyfile(ROOT / "consent-protocol" / ".env.example", backend / filename)
    frontend = tmp_path / "hushh-webapp"
    frontend.mkdir()
    for profile in ("local", "uat", "dev", "prod"):
        filename = f".env.{profile}.local"
        template = ROOT / "hushh-webapp" / f"{filename}.example"
        shutil.copyfile(template, frontend / template.name)
        lines = [
            line
            for line in template.read_text(encoding="utf-8").splitlines()
            if line.partition("=")[0] not in pins
        ]
        lines.extend(f"{name}={value}" for name, value in pins.items())
        (frontend / filename).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return verifier


@pytest.mark.parametrize("unexpected_key", [False, True])
def test_native_configured_runtime_profiles_preserve_strict_env_shape(
    tmp_path: Path, unexpected_key: bool
) -> None:
    client = "123456789012-synthetic.apps.googleusercontent.com"
    pins = {
        "NEXT_PUBLIC_GOOGLE_IOS_CONNECTOR_CLIENT_ID": client,
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_CLIENT_ID": client,
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_REDIRECT_URI": "com.hussh.app:/oauth2redirect",
        "NEXT_PUBLIC_GOOGLE_ANDROID_CONNECTOR_DEV_ENABLED": "true",
    }
    verifier = _native_runtime_profile_fixture(tmp_path, pins)
    if unexpected_key:
        runtime = tmp_path / "hushh-webapp" / ".env.dev.local"
        runtime.write_text(
            runtime.read_text(encoding="utf-8")
            + "NEXT_PUBLIC_UNRECOGNIZED_CONNECTOR_PIN=synthetic\n",
            encoding="utf-8",
        )
    result = subprocess.run(  # noqa: S603 - real repo verifier, synthetic fixtures only
        [sys.executable, str(verifier), "--include-runtime"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == int(unexpected_key), result.stderr
    assert client not in result.stdout + result.stderr
    if unexpected_key:
        assert result.stderr.splitlines() == [
            "Runtime profile env shape check failed:",
            "- hushh-webapp/.env.dev.local: unexpected extra keys NEXT_PUBLIC_UNRECOGNIZED_CONNECTOR_PIN",
        ]
    else:
        assert result.stdout.strip() == "Runtime profile env shape check passed."


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
    if lane == "production":
        assert ",_CLOUD_RUN_TIMEOUT_SECONDS=300," in substitutions


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


@pytest.mark.parametrize(
    "configured,expected",
    [
        ({}, {"python": "https://api.example.com", "developer": "https://api.example.com"}),
        (
            {"BACKEND_URL": "https://shared.example.com"},
            {"python": "https://shared.example.com", "developer": "https://shared.example.com"},
        ),
        (
            {
                "BACKEND_URL": "https://shared.example.com",
                "PYTHON_API_URL": "https://python.example.com",
                "DEVELOPER_API_URL": "https://developer.example.com",
            },
            {"python": "https://python.example.com", "developer": "https://developer.example.com"},
        ),
    ],
)
def test_web_ci_build_binds_explicit_server_origins(configured, expected) -> None:
    # Exercise the real CI adapter without building or contacting a backend.
    # Public client configuration must never become server routing authority.
    script = """
source scripts/ci/web-common.sh
npm() {
  python3 -c 'import json,os; print(json.dumps({"python":os.environ.get("PYTHON_API_URL"),"developer":os.environ.get("DEVELOPER_API_URL")}))'
}
web_ci_build
"""
    result = _run(
        script,
        env={
            "PYTHON_API_URL": "",
            "DEVELOPER_API_URL": "",
            "BACKEND_URL": "",
            "NEXT_PUBLIC_BACKEND_URL": "https://client-only.example.com",
            "NEXT_PUBLIC_DEVELOPER_API_URL": "https://client-only.example.com",
            **configured,
        },
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == expected
