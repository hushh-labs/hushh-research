from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from hushh_mcp.managed_ai_config import load_profile

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


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
    ("enabled", "deploy_backend", "allowed"),
    [
        ("true", "false", False),
        ("true", "", False),
        ("true", "true", True),
        ("false", "false", True),
        ("false", "true", True),
    ],
)
def test_initial_contacts_opt_in_requires_a_paired_backend_before_builds(
    enabled: str, deploy_backend: str, allowed: bool
) -> None:
    workflow = yaml.safe_load(_read(".github/workflows/deploy-uat.yml"))
    steps = workflow["jobs"]["deploy"]["steps"]
    scope_index = next(index for index, step in enumerate(steps) if step.get("id") == "scope")
    pairing_index = next(
        index for index, step in enumerate(steps) if step.get("id") == "initial-contacts-pairing"
    )
    pairing = steps[pairing_index]
    frontend_build_index = next(
        index for index, step in enumerate(steps) if step.get("id") == "start-frontend-image-build"
    )
    assert scope_index < pairing_index < frontend_build_index
    assert "if" not in pairing
    assert "continue-on-error" not in pairing
    assert pairing["env"]["DEPLOY_BACKEND"] == "${{ steps.scope.outputs.deploy_backend }}"
    assert workflow["env"]["INITIAL_CONTACTS_ONBOARDING_ENABLED"] == (
        "${{ inputs.initial_contacts_onboarding && 'true' || 'false' }}"
    )
    bash = shutil.which("bash")
    assert bash is not None
    result = subprocess.run(  # noqa: S603 - fixed bash executes only repository YAML.
        [bash, "-c", pairing["run"]],
        env={
            **os.environ,
            "INITIAL_CONTACTS_ONBOARDING_ENABLED": enabled,
            "DEPLOY_BACKEND": deploy_backend,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert (result.returncode == 0) is allowed
    if not allowed:
        assert "paired backend deployment" in result.stderr
        assert "scope=all" in result.stderr


def test_uat_deploy_builds_candidates_without_serving_traffic() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    frontend_build = _read("deploy/frontend.cloudbuild.yaml")

    assert "group: deploy-uat\n" in workflow
    assert "_CLOUD_RUN_NO_TRAFFIC=true" in workflow
    assert '--to-revisions="${{ steps.candidate-state.outputs.backend_revision }}=100"' in workflow
    assert '--to-revisions="${{ steps.candidate-state.outputs.frontend_revision }}=100"' in workflow

    assert '_CLOUD_RUN_NO_TRAFFIC: "false"' in backend_build
    assert (
        'if [[ "${_CLOUD_RUN_NO_TRAFFIC}" == "true" ]]; then\n          cmd+=("--no-traffic")'
        in backend_build
    )
    assert '_CLOUD_RUN_NO_TRAFFIC: "false"' in frontend_build
    assert (
        'if [[ "${_CLOUD_RUN_NO_TRAFFIC}" == "true" ]]; then\n          cmd+=("--no-traffic")'
        in frontend_build
    )


def test_uat_drive_secret_wiring_is_explicit_and_default_off() -> None:
    """Drive-only credentials are opt-in UAT bindings, never generic fallbacks."""
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = _read("deploy/backend.cloudbuild.yaml")
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
    backend_build = _read("deploy/backend.cloudbuild.yaml")
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

    # The build binds optional existing secrets, but refuses an enabled
    # new-request rollout unless both names resolve in the deploy project.
    assert (
        '"${_DRIVE_REQUEST_PAYMENTS_ENABLED}" == "true" || "${_DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED}" == "true"'
        in backend_build
    )
    assert (
        'for required_secret in "${_STRIPE_SECRET_KEY_SECRET}" "${_STRIPE_WEBHOOK_SECRET_SECRET}"; do'
        in backend_build
    )
    assert 'add_secret "${!v}" "${n}"' in backend_build
    assert "STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET" in backend_build
    assert "STRIPE_CONNECT_WEBHOOK_SECRET OPENAI_API_KEY" in backend_build
    assert '"${_DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED}" == "true"' in backend_build
    assert 'gcloud secrets describe "${_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET}"' in backend_build
    assert '_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET: ""' in backend_build


def test_document_owner_payouts_require_explicit_uat_api_and_worker_switches() -> None:
    """A UAT payout rollout must reach both runtimes and cannot silently reach production."""
    uat = _read(".github/workflows/deploy-uat.yml")
    production = _read(".github/workflows/deploy-production.yml")
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    uat_worker = _read("deploy/drive/deploy_worker_service.sh")
    production_worker = _read("deploy/drive/deploy_worker_service_prod.sh")

    flag = "DRIVE_REQUEST_OWNER_PAYOUTS_ENABLED"
    uat_variable = "${{ vars.DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED || 'false' }}"
    assert f"_{flag}={uat_variable}" in uat
    assert f"DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED: {uat_variable}" in uat
    assert f'_{flag}: "false"' in backend_build
    runtime_env_loops = re.findall(r"for n in ([^;\n]+); do", backend_build)
    assert any({flag, "STRIPE_MODE"}.issubset(loop.split()) for loop in runtime_env_loops)
    assert 'add_env "${n}" "${!v}"' in backend_build
    assert f'"_{flag}=${{_{flag}}}"' in backend_build
    assert f"{flag}=${{DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED:-false}}" in uat_worker
    assert '"${DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED:-false}" == "true"' in uat_worker
    assert f"_{flag}=" not in production
    assert f"{flag}=false" in production_worker


def test_uat_runtime_capacity_is_bounded_and_revision_safe() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    frontend_build = _read("deploy/frontend.cloudbuild.yaml")

    assert '"--cpu=${_CLOUD_RUN_CPU}"' in backend_build
    assert '"--concurrency=${_CLOUD_RUN_CONCURRENCY}"' in backend_build
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
    backend_build = _read("deploy/backend.cloudbuild.yaml")
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
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    deploy_start = backend_build.index('gcloud run jobs deploy "${job_name}"')
    execute_start = backend_build.index('gcloud run jobs execute "${job_name}"')
    readiness_deploy = backend_build[deploy_start:execute_start]

    # The job probes the managed model with synthetic inputs; it must not
    # retain application secrets, including the retired Live credential.
    assert "--clear-secrets" in readiness_deploy
    assert "--set-secrets" not in readiness_deploy


def test_backend_vertex_preflight_uses_supported_service_usage_command() -> None:
    backend_build = _read("deploy/backend.cloudbuild.yaml")

    assert "gcloud services list --enabled" in backend_build
    assert "--filter='config.name=aiplatform.googleapis.com'" in backend_build
    assert "gcloud services describe" not in backend_build


def test_uat_cross_project_vertex_preflight_defers_only_to_a_no_traffic_probe() -> None:
    build = yaml.safe_load(_read("deploy/backend.cloudbuild.yaml"))
    steps = build["steps"]
    preflight = next(step["args"][-1] for step in steps if step.get("id") == "verify-runtime-iam")
    probe = next(
        step["args"][-1] for step in steps if step.get("id") == "verify-managed-vertex-runtime"
    )
    step_ids = [step.get("id") for step in steps]
    assert step_ids.index("verify-runtime-iam") < step_ids.index("deploy-backend")
    assert step_ids.index("deploy-backend") < step_ids.index("verify-managed-vertex-runtime")

    # Execute the actual preflight decision with a fake build-principal gcloud.
    # Cross-project discovery is denied, as it is in the UAT Cloud Build account.
    start = preflight.index("gcloud iam service-accounts describe")
    end = preflight.index('if [[ "${_PKM_ANSWER_PAYMENTS_ENABLED}"', start)
    decision = preflight[start:end]
    script = (
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

    def run_case(
        deploy_env: str,
        no_traffic: str,
        probe_enabled: str,
        genai_project: str,
        *,
        deny_project_discovery: bool,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed bash executes only repository YAML with a fake gcloud
            ["/bin/bash", "-c", script],
            env={
                "PROJECT_ID": "hushh-pda-uat",
                "genai_project_id": genai_project,
                "_RUNTIME_SERVICE_ACCOUNT": "runtime@hushh-pda-uat.iam.gserviceaccount.com",
                "_DEPLOY_ENV": deploy_env,
                "_CLOUD_RUN_NO_TRAFFIC": no_traffic,
                "_VERIFY_MANAGED_VERTEX_RUNTIME": probe_enabled,
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
        ("uat", "false", "true", uat),
        ("uat", "true", "false", uat),
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

    static = run_case("production", "true", "true", uat, deny_project_discovery=False)
    assert static.returncode == 0, static.stderr
    assert static.stderr.count("CALL:projects get-iam-policy") == 2

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


def test_backend_vertex_advisory_probe_parses_pretty_json_verdict() -> None:
    backend_build = _read("deploy/backend.cloudbuild.yaml")

    assert '--command="python3"' in backend_build
    assert '--command="python"' not in backend_build
    assert "PROBE_LINE=\"${probe_line}\" python3 - <<'PY'" in backend_build
    assert "PROBE_LINE=\"${probe_line}\" python - <<'PY'" not in backend_build
    assert 'marker = "managed_vertex_probe_result"' in backend_build
    assert "json.loads(payload)" in backend_build
    assert 'verdict.get("classification")' in backend_build
    assert 'sed -n \'s/.*"classification":"' not in backend_build


def test_managed_vertex_targets_follow_environment_profiles() -> None:
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    assert {env: load_profile(env)["project"] for env in ("dev", "uat", "production")} == {
        "dev": "hushh-pda-uat",
        "uat": "hussh-511311",
        "production": "hushh-vertex-personal54",
    }
    for env in ("dev", "uat", "production"):
        assert f"scripts/ops/managed_ai_config.py --environment {env}" in _read(
            f".github/workflows/deploy-{env}.yml"
        )
    assert "Managed AI profile hash mismatch." in backend_build
    assert "roles/serviceusage.serviceUsageConsumer" in backend_build
    assert '"GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"' in backend_build
    assert "GENAI_GOOGLE_CLOUD_PROJECT=${genai_project_id}" in backend_build
    assert '_GENAI_PROJECT_ID: ""' in backend_build


def test_one_chat_uses_central_project_and_verified_profile() -> None:
    backend_build = _read("deploy/backend.cloudbuild.yaml")
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
    backend_build = _read("deploy/backend.cloudbuild.yaml")
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
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert '_ONE_VOICE_CALENDAR_NARRATION_ENABLED: "false"' in backend_build
    assert "ONE_VOICE_CALENDAR_NARRATION_ENABLED" in backend_build
    assert "_ONE_VOICE_CALENDAR_NARRATION_ENABLED=true" in uat_workflow
    assert "_ONE_VOICE_CALENDAR_NARRATION_ENABLED=true" not in production_workflow


def test_one_voice_live_env_contract_is_explicit_and_enabled_in_production() -> None:
    """One Live Voice runs on Vertex ADC only, behind one flag, with an exact model pin.

    Every lane carries the three names. Production enables the same live path as UAT.
    The pinned id must be the registry's native-realtime entry, so the deploy
    substitution and the registry can never disagree.
    """
    from hushh_mcp.runtime_providers.registry import resolve_live_model_entry

    backend_build = _read("deploy/backend.cloudbuild.yaml")
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

    backend_build = _read("deploy/backend.cloudbuild.yaml")
    # Background warmups need CPU outside requests on every lane.
    assert '"--no-cpu-throttling"' in backend_build

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


def test_hosted_backend_bounds_database_connection_fanout() -> None:
    backend_build = _read("deploy/backend.cloudbuild.yaml")
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert '"DB_POOL_MIN_SIZE=${_DB_POOL_MIN_SIZE}"' in backend_build
    assert '"DB_POOL_MAX_SIZE=${_DB_POOL_MAX_SIZE}"' in backend_build
    assert '"DB_SQLALCHEMY_POOL_SIZE=${_DB_SQLALCHEMY_POOL_SIZE}"' in backend_build
    assert '"DB_SQLALCHEMY_MAX_OVERFLOW=${_DB_SQLALCHEMY_MAX_OVERFLOW}"' in backend_build
    assert (
        'add_env "CONSENT_WEB_FALLBACK_ENABLED" "${_CONSENT_WEB_FALLBACK_ENABLED}"' in backend_build
    )
    assert 'add_env "CONSENT_SSE_ENABLED" "${_CONSENT_SSE_ENABLED}"' in backend_build
    assert '"--max=${_CLOUD_RUN_MAX_INSTANCES}"' in backend_build
    assert '"--min=${_CLOUD_RUN_MIN_INSTANCES}"' in backend_build
    assert '"--min-instances=0"' in backend_build
    assert '_DB_POOL_MIN_SIZE: "1"' in backend_build
    assert '_DB_POOL_MAX_SIZE: "4"' in backend_build
    assert '_DB_SQLALCHEMY_POOL_SIZE: "4"' in backend_build
    assert '_DB_SQLALCHEMY_MAX_OVERFLOW: "0"' in backend_build

    # Both pools are per-process module globals, so the real Cloud SQL ceiling
    # is (pool sizes) x (gunicorn workers) x (Cloud Run instances). Read the
    # worker count from the image rather than hardcoding it: raising -w without
    # lowering the pools multiplies the ceiling silently, which is exactly how
    # this arithmetic drifted 2x out of date before 2026-08-23.
    dockerfile = _read("consent-protocol/Dockerfile")
    worker_flag = re.search(r"gunicorn\s+server:app\s+-w\s+(\d+)", dockerfile)
    assert worker_flag is not None, "could not read the gunicorn worker count from the Dockerfile"
    gunicorn_workers = int(worker_flag.group(1))
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
    assert budget["admission_limit"] == 800
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
