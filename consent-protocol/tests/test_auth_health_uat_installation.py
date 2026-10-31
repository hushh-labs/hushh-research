# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Exact UAT health job installation contracts."""

import json
from pathlib import Path

import pytest
import requests
from auth_health_uat_installer_fixtures import (
    BUILD_ID,
    CHECKER_ID,
    CLOCK,
    CLOCK_ID,
    EXECUTION,
    JOB,
    JOB_NAME,
    OPERATION,
    PREPARED_SOURCE,
    PROJECT,
    SOURCE,
    job_resource,
    load_health,
    load_installer,
    prepared_uat_journal,
    runtime_fakes,
)

pytestmark = pytest.mark.feature_auth_reliability


def test_install_creates_only_exact_job_after_owner_bindings_and_build(monkeypatch, tmp_path):
    module, state, calls, job, _execution, _events = runtime_fakes(monkeypatch)
    receipt = tmp_path / "health-operation.json"

    result = module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, receipt)

    assert result["phase"] == "installed"
    assert result["timer_created"] is False
    assert result["job"]["uid"] == "job-uid-1"
    assert state["job"] == job
    assert receipt.stat().st_mode & 0o777 == 0o600
    assert not any(call[:2] == ("scheduler", "jobs") for call in calls)
    assert not any(call[0] == "iam:set" for call in calls)


def test_install_uses_same_wif_rest_404_as_the_only_absent_job_result(monkeypatch, tmp_path):
    module, state, calls, job, _execution, _events = runtime_fakes(
        monkeypatch, native_resource_reader=True
    )

    result = module.install_job(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json"
    )

    assert result["job"]["uid"] == "job-uid-1"
    assert state["job"] == job
    assert sum(call[0] == "job:get" for call in calls) == 1
    assert sum(call[:3] == ("run", "jobs", "create") for call in calls) == 1
    assert calls.index(next(call for call in calls if call[0] == "job:get")) < calls.index(
        next(call for call in calls if call[:3] == ("run", "jobs", "create"))
    )


@pytest.mark.parametrize("status", [302, 403, 500])
def test_install_refuses_non404_job_read_status_without_creation(monkeypatch, tmp_path, status):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, native_resource_reader=True, job_preflight_status=status
    )

    with pytest.raises(RuntimeError, match="Health resource observation refused"):
        module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json")

    assert state["job"] is None
    assert sum(call[0] == "job:get" for call in calls) == 1
    assert not any(call[:3] == ("run", "jobs", "create") for call in calls)


@pytest.mark.parametrize("error_type", [requests.Timeout, requests.ConnectionError])
def test_install_job_read_transport_failure_is_fail_closed_without_creation(
    monkeypatch, tmp_path, error_type
):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch,
        native_resource_reader=True,
        job_preflight_error=error_type("private transport marker"),
    )

    with pytest.raises(error_type):
        module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json")

    assert state["job"] is None
    assert sum(call[0] == "job:get" for call in calls) == 1
    assert not any(call[:3] == ("run", "jobs", "create") for call in calls)


def test_install_refuses_changed_job_uid_between_native_and_cli_reads(monkeypatch, tmp_path):
    foreign = job_resource()
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=foreign, native_resource_reader=True
    )
    state["job_preflight_uid"] = "foreign-job-uid"

    with pytest.raises(RuntimeError, match="identity changed during preflight"):
        module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json")

    assert state["job"] == foreign
    assert not any(call[:3] == ("run", "jobs", "create") for call in calls)


def test_record_intent_persists_exact_mutation_before_cloud_access(monkeypatch, tmp_path):
    module = load_installer(monkeypatch)
    monkeypatch.setattr(load_health(monkeypatch), "_reviewed_source", lambda: SOURCE)
    monkeypatch.setenv("GITHUB_RUN_ID", "41020000001")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    receipt = tmp_path / "intent.json"

    result = module.record_intent(
        "activate-timer", OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, receipt
    )

    assert result["phase"] == "requested"
    assert result["iam_effect"] == {
        "resource": JOB_NAME,
        "member": f"serviceAccount:{CLOCK}",
        "role": "roles/run.invoker",
        "condition": None,
        "when": "after exact healthy execution proof, before timer activation",
    }
    assert json.loads(receipt.read_text()) == result
    assert receipt.stat().st_mode & 0o777 == 0o600


def test_workflow_uploads_intent_before_wif_and_cloud_mutations():
    import yaml

    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/verify-protected-lists.yml").read_text())
    steps = workflow["jobs"]["health-image"]["steps"]
    record = next(
        i
        for i, step in enumerate(steps)
        if step.get("name") == "Persist exact monitoring mutation intent before cloud access"
    )
    upload = next(
        i
        for i, step in enumerate(steps)
        if step.get("uses") == "actions/upload-artifact@v6"
        and step.get("with", {}).get("name", "").startswith("auth-health-intent-")
    )
    auth = next(
        i for i, step in enumerate(steps) if step.get("uses") == "google-github-actions/auth@v3"
    )
    mutate = next(
        i
        for i, step in enumerate(steps)
        if step.get("name")
        == "Execute reviewed monitoring operation without application deployment"
    )
    assert record < upload < auth < mutate
    assert steps[upload]["with"]["if-no-files-found"] == "error"
    assert "--record-intent" in steps[record]["run"]


@pytest.mark.parametrize(
    ("operation", "checker", "clock"),
    [
        ("wrong", CHECKER_ID, CLOCK_ID),
        (OPERATION, "wrong", CLOCK_ID),
        (OPERATION, CHECKER_ID, "wrong"),
    ],
)
def test_install_refuses_wrong_operation_or_identity_before_cloud_access(
    monkeypatch, tmp_path, operation, checker, clock
):
    module = load_installer(monkeypatch)
    monkeypatch.setattr(
        load_health(monkeypatch),
        "_transport",
        lambda *_a, **_k: pytest.fail("cloud access"),
    )
    with pytest.raises(RuntimeError, match="identity changed"):
        module.install_job(operation, checker, clock, BUILD_ID, tmp_path / "receipt.json")


@pytest.mark.parametrize("failure", ["bucket-owner", "denied-secret-binding", "wrong-build"])
def test_install_fails_closed_before_job_mutation_when_prerequisites_differ(
    monkeypatch, tmp_path, failure
):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch,
        wrong_build=failure == "wrong-build",
        denied_secret_binding=failure == "denied-secret-binding",
        wrong_bucket=failure == "bucket-owner",
    )

    with pytest.raises(RuntimeError):
        module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json")
    assert state["job"] is None
    assert not any(call[:3] == ("run", "jobs", "create") for call in calls)


def test_existing_wrong_owner_or_image_is_never_adopted_or_updated(monkeypatch, tmp_path):
    foreign = job_resource(operation="other")
    module, _state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=foreign, native_resource_reader=True
    )
    with pytest.raises(RuntimeError, match="different operation owner"):
        module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json")
    assert not any(call[:3] == ("run", "jobs", "create") for call in calls)


def test_existing_wrong_image_is_refused_without_implicit_upgrade(monkeypatch, tmp_path):
    stale = job_resource(image=f"gcr.io/{PROJECT}/auth-health-job@sha256:{'c' * 64}")
    module, _state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=stale, native_resource_reader=True
    )
    with pytest.raises(RuntimeError, match="different image"):
        module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json")
    assert not any(call[:3] == ("run", "jobs", "create") for call in calls)


def test_install_reconciles_only_exact_job_after_lost_create_response(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(monkeypatch, deploy_error=True)
    result = module.install_job(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "receipt.json"
    )
    assert result["phase"] == "installed"
    assert result["reconciled"] is True
    assert sum(call[:3] == ("run", "jobs", "create") for call in calls) == 1
    assert not any(call[:2] == ("scheduler", "jobs") for call in calls)


def test_prepared_operation_keeps_original_source_while_reconciling_current_main_image(
    monkeypatch, tmp_path
):
    module, state, calls, job, _execution, _events = runtime_fakes(monkeypatch, deploy_error=True)
    monkeypatch.setenv("GITHUB_RUN_ID", "41020000001")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    original = prepared_uat_journal()
    journal = tmp_path / "original-prepared-operation.json"
    journal.write_text(json.dumps(original, sort_keys=True) + "\n")
    original_bytes = journal.read_bytes()

    intent = module.record_intent(
        "install-job",
        OPERATION,
        CHECKER_ID,
        CLOCK_ID,
        BUILD_ID,
        None,
        tmp_path / "separate-current-image-intent.json",
    )
    result = module.install_job(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, tmp_path / "installed-job.json"
    )

    assert original["source"] == PREPARED_SOURCE
    assert intent["source"] == result["source"] == SOURCE
    assert result["source"] != original["source"]
    assert intent["operation"] == result["operation"] == original["operation"]
    assert intent["checker_unique_id"] == result["checker_unique_id"] == CHECKER_ID
    assert intent["clock_unique_id"] == result["clock_unique_id"] == CLOCK_ID
    assert intent["build_id"] == result["build_id"] == BUILD_ID
    assert result["build_source_generation"] == "9"
    assert (
        result["image"]
        == job["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["image"]
    )
    assert result["reconciled"] is True
    assert state["job"] == job
    assert journal.read_bytes() == original_bytes
    assert sum(call[:3] == ("run", "jobs", "create") for call in calls) == 1
    assert not any(call[:2] == ("scheduler", "jobs") for call in calls)
    assert not any(call[0] == "iam:set" for call in calls)


@pytest.mark.parametrize("outcome", ["applied", "unapplied", "readback"])
def test_job_create_timeout_reads_back_once_without_leaking_cli_diagnostics(
    monkeypatch, tmp_path, outcome
):
    module, state, calls, job, _execution, _events = runtime_fakes(
        monkeypatch, deploy_error=f"timeout-{outcome}"
    )
    receipt = tmp_path / "receipt.json"
    if outcome == "applied":
        result = module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, receipt)
        assert result["reconciled"] is True
        assert state["job"] == job
    else:
        with pytest.raises(RuntimeError, match="timed out; exact readback unavailable") as error:
            module.install_job(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, receipt)
        for marker in ("timeout-command-marker", "timeout-stdout-marker", "timeout-stderr-marker"):
            assert marker not in str(error.value)
            assert marker not in receipt.read_text()
        assert json.loads(receipt.read_text())["phase"] == "install-unresolved"
        if outcome == "unapplied":
            assert state["job"] is None
        else:
            assert state["job"] == job
    assert sum(call[:3] == ("run", "jobs", "create") for call in calls) == 1
    assert sum(call[:4] == ("run", "jobs", "describe", JOB) for call in calls) == 1
    assert not any(call[:2] == ("scheduler", "jobs") for call in calls)
    assert not any(call[0] == "iam:set" for call in calls)
