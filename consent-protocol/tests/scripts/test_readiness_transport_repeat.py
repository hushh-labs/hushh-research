"""One repeat for a timeout, 429 or 5xx; never for semantic, trust or configuration failures.

Owner decision, 2026-10-30: a readiness exam step may repeat exactly once after a
classified transport failure, and the first failure must stay visible.
"""

from __future__ import annotations

import importlib.util
import json
from unittest.mock import AsyncMock

import pytest

from scripts.capability_check import repeat_stage_once, run_capability
from tests.test_pwm_runtime_probe import REPO_ROOT, capability_fixture


class _Status(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__("synthetic provider status")
        self.status_code = status_code


def _flaky(*errors, result=None):
    calls = []

    async def operation():
        calls.append(1)
        if len(calls) <= len(errors):
            raise errors[len(calls) - 1]
        return result

    return operation, calls


def _proof():
    path = REPO_ROOT / "scripts/ci/managed_capability_proof.py"
    spec = importlib.util.spec_from_file_location("managed_capability_proof", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_a_transient_capability_failure_repeats_once_and_stays_visible(capsys):
    operation, calls = _flaky(_Status(503), result={"synthetic_content_verified": True})
    report = {"capabilities": {}}
    await run_capability(report, "structured_text", operation, deadline=None)
    row = report["capabilities"]["structured_text"]
    assert len(calls) == 2
    assert row["ready"] is True and row["transport_retries"] == 1
    assert _proof()._valid_result(row)
    first, final = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert first["transport_retry"] == 1 and first["classification"] == "provider_unavailable"
    assert final == {"managed_capability_check": "structured_text", **row}


@pytest.mark.parametrize(
    "errors,attempts,classification",
    [
        ((_Status(429), TimeoutError()), 2, "provider_unavailable"),
        ((ValueError("Root answer is not JSON"),), 1, "candidate_misconfigured"),
        ((_Status(403),), 1, "candidate_misconfigured"),
    ],
)
async def test_one_capability_repeat_at_most_and_only_for_transport(
    errors, attempts, classification
):
    operation, calls = _flaky(*errors, result={})
    report = {"capabilities": {}}
    await run_capability(report, "one_text_root", operation, deadline=None)
    row = report["capabilities"]["one_text_root"]
    assert len(calls) == attempts and row["ready"] is False
    assert row["classification"] == classification
    assert ("transport_retries" in row) is (attempts == 2)


@pytest.mark.parametrize("retries,valid", [(1, True), (2, False), (True, False)])
def test_the_proof_admits_exactly_one_recorded_repeat(retries, valid):
    row = {"ready": True, "elapsed_ms": 1, "transport_retries": retries}
    assert _proof()._valid_result(row) is valid


async def test_a_stage_repeats_once_after_a_transient_failure(capsys):
    operation, calls = _flaky(TimeoutError(), result="token")
    assert await repeat_stage_once("federation", operation) == "token"
    assert len(calls) == 2
    assert json.loads(capsys.readouterr().out) == {
        "azure_pwm_runtime_probe_stage": "federation",
        "result": "transport_retry",
        "error_type": "TimeoutError",
    }


@pytest.mark.parametrize(
    "errors",
    [
        # A trust failure classifies as a candidate fault, as AzurePwmTrustError does.
        (RuntimeError("Azure confirmed research guidance evaluation failed"),),
        (_Status(503), _Status(503)),
    ],
)
async def test_a_stage_never_repeats_twice_or_for_a_candidate_fault(errors):
    operation, calls = _flaky(*errors)
    with pytest.raises(type(errors[-1])):
        await repeat_stage_once("primary", operation)
    assert len(calls) == len(errors)


@pytest.mark.parametrize("transient,exit_code,attempts", [(True, 0, 2), (False, 1, 1)])
def test_primary_http_repeats_only_a_transient_failure(
    monkeypatch, capsys, transient, exit_code, attempts
):
    module, report, _ = capability_fixture(monkeypatch)
    report["ready"] = True
    ready = module.run_probe.return_value
    failed = {
        **ready,
        "status": "unavailable",
        "http_status": 503 if transient else 401,
        "error_class": "InternalServerError" if transient else "AuthenticationError",
        "classification": "provider_unavailable" if transient else "candidate_misconfigured",
        "transient": transient,
    }
    run_probe = AsyncMock(side_effect=[failed, ready])
    monkeypatch.setattr(module, "run_probe", run_probe)
    assert module.main() == exit_code
    assert run_probe.await_count == attempts
    rows = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line[:1] == "{"]
    http = [row for row in rows if row.get("azure_pwm_runtime_probe_stage") == "primary_http"]
    expected = [("transport_retry", 1), ("ok", 2)] if transient else [("failed", 1)]
    assert [(row["result"], row["attempt"]) for row in http] == expected
