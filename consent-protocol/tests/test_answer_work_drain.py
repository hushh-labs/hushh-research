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
        worker = PkmAnswerWorkWorker(db=object())
        for stage in sorted(ANSWER_DRAIN_STAGES):
            assert await worker.run_stage(stage) == {"disabled": 1}
