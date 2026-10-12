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
    workflow = yaml.safe_load((root / ".github/workflows/deploy-dev.yml").read_text())
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
    exec(compile(source, str(root / ".github/workflows/deploy-dev.yml"), "exec"), {})  # noqa: S102 - trusted repository workflow
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
    workflow = yaml.safe_load((root / ".github/workflows/deploy-dev.yml").read_text())
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
    workflow = yaml.safe_load((ROOT / f".github/workflows/deploy-{environment}.yml").read_text())
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
