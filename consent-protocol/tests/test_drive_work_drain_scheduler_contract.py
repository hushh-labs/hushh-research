"""Keep the Drive work scheduler narrowly bounded and OIDC-only."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "drive" / "setup_work_drain_scheduler.sh"
CLOUDBUILD = ROOT / "deploy" / "backend.cloudbuild.yaml"
UAT_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PRODUCTION_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-production.yml"
WORKER_RELEASE = ROOT / "deploy" / "drive" / "deploy_worker_service.sh"
WORKER_ROLLBACK = ROOT / "deploy" / "drive" / "rollback_after_worker_failure.sh"
SCHEDULER_STATE = ROOT / "deploy" / "drive" / "verify_scheduler_state.py"


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

    # gcloud's multi-container parser treats trailing flags as container
    # arguments. Global flags must precede the command, not follow a sidecar.
    assert 'gcloud --quiet run deploy "${SERVICE}"' in release
    assert release.index("gcloud --quiet run deploy") < release.index("--container=clamav")
    assert "clamav/clamav@sha256:" in release
    assert "--no-allow-unauthenticated" in release
    assert "--depends-on=clamav" in release
    assert "--startup-probe=tcpSocket.port=3310" in release
    assert "--max-instances=1 --min-instances=0" in release
    assert "--timeout=240" in release
    assert 'traffic_flags=(--no-traffic "${traffic_flags[@]}")' in release
    assert "promoted=true\ngcloud run services update-traffic" in release
    assert 'retargeted=true\nBACKEND_URL="${worker_url}"' in release
    assert "actual_uri" in release and "actual_audience" in release
    assert "actual_revision" in release and "restore_failed" in release
    assert "trap rollback EXIT" in release
    assert "trap 'exit 130' INT" in release
    assert "trap 'exit 143' TERM" in release
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
    assert workflow.index("id: capture-drive-worker-scheduler") < workflow.index(
        "id: deploy-drive-worker"
    )
    assert workflow.index("id: verify-drive-worker-scheduler-rollback") < workflow.index(
        "id: final-state"
    )
    assert "drive_worker_failure_rollback_complete" in workflow
    scheduler_rollback_clause = workflow.split(
        'if [ "${{ steps.verify-drive-worker-scheduler-rollback.outcome }}"', 1
    )[1].split("fi", 1)[0]
    assert "steps.verify-drive-worker-scheduler-rollback.outputs.restored" in (
        scheduler_rollback_clause
    )
    assert "DRIVE_WORKER_ROLLBACK_COMPLETE=false" in scheduler_rollback_clause
    assert (
        '"drive_worker_failure_rollback_complete": os.environ["DRIVE_WORKER_ROLLBACK_COMPLETE"]'
        in workflow
    )
    assert "backend_sha" in workflow and "frontend_sha" in workflow
    assert 'if [ "$STATUS" != "healthy" ]; then' in workflow
    assert "_CLOUD_RUN_MEMORY=4Gi" in workflow


def _scheduler_snapshot(uri: str, audience: str) -> dict[str, object]:
    return {
        "httpTarget": {
            "uri": uri,
            "oidcToken": {
                "audience": audience,
                "serviceAccountEmail": (
                    "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
                ),
            },
        }
    }


def test_scheduler_capture_and_exact_rollback_verification(tmp_path: Path):
    uri = "https://api.uat.hushh.ai/api/internal/drive-work/drain"
    audience = "https://api.uat.hushh.ai"
    snapshot = tmp_path / "scheduler.json"
    output = tmp_path / "github-output"
    snapshot.write_text(json.dumps(_scheduler_snapshot(uri, audience)), encoding="utf-8")

    capture = subprocess.run(  # noqa: S603 - fixed repository-owned script
        [
            "python3",
            str(SCHEDULER_STATE),
            "capture",
            "--snapshot",
            str(snapshot),
            "--github-output",
            str(output),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert capture.returncode == 0, capture.stderr
    assert output.read_text(encoding="utf-8") == f"uri={uri}\naudience={audience}\n"

    verify = subprocess.run(  # noqa: S603 - fixed repository-owned script
        [
            "python3",
            str(SCHEDULER_STATE),
            "verify",
            "--snapshot",
            str(snapshot),
            "--expected-uri",
            uri,
            "--expected-audience",
            audience,
            "--github-output",
            str(output),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert verify.returncode == 0, verify.stderr
    assert output.read_text(encoding="utf-8").endswith("restored=true\n")

    snapshot.write_text(
        json.dumps(
            _scheduler_snapshot(
                "https://consent-protocol-drive-worker-abc.a.run.app/api/internal/drive-work/drain",
                audience,
            )
        ),
        encoding="utf-8",
    )
    mismatch = subprocess.run(  # noqa: S603 - fixed repository-owned script
        [
            "python3",
            str(SCHEDULER_STATE),
            "verify",
            "--snapshot",
            str(snapshot),
            "--expected-uri",
            uri,
            "--expected-audience",
            audience,
            "--github-output",
            str(output),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert mismatch.returncode != 0
    assert "did not return to pre-worker state" in mismatch.stderr
    assert output.read_text(encoding="utf-8").count("restored=true") == 1


@pytest.mark.parametrize(
    "snapshot",
    [
        _scheduler_snapshot(
            "https://api.uat.hushh.ai/api/internal/drive-work/drain",
            "https://api.uat.hushh.ai\nother=value",
        ),
        _scheduler_snapshot(
            "https://api.uat.hushh.ai/api/internal/drive-work/drain?redirect=1",
            "https://api.uat.hushh.ai",
        ),
        {
            "httpTarget": {
                "uri": "https://api.uat.hushh.ai/api/internal/drive-work/drain",
                "oidcToken": {"audience": "https://api.uat.hushh.ai"},
            }
        },
    ],
)
def test_scheduler_capture_rejects_malformed_or_wrong_identity(
    tmp_path: Path, snapshot: dict[str, object]
):
    snapshot_path = tmp_path / "scheduler.json"
    output = tmp_path / "github-output"
    snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
    result = subprocess.run(  # noqa: S603 - fixed repository-owned script
        [
            "python3",
            str(SCHEDULER_STATE),
            "capture",
            "--snapshot",
            str(snapshot_path),
            "--github-output",
            str(output),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert result.returncode != 0
    assert not output.exists()


@pytest.mark.parametrize(
    ("worker_state", "expect_no_traffic", "expect_deploy"),
    [
        ("absent", False, True),
        ("existing", True, True),
        ("ambiguous", False, False),
        ("list_error", False, False),
        ("cancel_during_deploy", False, True),
    ],
)
def test_worker_deploy_traffic_flags_match_service_state(
    tmp_path: Path,
    worker_state: str,
    expect_no_traffic: bool,
    expect_deploy: bool,
):
    """Exercise the real release script with a non-mutating gcloud stand-in."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_gcloud = fake_bin / "gcloud"
    fake_gcloud.write_text(
        """#!/usr/bin/env python3
import json
import os
import signal
import sys

args = sys.argv[1:]
with open(os.environ["MOCK_GCLOUD_CALLS"], "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
command = [arg for arg in args if arg != "--quiet"]
state = os.environ["MOCK_WORKER_STATE"]
if command[:3] == ["run", "services", "list"]:
    if state == "list_error":
        sys.exit(77)
    names = ["consent-protocol-drive-worker"] if state in ("existing", "ambiguous") else []
    print(json.dumps([{"metadata": {"name": name}} for name in names]))
elif command[:3] == ["run", "services", "describe"]:
    traffic = ([{"revisionName": "worker-previous-00001", "percent": 100}]
               if state == "existing" else [])
    print(json.dumps({"status": {"traffic": traffic}}))
elif command[:3] == ["scheduler", "jobs", "describe"]:
    if "--format=value(httpTarget.uri)" in command:
        print("https://api.uat.hushh.ai/api/internal/drive-work/drain")
    elif "--format=value(httpTarget.oidcToken.audience)" in command:
        print("https://api.uat.hushh.ai")
    else:
        sys.exit(78)
elif command[:2] == ["run", "deploy"]:
    if state == "cancel_during_deploy":
        os.kill(os.getppid(), signal.SIGTERM)
        sys.exit(0)
    sys.exit(79)
else:
    sys.exit(80)
""",
        encoding="utf-8",
    )
    fake_gcloud.chmod(0o755)
    call_log = tmp_path / "gcloud-calls.jsonl"
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "MOCK_GCLOUD_CALLS": str(call_log),
            "MOCK_WORKER_STATE": worker_state,
            "IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
            "DEPLOY_SHA": "b" * 40,
            "RUNTIME_SERVICE_ACCOUNT": (
                "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
            ),
            "CLOUDSQL_INSTANCE": "hushh-pda-uat:us-central1:hushh-uat-pg",
            "RELEASE_RUN_ID": "12345",
        }
    )
    result = subprocess.run(  # noqa: S603 - fixed repository-owned shell helper
        ["bash", str(WORKER_RELEASE)],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
    )
    calls = [json.loads(line) for line in call_log.read_text(encoding="utf-8").splitlines()]
    deploys = [call for call in calls if call[:3] == ["--quiet", "run", "deploy"]]

    assert result.returncode != 0  # The fake deploy intentionally stops before any GCP write.
    assert len(deploys) == int(expect_deploy), result.stderr
    if expect_deploy:
        deploy = deploys[0]
        assert ("--no-traffic" in deploy) is expect_no_traffic
        assert "--ingress=internal" in deploy
        assert "--no-allow-unauthenticated" in deploy
        assert "--tag=drive-candidate-12345" in deploy
        assert "--container=drive-worker" in deploy
        assert "--container=clamav" in deploy
    elif worker_state == "ambiguous":
        assert "no unambiguous serving revision" in result.stderr
    if worker_state == "cancel_during_deploy":
        assert result.returncode == 143
        assert "Drive worker candidate failed" in result.stderr
