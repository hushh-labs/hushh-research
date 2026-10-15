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
from tests._deploy_contract import managed_vertex_probe_script, managed_vertex_probe_surface

REPO_ROOT = Path(__file__).resolve().parents[2]


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
    assert wait["needs"] == "select-target"
    assert wait["if"] == "needs.select-target.outputs.decision == 'DEPLOY_EXACT_SHA'"
    assert wait["environment"] == {"name": "uat", "deployment": False}
    assert deploy["needs"] == ["select-target", "wait-capacity"]
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
    assert validator["env"]["REQUIRED_CHECK_NAME"] == "Main Post-Merge Smoke Gate"


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


def test_uat_runtime_capacity_is_bounded_and_revision_safe() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = managed_vertex_probe_surface()
    backend_deploy = _backend_deploy()
    frontend_build = _read("deploy/frontend.cloudbuild.yaml")

    assert '"--cpu=${_CLOUD_RUN_CPU}"' in backend_deploy
    assert '"--concurrency=${_CLOUD_RUN_CONCURRENCY}"' in backend_deploy
    assert '"--memory=${_CLOUD_RUN_MEMORY}"' in backend_deploy
    assert '"_CLOUD_RUN_MEMORY=${_CLOUD_RUN_MEMORY}"' in backend_build
    assert "_CLOUD_RUN_CPU=2" in workflow
    assert "_CLOUD_RUN_CONCURRENCY=20" in workflow

    assert '"--memory=${_CLOUD_RUN_MEMORY}"' in frontend_build
    assert '"--concurrency=${_CLOUD_RUN_CONCURRENCY}"' in frontend_build
    assert '"--max=${_CLOUD_RUN_MAX_INSTANCES}"' in frontend_build
    assert '"--min=${_CLOUD_RUN_MIN_INSTANCES}"' in frontend_build
    assert '"--min-instances=0"' in frontend_build
    assert "_CLOUD_RUN_MEMORY=1Gi" in workflow
    assert "_CLOUD_RUN_TIMEOUT_SECONDS=300" in workflow
    assert "_CLOUD_RUN_CONCURRENCY=10" in workflow
    assert "_CLOUD_RUN_MIN_INSTANCES=2" in workflow
    assert "_CLOUD_RUN_MAX_INSTANCES=10" in workflow


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

    assert load_profile("uat")["text_locations"] == ["global", "us", "eu"]
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
    backend_build = managed_vertex_probe_surface()
    deploy_start = backend_build.index('gcloud run jobs deploy "${job_name}"')
    execute_start = backend_build.index('gcloud run jobs execute "${job_name}"')
    readiness_deploy = backend_build[deploy_start:execute_start]

    # The job probes the managed model with synthetic inputs; it must not
    # retain application secrets, including the retired Live credential.
    assert "--clear-secrets" in readiness_deploy
    assert "--set-secrets" not in readiness_deploy


def test_managed_vertex_readiness_job_has_cold_start_headroom() -> None:
    backend_build = managed_vertex_probe_surface()
    deploy_start = backend_build.index('gcloud run jobs deploy "${job_name}"')
    execute_start = backend_build.index('gcloud run jobs execute "${job_name}"')
    readiness_deploy = backend_build[deploy_start:execute_start]

    # A 1 vCPU cold start reached the 90s task kill before any verdict.
    for flag in ("--cpu=2", "--memory=2Gi", "--task-timeout=300s"):
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
        'verdict.get("one_chat_probe_ok") is not True',
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
        "d8133e4d05ee98074f4a424ac96297ebefb32a9f",
        '"$REQUESTED_SCOPE" != "all"',
        '"$LIVE_CHECKS" != "false"',
        '"$GITHUB_ACTOR" != "ankitkumarsingh1702"',
    ):
        assert required in validation["run"]
    allowed_dispatch = {
        "REQUESTED_SHA": "d8133e4d05ee98074f4a424ac96297ebefb32a9f",
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
    tools = (
        "deploy/backend.cloudbuild.yaml",
        "scripts/deploy/backend-deploy.sh",
        "scripts/deploy/verify-managed-vertex-runtime.sh",
        "scripts/deploy/commerce-preview-bindings.sh",
        "scripts/deploy/backend-model-settings.sh",
        "scripts/deploy/backend-drive-secret-settings.sh",
        "scripts/deploy/scope-commerce-secrets.sh",
        "deploy/sso/bind_workos.sh",
    )
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
        "_DEPLOY_SHA": "d8133e4d05ee98074f4a424ac96297ebefb32a9f",
        "_CLOUD_RUN_NO_TRAFFIC": "true",
        "_VERIFY_MANAGED_VERTEX_RUNTIME": "true",
        "_IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
        "_GITHUB_RUN_ID": "123456789",
        "_CLOUD_RUN_TAG": "account-deletion-123456789",
    }

    def run_case(**overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - production guard with synthetic environment only.
            ["/bin/bash", "-c", guard],
            env={**os.environ, **valid, **overrides},
            capture_output=True,
            text=True,
            check=False,
        )

    approved = run_case()
    assert approved.returncode == 0, approved.stderr
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


def test_uat_cross_project_vertex_requires_a_complete_successful_probe_verdict() -> None:
    probe = managed_vertex_probe_script()
    # Run the owning receipt parser and release decision. The job itself is
    # represented by its exit status/log line; no provider or gcloud is called.
    script = "set -euo pipefail\n" + probe[probe.index('classification="$(') :]
    project = load_profile("uat")["project"]
    healthy = {
        "check": "managed_vertex_runtime",
        "ok": True,
        "classification": "dependency_ok",
        "candidate_models_exercised": True,
        "config_hash": "checked-profile-hash",
        "one_chat_project": project,
        "one_chat_probe_ok": True,
        "one_voice_project": project,
        "one_voice_probe_ok": True,
        "live_model": "reviewed-live-model",
        "live_location": "reviewed-live-location",
        "probes": [
            {"probe": name, "ok": True, "classification": "dependency_ok"}
            for name in ("one_chat", "embedding", "one_voice_live")
        ],
    }

    def run_verdict(
        report: dict | str,
        exit_status: int = 0,
        *,
        deploy_env: str = "uat",
        voice_enabled: str = "true",
    ) -> subprocess.CompletedProcess[str]:
        line = (
            "managed_vertex_probe_result " + json.dumps(report)
            if isinstance(report, dict)
            else report
        )
        return subprocess.run(  # noqa: S603 - fixed shell executes repository verdict logic with synthetic values
            ["/bin/bash", "-c", script],
            env={
                "PATH": str(Path(sys.executable).parent) + os.pathsep + os.defpath,
                "PROJECT_ID": "hushh-pda-uat",
                "genai_project_id": project,
                "_DEPLOY_ENV": deploy_env,
                "_ONE_VOICE_LIVE_ENABLED": voice_enabled,
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
        {**healthy, "one_chat_probe_ok": False},
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
    legacy = run_verdict(partial, 85, deploy_env="dev", voice_enabled="false")
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
        "dev": "hushh-pda-uat",
        "uat": "hushh-vertex-personal54",
        "production": "hushh-vertex-personal54",
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
    assert 'verdict.get("one_chat_probe_ok") is not True' in backend_build
    assert 'verdict.get("config_hash") != os.environ["EXPECTED_CONFIG_HASH"]' in backend_build
    assert "binding.build_regional_adk_model(model)" in readiness
    assert '"one_chat_probe_ok": chat_ok' in readiness


def test_one_voice_uses_central_project_and_is_probed_before_traffic() -> None:
    backend_build = managed_vertex_probe_surface()
    readiness = _read("consent-protocol/scripts/verify_managed_vertex_runtime.py")
    for env in ("dev", "uat", "production"):
        assert "_HUSHH_ONE_VOICE_VERTEX_PROJECT=" not in _read(
            f".github/workflows/deploy-{env}.yml"
        )
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


def test_backend_capacity_keeps_shared_limits_and_reviewed_environment_memory() -> None:
    """Production OOM-killed live chat turns; throttled CPU stalled first turns."""
    production_workflow = _read(".github/workflows/deploy-production.yml")
    uat_workflow = _read(".github/workflows/deploy-uat.yml")

    backend_build = managed_vertex_probe_surface()
    # The Cloud Build wrapper delegates deployment to the canonical script.
    assert "scripts/deploy/backend-deploy.sh" in backend_build
    backend_deploy = _read("scripts/deploy/backend-deploy.sh")
    command = backend_deploy.split("cmd=(", 1)[1].split("\n)", 1)[0]
    # Background warmups need CPU outside requests on every shared lane.
    assert '"--no-cpu-throttling"' in command

    for setting in (
        "_CLOUD_RUN_CPU=2",
        "_CLOUD_RUN_CONCURRENCY=20",
    ):
        assert setting in uat_workflow
        assert setting in production_workflow

    # The measured UAT working set exceeded the 80% memory gate on 4Gi.
    # Its isolated 6Gi trial must not change production before its own acceptance.
    assert "_CLOUD_RUN_MEMORY=6Gi" in uat_workflow
    assert "_CLOUD_RUN_MEMORY=4Gi" in production_workflow


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
    assert "if: steps.verify-parity.outcome == 'success'" in workflow
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
        'steps.final-state.outputs.backend_serving }}" != "${{ steps.predeploy-state.outputs.backend_revision'
        in workflow
    )
    assert (
        'steps.final-state.outputs.frontend_serving }}" != "${{ steps.predeploy-state.outputs.frontend_revision'
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
    workflow = _read(".github/workflows/deploy-production.yml")

    assert (
        "if: steps.scope.outputs.deploy_backend == 'true' "
        "&& steps.promote-traffic.outcome == 'success'"
    ) in workflow
    assert (
        "if: steps.scope.outputs.deploy_frontend == 'true' "
        "&& steps.promote-traffic.outcome == 'success'"
    ) in workflow


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
