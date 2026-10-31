"""Offline measurement contracts; fixture-only Nav public path."""

from types import SimpleNamespace

import pytest

from scripts import eval_specialist_turns as harness


def legacy_available():
    from hushh_mcp.adk_bridge import nav_agent

    return (
        not callable(getattr(nav_agent, "build_nav_agent", None))
        and callable(getattr(nav_agent.NavAgent, "_answer", None))
        and callable(getattr(nav_agent, "_is_active_consent_query", None))
    )


async def baseline_or_reject(case):
    if legacy_available():
        return await harness.run_case(case)
    with pytest.raises(ValueError, match="baseline requires its original revision"):
        await harness.run_case(case)
    return None


def test_fixture_coverage():
    cases = harness.load_cases()
    assert len(cases) == 22
    assert {c["family"] for c in cases} == {
        "active",
        "previous",
        "revoke",
        "details",
        "expiry",
        "explanatory",
        "redirect",
        "out_of_scope",
        "ambiguous",
    }


@pytest.mark.asyncio
async def test_public_path_maps_service_call_and_preserves_directive():
    case = harness.load_cases()[0]
    row = await baseline_or_reject(case)
    if row is None:
        return
    assert row["first_tool_hit"] and row["shape_hit"]
    assert row["directive"]["payload"]["items"][0]["id"] == "one_location_grant:fixture-grant"


@pytest.mark.asyncio
async def test_keyword_miss_stays_miss():
    row = await baseline_or_reject(harness.load_cases()[1])
    if row is None:
        return
    assert row["observed"] == "no_tool"
    assert not row["first_tool_hit"] and not row["shape_hit"]


@pytest.mark.asyncio
async def test_exceptions_are_retained_and_repetitions_all_or_nothing(monkeypatch):
    attempts = iter([True, False])

    async def fake(case):
        ok = next(attempts)
        return {
            "id": case["id"],
            "family": case["family"],
            "first_tool_hit": ok,
            "shape_hit": ok,
            "elapsed_ms": 1,
            "failure": None if ok else "TimeoutError",
        }

    sleeps = []

    async def paced(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(harness, "run_case", fake)
    monkeypatch.setattr(harness.asyncio, "sleep", paced)
    report = await harness.evaluate(
        harness.load_cases()[:1], runs=2, model="both", mode="baseline", gap_seconds=2
    )
    assert sleeps == [2]
    assert report["latency_ms"]["p95"] == 1
    assert report["first_tool_rate"] == report["shape_rate"] == 0
    assert report["results"][1]["failure"] == "TimeoutError"
    assert report["model_calls"] == 0 and report["effective_model"] is None
    assert not report["gates"]["passed"]


@pytest.mark.asyncio
async def test_adk_requires_one_actual_selected_model():
    with pytest.raises(ValueError, match="one selected model"):
        await harness.evaluate(harness.load_cases(), runs=1, model="both", mode="adk")


def test_shape_rejects_empty_epoch_and_instruction():
    case = {"directive": False}
    assert harness.shape_errors(case, "", None) == ["empty_answer"]
    assert "raw_epoch_or_instruction" in harness.shape_errors(
        case, "You are Nav 1785283200000", None
    )


@pytest.mark.asyncio
async def test_service_failure_is_narrated_without_card():
    case = next(c for c in harness.load_cases() if c["id"] == "unavailable")
    row = await baseline_or_reject(case)
    if row is None:
        return
    assert row["first_tool_hit"] and row["shape_hit"]
    assert "could not load" in row["text"]
    assert row["directive"] is None


@pytest.mark.asyncio
async def test_real_adk_callbacks_observe_nested_leaf_and_model_requests():
    from google.adk.agents import LlmAgent
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.adk.tools.agent_tool import AgentTool
    from google.genai import types
    from pydantic import PrivateAttr

    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn

    class OfflineModel(BaseLlm):
        _steps: list = PrivateAttr()

        def __init__(self, steps):
            super().__init__(model="gemini-3.7-flash")
            self._steps = list(steps)

        async def generate_content_async(self, llm_request, stream=False):
            step = self._steps.pop(0)
            if isinstance(step, Exception):
                raise step
            yield LlmResponse(content=types.Content(role="model", parts=[step]))

    async def list_active_consent_grants() -> dict:
        return {"fixture": True}

    child = LlmAgent(
        name="consent",
        model=OfflineModel(
            [
                types.Part(
                    function_call=types.FunctionCall(name="list_active_consent_grants", args={})
                ),
                types.Part.from_text(text="Fixture grants"),
            ]
        ),
        tools=[list_active_consent_grants],
    )
    root = LlmAgent(
        name="nav",
        model=OfflineModel(
            [
                types.Part(
                    function_call=types.FunctionCall(name="consent", args={"request": "fixture"})
                ),
                types.Part.from_text(text="Done"),
            ]
        ),
        tools=[AgentTool(agent=child)],
    )
    trace = harness.TurnTrace()
    harness.instrument_agent_graph(root, trace)
    result = await run_specialist_adk_turn(
        agent=root,
        app_name="nav_eval_test",
        user_id="fixture",
        consent_token="fixture",  # noqa: S106
        message="fixture",
    )
    assert result.final_text == "Done"
    assert len(trace.model_requests) == result.llm_calls == 4
    assert sum(event["phase"] == "model_response" for event in trace.progress_events) == 4
    assert any(event["phase"] == "tool_result" for event in trace.progress_events)
    elapsed = [event["elapsed_ms"] for event in trace.progress_events]
    assert elapsed == sorted(elapsed)
    assert all(
        set(event) <= {"phase", "agent", "tool", "elapsed_ms"} for event in trace.progress_events
    )
    assert trace.tool_calls == ["consent", "list_active_consent_grants"]
    assert trace.leaf_calls == ["list_active_consent_grants"]
    assert {request["model"] for request in trace.model_requests} == {"gemini-3.7-flash"}
    assert {request["agent"] for request in trace.model_requests} == {"nav", "consent"}


@pytest.mark.asyncio
async def test_adk_missing_callbacks_cannot_report_success(monkeypatch):
    from hushh_mcp.adk_bridge import nav_agent

    class UninstrumentedNav:
        def __init__(self, *, model):
            assert model == "gemini-3.7-flash"

        async def handle(self, task):
            return SimpleNamespace(text="Explanation", directive=None)

    monkeypatch.setattr(nav_agent, "NavAgent", UninstrumentedNav)
    monkeypatch.setattr(harness, "build_live_model", lambda model: (model, "fixture-bridge"))
    monkeypatch.setattr(nav_agent, "build_nav_agent", lambda: None, raising=False)
    row = await harness.run_case(
        {"id": "no_call", "family": "explanatory", "prompt": "Explain", "expected": ["no_tool"]},
        mode="adk",
        model="gemini-3.7-flash",
    )
    assert row["failure"] == "NoObservedModelRequest"
    assert not row["first_tool_hit"] and not row["shape_hit"]


@pytest.mark.asyncio
async def test_adk_aggregation_retains_failed_model_attempts(monkeypatch):
    async def failed(case, *, mode, model):
        return {
            "id": case["id"],
            "family": case["family"],
            "elapsed_ms": 120001,
            "failure": "TimeoutError",
            "first_tool_hit": False,
            "shape_hit": False,
            "model_calls": 1,
            "model_requests": [{"agent": "nav", "model": model}],
        }

    monkeypatch.setattr(harness, "run_case", failed)
    report = await harness.evaluate(
        harness.load_cases(), runs=3, model="gemini-3.7-flash", mode="adk"
    )
    assert len(report["results"]) == report["model_calls"] == 66
    assert report["first_tool_rate"] == report["shape_rate"] == 0
    assert report["latency_ms"]["p95"] == 120001
    assert not report["gates"]["passed"]


def test_live_model_uses_canonical_bridge_and_rejects_native_project(monkeypatch):
    from hushh_mcp import runtime_providers

    selected = []

    def build(model):
        selected.append(model)
        return SimpleNamespace(
            client_kwargs={"vertexai": True, "project": "hushh-vertex-personal54"}
        )

    monkeypatch.setattr(runtime_providers, "build_managed_gemini_adk_model", build)
    built, project = harness.build_live_model("gemini-3.7-flash")
    assert selected == ["gemini-3.7-flash"] and project == "hushh-vertex-personal54"
    assert built.client_kwargs["vertexai"]
    monkeypatch.setattr(
        runtime_providers,
        "build_managed_gemini_adk_model",
        lambda _: SimpleNamespace(client_kwargs={"vertexai": True, "project": "hushh-pda-uat"}),
    )
    with pytest.raises(ValueError, match="personal54"):
        harness.build_live_model("gemini-3.7-flash")


@pytest.mark.asyncio
async def test_migrated_public_handle_uses_fixture_services_and_real_callbacks(monkeypatch):
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types
    from pydantic import PrivateAttr

    class PublicPathModel(BaseLlm):
        _steps: list = PrivateAttr(
            default_factory=lambda: [
                types.Part(
                    function_call=types.FunctionCall(
                        name="consent", args={"request": "Show active consent"}
                    )
                ),
                types.Part(
                    function_call=types.FunctionCall(name="list_active_consent_grants", args={})
                ),
                types.Part.from_text(text="Alex can view your location."),
            ]
        )

        async def generate_content_async(self, llm_request, stream=False):
            yield LlmResponse(content=types.Content(role="model", parts=[self._steps.pop(0)]))

    monkeypatch.setattr(
        harness, "build_live_model", lambda model: (PublicPathModel(model=model), "fixture-bridge")
    )
    row = await harness.run_case(harness.load_cases()[0], mode="adk", model="gemini-3.7-flash")
    assert row["failure"] is None
    assert row["model_calls"] == 3
    assert row["observed"] == "list_active_consent_grants"
    assert row["service_trajectory"] == ["list_active_consent_grants"]
    assert row["first_tool_hit"] and row["shape_hit"]
