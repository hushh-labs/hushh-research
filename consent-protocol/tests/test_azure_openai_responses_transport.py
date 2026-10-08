"""The person's Azure deployment over the Responses API, through the real SDK.

GPT-6 and GPT-5.6 refuse function tools with reasoning on Chat Completions (measured
26 of 26 on gpt-6-luna, 2026-10-03), and Microsoft's documented path for tools with
reasoning is the Responses API. Every request here leaves the real ``AsyncOpenAI``
client and lands on an ``httpx.MockTransport``, so the assertions are about the bytes
the deployment receives: the per-request bearer, the ``/openai/v1/responses`` path,
``store: false``, the reasoning effort the agent asked for, tool and history items,
and the usage the answer reports back.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from google.adk.models.llm_request import LlmRequest
from google.genai import types
from pydantic import BaseModel, ConfigDict

from hushh_mcp.runtime_providers import azure_openai
from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
from hushh_mcp.runtime_providers.azure_openai import AzureOpenAITopology

HOST = "hussh-agent-test.openai.azure.com"
TOPOLOGY = AzureOpenAITopology(endpoint=f"https://{HOST}/", deployment="gpt-6-luna")
REPORTED_MODEL = "gpt-6-luna-2026-09-22"
USAGE = {
    "input_tokens": 120,
    "input_tokens_details": {"cached_tokens": 100},
    "output_tokens": 30,
    "output_tokens_details": {"reasoning_tokens": 12},
    "total_tokens": 150,
}


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

    def body(self, index: int = 0) -> dict[str, Any]:
        return json.loads(self.requests[index].content)


def _response(*output: dict[str, Any], usage: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": "resp_1",
        "object": "response",
        "created_at": 1,
        "model": REPORTED_MODEL,
        "status": "completed",
        "output": list(output),
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": usage if usage is not None else USAGE,
    }


def _message(text: str) -> dict[str, Any]:
    return {
        "type": "message",
        "id": "msg_1",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def _call(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function_call",
        "id": f"fc_{call_id}",
        "call_id": call_id,
        "name": name,
        "arguments": json.dumps(arguments),
        "status": "completed",
    }


def _encrypted_reasoning() -> dict[str, Any]:
    return {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "opaque"}


def _json(*output: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json=_response(*output))


def _sse(*events: dict[str, Any]) -> httpx.Response:
    body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, content=body.encode("utf-8")
    )


def _streamed_answer_with_two_tool_calls() -> httpx.Response:
    created = {**_response(usage={}), "status": "in_progress", "output": []}
    created.pop("usage")
    return _sse(
        {"type": "response.created", "sequence_number": 0, "response": created},
        {"type": "response.output_item.done", "sequence_number": 1, "output_index": 0,
         "item": _encrypted_reasoning()},
        {"type": "response.output_text.delta", "sequence_number": 2, "item_id": "msg_1",
         "output_index": 1, "content_index": 0, "delta": "Let me "},
        {"type": "response.output_text.delta", "sequence_number": 3, "item_id": "msg_1",
         "output_index": 1, "content_index": 0, "delta": "check."},
        {"type": "response.output_item.done", "sequence_number": 4, "output_index": 2,
         "item": _call("call_a", "open_screen", {"screen": "settings"})},
        {"type": "response.output_item.done", "sequence_number": 5, "output_index": 3,
         "item": _call("call_b", "list_app_actions", {"limit": 3})},
        {"type": "response.completed", "sequence_number": 6, "response": _response()},
    )  # fmt: skip


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


def _azure(server: _Server, tokens: Any = None) -> Any:
    return azure_openai.build_owner_azure_transport(
        runtime_provider="azure_openai",
        runtime_mode="user_azure_mi",
        topology=TOPOLOGY,
        token_provider=tokens or _Tokens("t"),
        http_client=server.client(),
    )


async def _send(config: types.GenerateContentConfig, contents: Any = None) -> _Server:
    server = _Server(_json(_message("ok")))
    await _azure(server).aio.models.generate_content(
        model="gpt-6-luna", contents=contents or _contents(), config=config
    )
    return server


async def test_each_request_is_stateless_on_the_responses_path_with_a_fresh_token() -> None:
    server = _Server(_json(_message("one")), _json(_message("two")))
    tokens = _Tokens("token-before-refresh", "token-after-refresh")
    transport = _azure(server, tokens)
    config = types.GenerateContentConfig(system_instruction="You are One.")

    first = await transport.aio.models.generate_content(
        model="gpt-6-luna", contents=_contents(), config=config
    )
    second = await transport.aio.models.generate_content(
        model="gpt-6-luna", contents=_contents(), config=config
    )

    assert (first.text, second.text) == ("one", "two")
    assert [r.headers["authorization"] for r in server.requests] == [
        "Bearer token-before-refresh",
        "Bearer token-after-refresh",
    ]
    assert all(r.url.host == HOST for r in server.requests)
    assert all(r.url.path == "/openai/v1/responses" for r in server.requests)
    body = server.body(0)
    assert body["store"] is False, "the model host must keep nothing between calls"
    assert body["model"] == "gpt-6-luna" and body["instructions"] == "You are One."
    assert body["input"] == [{"role": "user", "content": "open my settings"}]
    assert first.model_version == REPORTED_MODEL


async def test_tools_reach_the_wire_as_responses_function_tools() -> None:
    from google.adk.tools.function_tool import FunctionTool

    def open_screen(screen: str) -> dict:
        """Open an app screen."""
        return {"ok": True}

    config = types.GenerateContentConfig(
        tools=[types.Tool(function_declarations=[FunctionTool(open_screen)._get_declaration()])]
    )
    body = (await _send(config)).body()

    [tool] = body["tools"]
    assert tool["type"] == "function" and tool["name"] == "open_screen"
    assert tool["parameters"]["properties"]["screen"]["type"] == "string"
    assert tool["strict"] is False and body["tool_choice"] == "auto"


async def test_the_agents_thinking_level_becomes_the_reasoning_effort() -> None:
    low = types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)
    )
    off = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_budget=0))

    assert (await _send(low)).body()["reasoning"] == {"effort": "low"}
    assert (await _send(off)).body()["reasoning"] == {"effort": "none"}


async def test_no_reasoning_is_sent_when_the_agent_asked_for_none_negative_control() -> None:
    body = (await _send(types.GenerateContentConfig(temperature=0.2))).body()
    assert "reasoning" not in body, "the deployment's own default effort applies"
    assert "temperature" not in body, "a reasoning deployment refuses sampling controls"


async def test_a_tool_round_trip_replays_as_call_and_output_items_without_item_ids() -> None:
    contents = [
        types.Content(role="user", parts=[types.Part.from_text(text="open settings")]),
        types.Content(
            role="model",
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id="call_a", name="open_screen", args={"screen": "settings"}
                    )
                )
            ],
        ),
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="call_a", name="open_screen", response={"ok": True}
                    )
                )
            ],
        ),
    ]
    body = (await _send(types.GenerateContentConfig(), contents)).body()

    assert body["input"] == [
        {"role": "user", "content": "open settings"},
        {
            "type": "function_call",
            "call_id": "call_a",
            "name": "open_screen",
            "arguments": '{"screen":"settings"}',
        },
        {"type": "function_call_output", "call_id": "call_a", "output": '{"ok":true}'},
    ], "no item ids: they would reference stored items stateless mode never kept"


async def test_a_full_answer_carries_its_calls_and_usage() -> None:
    server = _Server(
        _json(_encrypted_reasoning(), _call("call_a", "open_screen", {"screen": "settings"}))
    )
    answer = await _azure(server).aio.models.generate_content(
        model="gpt-6-luna", contents=_contents(), config=types.GenerateContentConfig()
    )

    assert [(c.id, c.name, c.args) for c in answer.function_calls] == [
        ("call_a", "open_screen", {"screen": "settings"})
    ]
    assert answer.text == "", "an encrypted reasoning item is never surfaced as text"
    assert answer.usage is not None
    assert (answer.usage.input_tokens, answer.usage.output_tokens) == (120, 30)
    assert (answer.usage.cached_input_tokens, answer.usage.reasoning_tokens) == (100, 12)


async def test_the_one_runner_gets_executable_calls_and_usage_from_a_streamed_answer(
    monkeypatch,
) -> None:
    """End to end through the ADK adapter: the closing, non-partial response carries
    every function call (the event ADK executes tools from) and the token usage."""
    server = _Server(_streamed_answer_with_two_tool_calls())
    real = azure_openai.build_owner_azure_transport

    def _with_fake_server(**kwargs: Any) -> Any:
        return real(
            **kwargs, topology=TOPOLOGY, token_provider=_Tokens("t"), http_client=server.client()
        )

    monkeypatch.setattr(azure_openai, "build_owner_azure_transport", _with_fake_server)
    model = ProviderAdkModel(
        model="gpt-6-luna", provider="azure_openai", credential="", runtime_mode="user_azure_mi"
    )
    request = LlmRequest(
        model="gpt-6-luna", contents=_contents(), config=types.GenerateContentConfig()
    )

    responses = [r async for r in model.generate_content_async(request, stream=True)]

    final = [r for r in responses if not r.partial]
    assert final, "the aggregator's closing response must exist"
    calls = [
        part.function_call
        for response in final
        if response.content
        for part in response.content.parts or []
        if part.function_call
    ]
    assert [(c.name, c.args) for c in calls] == [
        ("open_screen", {"screen": "settings"}),
        ("list_app_actions", {"limit": 3}),
    ]
    usage = final[-1].usage_metadata
    assert usage is not None and usage.prompt_token_count == 120
    assert (usage.candidates_token_count, usage.thoughts_token_count) == (30, 12)
    assert server.body()["stream"] is True and server.body()["store"] is False


class _Answer(BaseModel):
    """A schema-constrained gene's output, the shape ADK passes as ``output_schema``."""

    model_config = ConfigDict(extra="forbid")
    title: str
    tags: list[str] = []


async def test_an_output_schema_reaches_the_wire_as_a_text_format() -> None:
    config = types.GenerateContentConfig(
        response_mime_type="application/json", response_schema=_Answer
    )
    body = (await _send(config)).body()

    fmt = body["text"]["format"]
    assert fmt["type"] == "json_schema" and fmt["name"] == "Answer"
    assert fmt["strict"] is False and fmt["schema"] == _Answer.model_json_schema()


async def test_no_text_format_is_sent_when_no_schema_was_asked_negative_control() -> None:
    assert "text" not in (await _send(types.GenerateContentConfig())).body()
