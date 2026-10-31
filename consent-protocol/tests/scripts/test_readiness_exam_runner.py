"""The pre-merge runner gives a live case exactly the UAT exam's one transport repeat."""

from __future__ import annotations

import json

from tests.scripts.test_readiness_exam_premerge import ROOT, _load


def test_only_a_transient_provider_failure_gets_the_uat_repeat(monkeypatch, capsys):
    import asyncio

    from hushh_mcp import managed_ai_config
    from hushh_mcp.one_adk import azure_workload_identity
    from scripts import probe_drive_activity_planner as planner
    from scripts import verify_azure_pwm_runtime

    runner = _load(ROOT / "scripts/ci/readiness_exam_runner.py", "exam_runner_repeat")
    account = {"tenant_id": "t", "readiness_exam_client_id": "probe"}
    monkeypatch.setattr(managed_ai_config, "load_managed_azure_account", lambda: account)
    monkeypatch.setattr(
        azure_workload_identity, "github_actions_token_provider", lambda **_: lambda: "token"
    )
    busy = type("Busy", (Exception,), {"status_code": 503})
    semantic = planner.ActivityPlannerContractError("core_reason")
    case = {"id": "drive_planner.ordinary", "stage": runner.PLANNER_STAGE}
    # One repeat for a 5xx, never a second; a semantic failure is never repeated.
    for outcomes, calls in (([busy(), None], 2), ([busy(), busy()], 2), ([semantic], 1)):
        ran = []

        async def probe(provider, *, case_ids, token_supplier, outcomes=outcomes, ran=ran):
            ran.append(case_ids)
            if outcomes[len(ran) - 1] is not None:
                raise outcomes[len(ran) - 1]

        monkeypatch.setattr(planner, "probe_drive_activity_planner", probe)
        try:
            asyncio.run(runner._run(case))
        except Exception as error:  # noqa: BLE001 - the last outcome is what surfaces
            assert error is outcomes[-1]
        assert len(ran) == calls
    capsys.readouterr()

    async def repeated(case):
        failed = {"schema": "drive.activity_planner.probe.v1", "result": "failed"}
        print(json.dumps(failed))
        print(
            json.dumps({"azure_pwm_runtime_probe_stage": case["id"], "result": "transport_retry"})
        )
        raise TimeoutError

    monkeypatch.setattr(runner, "_run", repeated)
    monkeypatch.setattr(verify_azure_pwm_runtime, "_initialize_synthetic_runtime", lambda: None)
    runner.main(["--case", "drive_planner.ordinary"])
    out = capsys.readouterr().out.splitlines()
    row = next(json.loads(line)["readiness_exam_case"] for line in out if "exam_case" in line)
    # The repeat is recorded, and only the final attempt decides the class.
    assert [row[k] for k in ("result", "class", "reason", "transport_retries")] == [
        "inconclusive",
        "transport",
        "provider_timeout",
        1,
    ]
