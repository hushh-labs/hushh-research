from __future__ import annotations

import re
from pathlib import Path

import yaml

from tests._deploy_contract import backend_deploy_surface

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_manual_rollback_jobs_bind_exact_deployment_environments() -> None:
    workflow = yaml.safe_load(_read(".github/workflows/rollback.yml"))

    assert workflow["jobs"]["rollback-uat"]["environment"] == "uat"
    assert workflow["jobs"]["rollback-production"]["environment"] == "production"


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


def test_uat_runtime_capacity_is_bounded_and_revision_safe() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    # The backend deploy command lives in scripts/deploy/backend-deploy.sh on this
    # branch, not inline in the cloudbuild YAML, so assert against the whole surface.
    backend_build = backend_deploy_surface()
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


def test_uat_automatic_rollback_uses_tagged_last_known_good() -> None:
    workflow = _read(".github/workflows/deploy-uat.yml")
    rollback_block = workflow[
        workflow.index("- name: Resolve last-known-good rollback targets") : workflow.index(
            "- name: Resolve final Cloud Run state"
        )
    ]

    assert "git fetch --force origin" in rollback_block
    assert "refs/tags/deployed/uat-latest:refs/tags/deployed/uat-latest" in rollback_block
    assert "scripts/ci/resolve-rollback-target.sh uat backend" in rollback_block
    assert "scripts/ci/resolve-rollback-target.sh uat frontend" in rollback_block
    assert "steps.rollback-targets.outputs.backend_revision" in rollback_block
    assert "steps.rollback-targets.outputs.frontend_revision" in rollback_block
    assert "steps.predeploy-state.outputs.backend_revision" not in rollback_block
    assert "steps.predeploy-state.outputs.frontend_revision" not in rollback_block


def test_uat_deploy_pins_the_shared_firebase_authority() -> None:
    workflow_source = _read(".github/workflows/deploy-uat.yml")
    workflow = yaml.safe_load(workflow_source)

    assert workflow["env"]["UAT_FIREBASE_PROJECT_ID"] == "hushh-pda"
    assert (
        workflow_source.count('--expected-firebase-project "${{ env.UAT_FIREBASE_PROJECT_ID }}"')
        == 2
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


def test_backend_vertex_advisory_probe_parses_pretty_json_verdict() -> None:
    backend_build = _read("deploy/backend.cloudbuild.yaml")

    # python3, not python: the cloud-sdk build-step image ships only python3, and
    # the parser runs on the probe-FAILED branch, so a bare `python` there is a 127
    # (command not found) that only surfaces when a probe actually fails -- exactly
    # the dev billing-dunning path. Observed live 2026-08-25 (build 4e875955). The
    # `--command="python3"` deploy-step assertion main added does not apply here: the
    # branch's deploy body lives in scripts/deploy/backend-deploy.sh, not inline, so
    # this contract checks the probe interpreter that IS in the cloudbuild.
    assert "PROBE_LINE=\"${probe_line}\" python3 - <<'PY'" in backend_build
    assert "PROBE_LINE=\"${probe_line}\" python - <<'PY'" not in backend_build
    assert 'marker = "managed_vertex_probe_result"' in backend_build
    assert "json.loads(payload)" in backend_build
    assert 'verdict.get("classification")' in backend_build
    assert 'sed -n \'s/.*"classification":"' not in backend_build


def test_cross_project_vertex_fallback_is_dev_or_exact_uat_bridge_only() -> None:
    # The IAM preflight (allowlist) lives in the cloudbuild's verify-runtime-iam
    # step, while the deployed service's GOOGLE_CLOUD_PROJECT env is assembled in
    # scripts/deploy/backend-deploy.sh. Read the whole deploy surface -- both files.
    backend_build = backend_deploy_surface()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert 'if [[ "${_DEPLOY_ENV}" == "dev" ]]; then' in backend_build
    assert 'genai_project_id="hushh-pda-uat"' in backend_build
    assert backend_build.count('case "${_DEPLOY_ENV}:${genai_project_id}" in') == 1
    assert "dev:hushh-pda-uat|uat:hushh-gemini-bridge)" in backend_build
    assert "Cross-project managed Vertex target is not allowlisted." in backend_build
    assert "##_GENAI_PROJECT_ID=hushh-gemini-bridge" in uat_workflow
    assert "hushh-gemini-bridge" not in production_workflow
    assert "roles/serviceusage.serviceUsageConsumer" in backend_build
    assert '"GOOGLE_CLOUD_PROJECT=${genai_project_id}"' in backend_build
    assert backend_build.count('"GOOGLE_CLOUD_PROJECT=${genai_project_id}"') == 1
    assert "GOOGLE_CLOUD_PROJECT=${genai_project_id}" in backend_build
    assert '_GENAI_PROJECT_ID: ""' in backend_build


def test_uat_uses_the_rehearsed_vertex_live_fallback_when_developer_credits_are_depleted() -> None:
    backend_build = backend_deploy_surface()
    uat_workflow = _read(".github/workflows/deploy-uat.yml")
    production_workflow = _read(".github/workflows/deploy-production.yml")
    readiness_probe = _read("consent-protocol/scripts/verify_managed_vertex_runtime.py")

    fallback = "gemini-live-2.5-flash-native-audio"
    assert f"##_AGENT_ONE_ADK_MODEL={fallback}" in uat_workflow
    assert "_AGENT_ONE_ADK_MODEL" not in production_workflow
    assert 'append_optional_env "AGENT_ONE_ADK_MODEL" "${_AGENT_ONE_ADK_MODEL}"' in backend_build
    assert "AGENT_ONE_ADK_MODEL=${_AGENT_ONE_ADK_MODEL}" in backend_build
    assert '_AGENT_ONE_ADK_MODEL: ""' in backend_build
    assert 'os.getenv("AGENT_ONE_ADK_MODEL") or live_model' in readiness_probe


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
    assert (
        'append_optional_env "CONSENT_WEB_FALLBACK_ENABLED" "${_CONSENT_WEB_FALLBACK_ENABLED}"'
        in backend_build
    )
    assert 'append_optional_env "CONSENT_SSE_ENABLED" "${_CONSENT_SSE_ENABLED}"' in backend_build
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
    # Two incidents shaped this number, in opposite directions.
    #
    # 2026-08-23: the bound was 5 per worker (3 + 2 + 0). Cloud Run admits 80
    # concurrent requests per instance and every asyncpg call site did a plain
    # pool.acquire() with no timeout, so once three connections were held by
    # slow routes every later request waited forever and died at Cloud Run's
    # 3600s request timeout, holding a concurrency slot for the full hour.
    #
    # 2026-08-24: raising it to 18 per worker to fix that exhausted Postgres.
    # db-custom-1-3840 gets a Cloud SQL default max_connections near 100 — NOT
    # the ~400 the first fix assumed from the disk/tier size. 18 x 2 workers x
    # 3 instances is 108 on its own, and a revision cutover briefly runs a
    # fourth instance, so UAT started answering
    # "FATAL: remaining connection slots are reserved for non-replication
    # superuser connections" as soon as traffic scaled out.
    #
    # 2026-08-24 later the same day: maxScale=3 saturated the Cloud Run request
    # plane under long-lived consent event requests, so UAT answered Cloud Run's
    # own "no available instance" 429 before authenticated setup calls could hit
    # app code. Rebalance toward more instances and smaller deterministic pools:
    # request headroom grows, while deploy peak stays under the same Postgres cap.
    #
    # So the ceiling is Postgres, not the app. Keep the total under ~70 and the
    # cutover peak under ~85 to leave room for migrations, cron jobs, ad-hoc
    # psql, and the extra instance a deploy briefly adds. Starvation is no
    # longer a hang: db/connection.py bounds pool.acquire(), so a pool that is
    # too small fails fast with a 503 instead of queueing until Cloud Run kills
    # the request.
    #
    # Overflow stays pinned at 0 so the ceiling remains deterministic.
    POSTGRES_MAX_CONNECTIONS = 100  # Cloud SQL default for db-custom-1-3840

    uat_per_worker = 4 + 3 + 0
    assert uat_per_worker == 7
    assert uat_per_worker * gunicorn_workers == 14
    uat_total = uat_per_worker * gunicorn_workers * 5
    assert uat_total == 70
    # A revision cutover briefly runs one instance more than the cap.
    uat_peak_during_deploy = uat_per_worker * gunicorn_workers * 6
    assert uat_peak_during_deploy <= POSTGRES_MAX_CONNECTIONS * 0.85, (
        f"UAT would use {uat_peak_during_deploy} of ~{POSTGRES_MAX_CONNECTIONS} "
        "Postgres connections during a deploy, leaving no room for migrations, "
        "cron, or psql"
    )

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
    # Prod runs a larger instance, but pin the same shape so a future bump has
    # to state the ceiling it is sizing against rather than assume one.
    assert prod_total <= 100

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
        (".github/workflows/deploy-uat.yml", 2),
        (".github/workflows/deploy-dev.yml", 2),
    ):
        workflow = _read(path)
        assert workflow.count("status.latestReadyRevisionName") == 0
        assert (
            workflow.count("status.latestCreatedRevisionName") == expected_created_revision_lookups
        )
        if path.endswith("deploy-uat.yml"):
            assert "--format='value(status.traffic[0].revisionName)'" not in workflow
            assert "resolve-cloud-run-serving-state.py" in workflow
        else:
            assert workflow.count("status.traffic[0].revisionName") >= 6
