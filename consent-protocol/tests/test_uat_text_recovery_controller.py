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
            status = "True" if outcome in {"success", "wrong_generation"} else "False"
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
                            "policy_generation": "other-generation"
                            if outcome == "wrong_generation"
                            else "qualified-generation",
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


@pytest.mark.parametrize(
    "outcome", ["success", "cancelled", "unconfirmed", "retained", "wrong_generation"]
)
def test_text_recovery_waits_for_provider_settlement_before_removing_job(
    controller, tmp_path, outcome
):
    module, calls = controller
    if outcome == "retained":
        with pytest.raises(ValueError, match="reconcile before retry"):
            module.main()
        assert not any(verb in call for call in calls for verb in ("replace", "execute", "delete"))
        return
    if outcome == "wrong_generation":
        with pytest.raises(ValueError, match="receipt is not yet available"):
            module.main()
        assert not (tmp_path / "proof.json").exists()
        assert sum("execute" in call for call in calls) == 1
        assert any("logging" in call for call in calls)
        assert "delete" in calls[-1]
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


@pytest.mark.asyncio
@pytest.mark.parametrize("expires_while_opening", [False, True])
async def test_recovery_observes_committed_retry_before_failing_its_deadline(
    monkeypatch, capsys, expires_while_opening
):
    from hushh_mcp.runtime_providers import managed_text
    from hushh_mcp.services import drive_owner_allowed, drive_owner_search_store

    spec = importlib.util.spec_from_file_location(
        "recovery_application", REPO_ROOT / "consent-protocol/scripts/recover_uat_text_requests.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    clock = [0]
    calls = []
    policy = {"approval_generation": "current"}
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(managed_text, "managed_text_policy", lambda: policy)
    monkeypatch.setattr(managed_text, "managed_text_binding", lambda: policy)
    monkeypatch.setattr(drive_owner_allowed, "semantic_search_request", lambda _: True)

    def read(statement, parameters):
        calls.append("scan")
        assert "r.request_envelope" in str(statement)
        assert parameters == {"limit": 200}
        return SimpleNamespace(
            mappings=lambda: SimpleNamespace(
                all=lambda: [
                    {
                        "user_id": "fixture-owner",
                        "client_request_id": "fixture-request",
                        "status": "failed",
                        "revision": 4,
                        "request_envelope": "fixture-envelope",
                    }
                ]
            )
        )

    async def transaction(operation):
        return operation(SimpleNamespace(execute=read))

    async def retry(**kwargs):
        assert kwargs["request_revision"] == 4
        assert kwargs["authority_mode"] == "trusted_auto"
        clock[0] = 91
        calls.append("committed")
        return {}, True

    def open_envelope(*args, **kwargs):
        if expires_while_opening:
            clock[0] = 91
        return {"semantic_model_binding": policy}

    monkeypatch.setattr(
        drive_owner_search_store,
        "DriveOwnerSearchStore",
        lambda: SimpleNamespace(
            _transaction=transaction,
            search_cipher=SimpleNamespace(open=open_envelope),
            retry_failed_request=retry,
        ),
    )
    with pytest.raises(TimeoutError, match="application budget"):
        await module.recover(apply=True, limit=20, deadline=90)
    assert calls == (["scan"] if expires_while_opening else ["scan", "committed"])
    progress = json.loads(capsys.readouterr().out)
    assert progress["uat_processor_recovery"] == "incomplete"
    assert progress["counts"]["resumed"] == int(not expires_while_opening)
