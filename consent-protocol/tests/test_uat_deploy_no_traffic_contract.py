from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from hushh_mcp.managed_ai_config import load_profile
from tests._deploy_contract import (
    backend_deploy_script,
    managed_vertex_probe_script,
    managed_vertex_probe_surface,
)
from tests.test_pwm_runtime_probe import pwm_proof_fixture

REPO_ROOT = Path(__file__).resolve().parents[2]

_BACKEND_RELEASE_TOOL_FIXTURES = (
    "deploy/backend.cloudbuild.yaml",
    "scripts/ci/managed_provider_readiness.py",
    "scripts/ci/managed_capability_proof.py",
    "scripts/deploy/backend-deploy.sh",
    "scripts/deploy/backend-capacity-settings.sh",
    "scripts/deploy/backend-app-surface-settings.sh",
    "scripts/deploy/verify-managed-vertex-runtime.sh",
    "scripts/deploy/commerce-preview-bindings.sh",
    "scripts/deploy/backend-model-settings.sh",
    "scripts/deploy/backend-drive-search-settings.sh",
    "scripts/deploy/backend-drive-secret-settings.sh",
    "scripts/deploy/scope-commerce-secrets.sh",
    "deploy/email-auth/bind_secrets.sh",
    "deploy/plg/bind_secrets.sh",
    "deploy/sso/bind_workos.sh",
)


def test_backend_cloud_build_uses_valid_secret_flag_combinations():
    document = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    for step in document["steps"]:
        for argument in step.get("args", []):
            if "--set-secrets" in argument:
                assert "--clear-secrets" not in argument, step.get("id")


@pytest.mark.parametrize(
    ("repeat", "fail_at", "expected_calls", "completed"),
    [(False, 0, 1, 1), (True, 0, 2, 2), (True, 1, 1, 0), (True, 2, 2, 1)],
)
def test_selected_reviewer_repetition_requires_each_independent_pass(
    tmp_path: Path, repeat: bool, fail_at: int, expected_calls: int, completed: int
) -> None:
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    inputs = workflow.get("on", workflow.get(True))["workflow_dispatch"]["inputs"]
    assert inputs["repeat_reviewer_byok"]["default"] is False
    step = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("id") == "verify-reviewer-byok"
    )
    command = step["run"].replace("${{ inputs.repeat_reviewer_byok }}", str(repeat).lower())
    command = command.replace("/tmp/uat-reviewer-byok.log", str(tmp_path / "reviewer.log"))  # noqa: S108 - redirect the authored log path into the isolated fixture
    binary = tmp_path / "bin"
    binary.mkdir()
    probe = binary / "node"
    probe.write_text(
        f"#!{sys.executable}\n"
        "import os, sys\nfrom pathlib import Path\n"
        "counter = Path(os.environ['PROBE_COUNT'])\n"
        "number = int(counter.read_text()) + 1 if counter.exists() else 1\n"
        "counter.write_text(str(number))\n"
        "if number == int(os.environ['PROBE_FAIL_AT']): sys.exit(1)\n"
        "print('PASS synthetic_read_only_baseline')\n"
    )
    probe.chmod(0o700)
    output = tmp_path / "outputs"
    count = tmp_path / "calls"
    result = subprocess.run(  # noqa: S603 - actual authored step, synthetic non-authorizing probe
        [shutil.which("bash") or "bash", "-c", command],
        cwd=tmp_path,
        env={
            **os.environ,
            "PATH": f"{binary}{os.pathsep}{os.environ.get('PATH', '')}",
            "GITHUB_OUTPUT": str(output),
            "PROBE_COUNT": str(count),
            "PROBE_FAIL_AT": str(fail_at),
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    assert (result.returncode == 0) is (fail_at == 0)
    assert int(count.read_text()) == expected_calls
    recorded = output.read_text().splitlines() if output.exists() else []
    assert recorded == [f"passes_completed={number}" for number in range(1, completed + 1)]


@pytest.mark.parametrize(
    ("supported", "backend", "flag", "allowed"),
    [
        (False, True, "false", True),
        (False, True, "true", False),
        (True, True, "true", True),
        (False, False, "true", False),
    ],
)
def test_email_auth_release_admits_only_supported_enabled_backends(
    tmp_path, supported, backend, flag, allowed
):
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    sync = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step["name"] == "Sync canonical hosted runtime secrets"
    )
    guard = sync["run"].split(
        '\n"${{ env.PROTOCOL_PYTHON }}" scripts/ops/sync_backend_runtime_secrets.py \\\n'
    )[0]
    guard = guard.replace("${{ env.PROTOCOL_PYTHON }}", sys.executable)
    guard = guard.replace("${{ steps.scope.outputs.deploy_backend }}", str(backend).lower())
    ops = tmp_path / "scripts/ops"
    ops.mkdir(parents=True)
    (ops / "sync_backend_runtime_secrets.py").write_text(
        "# --email-auth-enabled\n" if supported else "# legacy compiler\n"
    )
    if supported:
        (ops / "email_auth_uat_release.py").write_text(
            "from pathlib import Path\nPath('preflight-ran').touch()\n"
        )
    result = subprocess.run(  # noqa: S603 - authored guard and temporary synthetic inputs
        [shutil.which("bash") or "bash", "-c", guard],
        cwd=tmp_path,
        env={**os.environ, "UAT_EMAIL_AUTH_ENABLED": flag},
        capture_output=True,
        text=True,
        check=False,
    )
    assert (result.returncode == 0) is allowed
    assert (tmp_path / "preflight-ran").exists() is (supported and backend)


@pytest.mark.parametrize("environment", ["uat", "production", "dev"])
def test_email_auth_secret_bindings_are_uat_only(environment):
    body = backend_deploy_script()
    source = next(line.strip() for line in body.splitlines() if "source deploy/email-auth/" in line)
    source = source.replace("${_DEPLOY_ENV}", environment)
    result = subprocess.run(  # noqa: S603 - authored helper with synthetic environment
        [
            shutil.which("bash") or "bash",
            "-c",
            'append_optional_secret() { echo "$1=$2"; }; ' + source,
        ],
        cwd=REPO_ROOT,
        env=os.environ,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.splitlines() == (
        [
            "EMAIL_AUTH_VERIFIER_KEY=EMAIL_AUTH_VERIFIER_KEY",
            "EMAIL_AUTH_PAYLOAD_KEY=EMAIL_AUTH_PAYLOAD_KEY",
            "EMAIL_AUTH_LOOKUP_KEY=EMAIL_AUTH_LOOKUP_KEY",
            "MAIL_API_KEY=EMAIL_AUTH_MAIL_API_KEY",
        ]
        if environment == "uat"
        else []
    )


@pytest.mark.parametrize(
    ("flag_value", "unexpected_key"),
    [("false", None), ("true", None), ("true", "UNDECLARED_RUNTIME_KEY")],
)
def test_initial_contacts_hydrated_profiles_pass_the_strict_shape_contract(
    tmp_path: Path, monkeypatch, capsys, flag_value: str, unexpected_key: str | None
) -> None:
    # Exercise the production profile migration without cloud credentials.
    checker_path = REPO_ROOT / "scripts/ops/verify-runtime-profile-env-shape.py"
    spec = importlib.util.spec_from_file_location("runtime_profile_shape", checker_path)
    assert spec is not None and spec.loader is not None
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    flag = "NEXT_PUBLIC_INITIAL_CONTACTS_ONBOARDING_ENABLED"
    bootstrap = _read("scripts/env/bootstrap_profiles.sh")
    functions = []
    for name in ("remove_env_keys", "copy_template_if_needed"):
        match = re.search(rf"(?ms)^{name}\(\) \{{.*?(?=^[a-z_][a-z0-9_]*\(\) \{{|\Z)", bootstrap)
        assert match is not None
        functions.append(match.group(0))
    migration = (
        "\n".join(functions) + '\nSUMMARY=(); FORCE=false; copy_template_if_needed "$1" "$2"\n'
    )
    bash = shutil.which("bash")
    assert bash is not None
    for templates, runtimes in (
        (checker.BACKEND_TEMPLATE_FILES, checker.BACKEND_RUNTIME_FILES),
        (checker.FRONTEND_TEMPLATE_FILES, checker.FRONTEND_RUNTIME_FILES),
    ):
        for template, runtime in zip(templates, runtimes, strict=True):
            template_text = (REPO_ROOT / template).read_text(encoding="utf-8")
            (tmp_path / template).parent.mkdir(parents=True, exist_ok=True)
            (tmp_path / template).write_text(template_text, encoding="utf-8")
            runtime_text = template_text
            if template in checker.FRONTEND_TEMPLATE_FILES:
                runtime_text = (
                    "\n".join(
                        line
                        for line in template_text.splitlines()
                        if not line.startswith(f"{flag}=")
                    )
                    + f"\n{flag}={flag_value}\n"
                )
                runtime_text = re.sub(
                    r"(?m)^NEXT_PUBLIC_FIREBASE_API_KEY=.*$",
                    "NEXT_PUBLIC_FIREBASE_API_KEY=cached-test-key",
                    runtime_text,
                )
            (tmp_path / runtime).write_text(runtime_text, encoding="utf-8")
            if template in checker.FRONTEND_TEMPLATE_FILES:
                subprocess.run(  # noqa: S603 - fixed production helpers, temporary fixture files only.
                    [
                        bash,
                        "-c",
                        migration,
                        "profile-migration",
                        (tmp_path / template).as_posix(),
                        (tmp_path / runtime).as_posix(),
                    ],
                    env={**os.environ, "REPO_ROOT": tmp_path.as_posix()},
                    check=True,
                    capture_output=True,
                    text=True,
                )
                migrated = (tmp_path / runtime).read_text(encoding="utf-8")
                assert flag not in migrated
                assert "NEXT_PUBLIC_FIREBASE_API_KEY=cached-test-key" in migrated
    uat_runtime = tmp_path / "hushh-webapp/.env.uat.local"
    if unexpected_key is not None:
        with uat_runtime.open("a", encoding="utf-8") as runtime_file:
            runtime_file.write(f"{unexpected_key}=true\n")
    active_runtime = tmp_path / checker.FRONTEND_ACTIVE_RUNTIME_FILES[0]
    active_runtime.write_text(uat_runtime.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setattr(checker, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(
        sys, "argv", ["verify-runtime-profile-env-shape", "--include-runtime", "--include-active"]
    )
    result = checker.main()
    output = capsys.readouterr()
    if unexpected_key is not None:
        assert result == 1
        assert f"unexpected extra keys {unexpected_key}" in output.err
        assert flag not in output.err
    else:
        assert result == 0, output.err
        for template in checker.FRONTEND_TEMPLATE_FILES:
            assert flag not in (tmp_path / template).read_text(encoding="utf-8")


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def _backend_deploy() -> str:
    return _read("scripts/deploy/backend-deploy.sh")


def _container_worker_count(tmp_path: Path, worker_count: str | None = None) -> int:
    """Exercise the real Docker shell entrypoint without starting a server."""
    executable = tmp_path / "gunicorn"
    executable.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8")
    executable.chmod(0o700)
    command = next(
        line
        for line in _read("consent-protocol/Dockerfile").splitlines()
        if line.startswith("CMD ")
    )
    env = {**os.environ, "PATH": str(tmp_path) + os.pathsep + os.environ["PATH"]}
    env.pop("WEB_CONCURRENCY", None)
    if worker_count is not None:
        env["WEB_CONCURRENCY"] = worker_count
    result = subprocess.run(  # noqa: S603 - authored entrypoint, hermetic fake Gunicorn
        json.loads(command[4:]), env=env, capture_output=True, text=True, check=True
    )
    arguments = result.stdout.splitlines()
    return int(arguments[arguments.index("-w") + 1])


def test_backend_container_honors_governed_worker_count(tmp_path: Path) -> None:
    # Regression: dev declared one worker but the entrypoint launched two,
    # doubling its database connection budget and process-local listeners.
    assert _container_worker_count(tmp_path, "1") == 1


@pytest.mark.parametrize(
    "failure",
    ["", "missing_cpu", "missing_memory", "invalid_cpu", "invalid_memory", "lookup", "execute"],
)
def test_candidate_pkm_evaluator_inherits_exact_revision_resources(
    tmp_path: Path, failure: str
) -> None:
    cloud = tmp_path / "gcloud"
    calls_path = tmp_path / "calls.jsonl"
    cloud.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "args = sys.argv[1:]\n"
        "failure = os.environ['PROBE_FAILURE']\n"
        "with open(os.environ['CLOUD_CALLS'], 'a') as log:\n"
        "    log.write(json.dumps(args) + '\\n')\n"
        "if args[:3] == ['run', 'revisions', 'describe']:\n"
        "    assert args[3] == 'candidate-revision'\n"
        "    if failure == 'lookup': sys.exit(1)\n"
        "    projection = next(arg for arg in args if arg.startswith('--format='))\n"
        "    values = {'--format=value(spec.containers[0].image)': 'image@sha256:123',\n"
        "              '--format=value(spec.containers[0].resources.limits.cpu)': '2',\n"
        "              '--format=value(spec.containers[0].resources.limits.memory)': '6Gi'}\n"
        "    field = projection.split('.')[-1].removesuffix(')')\n"
        "    print('' if failure == 'missing_' + field else 'invalid' if failure == 'invalid_' + field else values[projection])\n"
        "elif args[:3] == ['run', 'services', 'describe']:\n"
        "    print('runtime@example.test')\n"
        "elif args[:3] == ['run', 'jobs', 'execute'] and failure == 'execute':\n"
        "    sys.exit(1)\n",
        encoding="utf-8",
    )
    cloud.chmod(0o700)
    result = subprocess.run(  # noqa: S603 - real wrapper, isolated synthetic gcloud
        ["bash", str(REPO_ROOT / "scripts/ci/run-candidate-pkm-structure-agent-eval.sh")],
        env={
            **os.environ,
            "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
            "CLOUD_CALLS": str(calls_path),
            "PROBE_FAILURE": failure,
            "GCP_PROJECT_ID": "test-project",
            "GCP_REGION": "test-region",
            "BACKEND_SERVICE": "backend",
            "BACKEND_REVISION": "candidate-revision",
            "GITHUB_RUN_ID": "123",
            "GITHUB_RUN_ATTEMPT": "1",
        },
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    calls = [json.loads(line) for line in calls_path.read_text().splitlines()]
    creates = [call for call in calls if call[:3] == ["run", "jobs", "create"]]
    executes = [call for call in calls if call[:3] == ["run", "jobs", "execute"]]
    assert (result.returncode == 0) is (not failure), result.stderr
    if failure not in ("", "execute"):
        assert not creates and not executes, (
            "Missing or invalid resources must fail before job creation"
        )
        return
    assert len(creates) == len(executes) == 1
    create = creates[0]
    for flag, value in (
        ("--cpu", "2"),
        ("--memory", "6Gi"),
        ("--image", "image@sha256:123"),
        ("--tasks", "1"),
        ("--parallelism", "1"),
        ("--max-retries", "0"),
        ("--task-timeout", "45m"),
    ):
        assert create[create.index(flag) + 1] == value
    assert create[create.index("--args") + 1] == (
        "scripts/eval_pkm_structure_agent.py,--phase,release_chain_24,--skip-shadow,--reps,3,"
        "--enforce-gates,--fail-fast,--json-out,/tmp/pkm-structure-agent-eval.json"
    )
    assert not any("secret" in arg or "cloudsql" in arg for arg in create)
    assert calls[-1][:4] == ["run", "jobs", "delete", "uat-pkm-eval-123-1"]


@pytest.mark.parametrize("pwm_provider", ["azure_openai_web_search", "azure_openai_tavily"])
def test_azure_pwm_uat_probe_requires_exact_runtime_identity_and_success_verdict(
    tmp_path: Path, pwm_provider: str
) -> None:
    build = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    steps = build["steps"]
    deploy_index = next(i for i, step in enumerate(steps) if step.get("id") == "deploy-backend")
    probe_index = next(
        i for i, step in enumerate(steps) if step.get("id") == "verify-azure-pwm-runtime"
    )
    assert probe_index == deploy_index + 1
    assert (
        next(i for i, step in enumerate(steps) if step.get("id") == "verify-managed-vertex-runtime")
        < deploy_index
        < probe_index
    )
    assert set(steps[probe_index]["waitFor"]) == {"build-backend-image", "verify-runtime-iam"}
    probe = steps[probe_index]["args"][-1]
    assert "execution_name" in probe and "--set-secrets" in probe
    config_path = tmp_path / "consent-protocol/config/managed-ai-runtime.json"
    config_path.parent.mkdir(parents=True)
    config_path.write_text(
        json.dumps(
            {
                "pwm_research": {"provider": "vertex_google_search"},
                "pwm_research_uat": {"provider": pwm_provider},
            }
        ),
        encoding="utf-8",
    )
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(
        "#!/bin/bash\n"
        'printf "%s\\n" "$*" >> "$GCLOUD_CALLS_PATH"\n'
        'if [[ "$1 $2 $3" == "run jobs executions" ]]; then echo "azure-pwm-exec-1"; fi\n'
        'if [[ "$1 $2" == "logging read" ]]; then\n'
        '  if [[ "$PROBE_DELAYED" == "true" && ! -f "$PROBE_FIRST_READ" ]]; then\n'
        '    touch "$PROBE_FIRST_READ"; printf "%s\\n" "$PROBE_PARTIAL_LOGS"\n'
        '  else printf "%s\\n" "$PROBE_LOGS"; fi\n'
        "fi\n",
        encoding="utf-8",
    )
    fake_gcloud.chmod(0o755)
    # Exercise the production bounded polling loop without real ingestion waits.
    (fake_bin / "sleep").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (fake_bin / "sleep").chmod(0o755)
    digest = "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64
    base_env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "PROJECT_ID": "hushh-pda-uat",
        "BUILD_ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "_DEPLOY_ENV": "uat",
        "_REGION": "us-central1",
        "_CLOUD_RUN_NO_TRAFFIC": "true",
        "_RUNTIME_SERVICE_ACCOUNT": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
        "_APP_SIGNING_KEY_SECRET": "APP_SIGNING_KEY",
        "_VAULT_DATA_KEY_SECRET": "VAULT_DATA_KEY",
        "_IMAGE_REFERENCE": digest,
    }
    runtime_identity = base_env["_RUNTIME_SERVICE_ACCOUNT"]
    cases = (
        ("ok", digest, runtime_identity, 0, True),
        ("delayed", digest, runtime_identity, 0, True),
        ("failed", digest, runtime_identity, 1, True),
        ("missing_http", digest, runtime_identity, 1, True),
        ("missing_managed", digest, runtime_identity, 1, True),
        ("wrong_scope", digest, runtime_identity, 1, True),
        ("ok", "gcr.io/hushh-pda-uat/consent-protocol:mutable", runtime_identity, 1, False),
        ("ok", digest, "other-runtime@hushh-pda-uat.iam.gserviceaccount.com", 1, False),
    )
    for verdict, image, service_account, expected_status, should_call_gcloud in cases:
        calls = tmp_path / "gcloud-calls.txt"
        calls.write_text("", encoding="utf-8")
        first_read = tmp_path / "first-read"
        first_read.unlink(missing_ok=True)
        http = {
            "azure_pwm_runtime_probe_stage": "primary_http",
            "result": "ok",
            "http_status": 200,
            "deployment": "synthetic-primary",
        }
        records = [
            http,
            {"azure_managed_text_contract": "ok", "scopes": 1 if verdict == "wrong_scope" else 2},
            {"azure_pwm_runtime_probe_result": "failed" if verdict == "failed" else "ok"},
        ]
        if verdict == "missing_http":
            records.pop(0)
        if verdict == "missing_managed":
            records.pop(1)
        result = subprocess.run(  # noqa: S603 - production build script with a fake gcloud.
            ["bash", "-c", probe],
            cwd=tmp_path,
            env={
                **base_env,
                "_IMAGE_REFERENCE": image,
                "_RUNTIME_SERVICE_ACCOUNT": service_account,
                "PROBE_LOGS": json.dumps([{"jsonPayload": value} for value in records]),
                "PROBE_PARTIAL_LOGS": json.dumps([{"jsonPayload": http}]),
                "PROBE_DELAYED": "true" if verdict == "delayed" else "false",
                "PROBE_FIRST_READ": str(first_read),
                "GCLOUD_CALLS_PATH": str(calls),
            },
            capture_output=True,
            text=True,
        )
        assert result.returncode == expected_status, result.stderr
        invoked = calls.read_text(encoding="utf-8")
        if should_call_gcloud:
            assert f"--image={digest}" in invoked
            assert (
                "--service-account=consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
                in invoked
            )
            assert "--clear-secrets" not in invoked
            assert (
                "--set-secrets=APP_SIGNING_KEY=APP_SIGNING_KEY:latest,VAULT_DATA_KEY=VAULT_DATA_KEY:latest"
                in invoked
            )
            assert "run.googleapis.com/execution_name" in invoked
            assert "jsonPayload.azure_pwm_runtime_probe_result" in invoked
            if verdict == "delayed":
                assert invoked.count("logging read") >= 2
        else:
            assert not invoked


def test_azure_pwm_probe_loads_production_contracts_without_application_secrets():
    script = REPO_ROOT / "consent-protocol/scripts/verify_azure_pwm_runtime.py"
    code = (
        "import importlib.util; "
        f"spec=importlib.util.spec_from_file_location('probe', {str(script)!r}); "
        "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
        "module._initialize_synthetic_runtime(); "
        "values, schemas=module._production_contract_examples(); "
        "assert set(values) == set(schemas) == {'assessment','finding','report','planner'}; "
        "from hushh_mcp.consent.audit_signing import audit_signing_status; "
        "assert audit_signing_status()['signing_key_configured']"
    )
    environment = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            "APP_SIGNING_KEY",
            "VAULT_DATA_KEY",
            "DATABASE_URL",
            "DB_CONNECTION_STRING",
        }
    }
    environment["ENVIRONMENT"] = "uat"
    environment["CONSENT_AUDIT_CHAIN_ENABLED"] = "true"
    result = subprocess.run(  # noqa: S603 - fixed probe import, no external input or credentials
        [sys.executable, "-c", code],
        env=environment,
        cwd=script.parent.parent,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_uat_drive_worker_uses_the_evaluated_fleet_model() -> None:
    from hushh_mcp.constants import FLEET_TEXT_MODEL_DEFAULT

    assert load_profile("uat")["text_model"] == FLEET_TEXT_MODEL_DEFAULT
    for path in (".github/workflows/deploy-uat.yml", "deploy/drive/deploy_worker_service.sh"):
        source = _read(path)
        assert "scripts/ops/managed_ai_config.py --environment uat" in source
        assert "HUSSH_GEMINI_TEXT_MODEL=gemini-" not in source
    assert "HUSSH_GEMINI_TEXT_MODEL=${MANAGED_TEXT_MODEL}" in _read(
        "deploy/drive/deploy_worker_service.sh"
    )


@pytest.mark.parametrize(
    "selector,default,expected_name",
    [
        ("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER_UAT", "gemini", "EXPECTED_SEMANTIC_MODEL_PROVIDER"),
        ("DRIVE_REQUEST_ACTIVITY_UNION_UAT_ENABLED", "true", "EXPECTED_ACTIVITY_UNION_ENABLED"),
        ("DRIVE_REQUEST_ACTIVITY_UNION_UAT_PAUSED", "false", "EXPECTED_ACTIVITY_UNION_PAUSED"),
    ],
)
def test_uat_semantic_provider_reaches_api_and_both_worker_revisions(
    selector, default, expected_name
) -> None:
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    steps = workflow["jobs"]["deploy"]["steps"]
    flag = selector.replace("_UAT", "")
    for step_id in ("deploy-backend", "deploy-drive-worker", "deploy-drive-v1-worker"):
        step = next(item for item in steps if item.get("id") == step_id)
        assert step["env"][selector] == "${{ vars." + selector + " || '" + default + "' }}"
    backend = next(item for item in steps if item.get("id") == "deploy-backend")
    assert f"_{flag}=${{{selector}}}" in backend["run"]
    build = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    assert build["substitutions"][f"_{flag}"] == default
    deployment = next(step for step in build["steps"] if step["id"] == "deploy-backend")
    assert (
        "_DRIVE_SEARCH_SETTINGS=${_DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED}|${_DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER}|${_DRIVE_REQUEST_ACTIVITY_UNION_ENABLED}|${_DRIVE_REQUEST_ACTIVITY_UNION_PAUSED}"
        in deployment["env"]
    )
    deployed_script = _read("scripts/deploy/backend-deploy.sh")
    assert "scripts/ops/managed_ai_config.py --environment uat --format validate" in deployed_script
    assert "scripts/ops/managed_ai_config.py --environment uat --format provider" in deployed_script
    for name in ("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "HUSHH_UAT_MANAGED_AI_PROVIDER"):
        assert f'"{name}=${{managed_provider}}"' in deployed_script
        assert f'"{name}=azure_openai"' not in deployed_script
    assert f'"{flag}=${{_{flag}}}"' in deployed_script
    assert (
        '"DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED=${_DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED}"'
        in deployed_script
    )
    for script in ("deploy_worker_service.sh", "deploy_v1_worker_service.sh"):
        source = _read(f"deploy/drive/{script}")
        defaults = source + _read("deploy/drive/activity_policy_flags.sh")
        assert f'{selector}="${{{selector}:-{default}}}"' in defaults
        assert f"{flag}=${{{selector}}}" in source
        assert f'{expected_name}="${{{selector}}}"' in source
    for lane in ("dev", "production"):
        assert f"_{flag}=" not in _read(f".github/workflows/deploy-{lane}.yml")


@pytest.mark.parametrize("lane", ["api", "worker", "v1"])
@pytest.mark.parametrize("provider", [None, "gemini", "azure_openai", "unknown"])
def test_uat_semantic_provider_deploy_guards_fail_closed(tmp_path, lane, provider) -> None:
    selector = "DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER_UAT"
    environment = {"PATH": os.environ["PATH"]}
    if provider is not None:
        environment[selector] = provider
    if lane == "api":
        workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
        backend = next(
            step
            for step in workflow["jobs"]["deploy"]["steps"]
            if step.get("id") == "deploy-backend"
        )
        start = backend["run"].index(
            "if grep -q '^[[:space:]]*_DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER:'"
        )
        end = backend["run"].index("\nfi", start) + len("\nfi")
        guard = backend["run"][start:end]
        (tmp_path / "deploy").mkdir()
        (tmp_path / "deploy/backend.cloudbuild.yaml").write_text(
            "  _DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER: gemini\n"
        )
        # GitHub supplies this declared default before the shell starts.
        environment.setdefault(selector, "gemini")
        guard = 'SUBSTITUTIONS=""\n' + guard
    else:
        script = "deploy_worker_service.sh" if lane == "worker" else "deploy_v1_worker_service.sh"
        source = _read(f"deploy/drive/{script}")
        start = source.index(f'{selector}="${{{selector}:-gemini}}"')
        end = source.index("\nesac", start) + len("\nesac")
        guard = source[start:end]
    result = subprocess.run(  # noqa: S603 - bounded authored guards, synthetic env, no cloud calls
        [shutil.which("bash") or "bash", "-c", "set -euo pipefail\n" + guard],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert (result.returncode == 0) is (provider != "unknown")


def test_uat_no_op_finishes_before_creating_a_deployment() -> None:
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    selection = workflow["jobs"]["select-target"]
    wait = workflow["jobs"]["wait-capacity"]
    deploy = workflow["jobs"]["deploy"]

    # A read-only no-op must not create a successful environment deployment
    # record or enter release classification with missing runtime evidence.
    assert "environment" not in selection
    assert selection["permissions"] == {
        "contents": "read",
        "checks": "read",
        "deployments": "read",
        "actions": "read",
    }
    assert wait["needs"] == ["select-target", "deployment-security"]
    assert wait["if"] == "needs.select-target.outputs.decision == 'DEPLOY_EXACT_SHA'"
    assert wait["environment"] == {"name": "uat", "deployment": False}
    assert deploy["needs"] == ["select-target", "wait-capacity", "deployment-security"]
    assert deploy["if"] == "needs.select-target.outputs.decision == 'DEPLOY_EXACT_SHA'"
    assert deploy["environment"] == "uat"

    resolver = next(step for step in selection["steps"] if step.get("id") == "resolve-sha")
    assert "--allow-no-op" in resolver["run"]
    assert "continue-on-error" not in resolver
    summary = next(
        step for step in selection["steps"] if step["name"] == "Summarize unchanged UAT target"
    )
    assert summary["if"] == "steps.resolve-sha.outputs.decision == 'NO_OP'"

    bridge = next(step for step in deploy["steps"] if step.get("id") == "resolve-sha")
    assert bridge["env"]["DEPLOY_SHA"] == "${{ needs.select-target.outputs.sha }}"
    validator = next(
        step for step in deploy["steps"] if step["name"] == "Validate deployment SHA against main"
    )
    assert validator["env"]["REQUIRE_CI_SUCCESS"] == "1"
    assert (
        validator["env"]["REQUIRED_BRANCH"] == "${{ steps.application-authority.outputs.branch }}"
    )
    assert (
        validator["env"]["REQUIRED_CHECK_NAME"]
        == "${{ steps.application-authority.outputs.checks || 'Main Post-Merge Smoke Gate' }}"
    )
    authority = next(step for step in deploy["steps"] if step.get("id") == "application-authority")
    assert deploy["steps"].index(authority) < deploy["steps"].index(validator)
    assert "promotion_approval.py uat" in authority["run"]
    assert "require-deploy-sha-on-main.sh" in validator["run"]


def test_manual_rollback_jobs_bind_exact_deployment_environments() -> None:
    workflow = yaml.safe_load(_read(".github/workflows/rollback.yml"))

    assert workflow["jobs"]["rollback-uat"]["environment"] == "uat"
    assert workflow["jobs"]["rollback-production"]["environment"] == "production"


@pytest.mark.parametrize(
    "scope",
    ["auto", "frontend", "backend"],
)
def test_initial_contacts_source_change_requires_paired_scope_before_builds(
    tmp_path: Path, scope: str
) -> None:
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    steps = workflow["jobs"]["deploy"]["steps"]
    scope_index = next(index for index, step in enumerate(steps) if step.get("id") == "scope")
    scope_step = steps[scope_index]
    frontend_build_index = next(
        index for index, step in enumerate(steps) if step.get("id") == "start-frontend-image-build"
    )
    assert scope_index < frontend_build_index
    assert "scripts/ci/resolve-deploy-scope.py" in scope_step["run"]
    assert "if" not in scope_step and "continue-on-error" not in scope_step
    for args in (
        ("init",),
        ("config", "user.email", "ci@example.test"),
        ("config", "user.name", "CI"),
    ):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)  # noqa: S603 - fixed Git fixture commands.
    (tmp_path / "README.md").write_text("compatible baseline\n")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "baseline"], cwd=tmp_path, check=True, capture_output=True
    )
    base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True).strip()
    source = tmp_path / "hushh-webapp/lib/contacts/initial-contact-onboarding-config.ts"
    source.parent.mkdir(parents=True)
    source.write_text(_read("hushh-webapp/lib/contacts/initial-contact-onboarding-config.ts"))
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "signup source"], cwd=tmp_path, check=True, capture_output=True
    )
    result = subprocess.run(  # noqa: S603 - production resolver against a synthetic local Git repository.
        [
            sys.executable,
            str(REPO_ROOT / "scripts/ci/resolve-deploy-scope.py"),
            "--requested-scope",
            scope,
            "--target-sha",
            "HEAD",
            "--backend-base-sha",
            base,
            "--frontend-base-sha",
            base,
            "--json",
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    if scope == "auto":
        assert result.returncode == 0, result.stderr
        decision = json.loads(result.stdout)
        assert decision["deploy_backend"] is True and decision["deploy_frontend"] is True
    else:
        assert result.returncode != 0
        assert "choose scope=all" in result.stderr


def test_uat_deploy_builds_candidates_without_serving_traffic() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = managed_vertex_probe_surface()
    backend_deploy = _backend_deploy()
    frontend_build = _read("deploy/frontend.cloudbuild.yaml")

    assert "group: deploy-uat\n" in workflow
    assert "_CLOUD_RUN_NO_TRAFFIC=true" in workflow
    assert '--to-revisions="${{ steps.candidate-state.outputs.backend_revision }}=100"' in workflow
    assert '--to-revisions="${{ steps.candidate-state.outputs.frontend_revision }}=100"' in workflow

    assert '_CLOUD_RUN_NO_TRAFFIC: "false"' in backend_build
    assert (
        'if [[ "${_CLOUD_RUN_NO_TRAFFIC}" == "true" ]]; then\n  cmd+=("--no-traffic")'
        in backend_deploy
    )
    assert '_CLOUD_RUN_NO_TRAFFIC: "false"' in frontend_build
    assert (
        'if [[ "${_CLOUD_RUN_NO_TRAFFIC}" == "true" ]]; then\n          cmd+=("--no-traffic")'
        in frontend_build
    )


def test_uat_drive_secret_wiring_is_explicit_and_default_off() -> None:
    """Drive-only credentials are opt-in UAT bindings, never generic fallbacks."""
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = managed_vertex_probe_surface()
    names = (
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
        "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
        "GOOGLE_DRIVE_PICKER_API_KEY",
        "EXTERNAL_CONNECTOR_CREDENTIAL_KEY",
        "DRIVE_DOCUMENT_KEY_V1",
        "DRIVE_SHARING_KEY_V1",
    )

    for name in names:
        assert f"_{name}_SECRET={name}" in workflow
        assert f'_{name}_SECRET: ""' in backend_build
        assert name in backend_build

    # Existing Gmail/Calendar credentials must never become an implicit Drive
    # fallback: Drive disconnect/revocation has a different blast radius.
    assert "GOOGLE_DRIVE_OAUTH_CLIENT_ID_SECRET=GMAIL_OAUTH_CLIENT_ID" not in workflow
    assert "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET_SECRET=GMAIL_OAUTH_CLIENT_SECRET" not in workflow


def test_stripe_secret_bindings_survive_payment_rollout_switch_off() -> None:
    """Existing paid-required requests still need Checkout and signed webhooks."""
    backend_build = managed_vertex_probe_surface()
    for lane in ("dev", "production"):
        workflow = _read(f".github/workflows/deploy-{lane}.yml")
        assert "_STRIPE_SECRET_KEY_SECRET=STRIPE_SECRET_KEY" in workflow
        assert "_STRIPE_WEBHOOK_SECRET_SECRET=STRIPE_WEBHOOK_SECRET" in workflow
        assert "_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET=STRIPE_CONNECT_WEBHOOK_SECRET" in workflow
        assert "_STRIPE_SECRET_KEY_SECRET=${{" not in workflow
        assert "_STRIPE_WEBHOOK_SECRET_SECRET=${{" not in workflow
        assert "_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET=${{" not in workflow

    uat = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    steps = uat["jobs"]["deploy"]["steps"]
    backend = next(step for step in steps if step.get("id") == "deploy-backend")
    worker = next(step for step in steps if step.get("id") == "deploy-drive-worker")
    mode_variable = "${{ vars.STRIPE_UAT_MODE || 'test' }}"
    assert backend["env"]["STRIPE_UAT_MODE"] == mode_variable
    assert worker["env"]["STRIPE_UAT_MODE"] == mode_variable
    assert "source deploy/drive/uat_stripe_bindings.sh" in backend["run"]
    assert backend["env"]["DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED"] == (
        "${{ vars.DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED || 'false' }}"
    )
    assert (
        "_DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED=${DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED}"
        in backend["run"]
    )
    assert worker["env"]["DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED"] == (
        "${{ vars.DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED || 'false' }}"
    )
    for runtime_name, selector_name in (
        ("STRIPE_SECRET_KEY", "STRIPE_UAT_KEY_SECRET"),
        ("STRIPE_WEBHOOK_SECRET", "STRIPE_UAT_WEBHOOK_SECRET"),
        ("STRIPE_CONNECT_WEBHOOK_SECRET", "STRIPE_UAT_CONNECT_SECRET"),
    ):
        assert f"_{runtime_name}_SECRET=${{{selector_name}}}" in backend["run"]

    worker_script = _read("deploy/drive/deploy_worker_service.sh")
    assert "source deploy/drive/uat_stripe_bindings.sh" in worker_script
    assert "STRIPE_SECRET_KEY=${STRIPE_UAT_KEY_SECRET}:latest" in worker_script
    assert "STRIPE_WEBHOOK_SECRET=${STRIPE_UAT_WEBHOOK_SECRET}:latest" in worker_script
    assert "STRIPE_CONNECT_WEBHOOK_SECRET=${STRIPE_UAT_CONNECT_SECRET}:latest" in worker_script
    selector = str(REPO_ROOT / "deploy/drive/uat_stripe_bindings.sh")
    # Selecting mode never depends on either new-order rollout switch: existing
    # money must retain its exact provider family even when enrollment stops.
    for mode in ("test", "live"):
        family = "STRIPE" if mode == "test" else "STRIPE_LIVE"
        expected = [
            mode,
            f"{family}_SECRET_KEY",
            f"{family}_WEBHOOK_SECRET",
            f"{family}_CONNECT_WEBHOOK_SECRET",
        ]
        for payments in ("false", "true"):
            for payouts in ("false", "true"):
                selected = subprocess.run(  # noqa: S603 - fixed shell and repository script; enum-only inputs
                    [
                        "/bin/bash",
                        "-c",
                        'source "$1"; printf "%s\\n" "$STRIPE_UAT_MODE" '
                        '"$STRIPE_UAT_KEY_SECRET" "$STRIPE_UAT_WEBHOOK_SECRET" '
                        '"$STRIPE_UAT_CONNECT_SECRET"',
                        "stripe-bindings-test",
                        selector,
                    ],
                    env={
                        "STRIPE_UAT_MODE": mode,
                        "DRIVE_REQUEST_PAYMENTS_UAT_ENABLED": payments,
                        "DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED": payouts,
                    },
                    capture_output=True,
                    text=True,
                    check=True,
                )
                assert selected.stdout.splitlines() == expected

    backend_deploy = _backend_deploy()
    secret_mounts = _read("scripts/deploy/scope-commerce-secrets.sh")
    # The build binds optional existing secrets, but refuses an enabled
    # new-request rollout unless both names resolve in the deploy project.
    assert (
        '"${_DRIVE_REQUEST_PAYMENTS_ENABLED}" == "true" || "${_DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED}" == "true"'
        in backend_deploy
    )
    assert (
        'for required_secret in "${_STRIPE_SECRET_KEY_SECRET}" "${_STRIPE_WEBHOOK_SECRET_SECRET}"; do'
        in backend_deploy
    )
    for name in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_CONNECT_WEBHOOK_SECRET"):
        assert f'append_optional_secret "${{_{name}_SECRET}}" "{name}"' in secret_mounts
    assert "/scope-commerce-secrets.sh" in backend_deploy
    assert "append_payment_provider_secrets" in backend_deploy
    assert '"${_DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED}" == "true"' in backend_deploy
    assert 'gcloud secrets describe "${_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET}"' in backend_deploy
    assert '_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET: ""' in backend_build


def test_document_owner_payouts_require_explicit_uat_api_and_worker_switches() -> None:
    """A UAT payout rollout must reach both runtimes and cannot silently reach production."""
    uat = _read(".github/workflows/deploy-uat.yml")
    production = _read(".github/workflows/deploy-production.yml")
    backend_build = managed_vertex_probe_surface()
    uat_worker = _read("deploy/drive/deploy_worker_service.sh")
    production_worker = _read("deploy/drive/deploy_worker_service_prod.sh")

    flag = "DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED"
    uat_variable = "${{ vars.DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED || 'false' }}"
    assert f"_{flag}={uat_variable}" in uat
    assert f"DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED: {uat_variable}" in uat
    assert f'_{flag}: "false"' in backend_build
    backend_deploy = _backend_deploy()
    for name in (flag, "STRIPE_MODE"):
        assert f'append_optional_env "{name}" "${{_{name}}}"' in backend_deploy
    assert f"owner_payouts_enabled=${{_{flag}}}" in backend_build
    assert f"{flag}=${{DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED:-false}}" in uat_worker
    assert '"${DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED:-false}" == "true"' in uat_worker
    assert f"_{flag}=" not in production
    assert f"{flag}=false" in production_worker


def test_frontend_verifies_server_chunks_before_binding_cloud_run_port() -> None:
    next_config = _read("hushh-webapp/next.config.ts")
    dockerfile = _read("hushh-webapp/Dockerfile")
    verifier = _read("hushh-webapp/scripts/runtime/verify-server-chunks.mjs")

    assert "preloadEntriesOnStart: true" in next_config
    assert "node scripts/runtime/verify-server-chunks.mjs && exec node server.js" in dockerfile
    assert "await readFile(chunk)" in verifier
    assert "No Next.js server chunks found" in verifier


def test_uat_automatic_rollback_prefers_predeploy_serving_revision() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    rollback_block = workflow[
        workflow.index("- name: Resolve rollback targets from predeploy traffic") : workflow.index(
            "- name: Resolve final Cloud Run state"
        )
    ]

    assert (
        'backend_revision="${{ steps.predeploy-state.outputs.backend_revision }}"' in rollback_block
    )
    assert (
        'frontend_revision="${{ steps.predeploy-state.outputs.frontend_revision }}"'
        in rollback_block
    )
    assert 'if [ -z "${backend_revision}" ]; then' in rollback_block
    assert 'if [ -z "${frontend_revision}" ]; then' in rollback_block
    assert "git fetch --force origin" in rollback_block
    assert "refs/tags/deployed/uat-latest:refs/tags/deployed/uat-latest" in rollback_block
    assert "scripts/ci/resolve-rollback-target.sh uat backend" in rollback_block
    assert "scripts/ci/resolve-rollback-target.sh uat frontend" in rollback_block
    assert "steps.rollback-targets.outputs.backend_revision" in rollback_block
    assert "steps.rollback-targets.outputs.frontend_revision" in rollback_block


def test_uat_deploy_pins_the_shared_firebase_authority() -> None:
    workflow_source = _read(".github/workflows/deploy-uat.yml")
    workflow = yaml.safe_load(workflow_source)

    assert workflow["env"]["UAT_FIREBASE_PROJECT_ID"] == "hushh-pda"
    assert (
        workflow_source.count('--expected-firebase-project "${{ env.UAT_FIREBASE_PROJECT_ID }}"')
        == 2
    )


def test_backend_and_readiness_job_share_the_supported_text_model_regions() -> None:
    backend_build = managed_vertex_probe_surface()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")

    assert load_profile("uat")["text_locations"] == ["global"]
    assert "_MANAGED_AI_CONFIG_HASH" in backend_build
    assert 'verdict.get("config_hash") != os.environ["EXPECTED_CONFIG_HASH"]' in backend_build
    assert '"config_hash": managed_ai_settings().config_hash' in _read(
        "consent-protocol/scripts/verify_managed_vertex_runtime.py"
    )
    assert "HUSHH_VERTEX_LOCATIONS=global,us,eu" not in backend_build
    # UAT always validates the deployed AI profile; semantic evaluation remains opt-in.
    assert '_VERIFY_MANAGED_VERTEX_RUNTIME: "false"' in backend_build
    assert 'case "${_VERIFY_MANAGED_VERTEX_RUNTIME}" in' in backend_build
    assert "true) probe_mode=full ;;" in backend_build
    assert "false)" in backend_build
    assert 'echo "_VERIFY_MANAGED_VERTEX_RUNTIME must be true or false." >&2' in backend_build
    assert (
        "Skipping managed Vertex candidate probe: live model checks were not requested."
        in backend_build
    )
    assert "verify_managed_vertex_runtime=true" in uat_workflow
    assert "steps.verification-plan.outputs.pkm_evaluator_runs" in uat_workflow
    assert "##_VERIFY_MANAGED_VERTEX_RUNTIME=${verify_managed_vertex_runtime}" in uat_workflow
    workflow = yaml.safe_load(uat_workflow)
    # PyYAML's YAML 1.1 loader treats the workflow `on` key as True.
    dispatch = workflow.get("on", workflow.get(True))["workflow_dispatch"]
    assert dispatch["inputs"]["run_live_model_checks"]["default"] is False
    assert '--run-live-model-checks "${{ inputs.run_live_model_checks' in uat_workflow
    semantic_steps = [
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("id") in {"verify-uat-1", "verify-uat-2"}
    ]
    assert len(semantic_steps) == 2
    for step in semantic_steps:
        assert (
            '--run-live-model-checks "${{ steps.verification-plan.outputs.run_live_model_checks }}"'
            in step["run"]
        )
    steps = workflow["jobs"]["deploy"]["steps"]
    preserve = next(
        step for step in steps if step.get("name") == "Preserve current release tooling"
    )
    checkout = next(step for step in steps if step.get("name") == "Checkout deployment SHA")
    assert steps.index(preserve) < steps.index(checkout)
    assert "cp scripts/ops/verify_uat_release.py" in preserve["run"]
    assert 'cp "${RUNNER_TEMP}/release-tools/verify_uat_release.py"' in checkout["run"]


def test_managed_vertex_readiness_job_clears_retained_runtime_secrets() -> None:
    backend_build = managed_vertex_probe_script()
    deploy_start = backend_build.index('gcloud run jobs deploy "${job_name}"')
    execute_start = backend_build.index('gcloud run jobs execute "${job_name}"')
    readiness_deploy = backend_build[deploy_start:execute_start]

    # Replacement semantics drop retained secrets. The application adapters
    # import core security configuration, but need no owner/provider secrets.
    assert "--clear-secrets" not in readiness_deploy
    assert (
        '--set-secrets="APP_SIGNING_KEY=${_APP_SIGNING_KEY_SECRET}:latest,VAULT_DATA_KEY=${_VAULT_DATA_KEY_SECRET}:latest"'
        in readiness_deploy
    )
    assert readiness_deploy.count("--set-secrets") == 1


def test_managed_vertex_readiness_job_has_cold_start_headroom() -> None:
    backend_build = managed_vertex_probe_script()
    deploy_start = backend_build.index('gcloud run jobs deploy "${job_name}"')
    execute_start = backend_build.index('gcloud run jobs execute "${job_name}"')
    readiness_deploy = backend_build[deploy_start:execute_start]

    # A 1 vCPU cold start reached the 90s task kill before any verdict.
    for flag in ("--cpu=2", "--memory=2Gi", "--task-timeout=420s"):
        assert flag in readiness_deploy
    assert "--task-timeout=90s" not in readiness_deploy


def test_backend_vertex_preflight_uses_supported_service_usage_command() -> None:
    backend_build = managed_vertex_probe_surface()

    assert "gcloud services list --enabled" in backend_build
    assert "--filter='config.name=aiplatform.googleapis.com'" in backend_build
    assert "gcloud services describe" not in backend_build


def _vertex_preflight_script(preflight: str) -> str:
    start = preflight.index("gcloud iam service-accounts describe")
    end = preflight.index('if [[ "${_PKM_ANSWER_PAYMENTS_ENABLED}"', start)
    decision = preflight[start:end]
    return (
        """set -euo pipefail
    gcloud() {
      printf 'CALL:%s\\n' "$*" >&2
      if [[ "$1 $2" == "iam service-accounts" ]]; then return 0; fi
      if [[ "${DENY_PROJECT_DISCOVERY}" == "true" ]]; then return 7; fi
      if [[ "$1 $2" == "services list" ]]; then
    printf 'aiplatform.googleapis.com\\n'
      elif [[ "$*" == *roles/aiplatform.user* ]]; then
    printf 'roles/aiplatform.user\\n'
      elif [[ "$*" == *roles/serviceusage.serviceUsageConsumer* ]]; then
    printf 'roles/serviceusage.serviceUsageConsumer\\n'
      else
    return 8
      fi
    }
    """
        + decision
    )


def test_uat_cross_project_vertex_preflight_defers_only_to_a_no_traffic_probe() -> None:
    build = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    steps = build["steps"]
    preflight = next(step["args"][-1] for step in steps if step.get("id") == "verify-runtime-iam")
    probe = managed_vertex_probe_script()
    step_ids = [step.get("id") for step in steps]
    assert step_ids.index("verify-runtime-iam") < step_ids.index("deploy-backend")
    assert step_ids.index("verify-managed-vertex-runtime") < step_ids.index("deploy-backend")
    deploy = next(step for step in steps if step.get("id") == "deploy-backend")
    assert "verify-managed-vertex-runtime" in deploy["waitFor"]

    # Execute the actual preflight decision with a fake build-principal gcloud.
    # Cross-project discovery is denied, as it is in the UAT Cloud Build account.
    script = _vertex_preflight_script(preflight)

    def run_case(
        deploy_env: str,
        no_traffic: str,
        probe_enabled: str,
        genai_project: str,
        *,
        deny_project_discovery: bool,
        deploy_project: str = "hushh-pda-uat",
        image: str = "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
        sha: str = "b" * 40,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed bash executes only repository YAML with a fake gcloud
            ["/bin/bash", "-c", script],
            env={
                "PROJECT_ID": deploy_project,
                "genai_project_id": genai_project,
                "_RUNTIME_SERVICE_ACCOUNT": "runtime@hushh-pda-uat.iam.gserviceaccount.com",
                "_DEPLOY_ENV": deploy_env,
                "_CLOUD_RUN_NO_TRAFFIC": no_traffic,
                "_VERIFY_MANAGED_VERTEX_RUNTIME": probe_enabled,
                "_IMAGE_REFERENCE": image,
                "_DEPLOY_SHA": sha,
                "DENY_PROJECT_DISCOVERY": "true" if deny_project_discovery else "false",
            },
            capture_output=True,
            text=True,
            check=False,
        )

    uat = load_profile("uat")["project"]
    deferred = run_case("uat", "true", "true", uat, deny_project_discovery=True)
    assert deferred.returncode == 0, deferred.stderr
    assert deferred.stderr.count("CALL:") == 1
    assert "CALL:iam service-accounts describe" in deferred.stderr

    for deploy_env, no_traffic, probe_enabled, project in (
        ("dev", "true", "true", uat),
        ("production", "true", "true", uat),
        ("uat", "true", "true", "hushh-pda-uat"),
    ):
        denied = run_case(
            deploy_env,
            no_traffic,
            probe_enabled,
            project,
            deny_project_discovery=True,
        )
        assert denied.returncode != 0, (deploy_env, no_traffic, probe_enabled, project)
        assert "CALL:services list --enabled" in denied.stderr

    # Missing capability-proof prerequisites fail even when administrative
    # reads would succeed; static IAM must not replace the mandatory probe.
    for overrides in (
        {"no_traffic": "false"},
        {"probe_enabled": "false"},
        {"deploy_project": "another-project"},
        {"image": "gcr.io/hushh-pda-uat/consent-protocol:latest"},
        {"image": "gcr.io/another-project/consent-protocol@sha256:" + "a" * 64},
        {"sha": "short-sha"},
    ):
        rejected = run_case(
            **{
                "deploy_env": "uat",
                "no_traffic": "true",
                "probe_enabled": "true",
                "genai_project": uat,
                "deny_project_discovery": False,
                **overrides,
            }
        )
        assert rejected.returncode != 0, overrides
        assert "CALL:services list" not in rejected.stderr

    static = run_case("production", "true", "true", uat, deny_project_discovery=False)
    assert static.returncode == 0, static.stderr
    assert static.stderr.count("CALL:projects get-iam-policy") == 2

    _assert_vertex_candidate_probe(probe)


def _assert_vertex_candidate_probe(probe: str) -> None:
    # Deferral is safe only while the exact runtime account probes the pinned
    # candidate image and positive chat/voice verdicts precede any advisory exit.
    assert '--service-account="${_RUNTIME_SERVICE_ACCOUNT}"' in probe
    assert '--image="${image_reference}"' in probe
    assert 'case "${_VERIFY_MANAGED_VERTEX_RUNTIME}" in' in probe
    advisory = probe.index('if [[ "${classification}" == "provider_unavailable" ]]; then')
    for required in (
        'verdict.get("config_hash") != os.environ["EXPECTED_CONFIG_HASH"]',
        'verdict.get("one_chat_project") != os.environ["EXPECTED_CHAT_PROJECT"]',
        "verdict.get(scope_field) is not True",
        'verdict.get("one_voice_probe_ok") is not True',
    ):
        assert probe.index(required) < advisory


def test_one_time_uat_vertex_skip_is_bound_to_the_approved_release(tmp_path: Path) -> None:
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    dispatch = workflow.get("on", workflow.get(True))["workflow_dispatch"]
    assert dispatch["inputs"]["skip_managed_vertex_probe_once"]["default"] is False
    steps = workflow["jobs"]["select-target"]["steps"]
    validation = next(
        step for step in steps if step["name"] == "Validate one-time Vertex probe exception"
    )
    assert validation["if"] == "inputs.skip_managed_vertex_probe_once"
    for required in (
        "a8e36651c17f6a0837530840fbeaf0ec3bbfcdf2",
        '"$REQUESTED_SCOPE" != "all"',
        '"$LIVE_CHECKS" != "false"',
        '"$GITHUB_ACTOR" != "ankitkumarsingh1702"',
    ):
        assert required in validation["run"]
    allowed_dispatch = {
        "REQUESTED_SHA": "a8e36651c17f6a0837530840fbeaf0ec3bbfcdf2",
        "REQUESTED_SCOPE": "all",
        "LIVE_CHECKS": "false",
        "GITHUB_ACTOR": "ankitkumarsingh1702",
    }

    def validate_dispatch(date: str = "2026-10-16", **overrides: str) -> int:
        script = f"date() {{ printf '%s\\n' '{date}'; }}\n" + validation["run"]
        result = subprocess.run(  # noqa: S603 - production workflow guard with synthetic inputs only.
            ["/bin/bash", "-c", script],
            env={**os.environ, **allowed_dispatch, **overrides},
            capture_output=True,
            text=True,
            check=False,
        )
        return result.returncode

    assert validate_dispatch() == 0
    assert validate_dispatch(REQUESTED_SHA="b" * 40) != 0
    assert validate_dispatch(REQUESTED_SCOPE="backend") != 0
    assert validate_dispatch(LIVE_CHECKS="true") != 0
    assert validate_dispatch(GITHUB_ACTOR="another-admin") != 0
    assert validate_dispatch(date="2026-10-18") != 0
    deploy = workflow["jobs"]["deploy"]["steps"]
    preserve = next(step for step in deploy if step["name"] == "Preserve current release tooling")
    checkout = next(step for step in deploy if step["name"] == "Checkout deployment SHA")
    assert "release-tools/backend.cloudbuild.yaml" in preserve["run"]
    assert "release-tools/backend.cloudbuild.yaml" in checkout["run"]
    for step in (preserve, checkout):
        assert '"${{ inputs.skip_managed_vertex_probe_once }}" == "true"' in step["run"]
    tools = _BACKEND_RELEASE_TOOL_FIXTURES
    (tmp_path / "runner/release-tools").mkdir(parents=True)
    for tool in tools:
        path = tmp_path / tool
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("current:" + tool)
    for index, step in enumerate((preserve, checkout)):
        script = step["run"]
        start = script.index('if [[ "${{ inputs.skip_managed_vertex_probe_once }}"')
        section = script[start : script.index("\nfi", start) + 3].replace(
            "${{ inputs.skip_managed_vertex_probe_once }}", "true"
        )
        result = subprocess.run(  # noqa: S603 - authored workflow, synthetic paths only.
            ["bash", "-euc", section],
            cwd=tmp_path,
            env={**os.environ, "RUNNER_TEMP": str(tmp_path / "runner")},
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        if index == 0:
            for tool in tools:
                (tmp_path / tool).unlink()
            (tmp_path / "deploy/sso/bind_workos.sh").write_text("old incompatible helper")
    assert all((tmp_path / tool).read_text() == "current:" + tool for tool in tools)
    assert (
        "!scripts/deploy/backend-capacity-settings.sh" in (tmp_path / ".gcloudignore").read_text()
    )
    backend = next(step for step in deploy if step.get("id") == "deploy-backend")
    assert (
        "##_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE=${{ inputs.skip_managed_vertex_probe_once }}"
        in backend["run"]
    )

    build = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    assert build["substitutions"]["_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE"] == "false"
    probe_step = next(
        step for step in build["steps"] if step.get("id") == "verify-managed-vertex-runtime"
    )
    assert (
        "_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE=${_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE}"
        in probe_step["env"]
    )
    probe = managed_vertex_probe_script()
    assert "one-time UAT Vertex probe skip" in probe
    assert probe.index("one-time UAT Vertex probe skip") < probe.index(
        'case "${_VERIFY_MANAGED_VERTEX_RUNTIME}" in'
    )
    preflight = next(
        step["args"][-1] for step in build["steps"] if step.get("id") == "verify-runtime-iam"
    )
    guard = preflight[: preflight.index('if [[ -z "${_RUNTIME_SERVICE_ACCOUNT}" ]]')]
    valid = {
        "PROJECT_ID": "hushh-pda-uat",
        "_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE": "true",
        "_DEPLOY_ENV": "uat",
        "_DEPLOY_SOURCE": "deploy-uat",
        "_DEPLOY_SHA": "a8e36651c17f6a0837530840fbeaf0ec3bbfcdf2",
        "_CLOUD_RUN_NO_TRAFFIC": "true",
        "_VERIFY_MANAGED_VERTEX_RUNTIME": "true",
        "_IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
        "_GITHUB_RUN_ID": "123456789",
        "_CLOUD_RUN_TAG": "account-deletion-123456789",
    }

    def run_case(date: str = "2026-10-16", **overrides: str) -> subprocess.CompletedProcess[str]:
        # Pin the clock like validate_dispatch: the guard compares today's UTC
        # date with the approved window, so the wall clock must not decide CI.
        script = f"date() {{ printf '%s\\n' '{date}'; }}\n" + guard
        return subprocess.run(  # noqa: S603 - production guard with synthetic environment only.
            ["/bin/bash", "-c", script],
            env={**os.environ, **valid, **overrides},
            capture_output=True,
            text=True,
            check=False,
        )

    approved = run_case()
    assert approved.returncode == 0, approved.stderr
    expired = run_case(date="2026-10-18")
    assert expired.returncode != 0, (expired.stdout, expired.stderr)
    for key, value in (
        ("PROJECT_ID", "another-project"),
        ("_DEPLOY_ENV", "production"),
        ("_DEPLOY_SOURCE", "manual"),
        ("_DEPLOY_SHA", "b" * 40),
        ("_CLOUD_RUN_NO_TRAFFIC", "false"),
        ("_VERIFY_MANAGED_VERTEX_RUNTIME", "false"),
        ("_IMAGE_REFERENCE", "gcr.io/hushh-pda-uat/consent-protocol:latest"),
        ("_GITHUB_RUN_ID", "not-a-run"),
        ("_CLOUD_RUN_TAG", "another-tag"),
        ("_SKIP_MANAGED_VERTEX_RUNTIME_FOR_RELEASE", "unexpected"),
    ):
        rejected = run_case(**{key: value})
        assert rejected.returncode != 0, (key, rejected.stdout, rejected.stderr)


def _healthy_vertex_verdict(project):
    return {
        "check": "managed_vertex_runtime",
        "ok": True,
        "classification": "dependency_ok",
        "candidate_models_exercised": True,
        "config_hash": "checked-profile-hash",
        "one_chat_project": project,
        "one_chat_probe_ok": None,
        "drive_document_requests_probe_ok": True,
        "one_voice_project": project,
        "one_voice_probe_ok": True,
        "live_model": "reviewed-live-model",
        "live_location": "reviewed-live-location",
        "probes": [
            {"probe": name, "ok": True, "classification": "dependency_ok"}
            for name in ("drive_document_requests:synthetic@global", "embedding", "one_voice_live")
        ],
    }


def test_uat_cross_project_vertex_requires_a_complete_successful_probe_verdict() -> None:
    probe = managed_vertex_probe_script()
    # Run the owning receipt parser and release decision. The job itself is
    # represented by its exit status/log line; no provider or gcloud is called.
    script = "set -euo pipefail\n" + probe[probe.index('classification="$(') :]
    project = load_profile("uat")["project"]
    healthy = _healthy_vertex_verdict(project)

    def run_verdict(
        report: dict | str,
        exit_status: int = 0,
        *,
        deploy_env: str = "uat",
        voice_enabled: str = "true",
        drive_provider: str = "gemini",
        drive_enabled: str = "true",
    ) -> subprocess.CompletedProcess[str]:
        line = (
            "managed_vertex_probe_result " + json.dumps(report)
            if isinstance(report, dict)
            else report
        )
        return subprocess.run(  # noqa: S603 - fixed shell executes repository verdict logic with synthetic values
            ["/bin/bash", "-c", script],
            cwd=REPO_ROOT,
            env={
                "PATH": str(Path(sys.executable).parent) + os.pathsep + os.defpath,
                "PROJECT_ID": "hushh-pda-uat",
                "genai_project_id": project,
                "_DEPLOY_ENV": deploy_env,
                "_ONE_VOICE_LIVE_ENABLED": voice_enabled,
                "_DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER": drive_provider,
                "_DRIVE_REQUEST_SEMANTIC_SEARCH_ENABLED": drive_enabled,
                "_CLOUD_RUN_NO_TRAFFIC": "true",
                "_MANAGED_AI_CONFIG_HASH": "checked-profile-hash",
                "_GENAI_PROJECT_ID": project,
                "_VERTEX_LIVE_MODEL_ID": "reviewed-live-model",
                "_VERTEX_LIVE_LOCATION": "reviewed-live-location",
                "probe_line": line,
                "execute_status": str(exit_status),
            },
            capture_output=True,
            text=True,
            check=False,
        )

    passed = run_verdict(healthy)
    assert passed.returncode == 0, passed.stderr
    for invalid in (
        "",
        "managed_vertex_probe_result not-json",
        {**healthy, "config_hash": "different-profile"},
        {**healthy, "one_chat_project": "different-project"},
        {**healthy, "drive_document_requests_probe_ok": False},
        {**healthy, "one_voice_probe_ok": False},
        {**healthy, "ok": False},
        {**healthy, "check": "different-check"},
        {**healthy, "candidate_models_exercised": False},
        {**healthy, "classification": "provider_unavailable"},
        {**healthy, "probes": []},
        {k: v for k, v in healthy.items() if k != "probes"},
        {**healthy, "probes": ["invalid-probe"]},
        {**healthy, "probes": [{"probe": "embedding", "ok": False}]},
    ):
        rejected = run_verdict(invalid)
        assert rejected.returncode != 0, invalid

    # Regression: chat success alone used to let a failed full runtime job
    # enter the provider-outage advisory and green the candidate build.
    partial = {
        **healthy,
        "ok": False,
        "classification": "provider_unavailable",
        "probes": [
            healthy["probes"][0],
            {"probe": "embedding", "ok": False, "classification": "provider_unavailable"},
        ],
    }
    assert run_verdict(partial, 85).returncode != 0
    assert run_verdict(healthy, 1).returncode != 0
    exhausted = {
        **healthy,
        "ok": False,
        "classification": "provider_unavailable",
        "candidate_models_exercised": False,
        "one_chat_probe_ok": None,
        "drive_document_requests_probe_ok": False,
        "one_voice_probe_ok": False,
        "probes": [
            {
                "probe": name,
                "ok": False,
                "classification": "provider_unavailable",
                "resource_exhausted": True,
            }
            for name in (
                "drive_document_requests:synthetic@global",
                "embedding",
                "one_voice_live:reviewed-live-model@reviewed-live-location",
            )
        ],
    }
    assert run_verdict(exhausted, 1, drive_provider="azure_openai").returncode == 0
    assert (
        run_verdict(exhausted, 1, drive_provider="azure_openai", drive_enabled="false").returncode
        != 0
    )
    assert run_verdict(exhausted, 1).returncode != 0
    assert (
        run_verdict(exhausted, 1, deploy_env="production", drive_provider="azure_openai").returncode
        != 0
    )
    for unsafe in (
        {
            **exhausted,
            "probes": [
                {**exhausted["probes"][0], "resource_exhausted": False},
                *exhausted["probes"][1:],
            ],
        },
        {
            **exhausted,
            "probes": [
                {**exhausted["probes"][0], "classification": "candidate_misconfigured"},
                *exhausted["probes"][1:],
            ],
        },
        {**exhausted, "probes": exhausted["probes"][1:]},
        {**exhausted, "probes": exhausted["probes"][:2]},
        {**exhausted, "config_hash": "other-profile"},
        {**exhausted, "one_chat_project": "wrong-project"},
        {**exhausted, "one_voice_project": "wrong-project"},
    ):
        assert run_verdict(unsafe, 1, drive_provider="azure_openai").returncode != 0, unsafe
    assert run_verdict(exhausted, 0, drive_provider="azure_openai").returncode != 0
    contradictory = {**exhausted, "probes": healthy["probes"]}
    assert run_verdict(contradictory, 1, drive_provider="azure_openai").returncode != 0
    legacy = run_verdict(
        {**partial, "one_chat_probe_ok": True}, 85, deploy_env="dev", voice_enabled="false"
    )
    assert legacy.returncode == 0, legacy.stderr
    assert "Release CONTINUES" in legacy.stdout


def test_backend_vertex_advisory_probe_parses_pretty_json_verdict() -> None:
    backend_build = managed_vertex_probe_surface()

    assert '--command="python3"' in backend_build
    assert '--command="python"' not in backend_build
    assert "PROBE_LINE=\"${probe_line}\" python3 - <<'PY'" in backend_build
    assert "PROBE_LINE=\"${probe_line}\" python - <<'PY'" not in backend_build
    assert 'marker = "managed_vertex_probe_result"' in backend_build
    assert "json.loads(payload)" in backend_build
    assert 'verdict.get("classification")' in backend_build
    assert 'sed -n \'s/.*"classification":"' not in backend_build


def test_managed_vertex_targets_follow_environment_profiles() -> None:
    backend_build = managed_vertex_probe_surface()
    assert {env: load_profile(env)["project"] for env in ("dev", "uat", "production")} == {
        "dev": "hushh-gemini-bridge",
        "uat": "hushh-gemini-bridge",
        "production": "hushh-gemini-bridge",
    }
    for env in ("dev", "uat", "production"):
        assert f"scripts/ops/managed_ai_config.py --environment {env}" in _read(
            f".github/workflows/deploy-{env}.yml"
        )
    assert "Managed AI profile hash mismatch." in backend_build
    assert "roles/serviceusage.serviceUsageConsumer" in backend_build
    assert '"GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"' in _backend_deploy()
    assert "GENAI_GOOGLE_CLOUD_PROJECT=${genai_project_id}" in _backend_deploy()
    assert '_GENAI_PROJECT_ID: ""' in backend_build


def test_one_chat_uses_central_project_and_verified_profile() -> None:
    backend_build = managed_vertex_probe_surface()
    readiness = _read("consent-protocol/scripts/verify_managed_vertex_runtime.py")
    workflow = _read(".github/workflows/deploy-uat.yml")
    assert "_HUSHH_ONE_CHAT_VERTEX_PROJECT=" not in workflow
    assert (
        '-n "${_HUSHH_ONE_CHAT_VERTEX_PROJECT}" || -n "${_HUSHH_ONE_VOICE_VERTEX_PROJECT}" ]]'
        in backend_build
    )
    assert 'EXPECTED_CHAT_PROJECT="${_GENAI_PROJECT_ID}"' in backend_build
    assert "verdict.get(scope_field) is not True" in backend_build
    assert 'verdict.get("config_hash") != os.environ["EXPECTED_CONFIG_HASH"]' in backend_build
    assert "binding.build_regional_adk_model(model)" in readiness
    assert '"one_chat_probe_ok": chat_ok' in readiness


def test_one_voice_uses_central_project_and_is_probed_before_traffic() -> None:
    backend_build = managed_vertex_probe_surface()
    readiness = _read("consent-protocol/scripts/verify_managed_vertex_runtime.py")
    for env in ("dev", "uat", "production"):
        workflow = _read(f".github/workflows/deploy-{env}.yml")
        assert "_HUSHH_ONE_VOICE_VERTEX_PROJECT=" not in workflow
        if env == "uat":
            assert "verify_managed_vertex_runtime=true" in workflow
            assert "_VERIFY_MANAGED_VERTEX_RUNTIME=${verify_managed_vertex_runtime}" in workflow
        else:
            assert "_VERIFY_MANAGED_VERTEX_RUNTIME=true" in workflow
    assert 'EXPECTED_VOICE_PROJECT="${_GENAI_PROJECT_ID}"' in backend_build
    assert 'EXPECTED_VOICE_MODEL="${_VERTEX_LIVE_MODEL_ID}"' in backend_build
    assert 'EXPECTED_VOICE_LOCATION="${_VERTEX_LIVE_LOCATION}"' in backend_build
    assert 'verdict.get("one_voice_probe_ok") is not True' in backend_build
    assert '"one_voice_project": voice_project or None' in readiness


def test_command_deploys_do_not_restore_live_or_model_pack_dependencies() -> None:
    sources = [
        _read("deploy/backend.cloudbuild.yaml"),
        _read(".github/workflows/deploy-uat.yml"),
        _read(".github/workflows/deploy-production.yml"),
        _read("consent-protocol/scripts/verify_managed_vertex_runtime.py"),
    ]
    for source in sources:
        assert "AGENT_ONE_ADK_MODEL" not in source
        assert "HUSHH_MANAGED_GEMINI_LIVE_API_KEY" not in source
        assert "LOCATION_COMMAND_GEMINI_LIVE" not in source
        assert "LOCATION_COMMAND_TRANSCRIBE_MODEL" not in source
        assert "gemini-3.5-transcribe-live-preview" not in source
        assert "gemini_live_capacity_pool" not in source
        assert "HUSHH_LOCAL_RUNTIME_PACK" not in source
        assert "ONE_VOICE_MODEL_URL_SIGNER" not in source
        # The retired relay's fail-open flag and the ADK live region pin must
        # not come back under their old names either.
        assert "AGENT_GEMINI_LIVE_ENABLED" not in source
        assert "AGENT_ONE_ADK_LOCATION" not in source
    assert "HUSSH_GEMINI_TEXT_MODEL" in sources[0]
    assert all("scripts/ops/managed_ai_config.py" in source for source in sources[1:3])
    assert "resolve_fleet_model_name" in sources[3]


def test_calendar_voice_details_are_enabled_only_for_uat_rollout() -> None:
    backend_build = managed_vertex_probe_surface()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert '_ONE_VOICE_CALENDAR_NARRATION_ENABLED: "false"' in backend_build
    assert "${_ONE_VOICE_CALENDAR_NARRATION_ENABLED}" in backend_build
    assert "_ONE_VOICE_CALENDAR_NARRATION_ENABLED=true" in uat_workflow
    assert "_ONE_VOICE_CALENDAR_NARRATION_ENABLED=true" not in production_workflow


def test_one_voice_live_env_contract_is_explicit_and_enabled_in_production() -> None:
    """One Live Voice runs on Vertex ADC only, behind one flag, with an exact model pin.

    Every lane carries the three names. Production enables the same live path as UAT.
    The pinned id must be the registry's native-realtime entry, so the deploy
    substitution and the registry can never disagree.
    """
    from hushh_mcp.runtime_providers.registry import resolve_live_model_entry

    backend_build = managed_vertex_probe_surface()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    dev_workflow = _read(".github/workflows/deploy-dev.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")

    for name in ("ONE_VOICE_LIVE_ENABLED", "VERTEX_LIVE_MODEL_ID", "VERTEX_LIVE_LOCATION"):
        assert name in backend_build
        if name == "ONE_VOICE_LIVE_ENABLED":
            assert all(
                f"_{name}=" in source
                for source in (uat_workflow, dev_workflow, production_workflow)
            )
    assert '_ONE_VOICE_LIVE_ENABLED: "false"' in backend_build
    assert '_VERTEX_LIVE_MODEL_ID: ""' in backend_build
    assert '_VERTEX_LIVE_LOCATION: ""' in backend_build
    assert "_ONE_VOICE_LIVE_ENABLED=true" in production_workflow
    assert "_ONE_VOICE_LIVE_ENABLED=true" in uat_workflow
    assert (
        '[[ "${_DEPLOY_ENV}" == "production" && "${_ONE_VOICE_LIVE_ENABLED}" == "true" ]]'
        in backend_build
    )
    assert "python3 scripts/ci/assert_one_voice_live_probe.py" in backend_build

    for env in ("uat", "dev", "production"):
        profile = load_profile(env)
        entry = resolve_live_model_entry(profile["live_model"])
        assert entry.supports_native_realtime is True
        assert profile["live_location"] in entry.supported_vertex_locations
        assert profile["live_location"] not in {"global", "us", "eu"}
    # Never an API key for Live in any lane.
    for source in (backend_build, uat_workflow, dev_workflow, production_workflow):
        assert "LIVE_API_KEY" not in source


def test_production_deploy_builds_candidates_without_serving_traffic() -> None:
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert "_CLOUD_RUN_NO_TRAFFIC=true" in production_workflow
    assert (
        '--to-revisions="${{ steps.candidate-state.outputs.backend_revision }}=100"'
        in production_workflow
    )
    assert (
        '--to-revisions="${{ steps.candidate-state.outputs.frontend_revision }}=100"'
        in production_workflow
    )


def test_hosted_backend_bounds_database_connection_fanout(tmp_path: Path) -> None:
    backend_build = managed_vertex_probe_surface()
    backend_deploy = _backend_deploy()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert '"DB_POOL_MIN_SIZE=${_DB_POOL_MIN_SIZE}"' in backend_deploy
    assert '"DB_POOL_MAX_SIZE=${_DB_POOL_MAX_SIZE}"' in backend_deploy
    assert '"DB_SQLALCHEMY_POOL_SIZE=${_DB_SQLALCHEMY_POOL_SIZE}"' in backend_deploy
    assert '"DB_SQLALCHEMY_MAX_OVERFLOW=${_DB_SQLALCHEMY_MAX_OVERFLOW}"' in backend_deploy
    assert (
        'append_optional_env "CONSENT_WEB_FALLBACK_ENABLED" "${_CONSENT_WEB_FALLBACK_ENABLED}"'
        in backend_deploy
    )
    assert 'append_optional_env "CONSENT_SSE_ENABLED" "${_CONSENT_SSE_ENABLED}"' in backend_deploy
    assert '"--max=${_CLOUD_RUN_MAX_INSTANCES}"' in backend_deploy
    assert '"--min=${_CLOUD_RUN_MIN_INSTANCES}"' in backend_deploy
    assert '"--min-instances=0"' in backend_deploy
    assert '_DB_POOL_MIN_SIZE: "1"' in backend_build
    assert '_DB_POOL_MAX_SIZE: "4"' in backend_build
    assert '_DB_SQLALCHEMY_POOL_SIZE: "4"' in backend_build
    assert '_DB_SQLALCHEMY_MAX_OVERFLOW: "0"' in backend_build

    # Both pools are per-process module globals, so the real Cloud SQL ceiling
    # is (pool sizes) x (gunicorn workers) x (Cloud Run instances). Read the
    # worker count from the image rather than hardcoding it: raising -w without
    # lowering the pools multiplies the ceiling silently, which is exactly how
    # this arithmetic drifted 2x out of date before 2026-08-23.
    gunicorn_workers = _container_worker_count(tmp_path)
    assert gunicorn_workers == 2

    assert "_DB_POOL_MIN_SIZE=1" in uat_workflow
    assert "_DB_POOL_MAX_SIZE=4" in uat_workflow
    assert "_DB_SQLALCHEMY_POOL_SIZE=3" in uat_workflow
    assert "_DB_SQLALCHEMY_MAX_OVERFLOW=0" in uat_workflow
    assert "_CONSENT_WEB_FALLBACK_ENABLED=false" in uat_workflow
    assert "_CONSENT_SSE_ENABLED=false" in uat_workflow
    assert "_CLOUD_RUN_MIN_INSTANCES=2" in uat_workflow
    assert "_CLOUD_RUN_MAX_INSTANCES=5" in uat_workflow
    # Each gunicorn WORKER opens the asyncpg pool (DB_POOL_MAX_SIZE) plus the
    # SQLAlchemy pool (DB_SQLALCHEMY_POOL_SIZE + DB_SQLALCHEMY_MAX_OVERFLOW).
    # Both pools are module globals, so the ceiling is per worker process and
    # multiplies by the gunicorn worker count before it multiplies by instances.
    # UAT: 7 per worker, 14 per instance, 70 total across 5 instances.
    #
    # The admission check counts serving, rollback, and new candidate
    # revisions at revision-level maxScale, plus jobs and administration.
    budget = json.loads(_read("config/runtime-capacity.json"))
    assert budget["database_max_connections"] == 1000
    # 900 since 2026-10-15: measured num_backends peaked at 256 over 7 days.
    assert budget["admission_limit"] == 900
    assert budget["administrative_reserve"] == 100

    uat_per_worker = 4 + 3 + 0
    assert uat_per_worker == 7
    assert uat_per_worker * gunicorn_workers == 14
    uat_total = uat_per_worker * gunicorn_workers * 5
    assert uat_total == 70
    uat_candidate = budget["environments"]["uat"]["services"]["consent-protocol"]["candidate"]
    assert uat_candidate["workers_per_instance"] == gunicorn_workers
    assert uat_total * 3 <= budget["admission_limit"] - budget["administrative_reserve"]

    assert "_DB_POOL_MIN_SIZE=1" in production_workflow
    assert "_DB_POOL_MAX_SIZE=4" in production_workflow
    assert "_DB_SQLALCHEMY_POOL_SIZE=4" in production_workflow
    assert "_DB_SQLALCHEMY_MAX_OVERFLOW=0" in production_workflow
    assert "_CONSENT_WEB_FALLBACK_ENABLED=false" in production_workflow
    assert "_CONSENT_SSE_ENABLED=false" in production_workflow
    assert "_CLOUD_RUN_MIN_INSTANCES=1" in production_workflow
    assert "_CLOUD_RUN_MAX_INSTANCES=5" in production_workflow
    # Production: 8 per worker, 16 per instance, 80 total across 5 instances
    # (overflow pinned to 0 so the ceiling is deterministic, not a burstable
    # QueuePool overflow that can exhaust Cloud SQL slots).
    prod_per_worker = 4 + 4 + 0
    assert prod_per_worker == 8
    assert prod_per_worker * gunicorn_workers == 16
    prod_total = prod_per_worker * gunicorn_workers * 5
    assert prod_total == 80
    prod_candidate = budget["environments"]["production"]["services"]["consent-protocol"][
        "candidate"
    ]
    assert prod_candidate["workers_per_instance"] == gunicorn_workers
    prod_policy = budget["environments"]["production"]["connection_policy"]
    assert prod_policy == {
        "database_max_connections": 400,
        "admission_limit": 300,
        "administrative_reserve": 30,
    }
    # Serving + retained rollback + candidate, optional worker and overlapping
    # readiness jobs all fit without inheriting UAT's larger database ceiling.
    assert (
        prod_total * 3 + 6 + 16 + prod_policy["administrative_reserve"]
        <= prod_policy["admission_limit"]
    )

    for workflow in (uat_workflow, production_workflow):
        assert 'BACKEND_REVISION_RETENTION: "2"' in workflow
        assert 'FRONTEND_REVISION_RETENTION: "10"' in workflow


def test_production_secret_parity_fails_closed_before_traffic() -> None:
    workflow = _read(".github/workflows/deploy-production.yml")

    parity_position = workflow.index("- name: Verify production candidate runtime env parity")
    promote_position = workflow.index("- name: Promote deployed revisions to production traffic")
    assert parity_position < promote_position
    steps = yaml.safe_load(workflow)["jobs"]["deploy"]["steps"]
    promote = next(step for step in steps if step.get("id") == "promote-traffic")
    assert promote["if"].startswith(
        "env.PHONE_DEPLOY_PHASE != 'cold' && (steps.verify-parity.outcome == 'success' &&"
    )
    assert '--backend-revision "${{ steps.candidate-state.outputs.backend_revision }}"' in workflow
    assert (
        '--frontend-revision "${{ steps.candidate-state.outputs.frontend_revision }}"' in workflow
    )
    assert '|| [ "$parity_failed" = "true" ]' in workflow
    assert "parity_failed=$parity_failed (warning-only)" not in workflow
    assert "--require-connected-systems" in workflow
    assert "- name: Verify production Connected Systems Omni Gateway" in workflow
    assert (
        workflow.index("- name: Verify production Connected Systems Omni Gateway")
        < promote_position
    )
    assert "steps.verify-connected-systems.outcome == 'success'" in workflow
    assert "CONNECTED_SYSTEMS_OUTCOME: ${{ steps.verify-connected-systems.outcome }}" in workflow
    assert '|| [ "$connected_systems_failed" = "true" ]' in workflow
    assert "CONSENT_API_PUBLIC_ORIGIN: https://api.hushh.ai" in workflow
    assert "_CONSENT_API_PUBLIC_ORIGIN=${{ env.CONSENT_API_PUBLIC_ORIGIN }}" in workflow


def test_production_release_result_fails_closed_on_upstream_or_missing_classification() -> None:
    workflow = _read(".github/workflows/deploy-production.yml")

    assert "UPSTREAM_JOB_STATUS: ${{ job.status }}" in workflow
    assert 'if [ "$UPSTREAM_JOB_STATUS" != "success" ]; then' in workflow
    assert 'if [ "$upstream_failed" = "true" ]' in workflow
    assert (
        workflow.count('if [ "${{ steps.classify.outputs.release_failed }}" != "false" ]; then')
        == 1
    )
    assert 'if [ "$STATUS" != "healthy" ]; then' in workflow


def test_production_release_verifies_provenance_and_publishes_evidence() -> None:
    workflow = _read(".github/workflows/deploy-production.yml")

    promote_position = workflow.index("- name: Promote deployed revisions to production traffic")
    backend_provenance_position = workflow.index(
        "- name: Verify production backend deployment provenance"
    )
    frontend_provenance_position = workflow.index(
        "- name: Verify production frontend deployment provenance"
    )
    assert promote_position < backend_provenance_position < frontend_provenance_position
    assert workflow.count("scripts/ci/verify-cloudrun-revision-provenance.py") >= 2
    assert "--expected-env production" in workflow
    assert "--expected-source deploy-production" in workflow
    assert "--report-path /tmp/prod-backend-provenance.json" in workflow
    assert "--report-path /tmp/prod-frontend-provenance.json" in workflow
    assert "- name: Write production release status artifact" in workflow
    assert "- name: Upload production deploy artifacts" in workflow
    release_status_path = "/" + "tmp/prod-release-status.json"
    assert release_status_path in workflow
    assert "if-no-files-found: error" in workflow
    assert (
        'steps.final-state.outputs.backend_serving }}" != "${{ steps.candidate-state.outputs.backend_revision'
        in workflow
    )
    assert (
        'steps.final-state.outputs.frontend_serving }}" != "${{ steps.candidate-state.outputs.frontend_revision'
        in workflow
    )
    assert (
        'steps.final-state.outputs.backend_serving }}" != "${{ steps.phone-rollback-qualified.outputs.revision'
        in workflow
    )
    assert (
        'steps.final-state.outputs.frontend_serving }}" != "${{ (steps.phone-rollback-plan.outputs.frontend_revision || steps.predeploy-state.outputs.frontend_revision)'
        in workflow
    )
    assert 'if [ "$STATUS" != "healthy" ]; then' in workflow


def test_production_partial_promotion_failure_rolls_back_every_selected_service() -> None:
    workflow = _read(".github/workflows/deploy-production.yml")

    promote_failure = workflow.index('if [ "$PROMOTE_OUTCOME" = "failure" ]; then')
    provenance_failure = workflow.index(
        'if [ "$DEPLOY_BACKEND" = "true" ] && [ "$PROMOTE_OUTCOME" = "success" ]'
    )
    classification = workflow[promote_failure:provenance_failure]
    assert (
        'if [ "$DEPLOY_BACKEND" = "true" ]; then\n              backend_failure=true'
        in classification
    )
    assert (
        'if [ "$DEPLOY_FRONTEND" = "true" ]; then\n              frontend_failure=true'
        in classification
    )
    assert "steps.classify.outputs.backend_failure == 'true'" in workflow
    assert "steps.classify.outputs.frontend_failure == 'true'" in workflow


def test_production_wif_has_one_keyless_setup_path() -> None:
    setup_script = _read("deploy/iam/setup_production_github_wif.sh")

    assert 'readonly PROD_PROJECT_ID="hushh-pda"' in setup_script
    assert 'readonly GITHUB_ENVIRONMENT="production"' in setup_script
    assert "environment:${GITHUB_ENVIRONMENT}" in setup_script
    assert "assertion.ref == 'refs/heads/main'" in setup_script
    assert "roles/iam.workloadIdentityUser" in setup_script
    assert 'build_service_account_email="${prod_project_number}-compute' in setup_script
    assert (
        'RUNTIME_SERVICE_ACCOUNT_EMAIL="consent-protocol-runtime@${PROD_PROJECT_ID}' in setup_script
    )
    assert setup_script.count('"roles/iam.serviceAccountUser"') == 2
    assert 'readonly BACKEND_ARTIFACT_REPOSITORY="gcr.io"' in setup_script
    assert 'readonly BACKEND_ARTIFACT_LOCATION="us"' in setup_script
    assert "gcloud artifacts repositories add-iam-policy-binding" in setup_script
    assert '"roles/artifactregistry.reader"' in setup_script
    assert "gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER" in setup_script
    assert "gh variable set GCP_DEPLOY_SERVICE_ACCOUNT" in setup_script
    assert "service-account keys create" not in setup_script


def test_production_health_gates_only_probe_after_successful_promotion() -> None:
    steps = yaml.safe_load(_read(".github/workflows/deploy-production.yml"))["jobs"]["deploy"][
        "steps"
    ]
    for lane in ("backend", "frontend"):
        gate = next(step for step in steps if step.get("id") == f"health-{lane}")
        assert gate["if"] == (
            f"env.PHONE_DEPLOY_PHASE != 'cold' && (steps.scope.outputs.deploy_{lane} == 'true' "
            "&& steps.promote-traffic.outcome == 'success')"
        )


def test_nonproduction_rollback_targets_are_traffic_bearing_revisions() -> None:
    for path, expected_unguarded_candidate_lookups in (
        # UAT resolves governed candidates from exact deployment labels. Dev
        # still uses latestCreatedRevisionName for its non-release candidates.
        (".github/workflows/deploy-uat.yml", 0),
        (".github/workflows/deploy-dev.yml", 2),
    ):
        workflow = _read(path)
        assert workflow.count("status.latestReadyRevisionName") == 0
        assert (
            workflow.count("status.latestCreatedRevisionName")
            == expected_unguarded_candidate_lookups
        )
        assert "--format='value(status.traffic[0].revisionName)'" not in workflow
        assert "resolve-cloud-run-serving-state.py" in workflow


def _managed_provider_gate():
    spec = importlib.util.spec_from_file_location(
        "managed_provider_readiness", REPO_ROOT / "scripts/ci/managed_provider_readiness.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _capability_results_fixture(policy):
    capabilities = {
        name: {"ready": True, "elapsed_ms": 1} for name in policy["required_capabilities"]
    }
    for name in ("structured_text", "image_input", "pdf_input"):
        capabilities[name]["synthetic_content_verified"] = True
    capabilities["structured_text"]["streaming_observed"] = True
    capabilities["public_search"].update(cited_sources=1, fresh_page_retrieval_claimed=False)
    if "compact_public_search" in capabilities:
        capabilities["compact_public_search"].update(
            cited_sources=1,
            fresh_page_retrieval_claimed=False,
            synthetic_content_verified=True,
        )
    capabilities["public_source"]["http_receipts"] = 1
    capabilities["location_transcription"]["synthetic_phrase_verified"] = True
    capabilities["location_semantics"]["steps"] = 1
    capabilities["narration"].update(audio_bytes=4800, sample_rate=24000, chunks=2)
    capabilities["live_audio"].update(
        function_round_trip=True,
        audio_bytes=4800,
        sample_rate=24000,
        input_sample_rate=16000,
        input_transcription_verified=True,
    )
    capabilities["embeddings"]["dimensions"] = 768
    if "one_text_root" in capabilities:
        capabilities["one_text_root"].update(
            synthetic_content_verified=True,
            streaming_observed=True,
            function_round_trip=True,
            steps=2,
            tools_sent=70,
        )
    return capabilities


def _provider_fixture(module, provider, *, document=None):
    from uuid import UUID, uuid5

    document = (
        document
        if document is not None
        else json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    )
    expected = module.context(
        {
            "READINESS_BUILD_ID": "11111111-1111-4111-8111-111111111111",
            "READINESS_SOURCE_SHA": "a" * 40,
            "READINESS_IMAGE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "b" * 64,
            "READINESS_RUNTIME_ACCOUNT": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "READINESS_PROJECT": "hushh-pda-uat",
            "READINESS_REGION": "us-central1",
            "READINESS_GITHUB_RUN": "12345",
            "READINESS_ENVIRONMENT": "uat",
        }
    )
    expected["config_fingerprint"] = module.fingerprint(document)
    core = {
        "schema": "managed_text_probe.v1",
        "provider": provider,
        "ready": True,
        "policy_generation": str(
            uuid5(
                UUID(document["private_drive_text_uat"]["policy_id"]),
                document["private_drive_text_uat"]["version"]
                + (":vertex" if provider == "vertex" else ""),
            )
        ),
        "config_fingerprint": expected["config_fingerprint"],
        "scopes": {
            scope: {
                "ready": True,
                "provider": provider,
                "model": document["managed_runtime_uat"]["azure"]["one_text_root"]["deployment"]
                if provider == "azure_openai" and scope == "one_text_chat"
                else document["pwm_research_uat"]["azure"]["primary_deployment"]
                if provider == "azure_openai"
                else document["environments"]["uat"]["text_model"],
                "location": ""
                if provider == "azure_openai"
                else document["environments"]["uat"]["text_locations"][0],
            }
            for scope in module.PROVIDER_SCOPES[provider]
        },
    }
    job = ("azure-pwm-" if provider == "azure_openai" else "genai-ready-") + expected["build_id"]
    receipt = {
        "schema": "managed_provider_execution.v1",
        "provider": provider,
        "context": expected,
        "verified": True,
        "core_ready": True,
        "core": core,
        "job": job,
        "execution": job + "-abc12",
        "execution_image": expected["image"],
        "runtime_account": expected["runtime_account"],
        "execution_terminal": "True",
        "step_exit": 0,
        "capabilities": {},
    }
    policy = document["managed_runtime_uat"]
    digest = module.fingerprint({"policy": policy, "azure": document["pwm_research_uat"]["azure"]})
    capabilities = _capability_results_fixture(policy)
    if provider == "vertex":
        capabilities["public_source"].update(research_contracts=1, attribution_cases=8)
    receipt["capability_proof"] = {
        "schema": "managed_capabilities_probe.v1",
        "provider": provider,
        "config_fingerprint": expected["config_fingerprint"],
        "policy_generation": str(
            uuid5(UUID(policy["policy_id"]), policy["version"] + digest + provider)
        ),
        "synthetic_only": True,
        "capabilities": capabilities,
        "ready": True,
        "elapsed_ms": 10,
    }
    if provider == "azure_openai":
        receipt.update(
            pwm_trust="passed",
            pwm_proof=pwm_proof_fixture(document),
        )
        receipt["capabilities"]["pwm_model_contract"] = True
    return expected, receipt


@pytest.mark.parametrize(
    "azure,vertex",
    [(True, False), (False, True), (True, True), (False, False)],
)
@pytest.mark.parametrize("configured", ["azure_openai", "vertex"])
def test_provider_release_admission_qualifies_the_configured_provider(azure, vertex, configured):
    module = _managed_provider_gate()
    document = json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    document["managed_provider_selection"]["uat"] = configured
    expected, a = _provider_fixture(module, "azure_openai", document=document)
    _, v = _provider_fixture(module, "vertex", document=document)
    result = module.evaluate(
        {"azure_openai": a if azure else None, "vertex": v if vertex else None},
        expected,
        document=document,
    )
    selected = configured if (azure if configured == "azure_openai" else vertex) else None
    assert result["ready"] is (selected is not None)
    assert result["selected_provider"] == selected


@pytest.mark.parametrize("provider", ["azure_openai", "vertex"])
@pytest.mark.parametrize(
    "defect",
    [
        "missing",
        "failed",
        "generation",
        "stream",
        "extra_body",
        "bool_count",
        "compact_missing",
        "compact_failed",
        "compact_uncited",
        "compact_fact",
        "compact_page_claim",
        "root_missing",
        "root_function",
        "root_stream",
        "root_inventory",
        "failed_execution",
        "failed_step",
    ],
)
def test_complete_provider_gate_rejects_missing_or_misbound_capability_proof(provider, defect):
    module = _managed_provider_gate()
    document = json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    document["managed_provider_selection"]["uat"] = provider
    expected, receipt = _provider_fixture(module, provider, document=document)
    assert module.evaluate({provider: receipt}, expected, document=document)["ready"] is True
    proof = receipt["capability_proof"]
    if defect == "failed_execution":
        receipt["execution_terminal"] = "False"
    elif defect == "failed_step":
        receipt["step_exit"] = 1
    elif defect == "missing":
        proof["capabilities"].pop("live_audio")
    elif defect == "failed":
        proof["capabilities"]["image_input"]["ready"] = False
    elif defect == "generation":
        proof["policy_generation"] = "stale"
    elif defect == "stream":
        proof["capabilities"]["structured_text"]["streaming_observed"] = False
    elif defect == "extra_body":
        proof["capabilities"]["structured_text"]["response_body"] = "not admissible"
    elif defect == "root_missing":
        proof["capabilities"].pop("one_text_root")
    elif defect == "root_function":
        proof["capabilities"]["one_text_root"]["function_round_trip"] = False
    elif defect == "root_stream":
        proof["capabilities"]["one_text_root"]["streaming_observed"] = False
    elif defect == "root_inventory":
        proof["capabilities"]["one_text_root"]["tools_sent"] = 1
    elif defect == "compact_missing":
        proof["capabilities"].pop("compact_public_search")
    elif defect == "compact_failed":
        proof["capabilities"]["compact_public_search"]["ready"] = False
    elif defect == "compact_uncited":
        proof["capabilities"]["compact_public_search"]["cited_sources"] = 0
    elif defect == "compact_fact":
        proof["capabilities"]["compact_public_search"]["synthetic_content_verified"] = False
    elif defect == "compact_page_claim":
        proof["capabilities"]["compact_public_search"]["fresh_page_retrieval_claimed"] = True
    else:
        proof["capabilities"]["public_source"]["http_receipts"] = True
    assert module.evaluate({provider: receipt}, expected, document=document)["ready"] is False


def test_vertex_core_receipt_uses_the_actual_selected_policy_generation(monkeypatch):
    from hushh_mcp.runtime_providers.managed_text import managed_text_policy

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "vertex")
    module = _managed_provider_gate()
    expected, receipt = _provider_fixture(module, "vertex")
    policy = managed_text_policy()
    receipt["core"]["policy_generation"] = policy["generation"]
    result = module.evaluate({"vertex": receipt}, expected)
    assert result["ready"] is False
    assert result["providers"]["vertex"]["ready"] is True


@pytest.mark.parametrize(
    "defect",
    ["image", "context", "scope", "model", "generation", "duplicate_trust", "failed_trust"],
)
def test_provider_gate_rejects_stale_partial_or_unsafe_evidence(defect):
    module = _managed_provider_gate()
    expected, value = _provider_fixture(module, "azure_openai")
    if defect == "image":
        value["execution_image"] = "wrong-image"
    elif defect == "context":
        value["context"] = {**expected, "source_sha": "d" * 40}
    elif defect == "scope":
        value["core"]["scopes"].pop("drive_document_requests")
    elif defect == "model":
        value["core"]["scopes"]["one_text_chat"]["model"] = "another-model"
    elif defect == "generation":
        value["core"]["policy_generation"] = "old"
    elif defect == "duplicate_trust":
        value["pwm_proof"] = [value["pwm_proof"]] * 2
    else:
        value["pwm_trust"] = "failed"
    assert module.evaluate({"azure_openai": value}, expected)["ready"] is False
    if defect == "failed_trust":
        _, alternate = _provider_fixture(module, "vertex")
        assert (
            module.evaluate({"azure_openai": value, "vertex": alternate}, expected)["ready"]
            is False
        )


@pytest.mark.parametrize("contract_failure", [False, True, "terminal_first"])
def test_collector_waits_for_terminal_and_retains_later_contract_failure(
    monkeypatch, contract_failure
):
    module = _managed_provider_gate()
    expected, value = _provider_fixture(module, "azure_openai")
    core_log = {"jsonPayload": {"managed_text_provider_probe": value["core"]}}
    success = [
        core_log,
        {"jsonPayload": value["pwm_proof"]},
        {"jsonPayload": {"managed_capabilities_probe": value["capability_proof"]}},
        {"jsonPayload": {"azure_pwm_runtime_probe_result": "ok"}},
    ]
    failure = [
        core_log,
        {
            "jsonPayload": {
                "azure_pwm_probe_failure": "source attribution",
                "failed_fields": ["namesake"],
            }
        },
        {"jsonPayload": {"azure_pwm_runtime_probe_result": "failed", "error_type": "RuntimeError"}},
    ]
    if contract_failure == "terminal_first":
        # The terminal line carries the trust verdict even if the separate
        # authored-case marker has not reached Cloud Logging yet.
        failure = [
            core_log,
            {
                "jsonPayload": {
                    "azure_pwm_runtime_probe_result": "failed",
                    "error_type": "AzurePwmTrustError",
                    "pwm_trust_failure": True,
                }
            },
        ]
    calls = []

    def cloud(args):
        if args[:4] == ["run", "jobs", "executions", "list"]:
            return [{"metadata": {"name": value["execution"]}}]
        if args[:4] == ["run", "jobs", "executions", "describe"]:
            return {
                "metadata": {"ownerReferences": [{"name": value["job"]}]},
                "spec": {
                    "template": {
                        "spec": {
                            "serviceAccountName": expected["runtime_account"],
                            "containers": [
                                {
                                    "image": expected["image"],
                                    "command": ["python3"],
                                    "args": ["scripts/verify_azure_pwm_runtime.py"],
                                    "env": [
                                        {"name": "ENVIRONMENT", "value": "uat"},
                                        {
                                            "name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER",
                                            "value": "azure_openai",
                                        },
                                        {
                                            "name": "HUSHH_UAT_MANAGED_AI_PROVIDER",
                                            "value": "azure_openai",
                                        },
                                    ],
                                }
                            ],
                        }
                    }
                },
                "status": {
                    "conditions": [
                        {"type": "Completed", "status": "False" if contract_failure else "True"}
                    ]
                },
            }
        assert args[:2] == ["logging", "read"]
        calls.append(args)
        return [core_log] if len(calls) == 1 else failure if contract_failure else success

    monkeypatch.setattr(module, "run_json", cloud)
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    collected = module.collect("azure_openai", expected, int(bool(contract_failure)), value["job"])
    assert len(calls) >= 2
    assert collected["core_ready"] is (not contract_failure)
    assert collected["pwm_trust"] == ("failed" if contract_failure else "passed")
    _, alternate = _provider_fixture(module, "vertex")
    admitted = module.evaluate({"azure_openai": collected, "vertex": alternate}, expected)
    assert admitted["ready"] is (not contract_failure)


@pytest.mark.parametrize("defect", [None, "already_live", "wrong_sha", "wrong_image"])
def test_provider_selection_requires_the_exact_unserved_candidate(defect):
    module = _managed_provider_gate()
    expected, _ = _provider_fixture(module, "azure_openai")
    env = {
        "HUSHH_DEPLOY_SHA": expected["source_sha"],
        "HUSHH_DEPLOY_RUN_ID": expected["github_run"],
        "HUSHH_DEPLOY_ENV": "uat",
        "HUSHH_UAT_MANAGED_TEXT_PROVIDER": "vertex",
        "HUSHH_UAT_MANAGED_AI_PROVIDER": "vertex",
    }
    container = {
        "image": expected["image"],
        "env": [{"name": k, "value": v} for k, v in env.items()],
    }
    traffic = {"tag": "account-deletion-12345", "revisionName": "candidate", "percent": 0}
    service = {
        "spec": {
            "template": {
                "spec": {
                    "serviceAccountName": expected["runtime_account"],
                    "containers": [container],
                }
            }
        },
        "status": {
            "latestCreatedRevisionName": "candidate",
            "latestReadyRevisionName": "candidate",
            "traffic": [traffic],
        },
    }
    if defect == "already_live":
        traffic["percent"] = 100
    elif defect == "wrong_sha":
        container["env"][0]["value"] = "d" * 40
    elif defect == "wrong_image":
        container["image"] = "wrong"
    if defect:
        with pytest.raises(ValueError):
            module.candidate(service, expected, "account-deletion-12345")
    else:
        assert module.candidate(service, expected, "account-deletion-12345") == (
            "candidate",
            "vertex",
        )


def test_required_provider_aggregate_cannot_be_allowed_to_fail():
    steps = {s["id"]: s for s in yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))["steps"]}
    aggregate = steps["verify-managed-provider-readiness"]
    assert aggregate.get("allowFailure", False) is False
    assert set(aggregate["waitFor"]) == {
        "deploy-backend",
        "verify-azure-pwm-runtime",
        "verify-managed-vertex-runtime",
    }
    for provider in ("verify-azure-pwm-runtime", "verify-managed-vertex-runtime"):
        if provider == "verify-managed-vertex-runtime":
            assert provider in steps["deploy-backend"]["waitFor"]
            shell = _read("scripts/deploy/verify-managed-vertex-runtime.sh")
            assert 'if [[ "${_DEPLOY_ENV}" == "uat" ]]; then exit 0; fi' in shell
            assert 'exit "${probe_status}"' in shell
        else:
            assert set(steps[provider]["waitFor"]) == {"build-backend-image", "verify-runtime-iam"}
            shell = steps[provider]["args"][-1]
        assert "trap finish_provider_probe EXIT" in shell
        assert shell.index("managed_provider_readiness.py record") < shell.index(
            "gcloud run jobs delete"
        )
    vertex = _read("scripts/deploy/verify-managed-vertex-runtime.sh")
    finalizer = vertex[
        vertex.index("finish_provider_probe() {") : vertex.index(
            "if [[", vertex.index("trap finish_provider_probe EXIT")
        )
    ]
    for environment, record_status, expected in (("uat", 0, 0), ("dev", 0, 7), ("dev", 13, 13)):
        result = subprocess.run(  # noqa: S603 - fixed finalizer with synthetic command stubs.
            [
                "bash",
                "-euc",
                'python3() { printf "record:%s\\n" "$READINESS_STEP_EXIT"; return '
                + str(record_status)
                + '; }; gcloud() { printf "delete\\n"; }; '
                + "_DEPLOY_ENV="
                + environment
                + "; PROJECT_ID=synthetic; _REGION=local; job_name=synthetic; "
                + finalizer
                + "\nexit 7",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == expected, result.stderr
        assert result.stdout.splitlines() == ["record:7"]


@pytest.mark.parametrize(
    "provider,defect",
    [
        ("azure_openai", None),
        ("vertex", None),
        ("vertex", "sha"),
        ("vertex", "image"),
        ("vertex", "provider"),
        ("vertex", "split"),
    ],
)
def test_drive_worker_inherits_only_exact_promoted_api_binding(monkeypatch, provider, defect):
    module = _managed_provider_gate()
    expected, _ = _provider_fixture(module, provider)
    revision_name = "consent-protocol-01234-abc"
    service = {"status": {"traffic": [{"revisionName": revision_name, "percent": 100}]}}
    env = {
        "HUSHH_DEPLOY_SHA": expected["source_sha"],
        "HUSHH_DEPLOY_RUN_ID": expected["github_run"],
        "HUSHH_DEPLOY_ENV": "uat",
        "HUSHH_UAT_MANAGED_TEXT_PROVIDER": provider,
        "HUSHH_UAT_MANAGED_AI_PROVIDER": provider,
    }
    revision = {
        "metadata": {"name": revision_name},
        "spec": {
            "serviceAccountName": expected["runtime_account"],
            "containers": [
                {
                    "image": expected["image"],
                    "env": [{"name": k, "value": v} for k, v in env.items()],
                }
            ],
        },
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }
    if defect == "sha":
        revision["spec"]["containers"][0]["env"][0]["value"] = "old"
    elif defect == "image":
        revision["spec"]["containers"][0]["image"] = "old"
    elif defect == "provider":
        revision["spec"]["containers"][0]["env"] = []
    elif defect == "split":
        service["status"]["traffic"][0]["percent"] = 50
    calls = []

    def cloud(args):
        calls.append(args)
        return service if args[:3] == ["run", "services", "describe"] else revision

    monkeypatch.setattr(module, "run_json", cloud)
    args = (
        expected["source_sha"],
        expected["image"],
        expected["github_run"],
        expected["runtime_account"],
    )
    if defect:
        with pytest.raises(ValueError):
            module.worker_provider(*args)
    else:
        assert module.worker_provider(*args) == provider
        assert calls[1][3] == revision_name


def test_legacy_provider_receipt_is_accepted_only_in_governed_exception():
    module = _managed_provider_gate()
    expected, receipt = _provider_fixture(module, "azure_openai")
    document = json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    legacy = {
        "schema": "azure_managed_text_legacy.v1",
        "scopes": 2,
        "http_status": 200,
        "deployment": receipt["pwm_proof"]["deployment"],
    }
    assert not module.valid_core(legacy, "azure_openai", expected, document)
    expected["legacy_exception"] = True
    assert module.valid_core(legacy, "azure_openai", expected, document)
    assert not module.valid_core(legacy, "vertex", expected, document)


@pytest.mark.parametrize(
    "classification,allowed",
    [
        ("provider_unavailable", True),
        ("candidate_misconfigured", True),
        ("application_broken", True),
    ],
)
def test_complete_azure_bundle_does_not_require_a_working_alternate(classification, allowed):
    module = _managed_provider_gate()
    expected, azure = _provider_fixture(module, "azure_openai")
    _, vertex = _provider_fixture(module, "vertex")
    vertex["capability_classifications"] = {"one_location_semantics:synthetic": classification}
    result = module.evaluate({"azure_openai": azure, "vertex": vertex}, expected)
    assert result["ready"] is allowed
    assert result["providers"]["vertex"]["classifications"] == vertex["capability_classifications"]


def test_provider_receipt_workflow_pins_collector_and_exact_build_identity():
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    steps = workflow["jobs"]["deploy"]["steps"]
    deploy = next(s for s in steps if s.get("id") == "deploy-backend")
    capture = next(
        s for s in steps if s.get("name") == "Capture managed provider readiness receipt"
    )
    assert "--suppress-logs --format='value(id)'" in deploy["run"]
    assert capture["env"]["READINESS_BUILD_ID"] == "${{ steps.deploy-backend.outputs.build_id }}"
    assert "capture_managed_provider_receipt.py" in capture["run"]
    for name in ("Preserve current release tooling", "Checkout deployment SHA"):
        command = next(s["run"] for s in steps if s.get("name") == name)
        assert command.index("capture_managed_provider_receipt.py") < command.index(
            'if [[ "${{ inputs.skip_managed_vertex_probe_once }}"'
        )
        assert command.index("run_uat_text_recovery_job.py") < command.index(
            'if [[ "${{ inputs.skip_managed_vertex_probe_once }}"'
        )


def test_text_recovery_generation_matches_the_selected_runtime_processor(monkeypatch):
    path = REPO_ROOT / "scripts/ops/run_uat_text_recovery_job.py"
    spec = importlib.util.spec_from_file_location("uat_text_recovery_generation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Derive the expectation from the actual producer, not a second test formula.
    from hushh_mcp.runtime_providers.managed_text import managed_text_policy

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    generations = []
    for provider in ("azure_openai", "vertex"):
        monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", provider)
        monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", provider)
        job = {
            "spec": {
                "template": {
                    "spec": {
                        "template": {
                            "spec": {
                                "containers": [
                                    {
                                        "env": [
                                            {
                                                "name": "HUSHH_UAT_MANAGED_AI_PROVIDER",
                                                "value": provider,
                                            },
                                            {
                                                "name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER",
                                                "value": provider,
                                            },
                                        ]
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        }
        actual = module.expected_policy_generation(job)
        assert actual == managed_text_policy()["generation"]
        generations.append(actual)
        job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["env"][1]["value"] = (
            "invalid"
        )
        with pytest.raises(ValueError, match="bindings disagree"):
            module.expected_policy_generation(job)
    assert generations[0] != generations[1]


def test_vertex_drive_evidence_cannot_qualify_one_chat():
    module = _managed_provider_gate()
    expected, vertex = _provider_fixture(module, "vertex")
    document = json.loads(_read("consent-protocol/config/managed-ai-runtime.json"))
    assert module.valid_core(vertex["core"], "vertex", expected, document)
    assert module.evaluate({"vertex": vertex}, expected)["selected_provider"] is None
    vertex["core"]["scopes"].pop("one_text_chat")
    assert not module.valid_core(vertex["core"], "vertex", expected, document)


def test_provider_selection_rejects_vertex_before_cloud_mutation(tmp_path, monkeypatch):
    module = _managed_provider_gate()
    expected, _ = _provider_fixture(module, "vertex")
    calls = []
    monkeypatch.setattr(module, "run_json", calls.append)
    with pytest.raises(ValueError, match="qualified configured"):
        module.select({"ready": True, "selected_provider": "vertex"}, expected, tmp_path)
    assert calls == []
