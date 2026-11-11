# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Exact UAT health event, job IAM and timer activation contracts."""

import importlib.util
import json
import sys
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
    OPERATION,
    PROJECT,
    job_resource,
    load_common,
    load_timer_activation,
    runtime_fakes,
    scheduler_resource,
)

pytestmark = pytest.mark.feature_auth_reliability


@pytest.mark.parametrize(
    ("runtime_setting", "runtime_result", "accepted"),
    [
        ("true", "healthy", True),
        ("false", "healthy", False),
        (None, "healthy", False),
        ("true", "unavailable", False),
    ],
)
def test_real_uat_health_producer_event_is_the_activation_contract(
    monkeypatch, capsys, tmp_path, runtime_setting, runtime_result, accepted
):
    root = Path(__file__).resolve().parents[2]
    module, _state, _calls, job_resource_value, execution, events = runtime_fakes(
        monkeypatch, healthy=False
    )
    ops_path = root / "scripts/ops/verify_secret_list_invariants.py"
    ops_spec = importlib.util.spec_from_file_location(
        "verify_secret_list_invariants_contract", ops_path
    )
    ops = importlib.util.module_from_spec(ops_spec)
    ops_spec.loader.exec_module(ops)
    ops.check_list = lambda _spec: ops.ListCheck("checked", [], [])
    runtime_calls = []
    ops.check_phone_runtime = lambda _project: runtime_calls.append(_project) or runtime_result
    writes = []
    ops.gcloud = lambda args: (writes.append(args), (0, ""))[1]

    job_path = root / "deploy/observability/auth_health_job.py"
    job_spec = importlib.util.spec_from_file_location(
        "auth_health_job_observation_contract", job_path
    )
    job = importlib.util.module_from_spec(job_spec)
    job_spec.loader.exec_module(job)

    class OwnedLease:
        def __enter__(self):
            return True

        def __exit__(self, *_args):
            return False

    job.lease = lambda _project: OwnedLease()

    def run_real_checker(args, *, stage, timeout):
        assert stage == job.HealthCommandStage.PROTECTED_LIST_CHECK
        assert timeout == 450
        monkeypatch.setattr(sys, "argv", ["verify", *args[2:]])
        assert ops.main() == 0
        return capsys.readouterr().out.encode()

    job.command = run_real_checker
    monkeypatch.setenv("AUTH_HEALTH_PROJECT", PROJECT)
    if runtime_setting is None:
        monkeypatch.delenv("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", raising=False)
    else:
        monkeypatch.setenv("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", runtime_setting)

    assert job.main() == (0 if runtime_result == "healthy" else 2)
    assert bool(runtime_calls) is (runtime_setting == "true")
    assert len(writes) == 1 and writes[0][:3] == ["logging", "write", "obs-auth-health"]
    payload = json.loads(writes[0][3])
    timer = load_timer_activation(monkeypatch)
    proof = timer._execution_proof(lambda _args: execution, job_resource_value, EXECUTION, "123")
    event = {
        "logName": f"projects/{PROJECT}/logs/obs-auth-health",
        "resource": {"type": "global", "labels": {"project_id": PROJECT}},
        "jsonPayload": payload,
        "severity": "INFO" if payload["status"] == "healthy" else "ERROR",
        "timestamp": proof["finished"],
    }
    events.append(event)
    if accepted:
        assert payload["runtime_status"] == "healthy"
        assert timer._healthy_event(lambda _args: events, proof)["runtime_status"] == "healthy"
    else:
        with pytest.raises(RuntimeError, match="healthy UAT runtime observation"):
            timer._healthy_event(lambda _args: events, proof)


def test_foreign_timer_refuses_before_job_permission_write(monkeypatch, tmp_path):
    foreign = scheduler_resource("PAUSED")
    foreign["description"] = "another operation"
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), timer=foreign, invoker=False
    )
    with pytest.raises(RuntimeError, match="timer does not match"):
        module.activate_timer(
            OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
        )
    assert state["timer"] == foreign
    assert not any(call[0] == "iam:set" for call in calls)


def test_activation_creates_hourly_timer_only_after_bound_healthy_proof(monkeypatch, tmp_path):
    module, state, calls, job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource()
    )
    result = module.activate_timer(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
    )

    assert result["phase"] == "active"
    assert result["schedule"] == "17 * * * *"
    assert state["timer"]["state"] == "ENABLED"
    create_index = next(
        i for i, call in enumerate(calls) if call[:3] == ("scheduler", "jobs", "create")
    )
    assert any(
        call[:4] == ("run", "jobs", "executions", "describe") for call in calls[:create_index]
    )
    assert any(call[:2] == ("logging", "read") for call in calls[:create_index])
    assert not any(call[:3] == ("scheduler", "jobs", "pause") for call in calls)
    assert not any(call[0] == "iam:set" for call in calls)
    assert result["iam_effect"]["state"] == "already-present"


def test_activation_refuses_without_healthy_event_before_create_or_resume(monkeypatch, tmp_path):
    paused = scheduler_resource("PAUSED")
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), timer=paused, healthy=False, invoker=False
    )
    with pytest.raises(RuntimeError, match="health event"):
        module.activate_timer(
            OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
        )
    assert state["timer"]["state"] == "PAUSED"
    assert not any(call[:3] == ("scheduler", "jobs", "resume") for call in calls)
    assert not any(call[:3] == ("scheduler", "jobs", "create") for call in calls)
    assert not any(call[0] == "iam:set" for call in calls)


def test_activation_adds_only_exact_job_invoker_after_health_proof(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), invoker=False
    )
    result = module.activate_timer(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
    )
    assert result["phase"] == "active"
    assert state["job_policy"]["bindings"] == [
        {"role": "roles/logging.viewer", "members": ["user:preserved@example.com"]},
        {"role": "roles/run.invoker", "members": [f"serviceAccount:{CLOCK}"]},
    ]
    read_index = next(
        i for i, call in enumerate(calls) if call[:4] == ("run", "jobs", "executions", "describe")
    )
    event_index = next(i for i, call in enumerate(calls) if call[:2] == ("logging", "read"))
    grant_index = next(i for i, call in enumerate(calls) if call[0] == "iam:set")
    create_index = next(
        i for i, call in enumerate(calls) if call[:3] == ("scheduler", "jobs", "create")
    )
    assert read_index < event_index < grant_index < create_index
    grant = calls[grant_index][2]["policy"]
    assert grant["etag"] == "policy-etag-1"
    assert grant["bindings"] == [
        {"role": "roles/logging.viewer", "members": ["user:preserved@example.com"]},
        {"role": "roles/run.invoker", "members": [f"serviceAccount:{CLOCK}"]},
    ]
    assert result["iam_effect"]["state"] == "added"


def test_activation_refuses_conditional_invoker_without_broadening(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), conditional_invoker=True
    )
    with pytest.raises(RuntimeError, match="conditional"):
        module.activate_timer(
            OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
        )
    assert state["timer"] is None
    assert not any(call[0] == "iam:set" for call in calls)
    assert not any(call[:3] == ("scheduler", "jobs", "create") for call in calls)


def test_activation_refuses_unexpected_job_invoker_before_grant(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), foreign_invoker=True
    )
    with pytest.raises(RuntimeError, match="unexpected invocation principal"):
        module.activate_timer(
            OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
        )
    assert state["timer"] is None
    assert not any(call[0] == "iam:set" for call in calls)
    assert not any(call[:3] == ("scheduler", "jobs", "create") for call in calls)


def test_activation_reconciles_lost_invoker_response_once(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), invoker=False, invoker_error="lost"
    )
    result = module.activate_timer(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
    )
    assert result["phase"] == "active"
    assert result["iam_effect"]["state"] == "reconciled"
    assert sum(call[0] == "iam:set" for call in calls) == 1
    assert state["timer"]["state"] == "ENABLED"


def test_activation_stops_if_invoker_write_is_denied(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), invoker=False, invoker_error="denied"
    )
    receipt = tmp_path / "receipt.json"
    with pytest.raises(RuntimeError, match="run.jobs.setIamPolicy"):
        module.activate_timer(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, receipt)
    assert json.loads(receipt.read_text())["phase"] == "invoker-refused"
    assert state["timer"] is None
    assert not any(call[:3] == ("scheduler", "jobs", "create") for call in calls)


def test_activation_stops_when_invoker_write_readback_is_unavailable(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch,
        current_job=job_resource(),
        invoker=False,
        invoker_readback_error=True,
    )
    receipt = tmp_path / "receipt.json"
    common = load_common(monkeypatch)
    with pytest.raises(common.OperationUnresolved, match="readback is unavailable"):
        module.activate_timer(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, receipt)
    assert json.loads(receipt.read_text())["phase"] == "invoker-unresolved"
    assert state["timer"] is None
    assert sum(call[0] == "iam:set" for call in calls) == 1
    assert not any(call[:3] == ("scheduler", "jobs", "create") for call in calls)


def test_activation_resumes_only_exact_paused_timer_after_readiness(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), timer=scheduler_resource("PAUSED")
    )
    result = module.activate_timer(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
    )
    assert result["phase"] == "active"
    assert state["timer"]["state"] == "ENABLED"
    assert sum(call[:3] == ("scheduler", "jobs", "resume") for call in calls) == 1
    assert not any(call[:3] == ("scheduler", "jobs", "create") for call in calls)


@pytest.mark.parametrize("failure", ["create-unresolved", "resume-unresolved"])
def test_timer_mutation_response_loss_is_read_back_once_without_retry(
    monkeypatch, tmp_path, failure
):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch,
        current_job=job_resource(),
        timer=scheduler_resource("PAUSED") if failure == "resume-unresolved" else None,
        create_error="unresolved" if failure == "create-unresolved" else None,
        resume_error=failure == "resume-unresolved",
    )
    with pytest.raises(RuntimeError):
        module.activate_timer(
            OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
        )
    expected = (
        ("scheduler", "jobs", "create")
        if failure == "create-unresolved"
        else ("scheduler", "jobs", "resume")
    )
    assert sum(call[:3] == expected for call in calls) == 1
    if failure == "resume-unresolved":
        assert state["timer"]["state"] == "PAUSED"
    else:
        assert state["timer"] is None
    receipt = json.loads((tmp_path / "receipt.json").read_text())
    assert receipt["phase"] == "activation-unresolved"


def test_lost_timer_create_response_reconciles_exact_enabled_resource_once(monkeypatch, tmp_path):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource(), create_error="lost"
    )
    result = module.activate_timer(
        OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, tmp_path / "receipt.json"
    )
    assert result["phase"] == "active"
    assert result["reconciled"] is True
    assert state["timer"]["state"] == "ENABLED"
    assert sum(call[:3] == ("scheduler", "jobs", "create") for call in calls) == 1


@pytest.mark.parametrize(
    ("mutation", "outcome"),
    [
        ("create", "applied"),
        ("create", "unapplied"),
        ("create", "readback"),
        ("resume", "applied"),
        ("resume", "unapplied"),
        ("resume", "readback"),
    ],
)
def test_timer_timeout_uses_one_exact_readback_and_never_retries(
    monkeypatch, tmp_path, mutation, outcome
):
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch,
        current_job=job_resource(),
        timer=scheduler_resource("PAUSED") if mutation == "resume" else None,
        create_error=f"timeout-{outcome}" if mutation == "create" else None,
        resume_error=f"timeout-{outcome}" if mutation == "resume" else False,
    )
    receipt = tmp_path / "receipt.json"
    write = ("scheduler", "jobs", mutation)
    if outcome == "applied":
        result = module.activate_timer(
            OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, receipt
        )
        assert result["phase"] == "active"
        assert result["reconciled"] is True
        assert state["timer"]["state"] == "ENABLED"
    else:
        with pytest.raises(RuntimeError, match="timed out; exact readback unavailable") as error:
            module.activate_timer(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, receipt)
        for marker in ("timeout-command-marker", "timeout-stdout-marker", "timeout-stderr-marker"):
            assert marker not in str(error.value)
            assert marker not in receipt.read_text()
        assert json.loads(receipt.read_text())["phase"] == "activation-unresolved"
        if outcome == "unapplied":
            assert (
                state["timer"]["state"] == "PAUSED"
                if mutation == "resume"
                else state["timer"] is None
            )
        else:
            assert state["timer"]["state"] == "ENABLED"
    assert sum(call[:3] == write for call in calls) == 1
    assert state["timer_readbacks"] == 2


@pytest.mark.parametrize("transport_error", [requests.Timeout, requests.ConnectionError])
def test_scheduler_postmutation_transport_readback_is_unresolved_once(
    monkeypatch, tmp_path, transport_error
):
    marker = "private-scheduler-readback-marker"
    module, state, calls, _job, _execution, _events = runtime_fakes(
        monkeypatch,
        current_job=job_resource(),
        timer_readback_error=transport_error(marker),
    )
    receipt = tmp_path / "receipt.json"

    with pytest.raises(RuntimeError, match="Cloud Scheduler readback unavailable") as error:
        module.activate_timer(OPERATION, CHECKER_ID, CLOCK_ID, BUILD_ID, EXECUTION, receipt)

    assert marker not in str(error.value)
    assert marker not in receipt.read_text()
    assert json.loads(receipt.read_text())["phase"] == "activation-unresolved"
    assert state["timer"]["state"] == "ENABLED"
    assert state["timer_readbacks"] == 2
    assert sum(call[:3] == ("scheduler", "jobs", "create") for call in calls) == 1


def test_execution_from_wrong_project_or_job_is_rejected(monkeypatch):
    _module, _state, _calls, job, _execution, _events = runtime_fakes(
        monkeypatch, current_job=job_resource()
    )
    timer = load_timer_activation(monkeypatch)
    with pytest.raises(RuntimeError, match="exact UAT job"):
        timer._execution_proof(
            None,
            job,
            f"projects/hushh-pda/locations/us-central1/jobs/{JOB}/executions/{JOB}-abcde",
            "123",
        )
