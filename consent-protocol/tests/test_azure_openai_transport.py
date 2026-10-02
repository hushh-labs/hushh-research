"""The OpenAI-wire transport, driven through the real SDK against a fake HTTP server.

Every request here leaves the real ``AsyncOpenAI`` client and lands on an
``httpx.MockTransport`` that records it, so the assertions are about the bytes the
person's Azure OpenAI deployment would receive: the bearer the pod's own identity
minted, the v1 path on the rendered host, and the request body. Streamed answers are
replayed as server-sent events, which is the shape the SDK actually parses.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from hushh_mcp.runtime_providers import azure_openai
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.runtime_providers.azure_openai import AzureOpenAITopology
from hushh_mcp.runtime_providers.openai_transport import (
    BearerTokenUnavailable,
    OpenAITransport,
    _messages,
)
from hushh_mcp.runtime_providers.translate import to_neutral_request

HOST = "hussh-agent-test.openai.azure.com"
TOPOLOGY = AzureOpenAITopology(endpoint=f"https://{HOST}/", deployment="gpt-5-mini")
REPORTED_MODEL = "gpt-5-mini-2025-08-07"


class _Server:
    """A fake Azure OpenAI endpoint that records each request and replays a script."""

    def __init__(self, *responses: httpx.Response) -> None:
        self._responses = list(responses)
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._responses.pop(0)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    def body(self, index: int) -> dict[str, Any]:
        return json.loads(self.requests[index].content)


def _completion(text: str = "hi") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 1,
            "model": REPORTED_MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
        },
    )


def _chunk(delta: dict[str, Any], *, finish: str | None = None) -> dict[str, Any]:
    return {
        "id": "chatcmpl-2",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": REPORTED_MODEL,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


def _sse(*events: dict[str, Any]) -> httpx.Response:
    body = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, content=body.encode("utf-8")
    )


def _call_delta(index: int, *, call_id: str = "", name: str = "", arguments: str = "") -> dict:
    function: dict[str, Any] = {"arguments": arguments}
    if name:
        function["name"] = name
    delta: dict[str, Any] = {"index": index, "function": function}
    if call_id:
        delta.update({"id": call_id, "type": "function"})
    return delta


# Azure sends its prompt-filter verdict first, with no choices and no model.
_PROMPT_FILTER = {"id": "", "object": "", "created": 0, "model": "", "choices": []}


def _streamed_answer_with_two_tool_calls() -> httpx.Response:
    return _sse(
        _PROMPT_FILTER,
        _chunk({"role": "assistant", "content": "Let me "}),
        _chunk({"content": "check."}),
        _chunk({"tool_calls": [_call_delta(0, call_id="call_a", name="open_screen")]}),
        _chunk({"tool_calls": [_call_delta(0, arguments='{"scr')]}),
        _chunk({"tool_calls": [_call_delta(1, call_id="call_b", name="list_app_actions")]}),
        _chunk({"tool_calls": [_call_delta(0, arguments='een": "settings"}')]}),
        _chunk({"tool_calls": [_call_delta(1, arguments='{"limit": 3}')]}),
        _chunk({}, finish="tool_calls"),
    )


class _Tokens:
    """A workload token provider that rotates on every call, the way a refresh does."""

    def __init__(self, *tokens: str) -> None:
        self._tokens = list(tokens)
        self.calls = 0

    def __call__(self) -> str:
        self.calls += 1
        return self._tokens.pop(0)


def _contents(text: str = "open my settings") -> list[types.Content]:
    return [types.Content(role="user", parts=[types.Part.from_text(text=text)])]


def _azure(server: _Server, tokens: Any) -> Any:
    return azure_openai.build_owner_azure_transport(
        runtime_provider="azure_openai",
        runtime_mode="user_azure_mi",
        topology=TOPOLOGY,
        token_provider=tokens,
        http_client=server.client(),
    )


async def test_the_token_provider_is_asked_per_request_and_the_fresh_token_is_sent() -> None:
    server = _Server(_completion("one"), _completion("two"))
    tokens = _Tokens("token-before-refresh", "token-after-refresh")
    transport = _azure(server, tokens)

    first = await transport.aio.models.generate_content(
        model="gpt-5-mini", contents=_contents(), config=types.GenerateContentConfig()
    )
    second = await transport.aio.models.generate_content(
        model="gpt-5-mini", contents=_contents(), config=types.GenerateContentConfig()
    )

    assert (first.text, second.text) == ("one", "two")
    assert tokens.calls == 2, "one token per request; caching is the provider's job"
    assert [r.headers["authorization"] for r in server.requests] == [
        "Bearer token-before-refresh",
        "Bearer token-after-refresh",
    ]
    assert all(r.url.host == HOST for r in server.requests)
    assert all(r.url.path == "/openai/v1/chat/completions" for r in server.requests)
    assert server.body(0)["model"] == "gpt-5-mini", "the deployment name is the model"
    assert first.model_version == REPORTED_MODEL, "the provider-reported model is carried"


async def test_an_empty_token_refuses_before_anything_is_sent() -> None:
    server = _Server(_completion())
    transport = _azure(server, _Tokens("   "))

    with pytest.raises(BearerTokenUnavailable):
        await transport.aio.models.generate_content(
            model="gpt-5-mini", contents=_contents(), config=types.GenerateContentConfig()
        )
    assert server.requests == []


async def test_streamed_text_and_streamed_tool_calls_are_both_assembled() -> None:
    server = _Server(_streamed_answer_with_two_tool_calls())
    transport = _azure(server, _Tokens("t"))

    stream = await transport.aio.models.generate_content_stream(
        model="gpt-5-mini", contents=_contents(), config=types.GenerateContentConfig()
    )
    chunks = [chunk async for chunk in stream]

    assert "".join(chunk.text for chunk in chunks) == "Let me check."
    calls = [call for chunk in chunks for call in chunk.function_calls]
    assert [(c.id, c.name, c.args) for c in calls] == [
        ("call_a", "open_screen", {"screen": "settings"}),
        ("call_b", "list_app_actions", {"limit": 3}),
    ], "fragments are joined per index, and nothing is emitted before the stream ends"
    assert chunks[-1].function_calls and not chunks[-1].text
    assert all(chunk.model_version == REPORTED_MODEL for chunk in chunks)
    assert server.body(0)["stream"] is True


async def test_sampling_controls_are_withheld_for_a_deployment_and_kept_for_openai() -> None:
    config = types.GenerateContentConfig(temperature=0.2, max_output_tokens=64)
    azure_server = _Server(_completion())
    await _azure(azure_server, _Tokens("t")).aio.models.generate_content(
        model="gpt-5-mini", contents=_contents(), config=config
    )
    openai_server = _Server(_completion())
    await OpenAITransport(
        api_key="k", http_client=openai_server.client()
    ).aio.models.generate_content(model="gpt-5.1", contents=_contents(), config=config)

    assert "temperature" not in azure_server.body(0), "a reasoning deployment refuses it"
    assert azure_server.body(0)["max_completion_tokens"] == 64
    assert openai_server.body(0)["temperature"] == 0.2
    assert openai_server.requests[0].headers["authorization"] == "Bearer k"


def test_a_key_and_a_token_provider_are_mutually_exclusive_and_one_is_required() -> None:
    with pytest.raises(ValueError, match="never both"):
        OpenAITransport(api_key="k", token_provider=lambda: "t")
    with pytest.raises(ValueError, match="needs an API key or a token provider"):
        OpenAITransport()


async def test_the_tools_reach_the_wire_as_standard_json_schema() -> None:
    """ADK declares One's tools through ``parameters_json_schema``; a specialist uses a
    genai ``Schema``. Both must arrive as JSON Schema, never as an empty object."""

    from google.adk.tools.function_tool import FunctionTool

    def open_screen(screen: str) -> dict:
        """Open an app screen."""
        return {"ok": True}

    specialist = types.FunctionDeclaration(
        name="search_inbox",
        description="Search mail.",
        parameters=types.Schema(
            type=types.Type.OBJECT,
            properties={"limit": types.Schema(type=types.Type.INTEGER)},
            required=["limit"],
        ),
    )
    config = types.GenerateContentConfig(
        tools=[
            types.Tool(
                function_declarations=[FunctionTool(open_screen)._get_declaration(), specialist]
            )
        ]
    )
    server = _Server(_completion())
    await _azure(server, _Tokens("t")).aio.models.generate_content(
        model="gpt-5-mini", contents=_contents(), config=config
    )

    sent = {
        tool["function"]["name"]: tool["function"]["parameters"] for tool in server.body(0)["tools"]
    }
    assert sent["open_screen"]["properties"]["screen"]["type"] == "string"
    assert sent["open_screen"]["required"] == ["screen"]
    assert sent["search_inbox"] == {
        "type": "object",
        "properties": {"limit": {"type": "integer"}},
        "required": ["limit"],
    }


def test_a_narrated_turn_with_two_calls_reaches_the_wire_as_one_assistant_message() -> None:
    """Consecutive assistant messages after a tool call are refused by the API."""
    contents = [
        types.Content(role="user", parts=[types.Part.from_text(text="open settings")]),
        types.Content(
            role="model",
            parts=[
                types.Part.from_text(text="Checking."),
                types.Part(
                    function_call=types.FunctionCall(
                        id="call_a", name="open_screen", args={"screen": "settings"}
                    )
                ),
                types.Part(
                    function_call=types.FunctionCall(id="call_b", name="list_app_actions", args={})
                ),
            ],
        ),
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="call_a", name="open_screen", response={"ok": True}
                    )
                ),
                types.Part(
                    function_response=types.FunctionResponse(
                        id="call_b", name="list_app_actions", response={"actions": []}
                    )
                ),
            ],
        ),
    ]
    wire = _messages(to_neutral_request(contents, types.GenerateContentConfig()))

    assert [m["role"] for m in wire] == ["user", "assistant", "tool", "tool"]
    assistant = wire[1]
    assert assistant["content"] == "Checking."
    assert [call["id"] for call in assistant["tool_calls"]] == ["call_a", "call_b"]
    assert [m["tool_call_id"] for m in wire[2:]] == ["call_a", "call_b"]


def test_two_plain_assistant_messages_stay_two_negative_control() -> None:
    contents = [
        types.Content(role="model", parts=[types.Part.from_text(text="first")]),
        types.Content(role="model", parts=[types.Part.from_text(text="second")]),
    ]
    wire = _messages(to_neutral_request(contents, types.GenerateContentConfig()))
    assert wire == [
        {"role": "assistant", "content": "first"},
        {"role": "assistant", "content": "second"},
    ]


async def test_the_one_runner_gets_an_executable_tool_call_from_a_streamed_answer(
    monkeypatch,
) -> None:
    """End to end through the ADK adapter: the final, non-partial response carries the
    function call, which is the event ADK executes tools from."""
    server = _Server(_streamed_answer_with_two_tool_calls())
    real = azure_openai.build_owner_azure_transport

    def _with_fake_server(**kwargs: Any) -> Any:
        return real(
            **kwargs, topology=TOPOLOGY, token_provider=_Tokens("t"), http_client=server.client()
        )

    monkeypatch.setattr(azure_openai, "build_owner_azure_transport", _with_fake_server)
    model = ProviderAdkModel(
        model="gpt-5-mini", provider="azure_openai", credential="", runtime_mode="user_azure_mi"
    )
    request = LlmRequest(
        model="gpt-5-mini", contents=_contents(), config=types.GenerateContentConfig()
    )

    responses = [r async for r in model.generate_content_async(request, stream=True)]

    final = [r for r in responses if not r.partial]
    assert final, "the aggregator's closing response must exist"
    calls = [
        part.function_call
        for response in responses
        if not response.partial and response.content
        for part in response.content.parts or []
        if part.function_call
    ]
    assert [(c.name, c.args) for c in calls] == [
        ("open_screen", {"screen": "settings"}),
        ("list_app_actions", {"limit": 3}),
    ]


def test_the_adk_adapter_refuses_a_key_for_the_pods_own_identity() -> None:
    model = ProviderAdkModel(
        model="gpt-5-mini",
        provider="azure_openai",
        credential="sk-should-not-be-here",
        runtime_mode="user_azure_mi",
    )
    with pytest.raises(azure_openai.AzureOpenAIModeMismatch, match="API key"):
        model._client()
