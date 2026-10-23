"""Protect recovery effects from controller timeout, cancellation and replay."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _cloud_response(command, *, calls, execution_name, name, outcome, elapsed, **kwargs):
    calls.append(command)
    if "list" in command:
        return SimpleNamespace(
            stdout=json.dumps([{"metadata": {"name": name}}] if outcome == "retained" else [])
        )
    if "execute" in command:
        if "--wait" in command and kwargs["timeout"] < 207:
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        return SimpleNamespace(stdout=json.dumps({"metadata": {"name": execution_name}}))
    if "describe" in command:
        assert execution_name in command
        # Reproduce the observed207s provider wall time without sleeping.
        status = "Unknown"
        if elapsed[0] >= 207 and outcome != "unconfirmed":
            status = "True" if outcome == "success" else "False"
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "metadata": {"name": execution_name},
                    "status": {"conditions": [{"type": "Completed", "status": status}]},
                }
            )
        )
    if "logging" in command:
        return SimpleNamespace(
            stdout=json.dumps(
                [
                    {
                        "jsonPayload": {
                            "uat_processor_recovery": "completed",
                            "mode": "apply",
                            "limit": 20,
                            "scan_limit": 200,
                            "policy_generation": "qualified-generation",
                            "counts": {
                                key: 0
                                for key in (
                                    "inspected",
                                    "migrated",
                                    "resumed",
                                    "out_of_scope",
                                    "already_current",
                                    "legacy",
                                    "refused",
                                )
                            },
                        }
                    }
                ]
            )
        )
    return SimpleNamespace(stdout="")


@pytest.fixture
def controller(monkeypatch, tmp_path, outcome):
    spec = importlib.util.spec_from_file_location(
        "uat_text_recovery_wait", REPO_ROOT / "scripts/ops/run_uat_text_recovery_job.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    name = "text-policy-recovery-39949039317"
    execution_name = name + "-qualified"
    source = tmp_path / "service.json"
    source.write_text("{}")
    monkeypatch.setattr(module, "job_spec", lambda *args, **kwargs: {"metadata": {"name": name}})
    monkeypatch.setattr(module, "expected_policy_generation", lambda job: "qualified-generation")
    monkeypatch.setattr(
        module,
        "Path",
        lambda value: (
            tmp_path / "proof.json"
            if Path(value).name == "uat-text-recovery-proof.json"
            else Path(value)
        ),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["recovery", "--service-json", str(source), "--sha", "a" * 40, "--run-id", "39949039317"],
    )
    elapsed = [0]
    monkeypatch.setattr(module.time, "monotonic", lambda: elapsed[0])
    monkeypatch.setattr(
        module.time, "sleep", lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds)
    )
    calls = []

    monkeypatch.setattr(
        module.subprocess,
        "run",
        partial(
            _cloud_response,
            calls=calls,
            execution_name=execution_name,
            name=name,
            outcome=outcome,
            elapsed=elapsed,
        ),
    )
    return module, calls


@pytest.mark.parametrize("outcome", ["success", "cancelled", "unconfirmed", "retained"])
def test_text_recovery_waits_for_provider_settlement_before_removing_job(
    controller, tmp_path, outcome
):
    module, calls = controller
    if outcome == "retained":
        with pytest.raises(ValueError, match="reconcile before retry"):
            module.main()
        assert not any(verb in call for call in calls for verb in ("replace", "execute", "delete"))
        return
    if outcome == "success":
        module.main()
        assert (
            json.loads((tmp_path / "proof.json").read_text())["uat_processor_recovery_job"]
            == "completed"
        )
        assert "logging" in calls[-2]
    else:
        with pytest.raises(ValueError if outcome == "cancelled" else TimeoutError):
            module.main()
        assert not (tmp_path / "proof.json").exists()
        assert not any("logging" in call for call in calls)
    assert sum("execute" in call for call in calls) == 1
    assert any("delete" in call for call in calls) == (outcome != "unconfirmed")
