"""Native Vertex research and complete deadline receipts qualify the selected runtime."""

import json

import pytest


@pytest.mark.parametrize("defect", [None, "attribution", "native_task", "duplicate_charge"])
async def test_vertex_research_probe_uses_native_completion_and_attribution_controls(
    monkeypatch, defect
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk import world_model
    from scripts.probe_managed_capabilities import _probe_vertex_research
    from scripts.verify_azure_pwm_runtime import _ATTRIBUTION_CASES

    async def native(**kwargs):
        await kwargs["on_attempts_start"]([world_model.MAX_SEARCHES + world_model.MAX_MODEL_CALLS])
        if defect == "duplicate_charge":
            await kwargs["on_attempts_start"](
                [world_model.MAX_SEARCHES + world_model.MAX_MODEL_CALLS]
            )
        return {
            "status": "unavailable" if defect == "native_task" else "offered",
            "pkm_written": False,
            "report": {"sections": []},
            "grounded_answers": [],
            "research": {"provider": "vertex_google_search"},
        }

    task = AsyncMock(side_effect=native)
    monkeypatch.setattr(world_model, "run_world_model", task)
    rows = [{"case_id": key, "supported": supported} for key, _, _, supported in _ATTRIBUTION_CASES]
    if defect == "attribution":
        rows[0]["supported"] = not rows[0]["supported"]
    generate = AsyncMock(
        return_value=SimpleNamespace(
            text=json.dumps(rows), candidates=[SimpleNamespace(finish_reason="STOP")]
        )
    )
    client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate)))
    if defect:
        with pytest.raises(ValueError, match="research"):
            await _probe_vertex_research(client)
    else:
        assert await _probe_vertex_research(client) == {
            "research_contracts": 1,
            "attribution_cases": 8,
        }
    task.assert_awaited_once()
    args = task.call_args.kwargs
    assert list(args["attempts_used"]) == list(
        range(1, world_model.MAX_SEARCHES + world_model.MAX_MODEL_CALLS)
    )
    assert args["work"]["sources"] == {} and args["consent_token"] == ""


async def test_vertex_capability_deadline_emits_all_undispatched_failures(monkeypatch, capsys):
    from types import SimpleNamespace

    from hushh_mcp import runtime_providers
    from scripts.probe_managed_capabilities import probe_managed_capabilities

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", raising=False)
    monkeypatch.setattr(
        runtime_providers, "build_managed_runtime_client", lambda *_: SimpleNamespace()
    )
    report = await probe_managed_capabilities("vertex", deadline=0)
    assert report["ready"] is False and len(report["capabilities"]) >= 12
    assert all(
        not value["ready"]
        and value["dispatched"] is False
        and value["error_type"] == "TimeoutError"
        for value in report["capabilities"].values()
    )
    assert "managed_capabilities_probe" in capsys.readouterr().out
