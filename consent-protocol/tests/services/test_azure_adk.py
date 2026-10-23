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


def test_actual_crm_nullable_objects_are_closed_before_nullable_wrapping():
    from hushh_mcp.agents.connected_systems.runtime import CRM_SCHEMA_MAPPING_SCHEMA
    from hushh_mcp.runtime_providers.azure_adk import _schema

    schema = _schema(CRM_SCHEMA_MAPPING_SCHEMA, strict=True)
    objects = []

    def inspect(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                objects.append(node)
            for child in node.values():
                inspect(child)
        elif isinstance(node, list):
            for child in node:
                inspect(child)

    inspect(schema)
    assert len(objects) >= 7
    assert all(
        node.get("additionalProperties") is False
        and set(node["required"]) == set(node.get("properties", {}))
        for node in objects
    )


async def test_untyped_object_gene_preserves_dynamic_keys_with_json_object_mode():
    adapter, client, _, _ = model([response(message('{"dynamic_key":{"value":42}}'))])
    results = [item async for item in adapter.generate_content_async(request(response_schema=dict))]
    assert client.requests[0]["text"]["format"] == {"type": "json_object"}
    assert json.loads(results[0].content.parts[0].text) == {"dynamic_key": {"value": 42}}


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
@pytest.mark.parametrize("managed", [True, False])
async def test_real_runner_migrates_gemini_fallback_tool_ids_without_guessing_pairs(
    matched, managed, monkeypatch
):
    from google.adk.agents import LlmAgent
    from google.adk.apps import App
    from google.adk.events import Event
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService

    adapter, client, _, token = model([response(message("Migrated synthetic history"))])
    if managed:
        from unittest.mock import AsyncMock

        from hushh_mcp.runtime_providers.managed_text import (
            ManagedPrimaryTextModel,
            managed_text_policy,
        )

        monkeypatch.setenv("ENVIRONMENT", "uat")
        monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
        adapter = ManagedPrimaryTextModel(
            **adapter.model_dump(exclude={"api_key", "client"}),
            token_supplier=token,
            client_factory=lambda **kwargs: client,
            require_current=AsyncMock(),
            fallback_model=SimpleNamespace(model="gemini"),
            policy_generation=managed_text_policy()["generation"],
            processing_scope="one_text_chat",
        )
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
    assert order[-3:] == ["token", "guard", "guard"]


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
async def test_managed_drive_fallback_targets_gemini_without_replaying_tools(monkeypatch, status):
    from unittest.mock import AsyncMock

    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    calls = []
    error = RuntimeError("synthetic outage")
    error.status_code = status

    async def azure(self, req, stream=False):
        calls.append(("azure", req.model))
        raise error
        yield

    async def gemini(req, stream=False):
        calls.append(("gemini", req.model))
        # Real Gemini non-stream responses do not set turn_complete.
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="Arbitrary topic result")])
        )

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    guard = AsyncMock()
    adapter, _, _, _ = model([])
    wrapped = managed.ManagedPrimaryTextModel(
        **adapter.model_dump(exclude={"api_key", "client"}),
        token_supplier=lambda: "synthetic",
        require_current=guard,
        fallback_model=SimpleNamespace(model="gemini-fallback", generate_content_async=gemini),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="drive_document_requests",
    )
    req = request(
        types.Content(role="user", parts=[types.Part(text="Arbitrary topic")]),
        types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(id="adk-existing", name="lookup", args={})
                )
            ],
        ),
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="adk-existing", name="lookup", response={"done": True}
                    )
                )
            ],
        ),
    )
    before = req.model_dump()
    result = [item async for item in wrapped.generate_content_async(req)]
    assert result[-1].content.parts[0].text == "Arbitrary topic result"
    assert calls == [("azure", "synthetic-deployment"), ("gemini", "gemini-fallback")]
    assert req.model_dump() == before
    assert guard.await_count == 3  # Each provider plus completion; no tool rerun.


@pytest.mark.parametrize(
    "failure",
    [
        PermissionError("revoked"),
        ValueError("invalid schema"),
        __import__(
            "hushh_mcp.runtime_providers.azure_adk", fromlist=["AzureAuthenticationError"]
        ).AzureAuthenticationError("auth"),
        SimpleNamespace(status_code=401),
        SimpleNamespace(status_code=403),
        SimpleNamespace(status_code=400),
    ],
)
async def test_managed_uat_denial_auth_configuration_never_falls_back(monkeypatch, failure):
    from unittest.mock import AsyncMock

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    if not isinstance(failure, Exception):
        error = RuntimeError("synthetic provider refusal")
        error.status_code = failure.status_code
    else:
        error = failure

    async def azure(self, req, stream=False):
        raise error
        yield

    fallback = Mock()
    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    wrapped = managed.ManagedPrimaryTextModel(
        model="synthetic",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic",
        require_current=AsyncMock(),
        fallback_model=SimpleNamespace(model="gemini", generate_content_async=fallback),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="drive_document_requests",
    )
    with pytest.raises(type(error)):
        _ = [item async for item in wrapped.generate_content_async(request())]
    fallback.assert_not_called()


async def test_managed_primary_success_partial_output_and_authority_fence(monkeypatch):
    from unittest.mock import AsyncMock

    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    fallback = Mock()
    guard = AsyncMock()
    wrapped = managed.ManagedPrimaryTextModel(
        model="synthetic",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic",
        require_current=guard,
        fallback_model=SimpleNamespace(model="gemini", generate_content_async=fallback),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="drive_document_requests",
    )

    async def azure(self, req, stream=False):
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="valid")]),
            turn_complete=True,
        )

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    assert len([item async for item in wrapped.generate_content_async(request())]) == 1
    fallback.assert_not_called()
    closed = []

    async def partial(self, req, stream=False):
        try:
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text="partial")]),
                partial=True,
            )
            raise TimeoutError
        finally:
            closed.append(True)

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", partial)
    with pytest.raises(TimeoutError):
        _ = [item async for item in wrapped.generate_content_async(request(), stream=True)]
    assert closed == [True]
    fallback.assert_not_called()
    guard.side_effect = PermissionError("revoked source")
    with pytest.raises(managed.ManagedTextAuthorityError):
        _ = [item async for item in wrapped.generate_content_async(request())]
    fallback.assert_not_called()


async def test_managed_invocation_guards_are_owner_local_and_policy_changes_block_send(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.adk_bridge import delegation
    from hushh_mcp.one_adk.request_secrets import store_request_secret
    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    adapter, client, factory, token = model([response(message("unused"))])
    wrapped = managed.ManagedPrimaryTextModel(
        **adapter.model_dump(exclude={"api_key", "client"}),
        token_supplier=token,
        client_factory=factory,
        fallback_model=SimpleNamespace(model="gemini"),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
    )
    agent = managed.managed_text_agent(name="one", model=wrapped)
    validator = AsyncMock(
        side_effect=lambda owner, credential, **kwargs: (
            object() if credential == f"synthetic-{owner}" else None
        )
    )
    monkeypatch.setattr(delegation, "validate_first_party_owner_token", validator)
    bound = await asyncio.gather(
        *(
            agent.canonical_model_async(
                SimpleNamespace(
                    state={
                        "hussh:user_id": owner,
                        "hussh:consent_token": store_request_secret(f"synthetic-{owner}"),
                    }
                )
            )
            for owner in ("owner-a", "owner-b")
        )
    )
    await asyncio.gather(*(item.require_current() for item in bound))
    assert validator.await_args_list[0].args != validator.await_args_list[1].args
    assert wrapped.require_current is None  # Shared model is only a template.
    with pytest.raises(managed.ManagedTextAuthorityError):
        _ = [item async for item in wrapped.generate_content_async(request())]
    original_policy = managed.managed_text_policy()
    token.side_effect = lambda: (
        monkeypatch.setattr(
            managed, "managed_text_policy", lambda: {**original_policy, "generation": "changed"}
        )
        or "synthetic"
    )
    with pytest.raises(managed.ManagedTextAuthorityError):
        _ = [item async for item in bound[0].generate_content_async(request())]
    assert client.requests == []  # Policy was rechecked after token acquisition.


async def test_managed_timeout_is_bounded_and_closed_before_single_fallback(monkeypatch):
    from unittest.mock import AsyncMock

    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    closed, calls = [], []

    async def blocked(self, req, stream=False):
        try:
            await asyncio.Event().wait()
            yield
        finally:
            closed.append(True)

    async def fallback(req, stream=False):
        calls.append(req.model)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="complete")]))

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", blocked)
    wrapped = managed.ManagedPrimaryTextModel(
        model="azure",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic",
        require_current=AsyncMock(),
        fallback_model=SimpleNamespace(model="gemini", generate_content_async=fallback),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="drive_document_requests",
        primary_seconds=0.01,
    )
    async with asyncio.timeout(1):
        assert len([item async for item in wrapped.generate_content_async(request())]) == 1
    assert closed == [True] and calls == ["gemini"]


async def test_managed_healthy_stream_can_finish_after_its_first_output_deadline(monkeypatch):
    from unittest.mock import AsyncMock

    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)

    async def healthy(self, req, stream=False):
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="first")]), partial=True
        )
        await asyncio.sleep(0.03)
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="complete")]),
            partial=False,
            turn_complete=True,
        )

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", healthy)
    fallback = Mock()
    wrapped = managed.ManagedPrimaryTextModel(
        model="azure",
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        token_supplier=lambda: "synthetic",
        require_current=AsyncMock(),
        fallback_model=SimpleNamespace(model="gemini", generate_content_async=fallback),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        primary_seconds=0.01,
    )
    result = [item async for item in wrapped.generate_content_async(request(), stream=True)]
    assert [item.partial for item in result] == [True, False]
    fallback.assert_not_called()


@pytest.mark.parametrize(
    ("status", "may_fallback"), [(429, True), (503, True), (401, False), (403, False)]
)
async def test_vertex_primary_uses_real_sdk_status_and_reports_only_actual_completion(
    monkeypatch, status, may_fallback
):
    from unittest.mock import AsyncMock

    from google.adk.models.llm_response import LlmResponse
    from google.genai import errors

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    calls, completed = [], []
    error_type = errors.ServerError if status >= 500 else errors.ClientError
    failure = error_type(
        status, {"error": {"code": status, "message": "Synthetic provider failure"}}
    )

    async def vertex(req, stream=False):
        calls.append("vertex")
        raise failure
        yield

    async def azure(self, req, stream=False):
        calls.append("azure_openai")
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="Ready")]))

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    base, *_ = model([])
    wrapped = managed.ManagedPrimaryTextModel(
        **base.model_dump(exclude={"api_key", "client"}),
        token_supplier=lambda: "synthetic",
        require_current=AsyncMock(),
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="drive_document_requests",
        primary_provider="vertex",
        fallback_model=SimpleNamespace(model="gemini-alternate", generate_content_async=vertex),
        completion_observer=completed.append,
    )
    if may_fallback:
        results = [item async for item in wrapped.generate_content_async(request())]
        assert results[-1].content.parts[0].text == "Ready"
        assert calls == ["vertex", "azure_openai"]
        assert completed == [
            {"provider": "azure_openai", "model": "synthetic-deployment", "location": ""}
        ]
    else:
        with pytest.raises(errors.APIError):
            [item async for item in wrapped.generate_content_async(request())]
        assert calls == ["vertex"]
        assert completed == []


async def test_azure_success_does_not_initialize_unused_alternate_and_revocation_has_no_output(
    monkeypatch,
):
    from google.adk.models.llm_response import LlmResponse

    from hushh_mcp.runtime_providers import managed_text as managed

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    revoked = False
    alternate = Mock(side_effect=AssertionError("Unused alternate initialized"))
    completed = []

    async def current():
        if revoked:
            raise PermissionError("Synthetic revocation")

    async def azure(self, req, stream=False):
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="Ready")]))

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", azure)
    base, *_ = model([])
    wrapped = managed.ManagedPrimaryTextModel(
        **base.model_dump(exclude={"api_key", "client"}),
        token_supplier=lambda: "synthetic",
        require_current=current,
        policy_generation=managed.managed_text_policy()["generation"],
        processing_scope="one_text_chat",
        fallback_factory=alternate,
        completion_observer=completed.append,
    )
    assert len([item async for item in wrapped.generate_content_async(request())]) == 1
    assert completed[0]["provider"] == "azure_openai"
    alternate.assert_not_called()

    async def revoked_before_completion(self, req, stream=False):
        nonlocal revoked
        revoked = True
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="Must not escape")])
        )

    monkeypatch.setattr(AzureOpenAIAdkModel, "generate_content_async", revoked_before_completion)
    completed.clear()
    received = []
    with pytest.raises(managed.ManagedTextAuthorityError):
        async for item in wrapped.generate_content_async(request()):
            received.append(item)
    assert received == completed == []
    alternate.assert_not_called()


async def test_generated_sdk_facade_preserves_schema_usage_and_streams_text_exactly_once():
    from hushh_mcp.runtime_providers.managed_azure_text import ManagedAzureTextClient

    complete = response(message('{"title":"Observed"}'))
    events = Stream(
        [
            {"type": "response.output_text.delta", "delta": '{"title":'},
            {"type": "response.output_text.delta", "delta": '"Observed"}'},
            {"type": "response.completed", "response": complete},
        ]
    )
    adapter, client, _, _ = model([complete, events])
    facade = ManagedAzureTextClient(model_factory=lambda *_args, **_kwargs: adapter)
    config = types.GenerateContentConfig(
        response_json_schema={
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
            "additionalProperties": False,
        }
    )
    from hushh_mcp.constants import GEMINI_MODEL

    answer = await facade.aio.models.generate_content(
        model=GEMINI_MODEL, contents="Synthetic", config=config
    )
    assert isinstance(answer, types.GenerateContentResponse)
    assert answer.parsed == {"title": "Observed"}
    assert (
        answer.model_version == "synthetic-version"
        and answer.usage_metadata.total_token_count == 20
    )
    stream = await facade.aio.models.generate_content_stream(
        model=GEMINI_MODEL, contents="Synthetic", config=config
    )
    chunks = [chunk async for chunk in stream]
    assert "".join(chunk.text or "" for chunk in chunks) == answer.text
    assert all(chunk.parsed is None for chunk in chunks[:-1])
    assert chunks[-1].parsed == answer.parsed and chunks[-1].usage_metadata == answer.usage_metadata
    assert events.closed and client.closed == 2


async def test_generated_sdk_facade_cancellation_closes_the_actual_transport():
    from hushh_mcp.constants import GEMINI_MODEL
    from hushh_mcp.runtime_providers.managed_azure_text import ManagedAzureTextClient

    events = Stream(blocked=True)
    adapter, client, _, _ = model([events])
    facade = ManagedAzureTextClient(model_factory=lambda *_args, **_kwargs: adapter)
    stream = await facade.aio.models.generate_content_stream(
        model=GEMINI_MODEL, contents="Synthetic"
    )
    task = asyncio.create_task(anext(stream))
    await events.started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert events.closed and client.closed == 1


async def test_admitted_inline_media_preserves_order_and_never_creates_provider_files():
    import base64

    adapter, client, _, _ = model([response(message("Read"))])
    pdf = b"%PDF-1.4\nsynthetic\n%%EOF"
    png = b"\x89PNG\r\n\x1a\nsynthetic"
    prompt = types.Content(
        role="user",
        parts=[
            types.Part(text="Before"),
            types.Part.from_bytes(data=pdf, mime_type="application/pdf"),
            types.Part(text="Between"),
            types.Part.from_bytes(data=png, mime_type="image/png"),
            types.Part.from_bytes(data=b"name,value\nsynthetic,1", mime_type="text/csv"),
            types.Part(text="After"),
        ],
    )
    _ = [item async for item in adapter.generate_content_async(request(prompt))]
    wire = client.requests[0]
    assert wire["store"] is False
    parts = wire["input"][0]["content"]
    assert [part["type"] for part in parts] == [
        "input_text",
        "input_file",
        "input_text",
        "input_image",
        "input_text",
        "input_text",
    ]
    assert (
        parts[0]["text"] == "Before"
        and parts[2]["text"] == "Between"
        and parts[-1]["text"] == "After"
    )
    assert parts[1]["file_data"] == "data:application/pdf;base64," + base64.b64encode(pdf).decode()
    assert "file_id" not in parts[1] and "file_url" not in parts[1]


async def test_native_search_requires_actual_completed_provider_citations_not_prompt_urls():
    from tests.test_azure_web_receipts import response as search_response

    raw = search_response()
    raw["model"] = "actual-azure-model"
    adapter, client, _, _ = model([raw, {**raw, "tool_usage": {}}])
    adapter.allow_web_search = True
    value = request(tools=[types.Tool(google_search=types.GoogleSearch())])
    (answer,) = [item async for item in adapter.generate_content_async(value)]
    assert [c.web.uri for c in answer.grounding_metadata.grounding_chunks] == [
        "https://example.test/team/owner"
    ]
    assert client.requests[0]["tools"] == [{"type": "web_search", "external_web_access": False}]
    with pytest.raises(ValueError, match="billable"):
        _ = [item async for item in adapter.generate_content_async(value)]


async def test_managed_embedding_contract_rejects_same_dimensions_with_bad_indices(monkeypatch):
    from hushh_mcp.runtime_providers import managed_azure as ports

    policy = {"provider": "azure_openai", "config_fingerprint": "f" * 64, "generation": "g"}
    monkeypatch.setattr(ports, "load_managed_runtime_policy", lambda: policy)
    binding = ports.ManagedAzureBinding(
        endpoint="https://synthetic.openai.azure.com/openai/v1/",
        tenant_id="synthetic",
        client_id="synthetic",
        policy_fingerprint=policy["config_fingerprint"],
        generation="g",
        token_supplier=lambda: "synthetic-token",
        capabilities={
            "embedding": {"deployment": "synthetic-embedding"},
            "embedding_dimensions": 768,
        },
    )

    class EmbeddingClient(Client):
        def __init__(self, outputs):
            super().__init__(outputs)
            self.embeddings = self

    vector = [1.0] + [0.0] * 767
    client = EmbeddingClient(
        [
            SimpleNamespace(
                data=[
                    SimpleNamespace(index=1, embedding=vector),
                    SimpleNamespace(index=0, embedding=vector),
                ]
            ),
            SimpleNamespace(
                data=[
                    SimpleNamespace(index=0, embedding=vector),
                    SimpleNamespace(index=0, embedding=vector),
                ]
            ),
        ]
    )

    def factory(**_kwargs):
        return client

    assert await ports.embed_texts(binding, ["one", "two"], timeout=1, client_factory=factory) == [
        vector,
        vector,
    ]
    with pytest.raises(ValueError, match="index"):
        await ports.embed_texts(binding, ["one", "two"], timeout=1, client_factory=factory)
    assert client.requests[0]["dimensions"] == 768
    policy["generation"] = "changed"
    with pytest.raises(RuntimeError, match="selection changed"):
        await ports.embed_texts(binding, ["one"], timeout=1, client_factory=factory)
    assert len(client.requests) == 2


async def test_actual_adk_search_child_uses_provider_aware_tool_and_received_citations():
    from hushh_mcp.hushh_adk.turn import run_specialist_adk_turn
    from hushh_mcp.one_adk.agent_tree import build_google_search_agent
    from tests.test_azure_web_receipts import response as search_response

    raw = search_response()
    raw["model"] = "actual-azure-version"
    adapter, client, _, _ = model([raw])
    adapter.allow_web_search = True
    agent = build_google_search_agent(model=adapter)
    observations = []

    async def observe(callback_context, llm_response):
        observations.append(llm_response.grounding_metadata)

    agent.after_model_callback = observe
    result = await run_specialist_adk_turn(
        agent=agent,
        app_name="synthetic_search",
        user_id="synthetic-public-reader",
        consent_token="",
        message="Search for a synthetic public page",
        max_llm_calls=1,
    )
    assert result.final_text == "Public team page confirms the owner [1]."
    assert observations[0].grounding_chunks[0].web.uri == "https://example.test/team/owner"
    assert client.requests[0]["tools"] == [{"type": "web_search", "external_web_access": False}]
