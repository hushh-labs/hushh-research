from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "deploy-uat.yml"
SERVING_STATE_SCRIPT = ROOT / "scripts" / "ci" / "resolve-cloud-run-serving-state.py"
SCHEDULER_ATTEMPT_SCRIPT = ROOT / "scripts" / "ci" / "verify-cloud-scheduler-attempt.py"
CLOUD_RUN_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "cloud_run"
CLOUD_SCHEDULER_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "cloud_scheduler"


def _workflow_steps() -> list[dict]:
    workflow = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    return workflow["jobs"]["deploy"]["steps"]


def _step(name: str) -> dict:
    for step in _workflow_steps():
        if step.get("name") == name:
            return step
    raise AssertionError(f"Missing workflow step: {name}")


def _serving_state_module():
    spec = importlib.util.spec_from_file_location(
        "resolve_cloud_run_serving_state", SERVING_STATE_SCRIPT
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _scheduler_attempt_module():
    spec = importlib.util.spec_from_file_location(
        "verify_cloud_scheduler_attempt", SCHEDULER_ATTEMPT_SCRIPT
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_uat_release_orders_image_fence_schema_runtime_and_activation() -> None:
    names = [str(step.get("name") or "") for step in _workflow_steps()]
    expected_order = [
        "Build and pin backend image before lifecycle migration",
        "Install fail-closed account deletion release fence",
        "Apply UAT DB migrations behind account deletion fence",
        "Deploy backend using Cloud Build",
        "Verify backend candidate readiness and exact-SHA provenance",
        "Promote deployed revisions to UAT traffic",
        "Classify UAT release outcome",
        "Activate tombstone-aware account deletion",
    ]
    positions = [names.index(name) for name in expected_order]
    assert positions == sorted(positions)


def test_uat_backend_deploy_consumes_the_pinned_digest_without_rebuilding() -> None:
    build_run = str(
        _step("Build and pin backend image before lifecycle migration").get("run") or ""
    )
    deploy_run = str(_step("Deploy backend using Cloud Build").get("run") or "")
    readiness_run = str(
        _step("Verify backend candidate readiness and exact-SHA provenance").get("run") or ""
    )

    assert "deploy/backend-image.cloudbuild.yaml" in build_run
    assert "image_summary.digest" in build_run
    assert "^sha256:[0-9a-f]{64}$" in build_run
    assert "_SKIP_IMAGE_BUILD=true" in deploy_run
    assert "_IMAGE_REFERENCE=${{ steps.build-backend-image.outputs.image_reference }}" in deploy_run
    assert 'containers[0].get("image") == expected_image_reference' in readiness_run
    assert "account-deletion-contract" in readiness_run

    image_build = yaml.safe_load(
        (ROOT / "deploy" / "backend-image.cloudbuild.yaml").read_text(encoding="utf-8")
    )
    assert image_build["timeout"] == "1800s"


@pytest.mark.parametrize("architecture", ["amd64", "arm64"])
def test_uat_pins_executable_manifest_instead_of_attested_index(
    tmp_path: Path, architecture: str
) -> None:
    child_digest = "sha256:" + "a" * 64
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": "sha256:" + "b" * 64,
                    "size": 1234,
                    "platform": {"os": "unknown", "architecture": "unknown"},
                    "annotations": {"vnd.docker.reference.type": "attestation-manifest"},
                },
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": child_digest,
                    "size": 1234,
                    "platform": {"os": "linux", "architecture": architecture},
                },
            ],
        }
    )
    index_digest = "sha256:" + hashlib.sha256(manifest.encode()).hexdigest()
    repository = "gcr.io/hushh-pda-uat/consent-protocol"
    script = _step("Build and pin backend image before lifecycle migration")["run"]
    script = script.replace("${{ env.GCP_PROJECT_ID }}", "hushh-pda-uat")
    script = script.replace("${{ steps.resolve-sha.outputs.sha }}", "c" * 40)
    for name in ("uat-backend-image.json", "uat-backend-image-manifest.json"):
        script = script.replace(
            f"/tmp/{name}",  # noqa: S108 - replace workflow paths with pytest isolation
            (tmp_path / name).as_posix(),
        )
    assert "${{" not in script
    # Execute the real workflow body but intercept every external build/registry
    # command. Only the production digest resolver runs, with fixed public inputs.
    guards = (
        'gcloud() { case "$1 $2" in '
        "'builds submit'|'auth configure-docker') return 0 ;; "
        f"'container images') printf '%s' '{index_digest}' ;; "
        "*) echo UNEXPECTED_CLOUD_COMMAND >&2; return 95 ;; esac; };\n"
        "docker() { "
        f"if [[ \"$*\" != *'{repository}@{index_digest}'* ]]; then "
        "echo UNEXPECTED_MUTABLE_LOOKUP >&2; return 96; fi; "
        f"printf '%s' '{manifest}'; }};\n"
        f"python3() {{ '{Path(sys.executable).as_posix()}' \"$@\"; }};\n"
    )
    output_path = tmp_path / "github-output"
    environment = os.environ.copy()
    environment.pop("BASH_ENV", None)
    environment["GITHUB_OUTPUT"] = output_path.as_posix()
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required for the workflow behavior test"
    result = subprocess.run(  # noqa: S603 - trusted workflow, fixed inputs, guarded cloud commands
        [bash, "-c", guards + script],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert "UNEXPECTED_" not in result.stdout + result.stderr
    if architecture != "amd64":
        assert result.returncode != 0
        assert "exactly one executable linux/amd64" in result.stderr
        assert not output_path.exists()
        return
    assert result.returncode == 0, result.stdout + result.stderr
    assert output_path.read_text().strip() == f"image_reference={repository}@{child_digest}"


@pytest.mark.parametrize(
    ("skip_build", "image_reference", "expected_code", "expected_message"),
    [
        ("true", "example.invalid/backend@sha256:" + "a" * 64, 0, "Using prebuilt"),
        ("true", "", 1, "requires an immutable _IMAGE_REFERENCE digest"),
        ("true", "example.invalid/backend:latest", 1, "requires an immutable"),
        ("invalid", "example.invalid/backend@sha256:" + "a" * 64, 1, "must be true or false"),
    ],
)
def test_prebuilt_backend_step_runs_without_substitution_environment(
    skip_build: str, image_reference: str, expected_code: int, expected_message: str
) -> None:
    cloudbuild = yaml.safe_load(
        (ROOT / "deploy" / "backend.cloudbuild.yaml").read_text(encoding="utf-8")
    )
    step = next(step for step in cloudbuild["steps"] if step["id"] == "build-backend-image")
    assert step["entrypoint"] == "bash"
    assert step["args"][0] == "-c"
    # Cloud Build replaces simple substitutions; it does not export them as shell
    # variables. Leave Bash parameter operators untouched to exercise strict mode.
    script = step["args"][1].replace("${_SKIP_IMAGE_BUILD}", skip_build)
    script = script.replace("${_IMAGE_REFERENCE}", image_reference)
    environment = os.environ.copy()
    environment.pop("_SKIP_IMAGE_BUILD", None)
    environment.pop("_IMAGE_REFERENCE", None)
    # Never build or touch cloud resources if the production step regresses.
    guards = (
        "docker() { echo UNEXPECTED_BUILD_COMMAND >&2; return 95; }; "
        "gcloud() { echo UNEXPECTED_CLOUD_COMMAND >&2; return 96; };\n"
    )
    bash = shutil.which("bash")
    assert bash is not None, "Bash is required to verify the Cloud Build runtime contract"
    result = subprocess.run(  # noqa: S603 - trusted repo script, fixed inputs, guarded commands
        [bash, "-c", guards + script],
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    output = result.stdout + result.stderr
    assert result.returncode == expected_code, output
    assert expected_message in output
    assert "UNEXPECTED_" not in output


def test_uat_activation_retires_legacy_revisions_before_removing_fence() -> None:
    activation = _step("Activate tombstone-aware account deletion")
    activation_run = str(activation.get("run") or "")

    assert activation.get("if") == (
        "steps.classify-uat-release.outputs.release_failed == 'false' && "
        "steps.scope.outputs.deploy_backend == 'true'"
    )
    assert "setup_cleanup_scheduler.sh" in activation_run
    assert "gcloud scheduler jobs run" in activation_run
    assert "gcloud logging read" in activation_run
    assert "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished" in activation_run
    assert "verify-cloud-scheduler-attempt.py" in activation_run
    assert "job.get('lastAttemptTime')" not in activation_run
    assert "--format='value(lastAttemptTime)'" not in activation_run
    assert "status.get('code') or '0'" not in activation_run
    scheduler_verifier = SCHEDULER_ATTEMPT_SCRIPT.read_text(encoding="utf-8")
    assert 'raw_http_status = http_request.get("status")' in scheduler_verifier
    assert "not 200 <= http_status < 300" in scheduler_verifier
    assert 'http_request.get("status") or' not in scheduler_verifier
    assert "gcloud run revisions delete" in activation_run
    assert "remaining_pre_v201_count" in activation_run
    assert activation_run.index("gcloud run revisions delete") < activation_run.index(
        "remove_release_fence.sql"
    )


def test_pre_v201_backend_rollback_requires_fence_and_empty_tombstones() -> None:
    rollback_run = str(_step("Roll back backend revision").get("run") or "")

    assert "install_release_fence.sql" in rollback_run
    assert "SELECT count(*) FROM public.account_deletion_tombstones" in rollback_run
    assert '"${rollback_contract}" != "v201"' in rollback_run
    assert '"${tombstone_count}" != "0"' in rollback_run
    assert "Refusing rollback to a pre-v201 backend" in rollback_run


def test_release_fence_is_statement_level_bounded_and_verified() -> None:
    install_sql = (ROOT / "deploy" / "account-deletion" / "install_release_fence.sql").read_text(
        encoding="utf-8"
    )
    remove_sql = (ROOT / "deploy" / "account-deletion" / "remove_release_fence.sql").read_text(
        encoding="utf-8"
    )
    verify_sql = (ROOT / "deploy" / "account-deletion" / "verify_release_boundary.sql").read_text(
        encoding="utf-8"
    )

    assert "LOCK TABLE public.actor_profiles, public.vault_keys" in install_sql
    assert "IN SHARE ROW EXCLUSIVE MODE" in install_sql
    assert install_sql.count("FOR EACH STATEMENT") == 2
    assert "ERRCODE = '55000'" in install_sql
    assert "DELETE FROM public.actor_profiles WHERE false" in install_sql
    assert "DELETE FROM public.vault_keys WHERE false" in install_sql
    assert remove_sql.index("DROP TRIGGER") < remove_sql.index("DROP FUNCTION")
    assert "trg_reject_deleted_account_insert" in verify_sql
    assert "trg_reject_deleted_account_reference_update" in verify_sql
    assert "hushh.account-deletion-guard/v3/insert-presence:" in verify_sql
    assert "hushh.account-deletion-guard/v3/update-bind-immutable:" in verify_sql
    assert "account_identity_presence_pkey" in verify_sql
    assert "missing_presence_count" in verify_sql


def test_uat_serving_state_ignores_zero_percent_candidate_tag() -> None:
    resolver = _serving_state_module()
    service = json.loads(
        (CLOUD_RUN_FIXTURES / "tagged_zero_before_serving.json").read_text(encoding="utf-8")
    )

    state = resolver.resolve_serving_state(service)

    assert state.revision == "consent-protocol-serving"
    assert state.url == "https://consent-protocol.example.run.app"


def test_uat_serving_state_rejects_ambiguous_split_traffic() -> None:
    resolver = _serving_state_module()
    service = json.loads(
        (CLOUD_RUN_FIXTURES / "ambiguous_split_traffic.json").read_text(encoding="utf-8")
    )

    with pytest.raises(ValueError, match="exactly one"):
        resolver.resolve_serving_state(service)


def test_uat_predeploy_and_final_state_use_order_safe_resolver() -> None:
    for name in ("Capture predeploy Cloud Run state", "Resolve final Cloud Run state"):
        run = str(_step(name).get("run") or "")
        assert "resolve-cloud-run-serving-state.py" in run
        assert "status.traffic[0]" not in run


def test_scheduler_attempt_requires_fresh_concrete_http_success() -> None:
    verifier = _scheduler_attempt_module()
    expected_job = "projects/hushh-pda-uat/locations/us-central1/jobs/account-deletion-cleanup-uat"
    expected_uri = "https://api.uat.hushh.ai/api/account/deletion-cleanup/drain?limit=10"
    triggered_at = verifier.parse_instant("2026-09-04T15:30:00Z")
    success = json.loads(
        (CLOUD_SCHEDULER_FIXTURES / "fresh_success.json").read_text(encoding="utf-8")
    )
    missing_status = json.loads(
        (CLOUD_SCHEDULER_FIXTURES / "fresh_missing_http_status.json").read_text(encoding="utf-8")
    )

    selected = verifier.successful_completion(
        success,
        triggered_at=triggered_at,
        expected_job=expected_job,
        expected_uri=expected_uri,
    )
    assert selected is not None
    assert selected["http_status"] == 200
    assert (
        verifier.successful_completion(
            missing_status,
            triggered_at=triggered_at,
            expected_job=expected_job,
            expected_uri=expected_uri,
        )
        is None
    )
    assert (
        verifier.successful_completion(
            [missing_status[0], success[0]],
            triggered_at=triggered_at,
            expected_job=expected_job,
            expected_uri=expected_uri,
        )
        is None
    )
    assert (
        verifier.successful_completion(
            success,
            triggered_at=verifier.parse_instant("2026-09-04T15:31:00Z"),
            expected_job=expected_job,
            expected_uri=expected_uri,
        )
        is None
    )


def test_production_backend_is_blocked_before_migration_201() -> None:
    workflow_path = ROOT / ".github" / "workflows" / "deploy-production.yml"
    workflow = yaml.safe_load(workflow_path.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [str(step.get("name") or "") for step in steps]
    block_name = "Block production migration 201 until lifecycle rollout controls exist"
    migration_name = "Apply production release migrations"

    assert names.index(block_name) < names.index(migration_name)
    block = next(step for step in steps if step.get("name") == block_name)
    assert block.get("if") == "steps.scope.outputs.deploy_backend == 'true'"
    block_run = str(block.get("run") or "")
    assert "201_account_deletion_tombstones.sql" in block_run
    assert "exit 1" in block_run
