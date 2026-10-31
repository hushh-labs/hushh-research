"""A trust failure's terminal verdict and build log name the failed stage, reason and leg.

Only authored identifiers travel: never model text, provider text or unknown fields.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from unittest.mock import AsyncMock

import pytest
import yaml

from scripts.probe_drive_activity_planner import ActivityPlannerContractError
from scripts.pwm_trust_failure import AzurePwmTrustError, trust_failure, trust_fields
from tests.test_pwm_runtime_probe import REPO_ROOT

PLANNER_REASON = "clause_core_entity_or_sparse_fallback_missing"


def _job():
    path = REPO_ROOT / "consent-protocol/scripts/verify_azure_pwm_runtime.py"
    spec = importlib.util.spec_from_file_location("azure_pwm_runtime_probe", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_pwm_check_failure_keeps_its_event_and_names_stage_and_reason(capsys):
    with pytest.raises(AzurePwmTrustError) as raised:
        trust_failure("confirmed research guidance", ["planner_lead"])
    # The pre-merge runner reads this event's failed_fields.
    assert json.loads(capsys.readouterr().out) == {
        "azure_pwm_probe_failure": "confirmed research guidance",
        "failed_fields": ["planner_lead"],
    }
    assert trust_fields(raised.value) == {
        "failure_stage": "pwm.confirmed_research_guidance",
        "failure_reason": "planner_lead",
    }


async def test_a_planner_contract_failure_carries_case_reason_and_leg(monkeypatch):
    from scripts import probe_managed_text

    contract = ActivityPlannerContractError(PLANNER_REASON, case="ordinary", leg="fallback_missing")
    assert contract.args == (PLANNER_REASON,)
    monkeypatch.setattr(probe_managed_text, "probe_managed_text", AsyncMock(side_effect=contract))
    with pytest.raises(AzurePwmTrustError) as raised:
        await _job()._probe_managed_text()
    assert trust_fields(raised.value) == {
        "failure_stage": "drive_planner.ordinary",
        "failure_reason": PLANNER_REASON,
        "leg": "fallback_missing",
    }


@pytest.mark.parametrize(
    "error,expected",
    [
        # Not raised by the grader (no case): nothing beyond the stage travels.
        (
            ActivityPlannerContractError("private_lowercase_text"),
            {"failure_stage": "drive_planner"},
        ),
        # Raised by the grader, but the values are not authored codes.
        (
            ActivityPlannerContractError("PRIVATE TEXT", case="ordinary", leg="Leg Text"),
            {"failure_stage": "drive_planner.ordinary"},
        ),
    ],
)
def test_only_authored_codes_reach_the_verdict(error, expected):
    from scripts.pwm_trust_failure import planner_trust_error

    assert trust_fields(planner_trust_error(error)) == expected


def test_the_terminal_verdict_names_the_trust_failure(monkeypatch, capsys):
    job = _job()
    error = AzurePwmTrustError("x", stage="drive_planner.ordinary", reason=PLANNER_REASON)
    monkeypatch.setattr(job, "probe", AsyncMock(side_effect=error))
    assert job.main() == 1
    verdict = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert verdict["failure_stage"] == "drive_planner.ordinary"
    assert verdict["failure_reason"] == PLANNER_REASON
    assert verdict["pwm_trust_failure"] is True and "leg" not in verdict


def _validation_snippet() -> str:
    steps = yaml.safe_load((REPO_ROOT / "deploy/backend.cloudbuild.yaml").read_text())["steps"]
    script = next(s for s in steps if s.get("id") == "verify-azure-pwm-runtime")["args"][-1]
    tail = script[script.index("# readiness-verdict-collector:end") :]
    body = tail[tail.index("<<'PY'\n") + len("<<'PY'\n") :]
    return body[: body.index("\nPY")]  # The YAML block scalar is already dedented.


def test_the_build_log_names_the_failed_check_with_closed_fields_only():
    verdict = {
        "azure_pwm_runtime_probe_result": "failed",
        "classification": "candidate_misconfigured",
        "error_type": "AzurePwmTrustError",
        "failure_stage": "drive_planner.ordinary",
        "failure_reason": PLANNER_REASON,
        "leg": "tokens_mismatch",
        "error": "PRIVATE_MODEL_OR_PROVIDER_TEXT",
    }
    result = subprocess.run(  # noqa: S603 - repo-owned snippet with synthetic log rows.
        [sys.executable, "-c", _validation_snippet()],
        env={**os.environ, "PROBE_ENTRIES": json.dumps([{"jsonPayload": verdict}])},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 1
    message = result.stderr.strip().splitlines()[-1]
    assert message.startswith("Azure PWM UAT runtime probe did not pass ")
    named = json.loads(message.removeprefix("Azure PWM UAT runtime probe did not pass "))
    assert named == {
        k: verdict[k] for k in verdict if k not in {"azure_pwm_runtime_probe_result", "error"}
    }
    assert "PRIVATE" not in result.stderr
