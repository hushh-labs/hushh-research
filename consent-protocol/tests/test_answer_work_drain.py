"""The paid-answer lane's own scheduler entrypoint.

Two properties matter here. The drain must be unreachable unless this
deployment enabled it and the configured scheduler identity signed the call,
and its response must be counts only — it is a monitoring surface for a lane
whose contents are a person's private information.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import answer_work_drain as drain
from hushh_mcp.services.pkm_answer_work_worker import (
    ANSWER_DRAIN_STAGES,
    STAGE_MAX_JOBS,
    PkmAnswerWorkWorker,
    safe_answer_drain_result,
)


@pytest.fixture
def scheduler_cli(tmp_path):
    """Run the real shell helper with a stateful cloud boundary, never GCP."""
    import json
    import os
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    driver = Path(__file__).parent / "fixtures/answer_scheduler_cloud.py"
    command = fake_bin / "gcloud"
    command.write_text(
        '#!/usr/bin/env bash\nexec "$FAKE_PYTHON" "$FAKE_CLOUD_DRIVER" "$@"\n', encoding="utf-8"
    )
    command.chmod(0o755)

    def run(
        *,
        enabled,
        state=None,
        deny=False,
        stage="timeouts",
        new_identity=False,
        create_failures=0,
        create_error="NOT_FOUND",
    ):
        state_file = tmp_path / "cloud.json"
        state_file.write_text(
            json.dumps(
                {
                    "job": state,
                    "calls": [],
                    "deny": deny,
                    "identity": not new_identity,
                    "create_failures": create_failures,
                    "create_error": create_error,
                }
            )
        )
        result = subprocess.run(  # noqa: S603 -- bounded helper, cloud calls replaced
            ["bash", (root / "deploy/answers/setup_answer_work_drain_scheduler.sh").as_posix()],
            env={
                **os.environ,
                "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                "FAKE_PYTHON": Path(sys.executable).as_posix(),
                "FAKE_CLOUD_DRIVER": driver.as_posix(),
                "FAKE_CLOUD_STATE": str(state_file),
                "ENVIRONMENT": "uat",
                "PROJECT_ID": "hushh-pda-uat",
                "BACKEND_URL": "https://api.uat.hushh.ai",
                "STAGE": stage,
                "JOB_NAME": f"answer-work-{stage}-uat",
                "ANSWER_WORK_DRAIN_ENABLED": str(enabled).lower(),
            },
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result, json.loads(state_file.read_text())

    return run


@pytest.mark.parametrize("stage", ["timeouts", "refunds", "payouts"])
def test_answer_scheduler_creates_each_pinned_oidc_stage(scheduler_cli, stage):
    result, state = scheduler_cli(enabled=True, stage=stage)
    assert result.returncode == 0, result.stderr
    assert state["job"] == "ENABLED"
    assert (
        state["config"]["uri"]
        == f"https://api.uat.hushh.ai/api/internal/answer-work/drain?stage={stage}"
    )
    assert (
        state["config"]["oidc-service-account-email"]
        == "answer-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"
    )
    assert state["config"]["oidc-token-audience"] == "https://api.uat.hushh.ai"


@pytest.mark.parametrize(
    "enabled,initial,expected,verb",
    [
        (True, "PAUSED", "ENABLED", "resume"),
        (False, "ENABLED", "PAUSED", "pause"),
        (False, None, None, None),
    ],
)
def test_answer_scheduler_respects_explicit_activation_and_pause(
    scheduler_cli, enabled, initial, expected, verb
):
    result, state = scheduler_cli(enabled=enabled, state=initial)
    assert result.returncode == 0, result.stderr
    assert state["job"] == expected
    verbs = [call[2] for call in state["calls"] if call[:2] == ["scheduler", "jobs"]]
    if verb:
        assert verb in verbs
    if not enabled:
        assert not {"create", "resume", "update"} & set(verbs)
        assert not any(call[:2] == ["iam", "service-accounts"] for call in state["calls"])


def test_answer_scheduler_denied_read_never_becomes_resource_creation(scheduler_cli):
    result, state = scheduler_cli(enabled=True, deny=True)
    assert result.returncode != 0
    assert [call[:3] for call in state["calls"]] == [["scheduler", "jobs", "describe"]]


@pytest.mark.parametrize(
    "new_identity,error,expected_calls,success",
    [
        (True, "NOT_FOUND", 3, True),
        (False, "NOT_FOUND", 1, False),
        (True, "PERMISSION_DENIED", 1, False),
    ],
)
def test_answer_scheduler_retries_only_first_use_identity_propagation(
    scheduler_cli, new_identity, error, expected_calls, success
):
    result, state = scheduler_cli(
        enabled=True, new_identity=new_identity, create_failures=2, create_error=error
    )
    assert (result.returncode == 0) is success, result.stderr
    assert (
        sum(call[:3] == ["scheduler", "jobs", "create"] for call in state["calls"])
        == expected_calls
    )


def test_uat_release_owns_answer_scheduler_reconciliation_and_failure_evidence():
    from pathlib import Path

    import yaml

    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/deploy-uat.yml").read_text())
    steps = [step for job in workflow["jobs"].values() for step in job.get("steps", [])]
    activation = next(step for step in steps if step.get("id") == "activate-answer-work-drain")
    assert (
        activation["env"]["ANSWER_WORK_DRAIN_ENABLED"]
        == "${{ vars.ANSWER_WORK_DRAIN_UAT_ENABLED || 'false' }}"
    )
    assert "deploy_backend == 'true'" in activation["if"]
    assert "for stage in timeouts refunds payouts" in activation["run"]
    assert 'gcloud scheduler jobs run "$job"' in activation["run"]
    assert "verify-cloud-scheduler-attempt.py" in activation["run"]
    assert (
        '--expected-job "projects/${PROJECT_ID}/locations/${SCHEDULER_LOCATION}/jobs/${job}"'
        in activation["run"]
    )
    assert '--expected-uri "$uri"' in activation["run"]
    assert "mode=reconciled-disabled" in activation["run"]
    assert "answer_scheduler_no_fresh_http_completion" in activation["run"]
    preserved = next(
        step for step in steps if step.get("name") == "Preserve current release tooling"
    )
    assert "deploy/answers/setup_answer_work_drain_scheduler.sh" in preserved["run"]
    assert steps.index(preserved) < next(
        i for i, s in enumerate(steps) if s.get("name") == "Checkout deployment SHA"
    )
    status = next(step for step in steps if 'STATUS="healthy"' in step.get("run", ""))
    assert "steps.activate-answer-work-drain.outcome" in status["run"]


class TestIndependenceFromDrive:
    def test_the_drive_drain_no_longer_knows_about_answers(self):
        # This lane runs on its own schedule. A Drive incident must not stall
        # an answer refund, and pausing this lane must not stall Drive.
        from hushh_mcp.services import drive_work_drain

        source = open(drive_work_drain.__file__).read()
        assert "answer_" not in source
        for stage in drive_work_drain.STAGE_WORKERS.values():
            assert not any(name.startswith("answer") for name in stage)

    def test_it_has_its_own_scheduler_identity_not_drive_s(self):
        from api.routes import drive_work_drain as drive_route

        assert drain._UAT_SCHEDULER_SERVICE_ACCOUNT != drive_route._UAT_SCHEDULER_SERVICE_ACCOUNT
        assert (
            drain._PRODUCTION_SCHEDULER_SERVICE_ACCOUNT
            != drive_route._PRODUCTION_SCHEDULER_SERVICE_ACCOUNT
        )
        assert drain._UAT_SCHEDULER_SERVICE_ACCOUNT.startswith("answer-work-drain-sched@")


class TestClosedByDefault:
    def test_disabled_without_its_own_flag(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "uat")
        monkeypatch.delenv("ANSWER_WORK_DRAIN_ENABLED", raising=False)
        assert drain._drain_enabled() is False

    def test_drive_s_flag_does_not_enable_this_lane(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "uat")
        monkeypatch.setenv("DRIVE_WORK_DRAIN_ENABLED", "true")
        monkeypatch.setenv("DRIVE_WORKER_MODE", "true")
        monkeypatch.delenv("ANSWER_WORK_DRAIN_ENABLED", raising=False)
        assert drain._drain_enabled() is False

    def test_enabled_only_with_its_own_flag_in_a_known_environment(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "uat")
        monkeypatch.setenv("ANSWER_WORK_DRAIN_ENABLED", "true")
        assert drain._drain_enabled() is True
        monkeypatch.setenv("ENVIRONMENT", "somewhere-else")
        assert drain._drain_enabled() is False

    def test_an_unlisted_audience_is_refused(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "uat")
        monkeypatch.setenv("ANSWER_WORK_DRAIN_AUDIENCE", "https://evil.example")
        with pytest.raises(RuntimeError):
            drain._configuration()

    def test_a_missing_audience_is_refused(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "uat")
        monkeypatch.delenv("ANSWER_WORK_DRAIN_AUDIENCE", raising=False)
        with pytest.raises(RuntimeError):
            drain._configuration()

    async def test_a_disabled_lane_is_a_404_before_any_token_work(self, monkeypatch):
        monkeypatch.delenv("ANSWER_WORK_DRAIN_ENABLED", raising=False)

        class Req:
            headers: dict[str, str] = {}

        with pytest.raises(HTTPException) as raised:
            await drain._require_scheduler_oidc(Req())
        assert raised.value.status_code == 404


class TestMonitoringCarriesCountsOnly:
    def test_unknown_keys_are_dropped_not_echoed(self):
        result = safe_answer_drain_result(
            "refunds",
            {
                "succeeded": 2,
                # None of these may reach a dashboard.
                "question": "How much did you spend on travel?",
                "request_id": "11111111-2222-3333-4444-555555555555",
                "scope": "attr.travel.trips",
                "provider_message": "card_declined: insufficient funds",
            },
        )
        assert result["outcomes"] == {"succeeded": 2}
        rendered = str(result)
        assert "travel" not in rendered
        assert "11111111" not in rendered
        assert "declined" not in rendered

    def test_non_integer_and_out_of_range_values_are_dropped(self):
        result = safe_answer_drain_result(
            "refunds", {"succeeded": "2", "retried": True, "manual_review": -1}
        )
        # "2" is a string, True is a bool, -1 is out of range.
        assert result["outcomes"] == {}

    def test_each_stage_reports_only_its_own_counts(self):
        payouts = safe_answer_drain_result(
            "payouts", {"transferred": 1, "succeeded": 9, "awaiting_account": 2}
        )
        assert payouts["outcomes"] == {"transferred": 1, "awaiting_account": 2}

    def test_an_unknown_stage_reports_nothing(self):
        assert safe_answer_drain_result("made_up", {"succeeded": 1})["outcomes"] == {}

    def test_the_record_names_its_schema_and_stage(self):
        result = safe_answer_drain_result("timeouts", {"expired": 1, "refunds_filed": 1})
        assert result["schema_version"] == "pkm.answer_work_drain.v1"
        assert result["stage"] == "timeouts"


class TestStageDispatch:
    async def test_an_unknown_stage_is_refused(self):
        with pytest.raises(ValueError):
            await PkmAnswerWorkWorker(db=object()).run_stage("drop_tables")

    def test_every_declared_stage_has_a_bound(self):
        assert set(STAGE_MAX_JOBS) == set(ANSWER_DRAIN_STAGES)
        # Small on purpose: this lane settles money, so falling behind beats
        # running long.
        assert all(1 <= bound <= 25 for bound in STAGE_MAX_JOBS.values())

    async def test_each_stage_short_circuits_while_the_feature_is_off(self, monkeypatch):
        monkeypatch.setenv("PKM_ANSWER_PAYMENTS_ENABLED", "false")
        monkeypatch.setenv("PKM_ANSWER_REQUESTS_ENABLED", "false")
        worker = PkmAnswerWorkWorker(db=object())
        for stage in sorted(ANSWER_DRAIN_STAGES):
            assert await worker.run_stage(stage) == {"disabled": 1}
