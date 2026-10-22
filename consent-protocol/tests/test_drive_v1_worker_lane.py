"""Static contracts for the isolated UAT deterministic Drive worker lane."""

from __future__ import annotations

import base64
import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DRIVE = ROOT / "deploy" / "drive"
sys.path.insert(0, str(DRIVE))

spec = importlib.util.spec_from_file_location("v1_scheduler_state", DRIVE / "v1_scheduler_state.py")
assert spec is not None and spec.loader is not None
scheduler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduler)

verifier_spec = importlib.util.spec_from_file_location(
    "verify_v1_worker_revision", DRIVE / "verify_v1_worker_revision.py"
)
assert verifier_spec is not None and verifier_spec.loader is not None
verifier = importlib.util.module_from_spec(verifier_spec)
verifier_spec.loader.exec_module(verifier)

SHA = "a" * 40
IMAGE = "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "b" * 64
SCANNER = "sha256:" + "c" * 64
ORIGIN = "https://consent-protocol-drive-v1-worker-abcd.a.run.app"


def _job() -> dict:
    return {
        "name": scheduler.FULL_JOB,
        "state": "ENABLED",
        "schedule": "* * * * *",
        "timeZone": "Etc/UTC",
        "attemptDeadline": "240s",
        "retryConfig": {
            "retryCount": 3,
            "minBackoffDuration": "10s",
            "maxBackoffDuration": "120s",
            "maxDoublings": 3,
        },
        "httpTarget": {
            "uri": ORIGIN + scheduler.PATH,
            "httpMethod": "POST",
            "body": base64.b64encode(b'{"stage":"v1"}').decode(),
            "headers": {
                "Content-Type": "application/json",
                "User-Agent": "Google-Cloud-Scheduler",
            },
            "oidcToken": {
                "serviceAccountEmail": scheduler.ACCOUNT,
                "audience": scheduler.AUDIENCE,
            },
        },
    }


def _revision() -> dict:
    return {
        "metadata": {"labels": {"deploy-sha": SHA}},
        "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        "spec": {
            "serviceAccountName": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
            "containers": [
                {
                    "name": "drive-worker",
                    "image": IMAGE,
                    "env": [
                        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "true"},
                        {"name": "DRIVE_WORKER_MODE", "value": "true"},
                        {"name": "DRIVE_WORKER_V1_ONLY", "value": "true"},
                        {"name": "DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "value": "gemini"},
                        {"name": "ENVIRONMENT", "value": "uat"},
                        {"name": "HUSHH_UAT_MANAGED_TEXT_PROVIDER", "value": "azure_openai"},
                        {"name": "HUSHH_UAT_MANAGED_AI_PROVIDER", "value": "azure_openai"},
                    ],
                },
                {"name": "clamav", "image": "clamav/clamav@" + SCANNER},
            ],
        },
    }


def test_only_fixed_v1_scheduler_contract_is_accepted() -> None:
    assert scheduler._state(_job(), ORIGIN) == {"origin": ORIGIN, "state": "ENABLED"}
    for change in ("body", "target", "account", "stage", "state"):
        job = copy.deepcopy(_job())
        if change == "body":
            job["httpTarget"]["body"] = base64.b64encode(b'{"stage":"documents"}').decode()
        elif change == "target":
            job["httpTarget"]["uri"] = "https://example.com" + scheduler.PATH
        elif change == "account":
            job["httpTarget"]["oidcToken"]["serviceAccountEmail"] = "wrong@example.com"
        elif change == "stage":
            job["schedule"] = "*/10 * * * *"
        else:
            job["state"] = "DISABLED"
        with pytest.raises(scheduler.V1SchedulerError):
            scheduler._state(job, ORIGIN)


def test_quarantine_pauses_exact_job_despite_partial_configuration(monkeypatch) -> None:
    state = {"value": "ENABLED"}
    calls = []

    def describe():
        return {
            "name": scheduler.FULL_JOB,
            "state": state["value"],
            "httpTarget": {"uri": "https://unreviewed.example.invalid/drain"},
        }

    def run(*args):
        calls.append(args)
        state["value"] = "PAUSED"
        return ""

    monkeypatch.setattr(scheduler, "_describe", describe)
    monkeypatch.setattr(scheduler, "_run", run)
    monkeypatch.setattr(scheduler, "_origin", lambda: pytest.fail("quarantine fetched origin"))
    monkeypatch.setattr(sys, "argv", ["v1_scheduler_state.py", "quarantine"])
    assert scheduler.main() == 0
    assert calls == [
        (
            "scheduler",
            "jobs",
            "pause",
            scheduler.JOB,
            f"--project={scheduler.PROJECT}",
            f"--location={scheduler.REGION}",
        )
    ]


def test_quarantine_rejects_unverified_pause(monkeypatch) -> None:
    monkeypatch.setattr(
        scheduler,
        "_describe",
        lambda: {"name": scheduler.FULL_JOB, "state": "ENABLED", "httpTarget": {}},
    )
    monkeypatch.setattr(scheduler, "_run", lambda *args: "")
    with pytest.raises(scheduler.V1SchedulerError, match="quarantine failed"):
        scheduler._quarantine()


@pytest.mark.parametrize("drain_enabled", ["true", "false"])
def test_v1_revision_requires_exact_image_and_isolation_flags(drain_enabled) -> None:
    revision = _revision()
    revision["spec"]["containers"][0]["env"][0]["value"] = drain_enabled
    arguments = dict(
        sha=SHA,
        image=IMAGE,
        scanner_index=SCANNER,
        scanner_amd64=SCANNER,
        drain_enabled=drain_enabled,
    )
    verifier.verify_v1_revision(revision, **arguments)
    for kind, message in (
        ("isolation", "isolation flags"),
        ("identity", "identity mismatch"),
        ("drain", "background processing state"),
        ("image", "app image"),
    ):
        broken = copy.deepcopy(revision)
        if kind == "isolation":
            broken["spec"]["containers"][0]["env"][2]["value"] = "false"
        elif kind == "identity":
            broken["spec"]["serviceAccountName"] = "other@example.invalid"
        elif kind == "drain":
            broken["spec"]["containers"][0]["env"][0]["value"] = (
                "true" if drain_enabled == "false" else "false"
            )
        else:
            broken["spec"]["containers"][0]["image"] = IMAGE[:-1] + "e"
        with pytest.raises(ValueError, match=message):
            verifier.verify_v1_revision(broken, **arguments)


def test_workflow_deploys_v1_only_after_paused_legacy_attestation() -> None:
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "deploy-uat.yml").read_text())
    steps = {row["id"]: row for row in workflow["jobs"]["deploy"]["steps"] if "id" in row}
    v1 = steps["deploy-drive-v1-worker"]
    assert "inputs.preserve_paused_drive_worker == true" in v1["if"]
    assert "steps.verify-paused-drive-maintenance.outcome == 'success'" in v1["if"]
    assert "deploy/drive/deploy_v1_worker_service.sh" in v1["run"]
    assert (
        "steps.deploy-drive-v1-worker.outcome == 'success'"
        in steps["verify-paused-drive-after-v1"]["if"]
    )
    assert "verify-paused-drive-after-v1" in steps["rollback-backend-after-drive-worker"]["if"]
    capacity = next(
        row
        for row in workflow["jobs"]["deploy"]["steps"]
        if row.get("name") == "Enforce UAT database connection budget before deployment"
    )
    assert "--candidate-service consent-protocol-drive-v1-worker" in capacity["run"]


def test_capacity_profile_reserves_optional_v1_worker_candidate() -> None:
    profile = json.loads((ROOT / "config" / "runtime-capacity.json").read_text())
    v1 = profile["environments"]["uat"]["services"][scheduler.SERVICE]
    assert v1["optional_existing"] is True
    assert v1["candidate"]["max_instances"] == 1
    assert v1["candidate"]["asyncpg_pool_max"] == 2

    budget_spec = importlib.util.spec_from_file_location(
        "runtime_capacity_budget", ROOT / "scripts" / "ci" / "runtime-capacity-budget.py"
    )
    assert budget_spec is not None and budget_spec.loader is not None
    budget = importlib.util.module_from_spec(budget_spec)
    budget_spec.loader.exec_module(budget)
    minimal_profile = {
        "schema_version": 1,
        "region": "us-central1",
        "database_max_connections": 1000,
        "admission_limit": 900,
        "administrative_reserve": 100,
        "environments": {
            "uat": {
                "project": "hushh-pda-uat",
                "database_instance": "hushh-uat-pg",
                "services": {scheduler.SERVICE: v1},
                "jobs": {},
            }
        },
    }
    report = budget.evaluate(
        minimal_profile,
        "uat",
        {"database_max_connections": 1000, "services": {}, "jobs": {}},
        candidate_services=frozenset({scheduler.SERVICE}),
    )
    assert report["admitted"] is True
    assert any(row["name"] == scheduler.SERVICE + ":new-candidate" for row in report["services"])


@pytest.mark.parametrize("state", ["PAUSED", "ENABLED", "ABSENT"])
def test_paused_scheduler_requires_unchanged_paused_baseline(monkeypatch, tmp_path, state):
    job = _job()
    job["state"] = state
    snapshot = tmp_path / "scheduler.json"
    snapshot.write_text(
        json.dumps(
            {"schema": "drive.v1.scheduler.v1", "job": {"origin": ORIGIN, "state": "PAUSED"}}
        )
    )
    monkeypatch.setattr(scheduler, "_describe", lambda: None if state == "ABSENT" else job)
    monkeypatch.setattr(scheduler, "_origin", lambda: ORIGIN)
    monkeypatch.setattr(
        scheduler, "_run", lambda *args: pytest.fail("paused verification mutated job")
    )
    monkeypatch.setattr(
        sys, "argv", ["v1_scheduler_state.py", "verify-paused", "--snapshot", str(snapshot)]
    )
    assert scheduler.main() == (0 if state == "PAUSED" else 1)
    if state == "PAUSED":
        monkeypatch.setattr(
            sys, "argv", ["v1_scheduler_state.py", "restore", "--snapshot", str(snapshot)]
        )
        assert scheduler.main() == 0
        snapshot.write_text(
            json.dumps(
                {"schema": "drive.v1.scheduler.v1", "job": {"origin": ORIGIN, "state": "ENABLED"}}
            )
        )
        monkeypatch.setattr(
            sys, "argv", ["v1_scheduler_state.py", "verify-paused", "--snapshot", str(snapshot)]
        )
        assert scheduler.main() == 1


@pytest.mark.parametrize(
    "baseline,invalid_candidate", [("PAUSED", False), ("ENABLED", False), ("PAUSED", True)]
)
def test_paused_release_never_dispatches_or_resumes_work(tmp_path, baseline, invalid_candidate):
    """Execute the real release helper against a deny-by-default cloud boundary."""
    import os
    import subprocess

    commands = tmp_path / "commands.jsonl"
    fixture = tmp_path / "fixture.json"
    revision = _revision()
    revision["spec"]["containers"][0]["env"][0]["value"] = "true" if invalid_candidate else "false"
    scanner = "sha256:0e31ce089574268aefa0b543767d66b70240ab51ed49eec53e07f18d5629d817"
    revision["spec"]["containers"][1]["image"] = "clamav/clamav@" + scanner
    job = _job()
    job["state"] = baseline
    fixture.write_text(json.dumps({"job": job, "revision": revision}))
    binary = tmp_path / "gcloud"
    binary.write_text(
        "#!"
        + sys.executable
        + "\n"
        + """
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ["COMMAND_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
fixture = json.loads(Path(os.environ["CLOUD_FIXTURE"]).read_text())
a = [v for v in args if v != "--quiet"]
if a[:4] == ["run", "services", "describe", "consent-protocol"]:
    print(json.dumps({"status": {"traffic": [{"revisionName": "consent-protocol-01234-api", "percent": 100}]}}))
elif a[:4] == ["run", "revisions", "describe", "consent-protocol-01234-api"]:
    print(json.dumps({
        "metadata": {"name": "consent-protocol-01234-api"},
        "spec": {"serviceAccountName": os.environ["RUNTIME_SERVICE_ACCOUNT"], "containers": [{
            "image": os.environ["IMAGE_REFERENCE"],
            "env": [{"name": key, "value": value} for key, value in {
                "HUSHH_DEPLOY_SHA": os.environ["DEPLOY_SHA"],
                "HUSHH_DEPLOY_RUN_ID": os.environ["RELEASE_RUN_ID"],
                "HUSHH_DEPLOY_ENV": "uat", "HUSHH_UAT_MANAGED_TEXT_PROVIDER": "azure_openai", "HUSHH_UAT_MANAGED_AI_PROVIDER": "azure_openai",
            }.items()],
        }]}, "status": {"conditions": [{"type": "Ready", "status": "True"}]},
    }))
elif a[:3] == ["iam", "service-accounts", "describe"]:
    print("{}")
elif a[:2] == ["secrets", "describe"]:
    sys.exit(1)
elif a[:3] == ["run", "services", "list"]:
    print(json.dumps([{"metadata": {"name": "consent-protocol-drive-v1-worker"}}]))
elif a[:3] == ["run", "services", "describe"]:
    if "--format=value(status.url)" in a:
        print("https://consent-protocol-drive-v1-worker-abcd.a.run.app")
    elif "--format=value(status.latestCreatedRevisionName)" in a:
        print("consent-protocol-drive-v1-worker-00002-new")
    else:
        print(json.dumps({"status": {"traffic": [{"revisionName": "consent-protocol-drive-v1-worker-00001-old", "percent": 100}]}}))
elif a[:3] == ["run", "revisions", "describe"]:
    print(json.dumps(fixture["revision"]))
elif a[:2] == ["run", "deploy"]:
    assert any("DRIVE_WORK_DRAIN_ENABLED=false|" in arg for arg in a)
elif a[:3] == ["run", "services", "update-traffic"]:
    pass
elif a[:3] == ["scheduler", "jobs", "list"]:
    print(json.dumps([fixture["job"]]))
elif a[:3] == ["scheduler", "jobs", "describe"]:
    print(json.dumps(fixture["job"]))
else:
    sys.exit("Forbidden cloud operation in paused release")
"""
    )
    binary.chmod(0o755)
    snapshot = tmp_path / "before.json"
    previous = tmp_path / "previous.txt"
    source = (DRIVE / "deploy_v1_worker_service.sh").read_text()
    # Isolate the two fixed runner paths; execute all policy/attestation code unchanged.
    source = source.replace("/tmp/uat-drive-v1-before.json", str(snapshot)).replace(  # noqa: S108 - replace runner literal, never use it locally
        "/tmp/uat-drive-v1-previous-revision.txt",  # noqa: S108 - rewrite runner path only
        str(previous),
    )
    script = tmp_path / "deploy.sh"
    script.write_text(source)
    environment = {
        **os.environ,
        "PATH": str(tmp_path)
        + os.pathsep
        + str(Path(sys.executable).parent)
        + os.pathsep
        + os.environ["PATH"],
        "IMAGE_REFERENCE": IMAGE,
        "DEPLOY_SHA": SHA,
        "RUNTIME_SERVICE_ACCOUNT": "consent-protocol-runtime@hushh-pda-uat.iam.gserviceaccount.com",
        "CLOUDSQL_INSTANCE": "hushh-pda-uat:us-central1:hushh-uat-pg",
        "RELEASE_RUN_ID": "123",
        "SNAPSHOT_PATH": str(snapshot),
        "PREVIOUS_REVISION_PATH": str(previous),
        "DRIVE_WORK_DRAIN_ENABLED": "false",
        "STRIPE_UAT_MODE": "test",
        "STRIPE_CONNECT_UAT_MODE": "test",
        "DRIVE_REQUEST_PAYMENTS_UAT_ENABLED": "false",
        "DRIVE_REQUEST_OWNER_PAYOUTS_UAT_ENABLED": "false",
        "DRIVE_REQUEST_HASHCOINS_UAT_ENABLED": "false",
        "DRIVE_REQUEST_HASHCOINS_LIVE_UAT_ENABLED": "false",
        "COMMAND_LOG": str(commands),
        "CLOUD_FIXTURE": str(fixture),
    }
    result = subprocess.run(  # noqa: S603 - authored repo script, synthetic cloud boundary
        ["bash", str(script)], cwd=ROOT, env=environment, text=True, capture_output=True, timeout=60
    )
    calls = [json.loads(row) for row in commands.read_text().splitlines()]
    if invalid_candidate:
        assert result.returncode != 0
        assert any(
            "update-traffic" in call
            and "--to-revisions=consent-protocol-drive-v1-worker-00001-old=100" in call
            for call in calls
        )
    elif baseline == "PAUSED":
        assert result.returncode == 0, result.stdout + result.stderr
        assert "background processing paused" in result.stdout
        assert any("deploy" in call for call in calls)
        assert any("update-traffic" in call for call in calls)
    else:
        assert result.returncode != 0
        # The workflow must not see an invalid rollback snapshot and resume it.
        assert not snapshot.exists()
        assert not any("deploy" in call or "update-traffic" in call for call in calls)
    assert not any(
        any(word in call for word in ("run", "resume", "apply", "add-iam-policy-binding"))
        for call in calls
        if call[:1] != ["run"] and call[:2] != ["--quiet", "run"]
    )
    assert not any("add-iam-policy-binding" in call for call in calls)


@pytest.mark.parametrize(
    "mode,paused,http200,expected",
    [
        ("false", "true", "false", "true"),
        ("false", "false", "true", "false"),
        ("false", "true", "true", "false"),
        ("true", "false", "true", "true"),
        ("true", "true", "false", "false"),
    ],
)
def test_release_gate_requires_mode_specific_evidence(mode, paused, http200, expected):
    import re
    import subprocess

    workflow = yaml.safe_load((ROOT / ".github/workflows/deploy-uat.yml").read_text())
    step = next(
        row
        for row in workflow["jobs"]["deploy"]["steps"]
        if row.get("name") == "Write UAT release status artifact"
    )
    gate = (
        step["run"]
        .split("DRIVE_WORKER_GATE_SUCCESS=false", 1)[1]
        .split('\nif [ "${{ steps.scope.outputs.deploy_backend }}" = "true" ]', 1)[0]
    )
    values = {
        "inputs.preserve_paused_drive_worker": "true",
        "steps.scope.outputs.deploy_backend": "true",
        "steps.resolve-sha.outputs.sha": SHA,
        "steps.deploy-drive-v1-worker.outputs.sha": SHA,
        "steps.deploy-drive-v1-worker.outputs.paused_drive_v1_unchanged": paused,
        "steps.deploy-drive-v1-worker.outputs.scheduler_http_200": http200,
        "vars.DRIVE_V1_WORK_DRAIN_UAT_ENABLED || 'true'": mode,
    }

    def replace(match):
        expression = match[1].strip()
        if expression in values:
            return values[expression]
        if expression.endswith(".outcome"):
            return "success"
        if expression.endswith(".outputs.paused_drive_baseline_captured") or expression.endswith(
            ".outputs.paused_drive_unchanged"
        ):
            return "true"
        pytest.fail("Unreviewed release gate expression: " + expression)

    gate = re.sub(r"\$\{\{(.*?)\}\}", replace, gate)
    result = subprocess.run(  # noqa: S603 - authored repo script, synthetic cloud boundary
        [
            "bash",
            "-c",
            "set -euo pipefail\nDRIVE_WORKER_GATE_SUCCESS=false\n"
            + gate
            + '\nprintf "%s" "$DRIVE_WORKER_GATE_SUCCESS"',
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    assert result.stdout == expected
