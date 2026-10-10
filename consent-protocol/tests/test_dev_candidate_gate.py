"""Candidate health must prove the candidate, never a redirect to live traffic."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def test_manual_ci_secret_range_includes_diverged_candidate_commits(tmp_path):
    repository = tmp_path / "repository"
    repository.mkdir()

    def git(*args):
        return subprocess.check_output(  # noqa: S603 - fixed Git operations in a synthetic repo.
            ["git", *args], cwd=repository, text=True
        ).strip()

    git("init", "--quiet", "--initial-branch=main")
    git("config", "user.name", "Synthetic Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "base")
    base = git("rev-parse", "HEAD")
    git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "main advanced")
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    git("checkout", "--quiet", "--detach", base)
    git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "candidate")
    candidate = git("rev-parse", "HEAD")
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    step = next(
        step for step in workflow["jobs"]["secret-scan"]["steps"] if step.get("id") == "scan-range"
    )
    function = step["run"].split('if [ "${{ github.event_name }}"', 1)[0]
    function = function.replace("${{ github.event.repository.default_branch }}", "main")
    function = function.replace("${{ github.sha }}", candidate)
    result = subprocess.run(  # noqa: S603 - executes the repository-owned workflow in a fixture.
        ["bash", "-eu", "-c", function + "\nresolve_from_default_branch"],
        cwd=repository,
        capture_output=True,
        text=True,
        check=True,
    )
    scan_args = result.stdout.strip().split()
    assert git("rev-list", *scan_args).splitlines() == [candidate]


def test_workflow_candidate_tag_fits_preview_services_and_binds_retry(tmp_path):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    resolve = next(step for step in steps if step["name"] == "Resolve fixed deployment target")
    probe = next(step for step in steps if step.get("id") == "verify-candidates")
    cleanup = next(step for step in steps if step["name"] == "Remove this run's candidate tags")
    tags = []
    for attempt in ("1", "99999999999999999999"):
        env_file = tmp_path / ("env-" + attempt)
        subprocess.run(  # noqa: S603 - repository-owned workflow in an isolated fixture.
            ["bash", "-eu", "-o", "pipefail", "-c", resolve["run"]],
            cwd=ROOT,
            env={
                **os.environ,
                "REQUESTED_TARGET": "scope-commerce-sandbox",
                "BUILD_POD_IMAGE": "false",
                "GITHUB_ENV": str(env_file),
                "GITHUB_RUN_ID": "3778850086800000000000000000",
                "GITHUB_RUN_ATTEMPT": attempt,
            },
            check=True,
            capture_output=True,
            text=True,
        )
        values = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
        tag = values["DEV_CANDIDATE_TAG"]
        assert len(tag) == 13 and tag.startswith("c")
        assert all(char in "0123456789abcdef" for char in tag[1:])
        for service in (values["BACKEND_SERVICE"], values["FRONTEND_SERVICE"]):
            assert len(service) + len(tag) <= 46
        tags.append(tag)
    assert tags[0] != tags[1]
    assert probe["env"]["CANDIDATE_TAG"] == "${{ env.DEV_CANDIDATE_TAG }}"
    assert '--remove-tags="${{ env.DEV_CANDIDATE_TAG }}"' in cleanup["run"]


@pytest.mark.parametrize("code,expected", [("200", 0), ("302", 1), ("503", 1)])
def test_candidate_http_gate_does_not_accept_redirects(tmp_path, code, expected):
    commands = tmp_path / "commands"
    for name, body in {
        "gcloud": 'echo "$*" >> "$COMMANDS"\n',
        "curl": 'echo "$*" >> "$COMMANDS"\nprintf "%s" "$HTTP_CODE"\n',
        "sleep": "exit 0\n",
        "python-gate": 'if [ "$1" = "-c" ]; then echo https://candidate.run.app; fi\n',
    }.items():
        path = tmp_path / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
    env = {
        **os.environ,
        "PATH": str(tmp_path) + ":" + os.environ["PATH"],
        "PROTOCOL_PYTHON": str(tmp_path / "python-gate"),
        "HTTP_CODE": code,
        "COMMANDS": str(commands),
    }
    run = subprocess.run(  # noqa: S603 - fixed script with isolated fake executables.
        [
            "bash",
            str(ROOT / "scripts/ci/verify-dev-candidate.sh"),
            "project",
            "region",
            "service",
            "revision",
            "registry/image@sha256:" + "a" * 64,
            "a" * 40,
            "99",
            "dev-candidate-99",
            "/health",
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    assert run.returncode == expected
    calls = commands.read_text()
    assert "--update-tags=dev-candidate-99=revision" in calls
    assert "--to-" not in calls
    assert "--location" not in calls and " -L" not in calls
    assert calls.count("https://candidate.run.app/health") == (1 if expected == 0 else 5)


def test_dev_builds_immutable_candidate_before_migration_and_probes_before_promotion():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Build and pin backend image before lifecycle migration") < names.index(
        "Apply dev DB migrations and predeploy schema gate"
    )
    assert names.index("Verify selected candidates before traffic promotion") < names.index(
        "Promote deployed revisions to dev traffic"
    )
    gate = next(step for step in steps if step.get("id") == "verify-candidates")
    assert "continue-on-error" not in gate
    assert "steps.scope.outputs.deploy_backend" in gate["run"]
    assert "steps.scope.outputs.deploy_frontend" in gate["run"]
    assert "/health" in gate["run"] and "/login" in gate["run"]
    for step in steps:
        if step.get("id") in {"verify-parity-1", "verify-parity-2"}:
            assert "--require-voice" in step["run"] and "--require-calendar" in step["run"]


def test_dev_observations_use_order_safe_serving_state():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    for step in steps:
        if step.get("id") in {"predeploy-state", "current-state", "final-state"}:
            assert "resolve-cloud-run-serving-state.py" in step["run"]
            assert "status.traffic[0]" not in step["run"]
            assert 'echo "backend_revision=${backend_revision}"' in step["run"]
            assert 'echo "frontend_revision=${frontend_revision}"' in step["run"]


@pytest.mark.parametrize("legacy_interface", [None, "missing-probe", "unprotected-retention"])
def test_candidate_interfaces_are_checked_before_mutating_steps(tmp_path, legacy_interface):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Validate candidate build capabilities") < names.index(
        "Sync canonical hosted runtime secrets"
    )
    step = next(step for step in steps if step["name"] == "Validate candidate build capabilities")
    program = step["run"].split("<<'PYBUILD'\n", 1)[1].rsplit("PYBUILD", 1)[0]
    for relative in (
        "scripts/ci/verify-dev-candidate.sh",
        "scripts/ci/cloudrun-retention.sh",
        "scripts/ci/verify-cloudrun-revision-provenance.py",
        "scripts/ops/verify-env-secrets-parity.py",
        "deploy/backend.cloudbuild.yaml",
    ):
        destination = tmp_path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)
    retention_helper = ROOT / "scripts/ci/cloudrun-retention.py"
    if retention_helper.exists():
        shutil.copy2(retention_helper, tmp_path / "scripts/ci/cloudrun-retention.py")
    if legacy_interface == "missing-probe":
        (tmp_path / "scripts/ci/verify-dev-candidate.sh").unlink()
    elif legacy_interface == "unprotected-retention":
        (tmp_path / "scripts/ci/cloudrun-retention.sh").write_text(
            "#!/bin/bash\necho 'Usage: retention <service> [region] [keep_count]'\n"
        )
    result = subprocess.run(  # noqa: S603 - checked-in workflow program in an isolated fixture.
        [sys.executable, "-c", program],
        cwd=tmp_path,
        env={**os.environ, "BUILD_POD_IMAGE": "false", "DEPLOY_BACKEND": "true"},
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == (1 if legacy_interface else 0), result.stderr
    if legacy_interface:
        assert "Candidate deployment interface is incompatible" in result.stderr


@pytest.mark.parametrize("target", ["scope-commerce-sandbox", "shared-dev", None])
def test_preview_migration_credentials_do_not_escape_the_subprocess(tmp_path, target):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    run = next(
        s["run"]
        for s in workflow["jobs"]["deploy"]["steps"]
        if s.get("name") == "Apply dev DB migrations and predeploy schema gate"
    )
    start = run.index(
        'if [[ "${DEV_TARGET:-shared-dev}" == "scope-commerce-sandbox" ]]; then\n  MIGRATOR_DB_USER='
    )
    section = run[start:]
    section = section[: section.index("\nfi") + 3]
    section = section.replace("${{ env.GCP_PROJECT_ID }}", "hushh-pda-dev")
    section = section.replace("${{ env.PROTOCOL_PYTHON }}", str(tmp_path / "python-gate"))
    (tmp_path / "consent-protocol").mkdir()
    (tmp_path / "python-gate").write_text(
        '#!/bin/sh\nprintf "%s:%s:%s\\n" "$*" "$DB_USER" "$DB_PASSWORD" >> "$CALLS"\n'
    )
    (tmp_path / "python-gate").chmod(0o755)
    (tmp_path / "gcloud").write_text(
        '#!/bin/sh\ncase "$*" in *MIGRATOR_DB_USER*) echo scope_commerce_sandbox_migrator;; '
        "*MIGRATOR_DB_PASSWORD*) echo synthetic-migration-password;; *) exit 1;; esac\n"
    )
    (tmp_path / "gcloud").chmod(0o755)
    env = {
        **os.environ,
        "PATH": str(tmp_path) + ":" + os.environ["PATH"],
        "DEPLOY_SECRET_PREFIX": "SCOPE_COMMERCE_SANDBOX_",
        "DB_USER": "scope_commerce_sandbox",
        "DB_PASSWORD": "synthetic-runtime-password",
        "CALLS": str(tmp_path / "calls"),
    }
    env.pop("DEV_TARGET", None)
    if target is not None:
        env["DEV_TARGET"] = target
    result = subprocess.run(  # noqa: S603 - real workflow with hermetic command adapters.
        ["bash", "-eu", "-c", section], cwd=tmp_path, env=env, capture_output=True, text=True
    )
    assert result.returncode == 0
    expected = (
        [
            "db/migrate.py --release --migration-mode ledger:"
            "scope_commerce_sandbox_migrator:synthetic-migration-password",
            "scripts/deploy/commerce-preview-verify.py --phase database "
            "--report-path /tmp/dev-preview-postmigration-database.json:"
            "scope_commerce_sandbox:synthetic-runtime-password",
        ]
        if target == "scope-commerce-sandbox"
        else [
            "db/migrate.py --release --migration-mode replay:"
            "scope_commerce_sandbox:synthetic-runtime-password"
        ]
    )
    assert (tmp_path / "calls").read_text().splitlines() == expected
    if target != "scope-commerce-sandbox":
        return
    (tmp_path / "calls").unlink()
    result = subprocess.run(  # noqa: S603 - real workflow with hermetic command adapters.
        ["bash", "-eu", "-c", section],
        cwd=tmp_path,
        env=env | {"DB_USER": "shared_database_user"},
        capture_output=True,
    )
    assert result.returncode != 0 and not (tmp_path / "calls").exists()


@pytest.mark.parametrize(
    "target,expected", [("shared-dev", 0), ("scope-commerce-sandbox", 0), ("arbitrary-target", 2)]
)
def test_main_owned_preview_selection_is_fixed_and_preserves_shared_defaults(
    tmp_path, target, expected
):
    environment = tmp_path / "github-env"
    result = subprocess.run(  # noqa: S603 - fixed repository selector with isolated output.
        [
            sys.executable,
            str(ROOT / "scripts/deploy/commerce-preview-target.py"),
            "--target",
            target,
            "--github-env",
            str(environment),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == expected
    if expected:
        assert not environment.exists()
        return
    values = dict(row.split("=", 1) for row in environment.read_text().splitlines())
    if target == "shared-dev":
        assert values == {
            "DEV_TARGET": "shared-dev",
            "DEV_DB_NAME": "postgres",
            "DEPLOY_SECRET_PREFIX": "",
        }
    else:
        assert values["BACKEND_SERVICE"] == "consent-protocol-commerce-sandbox"
        assert values["FRONTEND_SERVICE"] == "hushh-webapp-commerce-sandbox"
        assert values["DEV_DB_NAME"] == "scope_commerce_sandbox"
        assert values["DEPLOY_SECRET_PREFIX"] == "SCOPE_COMMERCE_SANDBOX_"


def test_preview_bootstrap_uses_the_verified_candidate_and_attests_before_promotion():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    trigger = workflow.get("on", workflow.get(True))
    assert trigger["workflow_dispatch"]["inputs"]["target"]["default"] == "shared-dev"
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Resolve fixed deployment target") < names.index("Checkout deployment SHA")
    assert names.index("Validate deployment SHA against requested ref") < names.index(
        "Checkout deployment SHA"
    )
    assert names.index("Checkout deployment SHA") < names.index(
        "Build fixed preview bootstrap image"
    )
    assert names.index("Build fixed preview bootstrap image") < names.index(
        "Bootstrap fixed private preview services"
    )
    assert names.index("Verify isolated preview bindings before traffic promotion") < names.index(
        "Promote deployed revisions to dev traffic"
    )
    bootstrap = next(step for step in steps if step.get("id") == "preview-bootstrap")
    assert "steps.resolve-sha.outputs.sha" in bootstrap["run"]
    assert "steps.bootstrap-image.outputs.image_reference" in bootstrap["run"]
    assert "continue-on-error" not in bootstrap
    assert "scope-commerce-sandbox" in bootstrap["if"]


def test_preview_database_gates_use_release_contract_without_shared_dev_fallback(tmp_path):
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    contract_dir = tmp_path / "consent-protocol/db/contracts"
    contract_dir.mkdir(parents=True)
    for name in ("prod_core_schema", "dev_minimum_schema", "uat_integrated_schema"):
        (contract_dir / f"{name}.json").write_text("{}")
    gates = [step["run"] for step in steps if "--contract-file" in step.get("run", "")]
    assert len(gates) == 2
    for gate in gates:
        selection = (
            "CONTRACT_FILE="
            + gate.split("CONTRACT_FILE=", 1)[1].split('"${{ env.PROTOCOL_PYTHON }}"', 1)[0]
        )
        script = selection + '\nprintf "%s" "$CONTRACT_FILE"\n'
        for target, contract in (
            ("scope-commerce-sandbox", "prod_core_schema"),
            ("shared-dev", "dev_minimum_schema"),
        ):
            result = subprocess.run(  # noqa: S603 - repository workflow in isolated fixture
                ["bash", "-eu", "-c", script],
                cwd=tmp_path,
                env={**os.environ, "DEV_TARGET": target},
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0
            assert result.stdout == f"consent-protocol/db/contracts/{contract}.json"
        release = contract_dir / "prod_core_schema.json"
        release.unlink()
        rejected = subprocess.run(  # noqa: S603 - repository workflow in isolated fixture
            ["bash", "-eu", "-c", script],
            cwd=tmp_path,
            env={**os.environ, "DEV_TARGET": "scope-commerce-sandbox"},
            capture_output=True,
        )
        assert rejected.returncode != 0
        release.write_text("{}")


@pytest.mark.parametrize("token,expected", [("synthetic-identity", 0), ("", 1)])
def test_private_preview_probe_requires_identity_without_recording_it(tmp_path, token, expected):
    calls = tmp_path / "calls"
    for name, body in {
        "gcloud": 'echo "$*" >> "$CALLS"\n',
        "curl": """echo "$*" >> "$CALLS"
body=$(cat)
[ "$body" = 'header = "X-Serverless-Authorization: Bearer synthetic-identity"' ] && printf 200 || printf 403
""",
        "sleep": "exit 0\n",
        "python-gate": 'if [ "$1" = "-c" ]; then echo https://candidate.run.app; fi\n',
    }.items():
        path = tmp_path / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
    result = subprocess.run(  # noqa: S603 - fixed gate with synthetic executables and identity.
        [
            "bash",
            str(ROOT / "scripts/ci/verify-dev-candidate.sh"),
            "hushh-pda-dev",
            "us-central1",
            "consent-protocol-commerce-sandbox",
            "revision",
            "registry/image@sha256:" + "a" * 64,
            "a" * 40,
            "99",
            "c123",
            "/health",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PATH": str(tmp_path) + ":" + os.environ["PATH"],
            "PROTOCOL_PYTHON": str(tmp_path / "python-gate"),
            "CALLS": str(calls),
            "DEV_TARGET": "scope-commerce-sandbox",
            "CANDIDATE_ID_TOKEN": token,
        },
    )
    assert result.returncode == expected, result.stderr
    assert "synthetic-identity" not in result.stdout + result.stderr + calls.read_text()
    if not token:
        assert "https://candidate.run.app/health" not in calls.read_text()


def test_preview_public_admission_follows_authenticated_health_and_application_promotion():
    steps = yaml.safe_load((ROOT / ".github/workflows/deploy-dev.yml").read_text())["jobs"][
        "deploy"
    ]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Verify selected candidates before traffic promotion") < names.index(
        "Promote deployed revisions to dev traffic"
    )
    assert names.index("Promote deployed revisions to dev traffic") < names.index(
        "Admit verified preview application invocation"
    )
    for lane, audience in (
        ("backend", "PREVIEW_BACKEND_ORIGIN"),
        ("frontend", "APP_FRONTEND_ORIGIN"),
    ):
        auth = next(step for step in steps if step.get("id") == f"preview-{lane}-probe-auth")
        assert auth["if"] == "env.DEV_TARGET == 'scope-commerce-sandbox'"
        assert auth["with"]["id_token_audience"] == "${{ env." + audience + " }}"
        assert auth["with"]["create_credentials_file"] is False
        assert auth["with"]["export_environment_variables"] is False
    quarantine = next(step for step in steps if step.get("id") == "quarantine-preview")
    expression = quarantine["if"].replace("&&", "and").replace("||", "or")
    expression = expression.replace("env.DEV_TARGET", "target").replace(
        "steps.classify-dev-release.outputs.release_failed", "classified"
    )
    for target, failed, classified, expected in (
        ("scope-commerce-sandbox", False, "true", True),
        ("scope-commerce-sandbox", True, "", True),
        ("scope-commerce-sandbox", False, "false", False),
        ("shared-dev", True, "true", False),
    ):
        # Evaluate the authored admission predicate, including the case where a
        # continued semantic failure leaves the GitHub job status successful.
        assert (
            eval(  # noqa: S307 - repository-owned boolean expression, no builtins
                expression,
                {"__builtins__": {}},
                {
                    "always": lambda: True,
                    "failure": lambda failed=failed: failed,
                    "target": target,
                    "classified": classified,
                },
            )
            is expected
        )
