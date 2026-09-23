"""Keep the Drive work scheduler narrowly bounded and OIDC-only."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "drive" / "setup_work_drain_scheduler.sh"
CLOUDBUILD = ROOT / "deploy" / "backend.cloudbuild.yaml"
UAT_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PRODUCTION_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-production.yml"
WORKER_RELEASE = ROOT / "deploy" / "drive" / "deploy_worker_service.sh"
WORKER_ROLLBACK = ROOT / "deploy" / "drive" / "rollback_after_worker_failure.sh"


def test_scheduler_targets_only_the_bounded_oidc_drain_and_never_mutates_runtime_iam():
    source = SCRIPT.read_text(encoding="utf-8")

    assert 'readonly UAT_PROJECT_ID="hushh-pda-uat"' in source
    assert 'readonly UAT_PUBLIC_BACKEND_ORIGIN="https://api.uat.hushh.ai"' in source
    assert (
        'readonly UAT_RUNTIME_BACKEND_ORIGIN="https://consent-protocol-f2gsa4kfsq-uc.a.run.app"'
        in source
    )
    assert 'URI="${BACKEND_URL%/}/api/internal/drive-work/drain"' in source
    assert "--http-method=POST" in source
    assert "--message-body='{}'" in source
    assert "--oidc-service-account-email" in source
    assert "--oidc-token-audience" in source
    assert "--attempt-deadline=240s" in source
    assert 'readonly UAT_WORKER_SERVICE="consent-protocol-drive-worker"' in source
    assert 'gcloud run services describe "${UAT_WORKER_SERVICE}"' in source
    assert "--max-retry-attempts=3" in source
    assert "scheduler jobs update http" in source
    assert "scheduler jobs create http" in source
    assert "roles/iam.serviceAccountTokenCreator" not in source
    assert "add-iam-policy-binding" not in source
    assert "run services update" not in source
    assert "dispatches\n# background work" in source


def _run_scheduler_with(**overrides: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.update(
        {
            "PROJECT_ID": "hushh-pda-uat",
            "BACKEND_URL": "https://api.uat.hushh.ai",
            "OIDC_AUDIENCE": "https://api.uat.hushh.ai",
            **overrides,
        }
    )
    return subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(SCRIPT)],
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )


def test_scheduler_refuses_non_uat_projects_before_any_gcloud_mutation():
    result = _run_scheduler_with(PROJECT_ID="hushh-pda")

    assert result.returncode != 0
    assert "limited to hushh-pda-uat" in result.stderr
    assert "gcloud" not in result.stderr.lower()


def test_scheduler_refuses_http_or_unreviewed_https_origins_before_any_gcloud_mutation():
    http_result = _run_scheduler_with(
        BACKEND_URL="http://api.uat.hushh.ai",
        OIDC_AUDIENCE="http://api.uat.hushh.ai",
    )
    unreviewed_result = _run_scheduler_with(
        BACKEND_URL="https://example.invalid",
        OIDC_AUDIENCE="https://example.invalid",
    )

    assert http_result.returncode != 0
    assert "must use HTTPS" in http_result.stderr
    assert unreviewed_result.returncode != 0
    assert "verified Drive worker origin" in unreviewed_result.stderr


def test_scheduler_refuses_audience_substitution_before_any_gcloud_mutation():
    result = _run_scheduler_with(OIDC_AUDIENCE="https://consent-protocol-f2gsa4kfsq-uc.a.run.app")

    assert result.returncode != 0
    assert "must exactly match BACKEND_URL" in result.stderr


def test_uat_runtime_wires_the_exact_scheduler_identity_and_keeps_other_lanes_default_off():
    cloudbuild = CLOUDBUILD.read_text(encoding="utf-8")
    uat = UAT_WORKFLOW.read_text(encoding="utf-8")
    production = PRODUCTION_WORKFLOW.read_text(encoding="utf-8")
    names = (
        "DRIVE_WORK_DRAIN_ENABLED",
        "DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID",
        "DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL",
        "DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE",
    )

    for name in names:
        assert f'"_{name}=${{_{name}}}"' in cloudbuild
        assert name in next(
            line for line in cloudbuild.splitlines() if "for n in ONE_EMAIL_ADDRESS" in line
        )
    assert '_DRIVE_WORK_DRAIN_ENABLED: "false"' in cloudbuild
    for name in names[1:]:
        assert f'_{name}: ""' in cloudbuild

    assert "_DRIVE_WORK_DRAIN_ENABLED=true" in uat
    assert "_DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID=${{ env.GCP_PROJECT_ID }}" in uat
    assert (
        "_DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL="
        "drive-work-drain-sched@${{ env.GCP_PROJECT_ID }}.iam.gserviceaccount.com"
    ) in uat
    assert "_DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE=${{ env.CONSENT_API_PUBLIC_ORIGIN }}" in uat
    assert "_DRIVE_WORK_DRAIN_ENABLED=true" not in production


def test_worker_promotion_is_post_gate_attested_and_recoverable():
    release = WORKER_RELEASE.read_text(encoding="utf-8")
    rollback = WORKER_ROLLBACK.read_text(encoding="utf-8")
    workflow = UAT_WORKFLOW.read_text(encoding="utf-8")

    assert "clamav/clamav@sha256:" in release
    assert "--no-allow-unauthenticated" in release
    assert "--depends-on=clamav" in release
    assert "--startup-probe=tcpSocket.port=3310" in release
    assert "--max-instances=1 --min-instances=0" in release
    assert "--timeout=240" in release
    assert "promoted=true\ngcloud run services update-traffic" in release
    assert 'retargeted=true\nBACKEND_URL="${worker_url}"' in release
    assert "actual_uri" in release and "actual_audience" in release
    assert "actual_revision" in release and "restore_failed" in release
    assert "account-deletion-contract" in rollback
    assert "Refusing rollback from ambiguous serving traffic" in rollback
    assert "Late UAT rollback did not restore" in rollback

    assert workflow.index("id: classify-uat-release") < workflow.index("id: deploy-drive-worker")
    assert workflow.index("id: deploy-drive-worker") < workflow.index(
        "id: rollback-backend-after-drive-worker"
    )
    assert workflow.index("id: rollback-backend-after-drive-worker") < workflow.index(
        "id: final-state"
    )
    assert "drive_worker_failure_rollback_complete" in workflow
    assert "backend_sha" in workflow and "frontend_sha" in workflow
    assert 'if [ "$STATUS" != "healthy" ]; then' in workflow
    assert "_CLOUD_RUN_MEMORY=4Gi" in workflow
