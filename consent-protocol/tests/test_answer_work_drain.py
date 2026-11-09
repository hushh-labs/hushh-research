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
        operation="reconcile",
        environment="uat",
        body="",
    ):
        project, origin = {
            "uat": ("hushh-pda-uat", "https://api.uat.hushh.ai"),
            "dev": ("hushh-pda-dev", "https://consent-protocol-621416509462.us-central1.run.app"),
        }[environment]
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
                    "body": body,
                    "config": {
                        "project": project,
                        "location": "us-central1",
                        "schedule": "*/5 * * * *",
                        "time-zone": "Etc/UTC",
                        "uri": f"{origin}/api/internal/answer-work/drain?stage={stage}",
                        "oidc-service-account-email": f"answer-work-drain-sched@{project}.iam.gserviceaccount.com",
                        "oidc-token-audience": origin,
                        "attempt-deadline": "180s",
                        "max-retry-attempts": "3",
                        "min-backoff": "10s",
                        "max-backoff": "120s",
                        "max-doublings": "3",
                    },
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
                "ENVIRONMENT": environment,
                "PROJECT_ID": project,
                "BACKEND_URL": origin,
                "STAGE": stage,
                "JOB_NAME": f"answer-work-{stage}-{environment}",
                "ANSWER_WORK_DRAIN_ENABLED": str(enabled).lower(),
                "OPERATION": operation,
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


@pytest.mark.parametrize("environment", ["dev", "uat"])
def test_release_owns_answer_scheduler_reconciliation_and_failure_evidence(environment):
    from pathlib import Path

    import yaml

    root = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load(
        (root / f".github/workflows/deploy-{environment}-implementation.yml").read_text()
    )
    steps = [step for job in workflow["jobs"].values() for step in job.get("steps", [])]
    activation = next(step for step in steps if step.get("id") == "activate-answer-work-drain")
    assert (
        activation["env"]["ANSWER_WORK_DRAIN_ENABLED"]
        == "${{ vars.ANSWER_WORK_DRAIN_" + environment.upper() + "_ENABLED || 'false' }}"
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
    paid_branch = (
        activation["run"]
        .split('if [ "$ANSWER_PAYMENTS_ENABLED" == true ]; then')[1]
        .split("\nfi\n", 1)[0]
    )
    assert "--paid-admission" in paid_branch
    assert "--not-before" in paid_branch
    assert "gcloud scheduler" not in paid_branch
    admission = next(step for step in steps if step.get("id") == "answer-settlement-admission")
    recheck = next(step for step in steps if step.get("id") == "recheck-answer-settlement")
    assert "--release-admission" in admission["run"]
    assert "--baseline" in recheck["run"]
    assert "predeploy-state.outputs.backend_revision" in recheck["run"]
    assert steps.index(admission) < next(
        i
        for i, step in enumerate(steps)
        if "Sync canonical hosted runtime secrets" == step.get("name")
    )
    assert steps.index(recheck) < next(
        i
        for i, step in enumerate(steps)
        if step.get("name", "").startswith("Promote deployed revisions")
    )
    for component in ("backend", "frontend"):
        recovery = next(
            step for step in steps if step.get("id") == f"rollback-{component}-after-answer"
        )
        assert "always()" in recovery["if"]
        assert "activate-answer-work-drain.outcome == 'failure'" in recovery["if"]
        assert "predeploy-state.outputs." + component + "_revision" in recovery["run"]
        assert "gcloud scheduler" not in recovery["run"]
        assert steps.index(recovery) > steps.index(activation)
    preserved = next(
        step
        for step in steps
        if "cp deploy/answers/setup_answer_work_drain_scheduler.sh" in step.get("run", "")
    )
    assert "deploy/answers/setup_answer_work_drain_scheduler.sh" in preserved["run"]
    # Dev captures tools in the checkout step itself, before git checkout.
    assert steps.index(preserved) <= next(
        i for i, s in enumerate(steps) if s.get("name") == "Checkout deployment SHA"
    )
    status = next(step for step in steps if 'STATUS="healthy"' in step.get("run", ""))
    assert "steps.activate-answer-work-drain.outcome" in status["run"]


@pytest.mark.parametrize("environment", ["dev", "uat"])
@pytest.mark.parametrize(
    "state,body,success",
    [
        ("ENABLED", "", True),
        ("PAUSED", "", False),
        (None, "", False),
        ("ENABLED", "dW5leHBlY3RlZA==", False),
    ],
)
def test_settlement_verification_never_mutates_or_runs_jobs(
    scheduler_cli, environment, state, body, success
):
    result, cloud = scheduler_cli(
        enabled=True, state=state, operation="verify", environment=environment, body=body
    )
    assert (result.returncode == 0) is success
    assert all(call[:3] == ["scheduler", "jobs", "describe"] for call in cloud["calls"])


@pytest.fixture
def qualified_settlement(monkeypatch):
    """Run the real admission verifier against content-free provider responses."""
    import importlib.util
    from datetime import UTC, datetime, timedelta
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "answer_settlement_release", root / "deploy/answers/verify_settlement_release.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    now = datetime.now(UTC)
    state = {
        "revision": "consent-protocol-qualified",
        "drain": "true",
        "payments": "false",
        "audience": "https://api.uat.hushh.ai",
        "paused": False,
        "failed": False,
        "calls": [],
    }

    def cloud(*args):
        state["calls"].append(args)
        if args[:2] == ("run", "services"):
            return {"status": {"traffic": [{"revisionName": state["revision"], "percent": 100}]}}
        if args[:2] == ("run", "revisions"):
            return {
                "spec": {
                    "containers": [
                        {
                            "env": [
                                {"name": "PKM_ANSWER_PAYMENTS_ENABLED", "value": state["payments"]},
                                {"name": "ANSWER_WORK_DRAIN_ENABLED", "value": state["drain"]},
                                {
                                    "name": "ANSWER_WORK_DRAIN_AUDIENCE",
                                    "value": state["audience"],
                                },
                            ]
                        }
                    ]
                },
                "status": {
                    "imageDigest": "gcr.io/hushh-pda-uat/backend@sha256:" + "a" * 64,
                    "conditions": [{"type": "Ready", "status": "True"}],
                },
            }
        if args[:2] == ("iam", "service-accounts"):
            return {"email": "answer-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com"}
        if args[:2] == ("scheduler", "jobs"):
            name = args[3]
            stage = name.removeprefix("answer-work-").removesuffix("-uat")
            return {
                "name": f"projects/hushh-pda-uat/locations/us-central1/jobs/{name}",
                "state": "PAUSED" if state["paused"] else "ENABLED",
                "schedule": "*/5 * * * *",
                "timeZone": "Etc/UTC",
                "attemptDeadline": "180s",
                "userUpdateTime": (now - timedelta(minutes=4)).isoformat(),
                "httpTarget": {
                    "httpMethod": "POST",
                    "uri": f"https://api.uat.hushh.ai/api/internal/answer-work/drain?stage={stage}",
                    "oidcToken": {
                        "serviceAccountEmail": "answer-work-drain-sched@hushh-pda-uat.iam.gserviceaccount.com",
                        "audience": "https://api.uat.hushh.ai",
                    },
                },
                "retryConfig": {
                    "retryCount": 3,
                    "minBackoffDuration": "10s",
                    "maxBackoffDuration": "120s",
                    "maxDoublings": 3,
                },
            }
        if args[:2] == ("logging", "read"):
            stage = next(
                stage
                for stage in ("timeouts", "refunds", "payouts")
                if f"answer-work-{stage}-uat" in args[2]
            )
            row = {
                "timestamp": now.isoformat(),
                "httpRequest": {"status": 200},
                "jsonPayload": {
                    "@type": "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished",
                    "jobName": f"projects/hushh-pda-uat/locations/us-central1/jobs/answer-work-{stage}-uat",
                    "url": f"https://api.uat.hushh.ai/api/internal/answer-work/drain?stage={stage}",
                },
            }
            if state["failed"]:
                return [
                    row,
                    {
                        **row,
                        "timestamp": (now + timedelta(seconds=1)).isoformat(),
                        "httpRequest": {"status": 503},
                    },
                ]
            return [row]
        raise AssertionError(f"Unexpected cloud operation: {args[:3]}")

    monkeypatch.setattr(module, "_cloud", cloud)
    return module, state, root / "scripts/ci"


def test_paid_admission_binds_existing_settlement_and_refuses_changed_evidence(
    qualified_settlement,
):
    module, state, tools = qualified_settlement
    baseline = module.verify_paid_admission("uat", state["revision"], tools)
    assert set(baseline["executions"]) == {"timeouts", "refunds", "payouts"}
    assert (
        module.verify_paid_admission("uat", state["revision"], tools, baseline=baseline)["status"]
        == "healthy"
    )
    baseline["identity"]["jobs"]["refunds"] = "different-configuration"
    with pytest.raises(ValueError, match="changed after release admission"):
        module.verify_paid_admission("uat", state["revision"], tools, baseline=baseline)


@pytest.mark.parametrize("failure", ["drain", "paused", "failed", "revision"])
def test_paid_admission_refuses_an_unqualified_or_changed_predecessor(
    qualified_settlement, failure
):
    module, state, tools = qualified_settlement
    revision = state["revision"]
    state[failure] = {"drain": "false", "paused": True, "failed": True, "revision": "replacement"}[
        failure
    ]
    with pytest.raises(ValueError):
        module.verify_paid_admission("uat", revision, tools)


def test_settlement_only_activation_cannot_enable_payment_or_retire_existing_obligations(
    qualified_settlement,
):
    module, state, tools = qualified_settlement
    with pytest.raises(ValueError, match="independently enabled"):
        module.verify_release_admission("uat", state["revision"], tools, payments=True, drain=False)
    with pytest.raises(ValueError, match="Retain settlement"):
        module.verify_release_admission(
            "uat", state["revision"], tools, payments=False, drain=False
        )
    state["drain"] = "false"
    result = module.verify_release_admission(
        "uat", state["revision"], tools, payments=False, drain=True
    )
    assert result["mode"] == "settlement-only"
    assert "executions" not in result


@pytest.mark.parametrize("mismatch", ["payments", "drain", "audience"])
def test_installed_candidate_must_match_admitted_answer_configuration(
    qualified_settlement, mismatch
):
    module, state, _ = qualified_settlement
    module.verify_candidate("uat", state["revision"], payments=False, drain=True)
    state[mismatch] = {"payments": "true", "drain": "false", "audience": "https://foreign.invalid"}[
        mismatch
    ]
    with pytest.raises(ValueError, match="Installed answer settings"):
        module.verify_candidate("uat", state["revision"], payments=False, drain=True)


def test_candidate_execution_cannot_reuse_predecessor_or_pre_promotion_success(
    qualified_settlement,
):
    from datetime import UTC, datetime, timedelta

    module, state, _ = qualified_settlement
    boundary = datetime.now(UTC)
    uri = "https://api.uat.hushh.ai/api/internal/answer-work/drain?stage=refunds"
    row = {
        "timestamp": boundary.isoformat(),
        "resource": {"labels": {"revision_name": state["revision"]}},
        "httpRequest": {"requestUrl": uri, "requestMethod": "POST", "status": 200},
    }
    assert module._candidate_execution(
        [row], revision=state["revision"], uri=uri, not_before=boundary
    )
    for changed in (
        {**row, "timestamp": (boundary - timedelta(seconds=1)).isoformat()},
        {**row, "resource": {"labels": {"revision_name": "predecessor"}}},
        {**row, "httpRequest": {**row["httpRequest"], "status": 503}},
    ):
        assert not module._candidate_execution(
            [changed], revision=state["revision"], uri=uri, not_before=boundary
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
    def test_dev_settlement_uses_its_own_project_identity_and_audience(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "dev")
        monkeypatch.setenv("ANSWER_WORK_DRAIN_ENABLED", "true")
        origin = "https://consent-protocol-621416509462.us-central1.run.app"
        monkeypatch.setenv("ANSWER_WORK_DRAIN_AUDIENCE", origin)
        assert drain._drain_enabled()
        assert drain._configuration() == (
            origin,
            "hushh-pda-dev",
            "answer-work-drain-sched@hushh-pda-dev.iam.gserviceaccount.com",
        )
        monkeypatch.setenv("ANSWER_WORK_DRAIN_AUDIENCE", "https://api.uat.hushh.ai")
        with pytest.raises(RuntimeError, match="audience"):
            drain._configuration()

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


@pytest.mark.parametrize(
    "case,expected",
    [("missing", "pending"), ("503", "pending"), ("403", "terminal"), ("paused", "terminal")],
)
def test_uat_paid_polling_retries_only_classified_evidence_lag(
    qualified_settlement, monkeypatch, case, expected
):
    module, state, tools = qualified_settlement
    cloud = module._cloud

    def observe(*args):
        result = cloud(*args)
        if args[:2] == ("logging", "read"):
            if case == "missing":
                return []
            if case in {"503", "403"}:
                result[0]["httpRequest"]["status"] = int(case)
        return result

    monkeypatch.setattr(module, "_cloud", observe)
    if case == "paused":
        state["paused"] = True
    with pytest.raises(ValueError) as failure:
        module.verify_paid_admission("uat", state["revision"], tools, retry_pending=True)
    assert isinstance(failure.value, module.PendingSettlement) is (expected == "pending")
    assert all(
        call[:3]
        not in {
            ("scheduler", "jobs", "run"),
            ("scheduler", "jobs", "update"),
            ("scheduler", "jobs", "create"),
            ("run", "services", "update-traffic"),
        }
        for call in state["calls"]
    )
