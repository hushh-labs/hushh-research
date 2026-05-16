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


def test_production_deploy_keeps_default_traffic_behavior() -> None:
    production_workflow = _read(".github/workflows/deploy-production.yml")

    assert "_CLOUD_RUN_NO_TRAFFIC" not in production_workflow
    assert "--no-traffic" not in production_workflow
