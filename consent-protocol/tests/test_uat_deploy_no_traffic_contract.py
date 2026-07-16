from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


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
    assert '"--max=${_CLOUD_RUN_MAX_INSTANCES}"' in backend_build
    assert '"--min=${_CLOUD_RUN_MIN_INSTANCES}"' in backend_build
    assert '"--min-instances=0"' in backend_build
    assert '_DB_POOL_MIN_SIZE: "1"' in backend_build
    assert '_DB_POOL_MAX_SIZE: "8"' in backend_build

    for workflow in (uat_workflow, production_workflow):
        assert "_DB_POOL_MIN_SIZE=1" in workflow
        assert "_DB_POOL_MAX_SIZE=8" in workflow
        assert "_CLOUD_RUN_MIN_INSTANCES=1" in workflow
        assert "_CLOUD_RUN_MAX_INSTANCES=5" in workflow
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
    assert "CONSENT_API_PUBLIC_ORIGIN: https://api.hushh.ai" in workflow
    assert "_CONSENT_API_PUBLIC_ORIGIN=${{ env.CONSENT_API_PUBLIC_ORIGIN }}" in workflow


def test_nonproduction_rollback_targets_are_traffic_bearing_revisions() -> None:
    for path in (".github/workflows/deploy-uat.yml", ".github/workflows/deploy-dev.yml"):
        workflow = _read(path)
        assert workflow.count("status.latestReadyRevisionName") == 0
        assert workflow.count("status.latestCreatedRevisionName") == 2
        assert workflow.count("status.traffic[0].revisionName") >= 6
