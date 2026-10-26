"""Keep the Drive work scheduler narrowly bounded and OIDC-only."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

from tests.helpers.drive_worker_gcloud import write_worker_gcloud_fixture
from tests.helpers.production_runtime_profile import run_production_backend_build

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "drive" / "setup_work_drain_scheduler.sh"
CLOUDBUILD = ROOT / "deploy" / "backend.cloudbuild.yaml"
UAT_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-uat.yml"
PRODUCTION_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-production.yml"
WORKER_RELEASE = ROOT / "deploy" / "drive" / "deploy_worker_service.sh"
WORKER_ROLLBACK = ROOT / "deploy" / "drive" / "rollback_after_worker_failure.sh"
SCHEDULER_STATE = ROOT / "deploy" / "drive" / "verify_scheduler_state.py"


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("test", "STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET"),
        (
            "live",
            "STRIPE_LIVE_SECRET_KEY STRIPE_LIVE_WEBHOOK_SECRET STRIPE_LIVE_CONNECT_WEBHOOK_SECRET",
        ),
        ("production", None),
    ],
)
def test_uat_stripe_mode_selects_isolated_secret_family(mode, expected):
    result = subprocess.run(
        [
            "bash",
            "-c",
            "source deploy/drive/uat_stripe_bindings.sh && "
            'printf "%s %s %s" "$STRIPE_UAT_KEY_SECRET" '
            '"$STRIPE_UAT_WEBHOOK_SECRET" "$STRIPE_UAT_CONNECT_SECRET"',
        ],
        cwd=ROOT,
        env={**os.environ, "STRIPE_UAT_MODE": mode},
        capture_output=True,
        text=True,
        check=False,
    )
    if expected is None:
        assert result.returncode != 0
        assert result.stdout == ""
    else:
        assert result.returncode == 0, result.stderr
        assert result.stdout == expected
    workflow = UAT_WORKFLOW.read_text()
    worker = WORKER_RELEASE.read_text()
    assert "source deploy/drive/uat_stripe_bindings.sh" in workflow
    assert "source deploy/drive/uat_stripe_bindings.sh" in worker
    assert "STRIPE_MODE=${STRIPE_UAT_MODE}" in workflow
    assert "STRIPE_MODE=${STRIPE_UAT_MODE}" in worker


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
    assert '--message-body="{\\"stage\\":\\"${STAGE}\\"}"' in source
    for name, stage, cron in (
        ("drive-work-drain-uat", "documents", "* * * * *"),
        ("drive-work-suggestions-uat", "suggestions", "* * * * *"),
        ("drive-work-sharing-uat", "sharing", "* * * * *"),
    ):
        assert f'"${{JOB_NAME}}" == "{name}"' in source
        assert f'"${{STAGE}}" == "{stage}"' in source
        assert f'"${{CRON}}" == "{cron}"' in source
    assert "2-59/4 * * * *" not in source

    production_source = (ROOT / "deploy/drive/setup_work_drain_scheduler_prod.sh").read_text(
        encoding="utf-8"
    )
    assert '"${CRON}" == "* * * * *"' in production_source
    assert "2-59/4 * * * *" not in production_source
    assert "base64.b64decode(body, validate=True) != expected" in source
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


@pytest.mark.parametrize(
    "overrides",
    [
        {"JOB_NAME": "drive-work-suggestions-uat", "STAGE": "documents"},
        {"JOB_NAME": "drive-work-drain-uat", "STAGE": "suggestions"},
        {"JOB_NAME": "drive-work-sharing-uat", "STAGE": "sharing", "CRON": "*/2 * * * *"},
        {"JOB_NAME": "attacker-job", "STAGE": "sharing", "CRON": "* * * * *"},
    ],
)
def test_scheduler_rejects_mismatched_fixed_job_stage_or_cadence_before_mutation(overrides):
    result = _run_scheduler_with(**overrides)

    assert result.returncode != 0
    assert "only configures the reviewed UAT Drive work-drain job" in result.stderr


def test_runtime_wires_exact_scheduler_identity_and_gates_production_activation():
    cloudbuild = CLOUDBUILD.read_text(encoding="utf-8")
    uat = UAT_WORKFLOW.read_text(encoding="utf-8")
    production = PRODUCTION_WORKFLOW.read_text(encoding="utf-8")
    names = (
        "DRIVE_WORK_DRAIN_ENABLED",
        "DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID",
        "DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL",
        "DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE",
    )

    deploy_script = (ROOT / "scripts" / "deploy" / "backend-deploy.sh").read_text(encoding="utf-8")
    packed = next(
        line for line in cloudbuild.splitlines() if '"_DRIVE_WORK_DRAIN_SETTINGS=' in line
    )
    for name in names:
        assert f"${{_{name}}}" in packed
        assert f'append_optional_env "{name}" "${{_{name}}}"' in deploy_script
    assert '_DRIVE_WORK_DRAIN_ENABLED: "false"' in cloudbuild
    for name in names[1:]:
        assert f'_{name}: ""' in cloudbuild

    assert (
        "_DRIVE_WORK_DRAIN_ENABLED=${{ inputs.preserve_paused_drive_worker && 'false' || 'true' }}"
    ) in uat
    wake = next(
        step
        for step in yaml.safe_load(uat)["jobs"]["deploy"]["steps"]
        if step.get("name") == "Verify prompt UAT Drive worker wake grant"
    )
    assert wake["if"] == (
        "steps.scope.outputs.deploy_backend == 'true' "
        "&& inputs.preserve_paused_drive_worker != true"
    )
    assert "roles/cloudscheduler.jobRunner" in wake["run"]
    assert "_DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID=${{ env.GCP_PROJECT_ID }}" in uat
    assert (
        "_DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL="
        "drive-work-drain-sched@${{ env.GCP_PROJECT_ID }}.iam.gserviceaccount.com"
    ) in uat
    assert "_DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE=${{ env.CONSENT_API_PUBLIC_ORIGIN }}" in uat
    steps = yaml.safe_load(production)["jobs"]["deploy"]["steps"]
    deploy = next(step["run"] for step in steps if step.get("id") == "deploy-backend")
    for active, hosted in (("false", "false"), ("true", "false"), ("false", "true")):
        result = run_production_backend_build(deploy, drive_active=active, hosted_documents=hosted)
        assert ("_DRIVE_WORK_DRAIN_ENABLED=true" in result.stdout) == (
            active == "true" or hosted == "true"
        )
        if active == "true" or hosted == "true":
            assert "_DRIVE_WORK_DRAIN_SCHEDULER_PROJECT_ID=hushh-pda," in result.stdout
            assert (
                "_DRIVE_WORK_DRAIN_SCHEDULER_SERVICE_ACCOUNT_EMAIL="
                "drive-work-drain-sched@hushh-pda.iam.gserviceaccount.com,"
            ) in result.stdout
            assert "_DRIVE_WORK_DRAIN_SCHEDULER_AUDIENCE=https://api.hushh.ai" in result.stdout


def test_full_uat_drive_rollout_cannot_inherit_disabled_repo_drain_variable():
    workflow = UAT_WORKFLOW.read_text(encoding="utf-8")
    steps = yaml.safe_load(workflow)["jobs"]["deploy"]["steps"]
    by_id = {step["id"]: step for step in steps if "id" in step}
    active = "${{ inputs.preserve_paused_drive_worker && 'false' || 'true' }}"

    # Ordinary suggestions and sharing jobs must resume on the default full
    # rollout even if a repository Actions variable remains set to false.
    assert "vars.DRIVE_WORK_DRAIN_UAT_ENABLED" not in workflow
    assert "_DRIVE_WORK_DRAIN_ENABLED=" + active in by_id["deploy-backend"]["run"]
    assert by_id["deploy-drive-worker"]["env"]["DRIVE_WORK_DRAIN_ENABLED"] == "true"
    assert "inputs.preserve_paused_drive_worker != true" in by_id["deploy-drive-worker"]["if"]
    status = next(step for step in steps if step.get("name") == "Write UAT release status artifact")
    assert '"drive_processing_enabled": "' + active + '"' in status["run"]


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
    assert "--max-instances=2 --min-instances=0" in release
    # The candidate attestation holds the revision to the budgeted scale.
    assert "EXPECTED_MAX_INSTANCES=2 EXPECTED_CONCURRENCY=1" in release
    assert "--timeout=240" in release
    assert 'traffic_flags=(--no-traffic "${traffic_flags[@]}")' in release
    assert "promoted=true\ngcloud run services update-traffic" in release
    assert 'retargeted=true\nif [[ "${DRIVE_WORK_DRAIN_ENABLED}" == false ]]' in release
    assert 'python3 "${SCHEDULER_STATE_HELPER}" restore' in release
    assert 'python3 "${SCHEDULER_STATE_HELPER}" quarantine' in release
    assert all(token in release for token in ("plan-configuration", "verify-configuration"))
    assert 'gcloud scheduler jobs run "${fixed_job}"' in release
    assert 'rm -f "${scheduler_snapshot}"' in release
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
    assert workflow.index("id: promote-uat-traffic") < workflow.index("id: deploy-drive-worker")
    assert workflow.index("id: verify-drive-worker-scheduler-rollback") < workflow.index(
        "id: final-state"
    )
    assert "drive_worker_failure_rollback_complete" in workflow
    deploy_step = workflow.split("id: deploy-drive-worker", 1)[1].split(
        "id: rollback-backend-after-drive-worker", 1
    )[0]
    assert "if: always() && !cancelled()" in deploy_step
    assert 'if [ "${{ steps.capture-drive-worker-scheduler.outcome }}" != "success" ]; then' in (
        deploy_step
    )
    assert "triggering runtime rollback" in deploy_step
    assert "exit 1" in deploy_step
    assert "exec > >(tee /tmp/uat-drive-worker-release.log) 2>&1" in deploy_step
    assert "exec bash deploy/drive/deploy_worker_service.sh" in deploy_step
    for rollback_step in (
        "rollback-backend-after-drive-worker",
        "rollback-frontend-after-drive-worker",
        "verify-drive-worker-scheduler-rollback",
    ):
        condition = workflow.split(f"id: {rollback_step}", 1)[1].split("shell: bash", 1)[0]
        assert "steps.promote-uat-traffic.outcome != 'skipped'" in condition
        assert "steps.classify-uat-release.outputs.release_failed != 'true'" in condition
        assert "steps.deploy-drive-worker.outcome != 'success'" in condition
        assert "steps.scope.outputs.deploy_backend == 'true'" in condition

    scheduler_rollback_clause = workflow.split(
        'if [ "${{ steps.scope.outputs.deploy_backend }}" = "true" ] \\\n', 1
    )[1].split('if [ "${{ steps.classify-uat-release.outputs.release_failed }}"', 1)[0]
    assert '"$DRIVE_WORKER_GATE_SUCCESS" != true' in scheduler_rollback_clause
    assert 'inputs.preserve_paused_drive_worker }}" != "true"' in scheduler_rollback_clause
    assert "DRIVE_WORKER_ROLLBACK_COMPLETE=false" in scheduler_rollback_clause
    assert 'steps.verify-drive-worker-scheduler-rollback.outcome }}" = "success"' in (
        scheduler_rollback_clause
    )
    assert 'steps.verify-drive-worker-scheduler-rollback.outputs.restored }}" = "true"' in (
        scheduler_rollback_clause
    )
    assert "DRIVE_WORKER_ROLLBACK_COMPLETE=true" in scheduler_rollback_clause
    assert (
        '"drive_worker_failure_rollback_complete": os.environ["DRIVE_WORKER_ROLLBACK_COMPLETE"]'
        in workflow
    )
    assert "backend_sha" in workflow and "frontend_sha" in workflow
    assert 'if [ "$STATUS" != "healthy" ]; then' in workflow


def test_frontend_only_uat_release_cannot_enter_drive_worker_fallback():
    """A skipped worker must not undo a valid frontend-only promotion."""
    workflow = UAT_WORKFLOW.read_text(encoding="utf-8")
    condition = workflow.split("id: rollback-frontend-after-drive-worker", 1)[1].split(
        "shell: bash", 1
    )[0]

    assert "steps.scope.outputs.deploy_backend == 'true'" in condition
    assert "steps.scope.outputs.deploy_frontend == 'true'" in condition
    # Backend failure, cancellation and skipped execution remain eligible once
    # promotion was attempted; backend scope is the key frontend-only guard.
    assert "steps.promote-uat-traffic.outcome != 'skipped'" in condition
    assert "steps.deploy-drive-worker.outcome != 'success'" in condition


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

    output.unlink()
    no_capture = subprocess.run(  # noqa: S603 - fixed repository-owned script
        [
            "python3",
            str(SCHEDULER_STATE),
            "verify",
            "--snapshot",
            str(snapshot),
            "--expected-uri",
            "",
            "--expected-audience",
            "",
            "--github-output",
            str(output),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    assert no_capture.returncode != 0
    assert not output.exists()


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
        _scheduler_snapshot(
            "https://unrelated-service-abc.a.run.app/api/internal/drive-work/drain",
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
        ("failed_first_create", False, True),
        ("existing", True, True),
        ("ambiguous", False, False),
        ("list_error", False, False),
        ("cancel_during_deploy", False, True),
    ],
)
@pytest.mark.parametrize(
    ("release_run_id", "expected_tag"),
    [
        ("12345", "d-9ix"),
        ("18446744073709551615", "d-3w5e11264sgsf"),
    ],
)
def test_worker_deploy_traffic_flags_match_service_state(
    tmp_path: Path,
    worker_state: str,
    expect_no_traffic: bool,
    expect_deploy: bool,
    release_run_id: str,
    expected_tag: str,
):
    """Exercise the real release script with a non-mutating gcloud stand-in."""
    fake_bin = tmp_path / "bin"
    write_worker_gcloud_fixture(fake_bin)
    call_log = tmp_path / "gcloud-calls.jsonl"
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
            "MOCK_GCLOUD_CALLS": str(call_log),
            "MOCK_WORKER_STATE": worker_state,
            "MOCK_SCHEDULER_JOB": json.dumps(
                [
                    {
                        "name": "projects/hushh-pda-uat/locations/us-central1/jobs/drive-work-drain-uat",
                        "schedule": "*/2 * * * *",
                        "timeZone": "Etc/UTC",
                        "state": "ENABLED",
                        "attemptDeadline": "120s",
                        "retryConfig": {
                            "retryCount": 3,
                            "minBackoffDuration": "10s",
                            "maxBackoffDuration": "120s",
                            "maxDoublings": 3,
                            "maxRetryDuration": "0s",
                        },
                        "httpTarget": {
                            "uri": "https://api.uat.hushh.ai/api/internal/drive-work/drain",
                            "httpMethod": "POST",
                            "body": "e30=",
                            "headers": {
                                "Content-Type": "application/json",
                                "User-Agent": "Google-Cloud-Scheduler",
                            },
                            "oidcToken": {
                                "audience": "https://api.uat.hushh.ai",
                                "serviceAccountEmail": (
                                    "drive-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
                                ),
                            },
                        },
                    }
                ]
            ),
            "IMAGE_REFERENCE": "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "a" * 64,
            "DEPLOY_SHA": "b" * 40,
            "RUNTIME_SERVICE_ACCOUNT": (
                "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com"
            ),
            "CLOUDSQL_INSTANCE": "hushh-pda-uat:us-central1:hushh-uat-pg",
            "RELEASE_RUN_ID": release_run_id,
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
        assert f"--tag={expected_tag}" in deploy
        assert len("consent-protocol-drive-worker") + 1 + len(expected_tag) <= 46
        assert "--container=drive-worker" in deploy
        assert "--container=clamav" in deploy
        # Scaling flags precede the first container, so they bind the service
        # and revision. Both budgeted instances stay warm through the
        # service-level floor; the revision keeps no floor and one request.
        first_container = deploy.index("--container=drive-worker")
        scaling = {
            name: value
            for name, _, value in (arg.partition("=") for arg in deploy[:first_container])
            if name in {"--concurrency", "--max-instances", "--min-instances", "--max", "--min"}
        }
        assert scaling == {
            "--concurrency": "1",
            "--max-instances": "2",
            "--min-instances": "0",
            "--max": "2",
            "--min": "2",
        }
        # Pre-deploy admission reserves the profile's candidate, so the cap,
        # launcher workers and pools must equal it; the floor never exceeds it.
        profile = json.loads((ROOT / "config" / "runtime-capacity.json").read_text())
        services = profile["environments"]["uat"]["services"]
        candidate = services["consent-protocol-drive-worker"]["candidate"]
        assert scaling["--max"] == scaling["--max-instances"] == str(candidate["max_instances"])
        assert 1 <= int(scaling["--min"]) <= candidate["max_instances"]
        worker = {
            name: value
            for name, _, value in (
                arg.partition("=")
                for arg in deploy[first_container : deploy.index("--container=clamav")]
            )
        }
        launcher = worker["--args"].split(",")
        assert launcher[launcher.index("-w") + 1] == str(candidate["workers_per_instance"])
        env_vars = worker["--set-env-vars"]
        assert env_vars.startswith("^|^")
        env = dict(item.split("=", 1) for item in env_vars.removeprefix("^|^").split("|"))
        assert [
            env["DB_POOL_MAX_SIZE"],
            env["DB_SQLALCHEMY_POOL_SIZE"],
            env["DB_SQLALCHEMY_MAX_OVERFLOW"],
        ] == [
            str(candidate[key])
            for key in ("asyncpg_pool_max", "sqlalchemy_pool_size", "sqlalchemy_max_overflow")
        ]
        assert int(env["DB_POOL_MIN_SIZE"]) <= candidate["asyncpg_pool_max"]
    elif worker_state == "ambiguous":
        assert "no unambiguous serving revision" in result.stderr
    if worker_state == "cancel_during_deploy":
        assert result.returncode == 143
        assert "Drive worker candidate failed" in result.stderr


def test_uat_sandbox_connect_does_not_change_live_checkout_binding():
    result = subprocess.run(
        [
            "bash",
            "-c",
            "source deploy/drive/uat_stripe_bindings.sh && "
            'printf "%s %s %s %s" "$STRIPE_UAT_KEY_SECRET" "$STRIPE_UAT_CONNECT_KEY_SECRET" '
            '"$STRIPE_UAT_CONNECT_SECRET" "$STRIPE_UAT_CONNECT_TEST_WEBHOOK_SECRET"',
        ],
        cwd=ROOT,
        env={**os.environ, "STRIPE_UAT_MODE": "live", "STRIPE_CONNECT_UAT_MODE": "test"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == (
        "STRIPE_LIVE_SECRET_KEY STRIPE_SECRET_KEY "
        "STRIPE_LIVE_CONNECT_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET"
    )


@pytest.mark.parametrize(
    ("connect_mode", "payment_mode", "connect_key", "live_flag", "secret_state", "expected"),
    [
        ("test", "live", "STRIPE_SECRET_KEY", "false", "ENABLED", 0),
        ("test", "live", "STRIPE_SECRET_KEY", "false", "MISSING", 1),
        ("test", "live", "STRIPE_SECRET_KEY", "true", "ENABLED", 1),
        ("live", "live", "STRIPE_LIVE_SECRET_KEY", "false", "ENABLED", 0),
        ("live", "live", "STRIPE_LIVE_SECRET_KEY", "true", "ENABLED", 0),
        ("live", "test", "STRIPE_LIVE_SECRET_KEY", "true", "ENABLED", 1),
        ("live", "live", "STRIPE_SECRET_KEY", "true", "ENABLED", 1),
        ("live", "live", "STRIPE_LIVE_SECRET_KEY", "true", "DISABLED", 1),
    ],
)
def test_hashcoin_deploy_preflight_checks_isolated_secret_project(
    connect_mode, payment_mode, connect_key, live_flag, secret_state, expected
):
    script = """
set -euo pipefail
gcloud() {
  if [[ "$*" == "secrets describe "*" --project=hushh-pda-uat" ]]; then
    [[ "$SECRET_STATE" != MISSING ]]
    return
  fi
  if [[ "$*" == "secrets versions describe latest "*" --project=hushh-pda-uat --format=value(state)" ]]; then
    [[ "$SECRET_STATE" != MISSING ]] || return 1
    printf '%s\\n' "$SECRET_STATE"
    return
  fi
  return 2
}
source deploy/drive/verify_hashcoin_config.sh hushh-pda-uat
"""
    result = subprocess.run(  # noqa: S603 - fixed repository-owned preflight script
        ["bash", "-c", script],
        cwd=ROOT,
        env={
            **os.environ,
            "_DRIVE_REQUEST_HASHCOINS_ENABLED": "true",
            "_DRIVE_REQUEST_HASHCOINS_LIVE_ENABLED": live_flag,
            "_STRIPE_MODE": payment_mode,
            "_STRIPE_SECRET_KEY_SECRET": "STRIPE_LIVE_SECRET_KEY"
            if payment_mode == "live"
            else "STRIPE_SECRET_KEY",
            "_STRIPE_CONNECT_MODE": connect_mode,
            "_STRIPE_CONNECT_SECRET_KEY_SECRET": connect_key,
            "_STRIPE_CONNECT_WEBHOOK_SECRET_SECRET": "STRIPE_LIVE_CONNECT_WEBHOOK_SECRET",
            "_STRIPE_CONNECT_TEST_WEBHOOK_SECRET_SECRET": "STRIPE_CONNECT_WEBHOOK_SECRET",
            "SECRET_STATE": secret_state,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == expected, result.stderr
