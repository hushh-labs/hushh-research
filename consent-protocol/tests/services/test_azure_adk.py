"""Azure ADK transport preserves authority-bearing protocol shapes offline."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import types
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from hushh_mcp.runtime_providers.azure_adk import AzureOpenAIAdkModel


def response(*output):
    return SimpleNamespace(
        status="completed",
        incomplete_details=None,
        output=list(output),
        model="synthetic-version",
        usage=SimpleNamespace(input_tokens=12, output_tokens=8, total_tokens=20),
    )


def message(text):
    return {"type": "message", "content": [{"type": "output_text", "text": text}]}


def call(arguments='{"query":"original subject"}', name="lookup", identity="call_123"):
    return {"type": "function_call", "name": name, "call_id": identity, "arguments": arguments}


def request(*contents, **config):
    return LlmRequest(
        model="synthetic-deployment",
        contents=list(contents)
        or [types.Content(role="user", parts=[types.Part(text="Original request")])],
        config=types.GenerateContentConfig(**config),
    )


def tools():
    return [
        types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="lookup",
                    description="Authorized lookup",
                    parameters_json_schema={
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                )
            ]
        )
    ]


class Stream:
    def __init__(self, events=(), *, blocked=False):
        self.events = iter(events)
        self.blocked = blocked
        self.started = asyncio.Event()
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.started.set()
        if self.blocked:
            await asyncio.Event().wait()
        try:
            return next(self.events)
        except StopIteration:
            raise StopAsyncIteration from None

    async def close(self):
        self.closed = True


class Client:
    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.requests = []
        self.closed = 0
        self.responses = self

    async def create(self, **kwargs):
        self.requests.append(kwargs)
        return next(self.outputs)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        self.closed += 1


def model(outputs):
    client = Client(outputs)
    factory, token = Mock(return_value=client), Mock(return_value="synthetic-bearer")
    adapter = AzureOpenAIAdkModel(
        model="synthetic-deployment",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=token,
        client_factory=factory,
    )
    return adapter, client, factory, token


async def test_complete_tool_history_reasoning_ids_and_owner_instruction_survive_roundtrip():
    reasoning = {
        "type": "reasoning",
        "id": "rs_1",
        "summary": [],
        "encrypted_content": "synthetic-encrypted-reasoning",
    }
    adapter, client, factory, token = model(
        [response(reasoning, message("Checking"), call()), response(message("Result"))]
    )
    first = request(
        tools=tools(),
        system_instruction="Only the authored instruction",
        thinking_config=types.ThinkingConfig(thinking_level="LOW"),
        max_output_tokens=128,
    )
    (answer,) = [item async for item in adapter.generate_content_async(first)]
    assert answer.content.parts[-1].function_call.id == "call_123"
    assert answer.usage_metadata.total_token_count == 20
    followup = request(
        first.contents[0],
        answer.content,
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="call_123",
                        name="lookup",
                        response={"result": "Untrusted tool information"},
                    )
                )
            ],
        ),
        tools=tools(),
        system_instruction="Only the authored instruction",
    )
    (final,) = [item async for item in adapter.generate_content_async(followup)]
    assert final.content.parts[0].text == "Result"
    sent = client.requests[1]
    assert sent["input"] == [
        {"role": "user", "content": "Original request"},
        reasoning,
        {"role": "assistant", "content": "Checking"},
        {
            "type": "function_call",
            "call_id": "call_123",
            "name": "lookup",
            "arguments": '{"query":"original subject"}',
        },
        {
            "type": "function_call_output",
            "call_id": "call_123",
            "output": '{"result":"Untrusted tool information"}',
        },
    ]
    assert sent["instructions"] == "Only the authored instruction"
    assert all(item["store"] is False for item in client.requests)
    assert client.requests[0]["reasoning"] == {"effort": "low"}
    assert client.requests[0]["include"] == ["reasoning.encrypted_content"]
    assert all(c.kwargs["max_retries"] == 0 for c in factory.call_args_list)
    assert token.call_count == 2 and client.closed == 2
    assert "synthetic-bearer" not in repr(adapter) + str(adapter.model_dump())


async def test_structured_contract_is_native_and_remains_subject_to_strict_host_validation():
    class Output(BaseModel):
        model_config = ConfigDict(extra="forbid", strict=True)
        title: str
        confidence: int = Field(ge=0, le=100)

    adapter, client, _, _ = model([response(message('{"title":"Observed","confidence":98}'))])
    (answer,) = [
        item async for item in adapter.generate_content_async(request(response_schema=Output))
    ]
    parsed = Output.model_validate_json(answer.content.parts[0].text)
    assert parsed.title == "Observed"
    wire = client.requests[0]["text"]["format"]
    assert wire["type"] == "json_schema" and wire["strict"] is True
    assert set(wire["schema"]["properties"]) == {"title", "confidence"}
    assert wire["schema"]["additionalProperties"] is False
    assert wire["schema"]["properties"]["confidence"]["maximum"] == 100
    with pytest.raises(ValidationError):
        Output.model_validate({"title": "Observed", "confidence": 101})


@pytest.mark.parametrize(
    "gene_id", ["agent_documents_request_search", "agent_documents_request_assessment"]
)
async def test_real_adk_single_turn_decodes_output_from_manifest_with_injected_azure_model(gene_id):
    from pathlib import Path

    from hushh_mcp.hushh_adk.manifest import ManifestLoader
    from hushh_mcp.hushh_adk.single_turn import build_single_turn_agent, run_single_turn
    from hushh_mcp.services.drive_request_package_assessment import DocumentBatchAssessment
    from hushh_mcp.services.drive_suggestion_service import SemanticLiveSearchModelPlan

    if gene_id == "agent_documents_request_search":
        schema = SemanticLiveSearchModelPlan
        payload = {
            "terms": [],
            "mode": "find",
            "file_kind": "any",
            "subject_scope": "specific_records",
            "subject_complete": True,
            "semantic_intent": "other",
            "discovery_clues": ["Synthetic subject"],
            "required_entities": [],
            "expected_document_anatomy": "Substantive content.",
            "semantic_query": {
                "version": 1,
                "status": "ready",
                "metadata_listing": False,
                "date_basis": "title_created_modified",
                "clarification": None,
                "clauses": [
                    {
                        "predicates": [
                            {
                                "id": "subject",
                                "kind": "semantic",
                                "value": "Synthetic subject",
                                "match": "phrase",
                                "negated": False,
                                "discovery_terms": [],
                            }
                        ]
                    }
                ],
            },
        }
    else:
        schema = DocumentBatchAssessment
        payload = {
            "documents": [
                {
                    "document_ref": "p1",
                    "decision": "exclude",
                    "confidence": 90,
                    "reason": "No substantive requested content.",
                    "citations": [],
                    "covered_periods": [],
                }
            ]
        }
    expected = schema.model_validate(payload)
    adapter, client, _, _ = model([response(message(expected.model_dump_json()))])
    manifest = ManifestLoader.load(
        str(Path(__file__).resolve().parents[2] / "hushh_mcp/agents/documents/agent.yaml")
    )
    gene = next(child for child in manifest.subagents if child.id == gene_id)
    agent = build_single_turn_agent(gene, output_schema=schema, model=adapter)
    result = await run_single_turn(
        agent,
        prompt_parts="Synthetic request",
        user_id="synthetic",
        consent_token="",
        timeout_seconds=5,
    )
    assert result == expected
    import jsonschema

    wire_schema = client.requests[0]["text"]["format"]["schema"]
    jsonschema.validate(json.loads(expected.model_dump_json()), wire_schema)
    assert client.requests[0]["instructions"].startswith(gene.system_instruction.strip())
    assert len(client.requests) == 1


async def test_real_adk_runner_executes_one_authorized_tool_then_preserves_its_result():
    from google.adk.agents import LlmAgent

    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn

    observed = []

    async def lookup(query: str) -> dict:
        """Return synthetic information for the explicit query."""
        observed.append(query)
        return {"observed_query": query}

    adapter, client, _, _ = model(
        [response(call()), response(message("Synthetic completed result"))]
    )
    agent = LlmAgent(
        name="synthetic_azure_tool",
        model=adapter,
        instruction="Use only authorized lookup.",
        tools=[lookup],
    )
    result = await run_specialist_adk_turn(
        agent=agent,
        app_name="synthetic_azure_tools",
        user_id="synthetic",
        consent_token="",
        message="Original request",
        max_llm_calls=2,
        total_timeout_s=5,
    )
    assert result.final_text == "Synthetic completed result" and result.llm_calls == 2
    assert observed == ["original subject"]
    sent = client.requests[1]["input"]
    assert any(
        item.get("type") == "function_call_output"
        and item["call_id"] == "call_123"
        and item["output"] == '{"observed_query":"original subject"}'
        for item in sent
    )


@pytest.mark.parametrize("matched", [True, False])
async def test_real_runner_migrates_gemini_fallback_tool_ids_without_guessing_pairs(matched):
    from google.adk.agents import LlmAgent
    from google.adk.apps import App
    from google.adk.events import Event
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService

    adapter, client, _, token = model([response(message("Migrated synthetic history"))])
    agent = LlmAgent(name="migration_agent", model=adapter, instruction="Keep original history.")
    sessions = InMemorySessionService()
    session = await sessions.create_session(
        app_name="azure_migration", user_id="synthetic", session_id="migration"
    )
    history = [
        types.Content(role="user", parts=[types.Part(text="Original historical request")]),
        types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id="adk-gemini-fallback",
                        name="historical_lookup",
                        args={"query": "original subject"},
                    )
                )
            ],
        ),
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="adk-gemini-fallback" if matched else "adk-unmatched",
                        name="historical_lookup",
                        response={"result": "Original historical result"},
                    )
                )
            ],
        ),
    ]
    for content in history:
        await sessions.append_event(
            session,
            Event(
                author="user" if content.role == "user" else agent.name,
                invocation_id="historical-turn",
                content=content,
            ),
        )
    runner = Runner(app=App(name="azure_migration", root_agent=agent), session_service=sessions)

    async def run():
        return [
            event
            async for event in runner.run_async(
                user_id="synthetic",
                session_id=session.id,
                new_message=types.Content(
                    role="user", parts=[types.Part(text="Continue original request")]
                ),
            )
        ]

    try:
        if matched:
            events = await run()
            assert any(
                event.content
                and any(
                    part.text == "Migrated synthetic history" for part in event.content.parts or []
                )
                for event in events
            )
            inputs = client.requests[0]["input"]
            assert {
                "type": "function_call",
                "call_id": "adk-gemini-fallback",
                "name": "historical_lookup",
                "arguments": '{"query":"original subject"}',
            } in inputs
            assert {
                "type": "function_call_output",
                "call_id": "adk-gemini-fallback",
                "output": '{"result":"Original historical result"}',
            } in inputs
            token.assert_called_once()
        else:
            with pytest.raises(ValueError):
                await run()
            token.assert_not_called()
            assert client.requests == []
    finally:
        await runner.close()


async def test_streaming_has_text_fragments_and_one_complete_nonpartial_tool_response():
    complete = response(message("Hello"), call())
    events = Stream(
        [
            {"type": "response.output_text.delta", "delta": "Hel"},
            {"type": "response.function_call_arguments.delta", "delta": '{"query":'},
            {"type": "response.output_text.delta", "delta": "lo"},
            {"type": "response.completed", "response": complete},
        ]
    )
    adapter, client, _, _ = model([events, complete])
    streamed = [
        item async for item in adapter.generate_content_async(request(tools=tools()), stream=True)
    ]
    assert [item.content.parts[0].text for item in streamed[:-1]] == ["Hel", "lo"]
    assert all(
        item.partial is True and not item.content.parts[0].function_call for item in streamed[:-1]
    )
    assert streamed[-1].partial is False and streamed[-1].turn_complete is True
    (single,) = [item async for item in adapter.generate_content_async(request(tools=tools()))]
    assert streamed[-1] == single and events.closed and client.closed == 2


async def test_cancellation_closes_stream_and_client_without_replaying_or_final_output():
    events = Stream(blocked=True)
    adapter, client, _, _ = model([events])
    source = adapter.generate_content_async(request(), stream=True)
    task = asyncio.create_task(anext(source))
    await events.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert events.closed and client.closed == 1 and len(client.requests) == 1


@pytest.mark.parametrize(
    "unsupported", ["native_tool", "media", "missing_tool_result", "wrong_result_id"]
)
async def test_unsupported_or_incomplete_authority_bearing_input_fails_before_auth(unsupported):
    adapter, client, _, token = model([])
    value = request()
    if unsupported == "native_tool":
        value.config.tools = [types.Tool(google_search=types.GoogleSearch())]
    elif unsupported == "media":
        value.contents[0].parts = [
            types.Part(inline_data=types.Blob(data=b"synthetic", mime_type="image/png"))
        ]
    else:
        value.contents.append(
            types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(id="call_123", name="lookup", args={})
                    )
                ],
            )
        )
        if unsupported == "wrong_result_id":
            value.contents.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            function_response=types.FunctionResponse(
                                id="wrong", name="lookup", response={}
                            )
                        )
                    ],
                )
            )
    with pytest.raises(ValueError):
        _ = [item async for item in adapter.generate_content_async(value)]
    token.assert_not_called()
    assert client.requests == []


@pytest.mark.parametrize(
    "bad",
    [
        call("not JSON"),
        call("[]"),
        call('{"value":NaN}'),
        call(name="undeclared"),
        {"type": "web_search_call"},
    ],
)
async def test_unknown_calls_or_invalid_arguments_never_become_executable_adk_output(bad):
    adapter, _, _, _ = model([response(bad)])
    with pytest.raises(ValueError):
        _ = [item async for item in adapter.generate_content_async(request(tools=tools()))]


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://synthetic.openai.azure.com/openai/v1/",
        "https://openai.azure.com.evil.test/openai/v1/",
        "https://user:secret@synthetic.openai.azure.com/openai/v1/",
        "https://synthetic.openai.azure.com/other",
        "https://synthetic.openai.azure.com/openai/v1/?key=secret",
    ],
)
def test_endpoint_is_not_a_caller_controlled_credential_exfiltration_target(endpoint):
    with pytest.raises(ValidationError):
        AzureOpenAIAdkModel(
            model="synthetic", endpoint=endpoint, token_supplier=lambda: "synthetic"
        )


@pytest.mark.parametrize("stream", [False, True])
async def test_private_authority_is_rechecked_after_token_before_every_send(stream):
    output = response(message("safe"))
    if stream:
        output = Stream([{"type": "response.completed", "response": output}])
    adapter, client, _, token = model([output])
    order = []
    token.side_effect = lambda: order.append("token") or "synthetic-bearer"

    async def current():
        order.append("guard")
        assert order[-2] == "token"
        raise PermissionError("authority revoked during token acquisition")

    adapter.require_current = current
    for _ in range(2):
        with pytest.raises(PermissionError):
            _ = [item async for item in adapter.generate_content_async(request(), stream=stream)]
    assert order == ["token", "guard", "token", "guard"]
    assert client.requests == []  # Removing the adapter guard sends private text.

    async def allowed():
        order.append("guard")

    adapter.require_current = allowed
    if stream:
        client.outputs = iter(
            [Stream([{"type": "response.completed", "response": response(message("safe"))}])]
        )
    result = [item async for item in adapter.generate_content_async(request(), stream=stream)]
    assert result[-1].turn_complete and len(client.requests) == 1
    assert order[-2:] == ["token", "guard"]
