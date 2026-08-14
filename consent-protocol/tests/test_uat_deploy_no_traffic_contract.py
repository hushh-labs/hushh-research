from __future__ import annotations

from pathlib import Path

from tests._deploy_contract import backend_deploy_surface

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_uat_deploy_builds_candidates_without_serving_traffic() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    backend_build = backend_deploy_surface()
    frontend_build = _read("deploy/frontend.cloudbuild.yaml")

    assert "group: deploy-uat\n" in workflow
    assert "_CLOUD_RUN_NO_TRAFFIC=true" in workflow
    assert '--to-revisions="${{ steps.candidate-state.outputs.backend_revision }}=100"' in workflow
    assert '--to-revisions="${{ steps.candidate-state.outputs.frontend_revision }}=100"' in workflow

    assert '_CLOUD_RUN_NO_TRAFFIC: "false"' in backend_build
    # The backend's guard now lives in scripts/deploy/backend-deploy.sh rather than in a
    # YAML block scalar, so it is dedented by the 8 spaces that indentation used to add.
    # The frontend below is still inline and keeps the original indentation — that
    # difference is exactly why the two assertions no longer read identically.
    assert (
        'if [[ "${_CLOUD_RUN_NO_TRAFFIC}" == "true" ]]; then\n  cmd+=("--no-traffic")'
        in backend_build
    )
    assert '_CLOUD_RUN_NO_TRAFFIC: "false"' in frontend_build
    assert (
        'if [[ "${_CLOUD_RUN_NO_TRAFFIC}" == "true" ]]; then\n          cmd+=("--no-traffic")'
        in frontend_build
    )


def test_backend_and_readiness_job_share_the_supported_text_model_regions() -> None:
    backend_build = backend_deploy_surface()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")

    # Gemini 3.1 Flash-Lite is part of the approved text matrix and only shares
    # global/us/eu endpoints with Gemini 3.5 Flash. The deployed service and its
    # candidate-image readiness job must prove the same configuration.
    assert backend_build.count("GOOGLE_CLOUD_LOCATION=global") == 2
    assert '"HUSHH_VERTEX_LOCATIONS=global,us,eu"' in backend_build
    assert '--set-env-vars="^|^HUSHH_GENAI_AUTH_MODE=vertex_adc|' in backend_build
    assert "|HUSHH_VERTEX_LOCATIONS=global,us,eu|" in backend_build
    assert "HUSHH_VERTEX_LOCATIONS=global\\,us\\,eu" not in backend_build
    assert "GOOGLE_CLOUD_LOCATION=asia-southeast1" not in backend_build
    # The managed-Vertex candidate job stays conservative for direct builds,
    # while UAT must honor the same changed-SHA selector that governs the
    # candidate evaluator lane. An unrelated release must not fail because an
    # unselected advisory probe happened to be unavailable.
    assert '_VERIFY_MANAGED_VERTEX_RUNTIME: "true"' in backend_build
    assert 'case "${_VERIFY_MANAGED_VERTEX_RUNTIME}" in' in backend_build
    assert "true) ;;" in backend_build
    assert "false)" in backend_build
    assert 'echo "_VERIFY_MANAGED_VERTEX_RUNTIME must be true or false." >&2' in backend_build
    assert (
        "Skipping managed Vertex candidate probe: not selected by the verification plan."
        in backend_build
    )
    assert "verify_managed_vertex_runtime=false" in uat_workflow
    assert "steps.verification-plan.outputs.pkm_evaluator_runs" in uat_workflow
    assert "##_VERIFY_MANAGED_VERTEX_RUNTIME=${verify_managed_vertex_runtime}" in uat_workflow


def test_backend_vertex_preflight_uses_supported_service_usage_command() -> None:
    backend_build = backend_deploy_surface()

    assert "gcloud services list --enabled" in backend_build
    assert "--filter='config.name=aiplatform.googleapis.com'" in backend_build
    assert "gcloud services describe" not in backend_build


def test_cross_project_vertex_fallback_is_dev_only_and_shared_by_readiness() -> None:
    backend_build = backend_deploy_surface()

    assert 'if [[ "${_DEPLOY_ENV}" == "dev" ]]; then' in backend_build
    assert 'genai_project_id="hushh-pda-uat"' in backend_build
    assert '"${_DEPLOY_ENV}" != "dev"' in backend_build
    assert "roles/serviceusage.serviceUsageConsumer" in backend_build
    assert '"GOOGLE_CLOUD_PROJECT=${genai_project_id}"' in backend_build
    assert backend_build.count('"GOOGLE_CLOUD_PROJECT=${genai_project_id}"') == 1
    assert "GOOGLE_CLOUD_PROJECT=${genai_project_id}" in backend_build
    assert '_GENAI_PROJECT_ID: ""' in backend_build


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
    backend_build = backend_deploy_surface()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert '"DB_POOL_MIN_SIZE=${_DB_POOL_MIN_SIZE}"' in backend_build
    assert '"DB_POOL_MAX_SIZE=${_DB_POOL_MAX_SIZE}"' in backend_build
    assert '"DB_SQLALCHEMY_POOL_SIZE=${_DB_SQLALCHEMY_POOL_SIZE}"' in backend_build
    assert '"DB_SQLALCHEMY_MAX_OVERFLOW=${_DB_SQLALCHEMY_MAX_OVERFLOW}"' in backend_build
    assert '"--max=${_CLOUD_RUN_MAX_INSTANCES}"' in backend_build
    assert '"--min=${_CLOUD_RUN_MIN_INSTANCES}"' in backend_build
    assert '"--min-instances=0"' in backend_build
    assert '_DB_POOL_MIN_SIZE: "1"' in backend_build
    assert '_DB_POOL_MAX_SIZE: "4"' in backend_build
    assert '_DB_SQLALCHEMY_POOL_SIZE: "4"' in backend_build
    assert '_DB_SQLALCHEMY_MAX_OVERFLOW: "0"' in backend_build

    assert "_DB_POOL_MIN_SIZE=1" in uat_workflow
    assert "_DB_POOL_MAX_SIZE=3" in uat_workflow
    assert "_DB_SQLALCHEMY_POOL_SIZE=2" in uat_workflow
    assert "_DB_SQLALCHEMY_MAX_OVERFLOW=0" in uat_workflow
    assert "_CLOUD_RUN_MIN_INSTANCES=1" in uat_workflow
    assert "_CLOUD_RUN_MAX_INSTANCES=3" in uat_workflow
    # Each backend instance opens the asyncpg pool (DB_POOL_MAX_SIZE) plus the
    # SQLAlchemy pool (DB_SQLALCHEMY_POOL_SIZE + DB_SQLALCHEMY_MAX_OVERFLOW).
    # UAT: at most 5 connections per instance and 15 total across 3 instances.
    uat_per_instance = 3 + 2 + 0
    assert uat_per_instance == 5
    assert uat_per_instance * 3 == 15

    assert "_DB_POOL_MIN_SIZE=1" in production_workflow
    assert "_DB_POOL_MAX_SIZE=4" in production_workflow
    assert "_DB_SQLALCHEMY_POOL_SIZE=4" in production_workflow
    assert "_DB_SQLALCHEMY_MAX_OVERFLOW=0" in production_workflow
    assert "_CLOUD_RUN_MIN_INSTANCES=1" in production_workflow
    assert "_CLOUD_RUN_MAX_INSTANCES=5" in production_workflow
    # Production: at most 8 connections per instance and 40 total across 5
    # instances (overflow pinned to 0 so the ceiling is deterministic, not
    # a burstable QueuePool overflow that can exhaust Cloud SQL slots).
    prod_per_instance = 4 + 4 + 0
    assert prod_per_instance == 8
    assert prod_per_instance * 5 == 40

    for workflow in (uat_workflow, production_workflow):
        assert 'BACKEND_REVISION_RETENTION: "3"' in workflow
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
    for path, expected_created_revision_lookups in (
        (".github/workflows/deploy-uat.yml", 3),
        (".github/workflows/deploy-dev.yml", 2),
    ):
        workflow = _read(path)
        assert workflow.count("status.latestReadyRevisionName") == 0
        assert (
            workflow.count("status.latestCreatedRevisionName") == expected_created_revision_lookups
        )
        assert workflow.count("status.traffic[0].revisionName") >= 6
