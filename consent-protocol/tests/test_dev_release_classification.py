"""Execute the deploy classifier against semantic failure receipts."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    ("failure", "backend", "frontend", "blocked"),
    [
        ("location_command_recovery", True, False, True),
        ("frontend_login", False, True, True),
        ("calendar_secret", True, False, True),
        ("calendar_runtime", True, False, True),
        ("signed_in_routes:/one", False, False, False),
        ("preview_app", True, True, True),
        ("preview_mounts", True, True, True),
    ],
)
def test_semantic_failure_selects_rollback(
    tmp_path, monkeypatch, failure, backend, frontend, blocked
):
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load(
        (root / ".github/workflows/deploy-dev-implementation.yml").read_text()
    )
    step = next(
        step
        for job in workflow["jobs"].values()
        for step in job.get("steps", [])
        if step.get("id") == "classify-dev-release"
    )
    source = step["run"].split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    # Keep the actual classifier intact; redirect its artifact directory only.
    source = source.replace("/tmp/", str(tmp_path) + "/")  # noqa: S108 - redirects to pytest isolation
    (tmp_path / "dev-release-verify-attempt-2.json").write_text(
        json.dumps({"status": "blocked", "failures": [failure]})
    )
    for key, value in {
        "DEPLOY_BACKEND": "true",
        "DEPLOY_FRONTEND": "true",
        "PARITY_ATTEMPT_1": "success",
        "PARITY_ATTEMPT_2": "skipped",
        "BACKEND_PROVENANCE_OUTCOME": "success",
        "FRONTEND_PROVENANCE_OUTCOME": "success",
        "DB_OUTCOME": "success",
        "SEMANTIC_ATTEMPT_1": "failure",
        "SEMANTIC_ATTEMPT_2": "failure",
        "GITHUB_OUTPUT": str(tmp_path / "outputs"),
    }.items():
        monkeypatch.setenv(key, value)
    if failure.startswith("calendar_"):
        parity = {"classifications": ["runtime_mount_missing"]}
        if failure == "calendar_secret":
            parity.update(
                required={"calendar": ["CALENDAR_SECRET"]}, missing_secrets=["CALENDAR_SECRET"]
            )
        else:
            parity["runtime_contract"] = {
                "backend_calendar": [{"key": "CALENDAR_KEY", "status": "missing"}]
            }
        (tmp_path / "dev-runtime-parity-attempt-2.json").write_text(json.dumps(parity))
        monkeypatch.setenv("PARITY_ATTEMPT_1", "failure")
        monkeypatch.setenv("PARITY_ATTEMPT_2", "failure")
        monkeypatch.setenv("SEMANTIC_ATTEMPT_1", "success")
        monkeypatch.setenv("SEMANTIC_ATTEMPT_2", "skipped")
    if failure.startswith("preview_"):
        monkeypatch.setenv("DEV_TARGET", "scope-commerce-sandbox")
        for filename in ("dev-release-verify-attempt-2.json", "dev-runtime-parity-attempt-2.json"):
            (tmp_path / filename).write_text(
                json.dumps(
                    {
                        "status": "failed",
                        "classifications": ["commerce_preview_unverified"],
                        "required": {},
                        "runtime_contract": {},
                    }
                )
            )
        if failure == "preview_mounts":
            monkeypatch.setenv("PARITY_ATTEMPT_1", "failure")
            monkeypatch.setenv("PARITY_ATTEMPT_2", "failure")
            monkeypatch.setenv("SEMANTIC_ATTEMPT_1", "success")
    else:
        monkeypatch.setenv("DEV_TARGET", "shared-dev")
    exec(compile(source, str(root / ".github/workflows/deploy-dev-implementation.yml"), "exec"), {})  # noqa: S102 - trusted repository workflow
    result = json.loads((tmp_path / "dev-release-classification.json").read_text())
    assert result["release_failed"] is blocked
    assert result["backend_failure"] is backend
    assert result["frontend_failure"] is frontend


@pytest.mark.parametrize("semantic", ["success", "failure"])
@pytest.mark.parametrize(
    ("required", "outcome", "blocked"),
    [
        (True, "failure", True),
        (True, "skipped", True),
        (True, "success", False),
        (False, "skipped", False),
    ],
)
def test_selected_owner_navigation_requires_a_successful_receipt(
    tmp_path, monkeypatch, required, outcome, blocked, semantic
):
    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load(
        (root / ".github/workflows/deploy-dev-implementation.yml").read_text()
    )
    step = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("id") == "classify-dev-release"
    )
    source = step["run"].split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    source = source.replace("/tmp/", str(tmp_path) + "/")  # noqa: S108 - redirect to pytest isolation.
    if semantic == "failure":
        (tmp_path / "dev-release-verify-attempt-1.json").write_text(
            json.dumps({"status": "blocked", "failures": ["signed_in_routes:/one"]})
        )
    for key, value in {
        "DEV_TARGET": "shared-dev",
        "DEPLOY_BACKEND": "false",
        "DEPLOY_FRONTEND": "true",
        "PARITY_ATTEMPT_1": "success",
        "PARITY_ATTEMPT_2": "skipped",
        "FRONTEND_PROVENANCE_OUTCOME": "success",
        "DB_OUTCOME": "skipped",
        "SEMANTIC_ATTEMPT_1": semantic,
        "SEMANTIC_ATTEMPT_2": "skipped",
        "REVIEWER_BYOK_REQUIRED": str(required).lower(),
        "REVIEWER_BYOK_OUTCOME": outcome,
        "GITHUB_OUTPUT": str(tmp_path / "outputs"),
    }.items():
        monkeypatch.setenv(key, value)
    exec(compile(source, "dev-classifier", "exec"), {})  # noqa: S102 - authored workflow classifier
    result = json.loads((tmp_path / "dev-release-classification.json").read_text())
    assert result["release_failed"] is blocked
    assert result["frontend_failure"] is blocked
    assert result["backend_failure"] is False
    assert ("reviewer_byok_unverified" in result["blocking_classifications"]) is blocked


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_selected_pkm_gate_runs_without_a_backend_deployment(environment):
    workflow = yaml.safe_load(
        (
            ROOT
            / f".github/workflows/deploy-{environment}{'-implementation' if environment != 'production' else ''}.yml"
        ).read_text()
    )
    steps = workflow["jobs"]["deploy"]["steps"]
    gate = next(step for step in steps if step.get("id") == "verify-pkm-preservation")
    # This is a release-authority wiring contract: frontend-only selection must
    # execute the same preservation gate instead of merely installing its deps.
    assert gate["if"] == "steps.verification-plan.outputs.run_pkm_upgrade_gate == 'true'"
    assert gate.get("continue-on-error", False) is False
    assert gate["run"] == f"bash scripts/ci/run-release-pkm-gate.sh {environment}"
    proxy = next(step for step in steps if step["name"] == "Install Cloud SQL Auth Proxy")
    assert "steps.verification-plan.outputs.run_pkm_upgrade_gate == 'true'" in proxy["if"]
    assert steps.index(gate) < next(
        i for i, step in enumerate(steps) if step.get("id") == "deploy-backend"
    )


@pytest.mark.parametrize(
    ("environment", "project", "gate_exit"),
    [("dev", "hushh-pda-dev", 0), ("uat", "hushh-pda-uat", 73), ("dev", "hushh-pda", None)],
)
def test_release_pkm_gate_owns_its_connection_and_propagates_failure(
    tmp_path, environment, project, gate_exit
):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls"
    proxy_pid_file = tmp_path / "proxy-pid"
    proxy = bin_dir / "cloud-sql-proxy"
    proxy.write_text(
        f"#!{sys.executable}\nimport os,socket,sys,time\nfrom pathlib import Path\n"
        "Path(os.environ['PROXY_PID_FILE']).write_text(str(os.getpid()))\n"
        "port=int(sys.argv[sys.argv.index('--port')+1]);s=socket.socket();s.bind(('127.0.0.1',port));s.listen()\n"
        "while True: time.sleep(1)\n"
    )
    gcloud = bin_dir / "gcloud"
    gcloud.write_text('#!/bin/sh\necho "fixture-credential"\n')
    (bin_dir / "psql").write_text("#!/bin/sh\nexit 0\n")
    (bin_dir / "psql").chmod(0o700)
    proxy.chmod(0o700)
    gcloud.chmod(0o700)
    scripts = tmp_path / "scripts"
    (scripts / "ci").mkdir(parents=True)
    (scripts / "env").mkdir()
    for name in ("bootstrap_profiles.sh", "use_profile.sh"):
        (scripts / "env" / name).write_text("#!/bin/sh\nexit 0\n")
    (scripts / "ci/pkm-upgrade-gate.sh").write_text(
        '#!/bin/sh\nprintf "%s\\n" "$PGHOST:$PGPORT:$PGDATABASE" "$PKM_UPGRADE_PROTECTED_UAT" "$PKM_UPGRADE_RUNTIME_AUDIT_DEFERRED" > "$CALLS_FILE"\n'
        f"exit {gate_exit or 0}\n"
    )
    result = subprocess.run(  # noqa: S603 - repository helper and fixed synthetic environment.
        ["bash", str(ROOT / "scripts/ci/run-release-pkm-gate.sh"), environment],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
        env={
            **os.environ,
            "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
            "PROTOCOL_PYTHON": sys.executable,
            "GCP_PROJECT_ID": project,
            "CALLS_FILE": str(calls),
            "PROXY_PID_FILE": str(proxy_pid_file),
            "RUNNER_TEMP": str(tmp_path),
        },
    )
    if gate_exit is None:
        assert result.returncode == 1 and "project mismatch" in result.stderr
        assert not calls.exists() and not proxy_pid_file.exists()
    else:
        assert result.returncode == gate_exit, result.stderr
        address, protected, deferred = calls.read_text().splitlines()
        host, port, database = address.split(":")
        assert (host, database, protected, deferred) == ("127.0.0.1", "postgres", "1", "1")
        assert 0 < int(port) < 65536
        with pytest.raises(ProcessLookupError):
            os.kill(int(proxy_pid_file.read_text()), 0)
    assert not list(tmp_path.glob("hussh-pkm-release.*"))


@pytest.mark.parametrize(
    ("environment", "phase"),
    [
        ("dev", "image"),
        ("dev", "downstream"),
        ("uat", "image"),
        ("uat", "downstream"),
        ("production", "image"),
        ("production", "prepromotion"),
        ("production", "postpromotion"),
    ],
)
def test_release_phase_blocks_without_unnecessary_rollback(
    tmp_path, monkeypatch, environment, phase
):
    workflow = yaml.safe_load(
        (
            ROOT
            / f".github/workflows/deploy-{environment}{'-implementation' if environment != 'production' else ''}.yml"
        ).read_text()
    )
    steps = workflow["jobs"]["deploy"]["steps"]
    identifier = "classify" if environment == "production" else f"classify-{environment}-release"
    step = next(step for step in steps if step.get("id") == identifier)
    assert (
        step["env"]["FRONTEND_IMAGE_CHECK_OUTCOME"] == "${{ steps.check-frontend-image.outcome }}"
    )
    # Missing checks before production promotion cannot justify moving traffic.
    # Dev/UAT retain their existing downstream classifier contracts.
    values = {key: "skipped" for key in step["env"]}
    values.update(
        DEPLOY_BACKEND="true",
        DEPLOY_FRONTEND="true",
        UPSTREAM_JOB_STATUS="failure",
        FRONTEND_IMAGE_CHECK_OUTCOME="failure" if phase == "image" else "success",
        PKM_EVALUATOR_RUNS="0",
        DRIVE_PAUSE_SNAPSHOT="",
        DEV_TARGET="shared-dev",
        GITHUB_OUTPUT=str(tmp_path / "outputs"),
    )
    if phase == "postpromotion":
        values.update(
            {
                key: "success"
                for key in (
                    "HEALTH_BACKEND",
                    "HEALTH_FRONTEND",
                    "PARITY_OUTCOME",
                    "CONNECTED_SYSTEMS_OUTCOME",
                    "BACKEND_PROVENANCE_OUTCOME",
                    "FRONTEND_PROVENANCE_OUTCOME",
                    "PASSKEY_ASSOCIATIONS_OUTCOME",
                    "DRIVE_PAUSE_OUTCOME",
                    "PROMOTE_OUTCOME",
                )
            },
            DRIVE_ENABLED="false",
            DOCUMENT_DELIVERY_CONFIGURED="false",
        )
        # Isolate the missing combined serving-pair compatibility receipt.
        assert values["ACCOUNT_SESSION_CONTRACT_OUTCOME"] == "skipped"
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    source = step["run"].replace("/tmp/", str(tmp_path) + "/")  # noqa: S108 - isolated workflow artifacts.
    if environment == "production":
        result = subprocess.run(  # noqa: S603 - trusted classifier, no cloud commands.
            ["bash", "-c", source], capture_output=True, text=True, timeout=5
        )
        assert result.returncode == 0, result.stderr
    else:
        source = source.split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        with pytest.raises(SystemExit) as terminal:
            exec(compile(source, "release-classifier", "exec"), {})  # noqa: S102 - trusted workflow source.
        assert terminal.value.code == 0
    outputs = dict(line.split("=", 1) for line in (tmp_path / "outputs").read_text().splitlines())
    assert outputs["release_failed"] == "true"
    rollback = phase not in {"image", "prepromotion"} and environment == "production"
    assert outputs["backend_failure"] == str(rollback).lower()
    assert outputs["frontend_failure"] == str(rollback).lower()
    early = next(i for i, item in enumerate(steps) if item.get("id") == "check-frontend-image")
    assert early < next(i for i, item in enumerate(steps) if item.get("id") == "deploy-backend")


def _dev_workflow_step(name: str) -> dict:
    workflow = yaml.safe_load(
        (ROOT / ".github/workflows/deploy-dev-implementation.yml").read_text()
    )
    return next(step for step in workflow["jobs"]["deploy"]["steps"] if step["name"] == name)


def _fake_backend_sync(tmp_path: Path, help_text: str, has_profile_constant: bool = False) -> None:
    script = tmp_path / "scripts/ops/sync_backend_runtime_secrets.py"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        '"""--drive-four-group-index compatibility fixture."""\n'
        "import json, os, sys\n"
        f'if "--help" in sys.argv:\n print({help_text!r})\n'
        "else:\n"
        ' open(os.environ["BACKEND_ARGS_FILE"], "w").write(json.dumps(sys.argv[1:]))\n'
    )
    if has_profile_constant:
        profile_file = tmp_path / "consent-protocol/db/hosted_custody_profiles.py"
        profile_file.parent.mkdir(parents=True, exist_ok=True)
        profile_file.write_text('DEV_CONTROL_PLANE_OWNER_PROFILE = "dev_control_plane_owner"\n')


@pytest.mark.parametrize(
    ("help_text", "has_profile_constant", "expected_profile"),
    [
        ("", True, False),
        ("--hosted-custody-profile", True, False),
        ("--dev-target", True, False),
        ("--hosted-custody-profile --dev-target", False, False),
        ("--hosted-custody-profile --dev-target", True, True),
    ],
)
def test_backend_secret_sync_adds_custody_flags_only_for_compatible_source(
    tmp_path, help_text, has_profile_constant, expected_profile
):
    step = _dev_workflow_step("Sync canonical hosted runtime secrets")
    source = step["run"].split("# Same main-workflow", 1)[0]
    _fake_backend_sync(tmp_path, help_text, has_profile_constant)
    replacements = {
        "${{ env.PROTOCOL_PYTHON }}": sys.executable,
        "${{ env.GCP_PROJECT_ID }}": "hushh-pda-dev",
        "${{ env.APP_FRONTEND_ORIGIN }}": "https://dev.example",
        "${{ env.DEV_DB_UNIX_SOCKET }}": str(tmp_path / "socket"),
        "${{ env.DEV_CLOUDSQL_INSTANCE }}": "hushh-pda-dev:us-central1:hushh-dev-pg",
        "/tmp/dev-runtime-secret-sync.json": str(tmp_path / "dev-runtime-secret-sync.json"),  # noqa: S108 - redirect workflow output into pytest isolation.
    }
    for old, new in replacements.items():
        source = source.replace(old, new)
    source += "\nexit 0\n"
    args_file = tmp_path / "backend-args.json"
    env = os.environ.copy()
    env.update(BACKEND_ARGS_FILE=str(args_file), DEV_TARGET="shared-dev")
    result = subprocess.run(  # noqa: S603 - execute trusted repository workflow shell with fake local commands.
        ["bash", "-euo", "pipefail", "-c", source],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    args = json.loads(args_file.read_text())
    has_profile = "--hosted-custody-profile" in args
    assert has_profile is expected_profile
    assert ("--dev-target" in args) is expected_profile
    if expected_profile:
        assert args[args.index("--hosted-custody-profile") + 1] == "dev_control_plane_owner"
        assert args[args.index("--dev-target") + 1] == "shared-dev"


@pytest.mark.parametrize(
    ("target", "help_text", "has_profile_constant", "expected"),
    [
        ("shared-dev", "--hosted-custody-profile --dev-target", True, "dev_control_plane_owner"),
        ("shared-dev", "--hosted-custody-profile", True, ""),
        ("shared-dev", "--hosted-custody-profile --dev-target", False, ""),
        ("", "--hosted-custody-profile --dev-target", True, ""),
        ("scope-commerce-sandbox", "--hosted-custody-profile --dev-target", True, ""),
        ("pod-publication", "--hosted-custody-profile --dev-target", True, ""),
    ],
)
def test_predeploy_profile_export_is_dev_target_and_source_gated(
    tmp_path, target, help_text, has_profile_constant, expected
):
    step = _dev_workflow_step("Apply dev DB migrations and predeploy schema gate")
    source = (
        step["run"]
        .split("# HOSTED_CUSTODY_PROFILE_ENV_GATE_BEGIN", 1)[1]
        .split("# HOSTED_CUSTODY_PROFILE_ENV_GATE_END", 1)[0]
    )
    _fake_backend_sync(tmp_path, help_text, has_profile_constant)
    source = source.replace("${{ env.PROTOCOL_PYTHON }}", sys.executable)
    source = source.replace("${{ env.GCP_PROJECT_ID }}", "hushh-pda-dev")
    source = source.replace(
        "${{ env.DEV_CLOUDSQL_INSTANCE }}", "hushh-pda-dev:us-central1:hushh-dev-pg"
    )
    source += '\nprintf "%s" "${HUSHH_HOSTED_CUSTODY_PROFILE-}"\n'
    env = os.environ.copy()
    env.update(DEV_TARGET=target, HUSHH_HOSTED_CUSTODY_PROFILE="stale-profile")
    result = subprocess.run(  # noqa: S603 - execute trusted repository workflow shell with fake local commands.
        ["bash", "-euo", "pipefail", "-c", source],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == expected


def test_commerce_target_skips_hosted_backend_secret_sync(tmp_path):
    step = _dev_workflow_step("Sync canonical hosted runtime secrets")
    source = step["run"].split("# Same main-workflow", 1)[0]
    _fake_backend_sync(tmp_path, "--hosted-custody-profile --dev-target")
    preview = tmp_path / "scripts/deploy/commerce-preview-verify.py"
    preview.parent.mkdir(parents=True, exist_ok=True)
    preview.write_text(
        "import json, os, sys\n"
        'open(os.environ["PREVIEW_ARGS_FILE"], "w").write(json.dumps(sys.argv[1:]))\n'
    )
    source = source.replace("${{ env.PROTOCOL_PYTHON }}", sys.executable)
    source = source.replace("/tmp/dev-runtime-secret-sync.json", str(tmp_path / "report.json"))  # noqa: S108 - isolate workflow report path.
    args_file = tmp_path / "backend-args.json"
    preview_args_file = tmp_path / "preview-args.json"
    env = os.environ.copy()
    env.update(
        BACKEND_ARGS_FILE=str(args_file),
        PREVIEW_ARGS_FILE=str(preview_args_file),
        DEV_TARGET="scope-commerce-sandbox",
    )
    result = subprocess.run(  # noqa: S603 - execute trusted repository workflow shell with fake local commands.
        ["bash", "-euo", "pipefail", "-c", source],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )
    assert result.returncode == 0, result.stderr
    assert not args_file.exists()
    assert json.loads(preview_args_file.read_text()) == [
        "--phase",
        "resources",
        "--report-path",
        str(tmp_path / "report.json"),
    ]


def test_pod_publication_job_cannot_export_hosted_custody_profile():
    workflow = yaml.safe_load(
        (ROOT / ".github/workflows/deploy-dev-implementation.yml").read_text()
    )
    pod_job = workflow["jobs"]["pod-publication"]
    assert "HUSHH_HOSTED_CUSTODY_PROFILE" not in str(pod_job)
    assert "--hosted-custody-profile" not in str(pod_job)
