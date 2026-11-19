"""Native Vertex research and complete deadline receipts qualify the selected runtime."""

import json

import pytest


@pytest.mark.parametrize(
    "defect", [None, "wrong_fact", "missing_domain", "lookalike_domain", "no_citations", "no_field"]
)
async def test_native_compact_search_requires_the_fact_field_and_received_sources(
    monkeypatch, defect
):
    from types import SimpleNamespace

    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    from hushh_mcp.hushh_adk import turn
    from hushh_mcp.one_adk import agent_tree
    from hushh_mcp.runtime_providers.managed_text import build_managed_text_model
    from scripts.probe_managed_capabilities import _probe_public_search

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.delenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", raising=False)
    model = build_managed_text_model(scope="one_text_chat")
    monkeypatch.setattr(agent_tree, "_resolve_text_model", lambda *args, **kwargs: model)
    dispatched = []
    text = "registration_available=false\nIANA reserves example.net and example.org."
    if defect == "wrong_fact":
        text = text.replace("=false", "=true")
    elif defect == "missing_domain":
        text = text.replace("example.org", "a different domain")
    elif defect == "lookalike_domain":
        text = text.replace("example.net", "example.net.evil")
    elif defect == "no_field":
        text = text.partition("\n")[2]

    async def received(**kwargs):
        dispatched.append(True)
        assert "Do not use JSON" in kwargs["message"]
        response = LlmResponse(
            grounding_metadata=types.GroundingMetadata(
                grounding_chunks=[]
                if defect == "no_citations"
                else [
                    types.GroundingChunk(
                        web=types.GroundingChunkWeb(uri="https://www.iana.org/help/example-domains")
                    )
                ]
            )
        )
        await kwargs["agent"].after_model_callback(None, response)
        return SimpleNamespace(final_text=text)

    monkeypatch.setattr(turn, "run_specialist_adk_turn", received)
    if defect:
        with pytest.raises(ValueError):
            await _probe_public_search(compact=True)
    else:
        proof = await _probe_public_search(compact=True)
        assert proof["synthetic_content_verified"] is True and proof["cited_sources"] == 1
    assert dispatched == [True]


def _capture_task_output(original_turn, defect):
    async def capture(**kwargs):
        from dataclasses import replace

        result = await original_turn(**kwargs)
        if defect == "output_mismatch":
            output = {**result.structured_output, "summary": "A different received value."}
            return replace(result, structured_output=output)
        if defect == "missing_receipt":
            return replace(result, tool_results=())
        return result

    return capture


@pytest.mark.parametrize("defect", [None, "coverage", "output_mismatch", "missing_receipt"])
async def test_native_research_generation_projection_keeps_original_task_validator(
    monkeypatch, defect
):
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types

    from hushh_mcp import runtime_providers
    from hushh_mcp.hushh_adk import turn as turn_runtime
    from hushh_mcp.hushh_adk.turn import SpecialistAdkTurnError
    from hushh_mcp.one_adk.world_model_contracts import WorldModelReport
    from scripts.probe_vertex_research import _probe_native_research
    from scripts.verify_azure_pwm_runtime import _production_contract_examples

    examples, _ = _production_contract_examples()
    if defect == "coverage":
        examples["report"]["coverage"] = []
    expected = WorldModelReport.model_json_schema()
    requests = []

    class NativeTask(BaseLlm):
        async def generate_content_async(self, request, stream=False):
            requests.append(request.model_copy(deep=True))
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="finish_task", args=examples["report"]
                            )
                        )
                    ],
                ),
                finish_reason=types.FinishReason.STOP,
            )

    monkeypatch.setattr(
        runtime_providers,
        "build_managed_regional_gemini_adk_model",
        lambda *_: NativeTask(model="synthetic-native-task"),
    )
    monkeypatch.setattr(
        turn_runtime,
        "run_specialist_adk_turn",
        _capture_task_output(turn_runtime.run_specialist_adk_turn, defect),
    )
    # Keep provider/model construction local, while the real ADK task wrapper
    # validates finish_task and the existing research budget rejects a retry.
    if defect == "coverage":
        with pytest.raises(SpecialistAdkTurnError):
            await _probe_native_research()
    elif defect == "output_mismatch":
        with pytest.raises(ValueError, match="differs from its validated receipt"):
            await _probe_native_research()
    elif defect == "missing_receipt":
        with pytest.raises(ValueError, match="selected_candidate_id"):
            await _probe_native_research()
    else:
        await _probe_native_research()
    assert len(requests) == 1
    request = requests[0]
    declaration = next(
        f for t in request.config.tools for f in t.function_declarations if f.name == "finish_task"
    )
    assert "minItems" not in declaration.parameters_json_schema["properties"]["coverage"]
    assert (
        declaration.parameters_json_schema["properties"]["name"] == expected["properties"]["name"]
    )
    assert request.config.tool_config.function_calling_config.allowed_function_names == [
        "finish_task"
    ]
    assert WorldModelReport.model_json_schema() == expected
    assert expected["properties"]["coverage"]["minItems"] == 20


@pytest.mark.parametrize("finish", ["STOP", "MAX_TOKENS", None])
async def test_root_probe_accepts_native_adk_terminal_and_rejects_truncation(monkeypatch, finish):
    import re
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from google.adk.models.llm_response import LlmResponse
    from google.adk.utils.streaming_utils import StreamingResponseAggregator
    from google.genai import types

    from scripts import probe_one_text_root as probe

    async def generate(request, stream=False):
        if not stream:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="get_current_time", args={"time_zone": "UTC"}
                            )
                        )
                    ],
                ),
                finish_reason=types.FinishReason.STOP,
            )
            return
        pdf = next(
            p.inline_data.data
            for p in request.contents[0].parts
            if p.inline_data and p.inline_data.mime_type == "application/pdf"
        )
        nonce = re.search(rb"ROOT[A-F0-9]+", pdf).group().decode()
        answer = json.dumps({"code": nonce, "color": "red", "time_zone": "UTC"})
        aggregator = StreamingResponseAggregator()
        async for chunk in aggregator.process_response(
            types.GenerateContentResponse(
                candidates=[
                    types.Candidate(
                        content=types.Content(role="model", parts=[types.Part(text=answer)]),
                        finish_reason=finish,
                    )
                ]
            )
        ):
            yield chunk
        final = aggregator.close()
        assert final.turn_complete is None
        yield final

    model = SimpleNamespace(model="synthetic-native", generate_content_async=generate)
    monkeypatch.setattr(probe, "_root_contract", AsyncMock(return_value=(model, "synthetic", [])))
    if finish == "STOP":
        assert (await probe.probe_one_text_root())["streaming_observed"] is True
    else:
        with pytest.raises(ValueError):
            await probe.probe_one_text_root()


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


def _structured_probe_client(defect, nonce, calls):
    from types import SimpleNamespace

    from google.genai import types

    async def unary(**kwargs):
        calls.append(("unary", kwargs["config"]))
        return SimpleNamespace(
            text=json.dumps(nonce if defect == "unary_scalar" else {"code": nonce}),
            candidates=[SimpleNamespace(finish_reason=types.FinishReason.STOP)],
        )

    async def streaming(**kwargs):
        calls.append(("stream", kwargs["config"]))
        payload = {
            "scalar": nonce,
            "array": [nonce],
            "null": None,
            "wrong_nonce": {"code": "different"},
            "extra_key": {"code": nonce, "extra": True},
        }.get(defect, {"code": nonce})
        answer = json.dumps(payload)
        if defect == "duplicate":
            answer += answer
        elif defect == "non_json":
            answer = "not JSON"

        async def chunks():
            if defect != "no_chunks":
                yield SimpleNamespace(text=answer[:5], candidates=[])
                yield SimpleNamespace(
                    text=answer[5:],
                    candidates=[
                        SimpleNamespace(
                            finish_reason=(
                                types.FinishReason.MAX_TOKENS
                                if defect == "incomplete"
                                else types.FinishReason.STOP
                            )
                        )
                    ],
                )

        return chunks()

    return SimpleNamespace(
        aio=SimpleNamespace(
            models=SimpleNamespace(
                generate_content=unary,
                generate_content_stream=streaming,
            )
        )
    )


@pytest.mark.parametrize(
    "defect",
    [
        None,
        "scalar",
        "array",
        "null",
        "wrong_nonce",
        "incomplete",
        "duplicate",
        "non_json",
        "extra_key",
        "no_chunks",
        "unary_scalar",
    ],
)
async def test_structured_probe_requires_closed_object_and_complete_received_stream(
    monkeypatch, defect
):
    from hushh_mcp import runtime_providers
    from scripts import probe_managed_capabilities as probe
    from scripts.capability_check import run_capability

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("HUSHH_UAT_MANAGED_AI_PROVIDER", "vertex")
    monkeypatch.setenv("HUSHH_UAT_MANAGED_TEXT_PROVIDER", "vertex")
    nonce = "0123456789abcdef"
    monkeypatch.setattr(probe.secrets, "token_hex", lambda _: nonce)
    calls = []

    async def only_structured(report, name, operation, *, deadline):
        if name == "structured_text":
            await run_capability(report, name, operation, deadline=deadline)

    client = _structured_probe_client(defect, nonce, calls)
    monkeypatch.setattr(runtime_providers, "build_managed_runtime_client", lambda *_: client)
    monkeypatch.setattr(probe, "run_capability", only_structured)
    report = await probe.probe_managed_capabilities("vertex")
    row = report["capabilities"]["structured_text"]
    assert row["ready"] is (defect is None)
    assert [name for name, _ in calls] == (
        ["unary"] if defect == "unary_scalar" else ["unary", "stream"]
    )
    for _, config in calls:
        assert config.response_json_schema == {
            "type": "object",
            "properties": {"code": {"type": "string", "enum": [nonce]}},
            "required": ["code"],
            "additionalProperties": False,
        }
    if defect:
        assert row["classification"] == "candidate_misconfigured"
        assert row["error_type"] == "ValueError"
        assert row["failure_reason"] == (
            "structured.unary" if defect == "unary_scalar" else "structured.stream"
        )
        assert "transport_retries" not in row
    else:
        assert row["synthetic_content_verified"] and row["streaming_observed"]
