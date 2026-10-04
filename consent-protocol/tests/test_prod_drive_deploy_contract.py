"""Production Drive release must stay closed until its fixed prerequisites pass."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def _module(name: str):
    path = ROOT / "deploy/drive" / name
    spec = importlib.util.spec_from_file_location(name.removesuffix(".py"), path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_production_dispatch_is_opt_in_and_worker_precedes_app_traffic():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    assert workflow[True]["workflow_dispatch"]["inputs"]["drive_live_mode"]["default"] == "preserve"
    assert workflow["env"]["DRIVE_CANDIDATE_RUNTIME_SECRET"].endswith(
        "${{ github.run_id }}_${{ github.run_attempt }}"
    )
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert names.index("Resolve production Drive release mode from serving backend") < names.index(
        "Verify production Drive prerequisites before mutation"
    )
    assert names.index("Verify production Drive prerequisites before mutation") < names.index(
        "Sync canonical hosted runtime secrets"
    )
    assert names.index("Deploy and attest private production Drive worker") < names.index(
        "Promote deployed revisions to production traffic"
    )
    worker = next(step for step in steps if step.get("id") == "deploy-drive-worker")
    assert "steps.drive-mode.outputs.active == 'true'" in worker["if"]
    assert worker["env"]["RELEASE_RUN_ATTEMPT"] == "${{ github.run_attempt }}"
    promote = next(step for step in steps if step.get("id") == "promote-traffic")
    assert "steps.deploy-drive-worker.outcome == 'success'" in promote["if"]
    assert any(step.get("id") == "rollback-drive-worker" for step in steps)


def test_drive_release_mode_preserves_live_state_and_requires_explicit_change():
    module = _module("resolve_prod_release_mode.py")
    revision = {
        "spec": {
            "containers": [
                {
                    "env": [
                        {"name": "HUSHH_DEPLOY_ENV", "value": "production"},
                        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "true"},
                        {
                            "name": "BACKEND_RUNTIME_CONFIG_JSON",
                            "valueFrom": {
                                "secretKeyRef": {"name": "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_123_1"}
                            },
                        },
                    ]
                }
            ]
        }
    }
    runtime = {"environment": "production", **dict.fromkeys(module.DRIVE_FLAGS, "true")}
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
    ) == (True, True)
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=False, revision=revision, runtime=runtime
    ) == (True, True)
    assert module.resolve_mode(
        requested_mode="disable", backend_deploy=True, revision=revision, runtime=runtime
    ) == (True, False)
    with pytest.raises(module.DriveReleaseStateError, match="requires a backend release"):
        module.resolve_mode(
            requested_mode="disable", backend_deploy=False, revision=revision, runtime=runtime
        )
    runtime["google_drive_live"] = "false"
    with pytest.raises(module.DriveReleaseStateError, match="incomplete"):
        module.resolve_mode(
            requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
        )


def test_drive_release_mode_defaults_off_until_explicit_enable():
    module = _module("resolve_prod_release_mode.py")
    revision = {
        "spec": {
            "containers": [
                {
                    "env": [
                        {"name": "HUSHH_DEPLOY_ENV", "value": "production"},
                        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "false"},
                        {
                            "name": "BACKEND_RUNTIME_CONFIG_JSON",
                            "valueFrom": {"secretKeyRef": {"name": "BACKEND_RUNTIME_CONFIG_JSON"}},
                        },
                    ]
                }
            ]
        }
    }
    runtime = {"environment": "production", **dict.fromkeys(module.DRIVE_FLAGS, "false")}
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
    ) == (False, False)
    assert module.resolve_mode(
        requested_mode="enable", backend_deploy=True, revision=revision, runtime=runtime
    ) == (False, True)
    revision["spec"]["containers"][0]["env"][2]["valueFrom"]["secretKeyRef"]["name"] = (
        "BACKEND_RUNTIME_CONFIG_JSON_DRIVE_123_1"
    )
    assert module.resolve_mode(
        requested_mode="preserve", backend_deploy=True, revision=revision, runtime=runtime
    ) == (False, False)


def test_production_backend_config_stays_on_candidate_and_frontend_scope_skips_places():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    by_name = {step["name"]: step for step in steps}
    places = by_name["Verify production Places prerequisites"]
    assert "steps.scope.outputs.deploy_backend == 'true'" in places["if"]
    backend_sync = by_name["Sync canonical hosted runtime secrets"]
    frontend_sync = by_name["Sync frontend hosted runtime secrets"]
    assert backend_sync["if"] == "steps.scope.outputs.deploy_backend == 'true'"
    assert frontend_sync["if"] == "steps.scope.outputs.deploy_frontend == 'true'"
    assert "sync_backend_runtime_secrets.py" in backend_sync["run"]
    assert "sync_frontend_runtime_secrets.py" not in backend_sync["run"]
    assert "sync_frontend_runtime_secrets.py" in frontend_sync["run"]
    deploy = by_name["Deploy backend using Cloud Build"]["run"]
    assert (
        'DRIVE_SUBSTITUTIONS=",_BACKEND_RUNTIME_CONFIG_JSON_SECRET=${DRIVE_CANDIDATE_RUNTIME_SECRET}"'
        in deploy
    )
    readiness = by_name["Verify backend candidate readiness and exact-SHA provenance"]["run"]
    assert 'expected_runtime_secret = os.environ["DRIVE_CANDIDATE_RUNTIME_SECRET"]' in readiness


def test_production_drive_worker_keeps_refund_credentials_bound_and_fails_closed():
    script = (ROOT / "deploy/drive/deploy_worker_service_prod.sh").read_text()
    block = (
        'payment_secret_bindings=""'
        + script.split('payment_secret_bindings=""', 1)[1].split("\ngcloud --quiet run deploy", 1)[
            0
        ]
    )
    assert "${payment_secret_bindings}" in script.split("--set-secrets=", 1)[1]
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    worker = next(
        step
        for step in workflow["jobs"]["deploy"]["steps"]
        if step.get("id") == "deploy-drive-worker"
    )
    assert worker["env"]["DRIVE_REQUEST_PAYMENTS_PROD_ENABLED"] == (
        "${{ vars.DRIVE_REQUEST_PAYMENTS_PROD_ENABLED || 'false' }}"
    )
    mocked = """set -euo pipefail
PROJECT_ID=hushh-pda
REGION=us-central1
previous_revision="${PREVIOUS_REVISION:-}"
gcloud() {
  if [[ "$1" == secrets && "$2" == describe ]]; then
    [[ "$3" != "${MISSING_SECRET:-}" ]]
  elif [[ "$1" == run && "$2" == revisions && "$3" == describe ]]; then
    if [[ "${PREVIOUS_STRIPE_BOUND:-false}" == true ]]; then
      printf '%s\\n' '{"spec":{"containers":[{"name":"drive-worker","env":[{"name":"STRIPE_SECRET_KEY","valueFrom":{"secretKeyRef":{"name":"STRIPE_SECRET_KEY"}}}]}]}}'
    else
      printf '%s\\n' '{"spec":{"containers":[{"name":"drive-worker","env":[]}]}}'
    fi
  else
    return 2
  fi
}
"""

    def run(
        *, enabled: bool, missing: str = "", previous_bound: bool = False
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(  # noqa: S603 - fixed repo shell block with a mocked gcloud
            ["bash", "-c", mocked + block + '\nprintf "%s" "$payment_secret_bindings"\n'],
            env={
                **os.environ,
                "DRIVE_REQUEST_PAYMENTS_PROD_ENABLED": "true" if enabled else "false",
                "MISSING_SECRET": missing,
                "PREVIOUS_REVISION": "consent-protocol-drive-worker-prev" if previous_bound else "",
                "PREVIOUS_STRIPE_BOUND": "true" if previous_bound else "false",
            },
            capture_output=True,
            text=True,
            check=False,
        )

    ready = run(enabled=False)
    assert ready.returncode == 0
    assert "STRIPE_SECRET_KEY=STRIPE_SECRET_KEY:latest" in ready.stdout
    assert "STRIPE_WEBHOOK_SECRET=STRIPE_WEBHOOK_SECRET:latest" in ready.stdout
    assert "APP_FRONTEND_ORIGIN=APP_FRONTEND_ORIGIN:latest" in ready.stdout
    missing_off = run(enabled=False, missing="STRIPE_WEBHOOK_SECRET")
    assert missing_off.returncode == 0 and missing_off.stdout == ""
    missing_previous = run(enabled=False, missing="STRIPE_WEBHOOK_SECRET", previous_bound=True)
    assert missing_previous.returncode != 0
    assert "requires the production Stripe and origin secrets" in missing_previous.stderr
    for secret in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "APP_FRONTEND_ORIGIN"):
        missing_on = run(enabled=True, missing=secret)
        assert missing_on.returncode != 0
        assert "requires the production Stripe and origin secrets" in missing_on.stderr


def test_disabling_drive_preserves_jobs_until_promotion_and_restores_on_failure():
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = workflow["jobs"]["deploy"]["steps"]
    names = [step["name"] for step in steps]
    assert (
        names.index("Promote deployed revisions to production traffic")
        < names.index("Quarantine production Drive jobs after disabling live Drive")
        < names.index("Post-deploy backend runtime health gate")
    )
    pause = next(step for step in steps if step.get("id") == "pause-drive-worker")
    assert pause["run"].index(" capture ") < pause["run"].index(" quarantine")
    assert pause["run"].index('echo "snapshot=') < pause["run"].index(" quarantine")
    classify = next(step for step in steps if step.get("id") == "classify")
    assert (
        "backend_failure=true"
        in classify["run"].split(
            'if [ "$release_failed" = "true" ] && [ -n "$DRIVE_PAUSE_SNAPSHOT" ]; then'
        )[1]
    )
    restore = next(step for step in steps if step.get("id") == "rollback-paused-drive-worker")
    assert "steps.rollback-backend.outcome == 'success'" in restore["if"]
    assert "work_drain_scheduler_snapshot_prod.py restore" in restore["run"]


@pytest.mark.parametrize(
    "worker_origin", [None, "https://consent-protocol-drive-worker-test.a.run.app"]
)
def test_quarantined_drive_job_restores_exact_prior_state(monkeypatch, tmp_path, worker_origin):
    module = _module("work_drain_scheduler_snapshot_prod.py")
    name = "drive-work-drain-prod"
    job = module._candidate_job(name, worker_origin or module.PUBLIC_ORIGIN)
    if worker_origin is None:
        job["audience"] = module.PUBLIC_ORIGIN
    raw = {
        "name": f"projects/{module.PROJECT}/locations/{module.LOCATION}/jobs/{name}",
        "httpTarget": {
            "uri": job["uri"],
            "httpMethod": job["httpMethod"],
            "body": base64.b64encode(job["body"].encode()).decode(),
            "headers": dict(job["headers"]),
            "oidcToken": {
                "serviceAccountEmail": job["serviceAccountEmail"],
                "audience": job["audience"],
            },
        },
        "schedule": job["schedule"],
        "timeZone": job["timeZone"],
        "state": job["state"],
        "attemptDeadline": job["attemptDeadline"],
        "retryConfig": dict(job["retryConfig"]),
    }
    monkeypatch.setattr(module, "_job_names", lambda: {name})
    monkeypatch.setattr(module, "_describe", lambda _: raw)

    def fake_gcloud(*args):
        if args[:3] == ("scheduler", "jobs", "pause"):
            raw["state"] = "PAUSED"
        elif args[:3] == ("scheduler", "jobs", "resume"):
            raw["state"] = "ENABLED"
        elif args[:3] != ("scheduler", "jobs", "update"):
            raise AssertionError(f"Unexpected scheduler mutation: {args[:3]}")
        return ""

    monkeypatch.setattr(module, "_gcloud", fake_gcloud)
    snapshot = tmp_path / "scheduler.json"
    module.capture(snapshot, worker_origin=worker_origin)
    module.quarantine()
    assert raw["state"] == "PAUSED"
    module.restore(snapshot, worker_origin=worker_origin)
    assert raw["state"] == "ENABLED"
    module.verify(snapshot, worker_origin=worker_origin)


def test_production_preflight_rejects_unattested_oauth_and_wrong_picker(monkeypatch):
    module = _module("verify_prod_prerequisites.py")
    with pytest.raises(module.PrerequisiteError, match="attestation is missing"):
        module.verify(oauth_attested=False)

    values = {name: "value" for name in module.SECRETS}
    values["GOOGLE_DRIVE_OAUTH_CLIENT_ID"] = "client.apps.googleusercontent.com"
    values["DRIVE_DOCUMENT_KEY_V1"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    values["DRIVE_SHARING_KEY_V1"] = base64.b64encode(b"\x01" * 32).decode()
    values["EXTERNAL_CONNECTOR_CREDENTIAL_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    monkeypatch.setattr(module, "_secret", values.__getitem__)

    def fake_gcloud(*args):
        if args[:3] == ("services", "api-keys", "list"):
            return json.dumps(
                [
                    {
                        "name": "projects/prod/locations/global/keys/reviewed",
                        "displayName": module.PICKER_KEY_NAME,
                        "restrictions": {
                            "apiTargets": [{"service": "picker.googleapis.com"}],
                            "browserKeyRestrictions": {
                                "allowedReferrers": ["https://uat.one.hushh.ai/*"]
                            },
                        },
                    }
                ]
            )
        return "{}"

    monkeypatch.setattr(module, "_gcloud", fake_gcloud)
    with pytest.raises(module.PrerequisiteError, match="restrictions are incomplete"):
        module.verify(oauth_attested=True)

    values["DRIVE_SHARING_KEY_V1"] = values["DRIVE_DOCUMENT_KEY_V1"]
    with pytest.raises(module.PrerequisiteError, match="must be distinct"):
        module.verify(oauth_attested=True)


def test_first_production_worker_release_snapshots_absent_fixed_jobs(monkeypatch, tmp_path):
    module = _module("work_drain_scheduler_snapshot_prod.py")
    monkeypatch.setattr(module, "_job_names", lambda: set())
    snapshot = tmp_path / "scheduler.json"
    module.capture(snapshot, worker_origin=None)
    payload = json.loads(snapshot.read_text())
    assert payload["schema"] == "drive.scheduler.prod.snapshot.v1"
    assert set(payload["jobs"]) == {
        "drive-work-drain-prod",
        "drive-work-suggestions-prod",
        "drive-work-sharing-prod",
    }
    assert all(value is None for value in payload["jobs"].values())
    payload["jobs"]["drive-work-drain-uat"] = None
    snapshot.write_text(json.dumps(payload))
    with pytest.raises(module.SchedulerStateError, match="snapshot is invalid"):
        module.verify(snapshot, worker_origin=None)


def test_older_target_keeps_release_tooling_but_cannot_enable_drive(tmp_path, monkeypatch):
    """Run the actual checkout steps against an old commit without production Drive."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-production.yml").read_text())
    steps = {step["name"]: step for step in workflow["jobs"]["deploy"]["steps"]}
    repo = tmp_path / "repo"
    repo.mkdir()
    runner = tmp_path / "runner"
    runner.mkdir()

    def git(*args):
        return subprocess.run(  # noqa: S603 - fixed git command and synthetic fixture arguments
            ["git", *args], cwd=repo, capture_output=True, text=True, check=True
        ).stdout.strip()

    def write(path, contents):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents)

    git("init", "-q")
    git("config", "user.name", "Drive Release Test")
    git("config", "user.email", "drive-release@example.test")
    old_paths = (
        "scripts/ci/resolve-cloud-run-deploy-revision.py",
        "scripts/ci/resolve-uat-verified-image.py",
        "scripts/ci/assert_one_voice_live_probe.py",
        "deploy/backend.cloudbuild.yaml",
        "scripts/ops/sync_backend_runtime_secrets.py",
    )
    for path in old_paths:
        write(path, "old release tooling\n")
    git("add", ".")
    git("commit", "-qm", "Old application target")
    old_sha = git("rev-parse", "HEAD")
    tools = (
        "resolve_prod_release_mode.py",
        "verify_prod_prerequisites.py",
        "deploy_worker_service_prod.sh",
        "setup_work_drain_scheduler_prod.sh",
        "work_drain_scheduler_snapshot_prod.py",
        "restore_prod_after_release_failure.sh",
    )
    current_paths = [
        *old_paths,
        "scripts/ci/verify-prod-places-readiness.py",
        *(f"deploy/drive/{name}" for name in tools),
    ]
    for path in current_paths:
        write(path, (ROOT / path).read_text())
    registry = "consent-protocol/hushh_mcp/services/drive_prod_registry_provisioning.py"
    write(registry, "# Production Drive runtime support\n")
    git("add", ".")
    git("commit", "-qm", "Introduce production Drive support")
    feature_sha = git("rev-parse", "HEAD")
    env = {**os.environ, "RUNNER_TEMP": str(runner)}
    subprocess.run(  # noqa: S603 - execute the repo-authored release steps in an isolated fixture
        ["bash", "-c", steps["Preserve current release tooling"]["run"]],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    checkout = steps["Checkout deployment SHA"]["run"].replace(
        "${{ github.event.inputs.sha }}", old_sha
    )
    subprocess.run(  # noqa: S603 - execute the repo-authored release steps in an isolated fixture
        ["bash", "-c", checkout], cwd=repo, env=env, capture_output=True, text=True, check=True
    )
    for path in current_paths:
        # These two existing helpers are consumed directly from RUNNER_TEMP.
        if path.endswith(
            (
                "resolve-cloud-run-deploy-revision.py",
                "resolve-uat-verified-image.py",
                "verify-prod-places-readiness.py",
            )
        ):
            continue
        assert (repo / path).read_text() == (ROOT / path).read_text()
    assert (runner / "release-tools/verify-prod-places-readiness.py").read_text() == (
        ROOT / "scripts/ci/verify-prod-places-readiness.py"
    ).read_text()
    assert not (repo / registry).exists(), (
        "Release tooling must not replace target application code"
    )
    assert (runner / "release-tools/prod-drive-feature-commit").read_text().strip() == feature_sha

    module = _module("resolve_prod_release_mode.py")
    monkeypatch.chdir(repo)
    module.verify_target_support(
        active=False, backend_deploy=True, target_sha=old_sha, required_ancestor=feature_sha
    )
    with pytest.raises(module.DriveReleaseStateError, match="runtime support"):
        module.verify_target_support(
            active=True, backend_deploy=True, target_sha=old_sha, required_ancestor=feature_sha
        )
    module.verify_target_support(
        active=True, backend_deploy=True, target_sha=feature_sha, required_ancestor=feature_sha
    )
