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
            "containers": [
                {
                    "name": "drive-worker",
                    "image": IMAGE,
                    "env": [
                        {"name": "DRIVE_WORK_DRAIN_ENABLED", "value": "true"},
                        {"name": "DRIVE_WORKER_MODE", "value": "true"},
                        {"name": "DRIVE_WORKER_V1_ONLY", "value": "true"},
                        {"name": "ENVIRONMENT", "value": "uat"},
                    ],
                },
                {"name": "clamav", "image": "clamav/clamav@" + SCANNER},
            ]
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


def test_v1_revision_requires_exact_image_and_isolation_flags() -> None:
    verifier.verify_v1_revision(
        _revision(), sha=SHA, image=IMAGE, scanner_index=SCANNER, scanner_amd64=SCANNER
    )
    revision = _revision()
    revision["spec"]["containers"][0]["env"][2]["value"] = "false"
    with pytest.raises(ValueError, match="isolation flags"):
        verifier.verify_v1_revision(
            revision, sha=SHA, image=IMAGE, scanner_index=SCANNER, scanner_amd64=SCANNER
        )


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
