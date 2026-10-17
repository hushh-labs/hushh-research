"""Tool turns on the person's Azure model: results that carry dates, the agent's tool
mode, and names the wire refuses.

Live, 2026-10-05: the first Azure tool turn recalled two memories and then ended in
`TypeError` on the next model call, because a recall result carries datetimes and
the tool output was serialized with plain `json.dumps`.
"""

from __future__ import annotations

import datetime
import json
from typing import Any

import httpx
import pytest

from hushh_mcp.runtime_providers.openai_responses_transport import (
    OpenAIResponsesTransport,
    wire_name,
)
from hushh_mcp.runtime_providers.openai_transport import tool_json
from hushh_mcp.runtime_providers.translate import NeutralMessage, NeutralRequest, NeutralTool

LONG = "hussh_action_" + "b25ib2FyZGluZy5jbGFpbV9vbmVfd2l0aF9hX3ZlcnlfbG9uZ19pZA" + "x" * 12
RECALLED_AT = datetime.datetime(2026, 10, 5, 9, 41, 4, tzinfo=datetime.timezone.utc)


def _transport(server: list[dict[str, Any]], reply: dict[str, Any]) -> OpenAIResponsesTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        server.append(json.loads(request.content))
        return httpx.Response(200, json=reply)

    return OpenAIResponsesTransport(
        "k",
        base_url="https://hussh-agent-test.openai.azure.com/openai/v1/",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
    )


def _reply(*output: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "resp_1",
        "object": "response",
        "created_at": 1,
        "model": "gpt-5.6-luna",
        "status": "completed",
        "output": list(output),
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
    }


def _tool(name: str) -> NeutralTool:
    return NeutralTool(name=name, description="d", json_schema={"type": "object"})


def test_a_recall_result_with_dates_and_bytes_reaches_the_model():
    result = {"hits": [{"text": "likes tea", "at": RECALLED_AT, "blob": b"\x00\x01"}]}
    wire = json.loads(tool_json(result))
    assert wire == {"hits": [{"text": "likes tea", "at": RECALLED_AT.isoformat(), "blob": "AAE="}]}


async def test_the_live_failure_turn_now_sends_its_tool_output():
    sent: list[dict[str, Any]] = []
    request = NeutralRequest(
        messages=(
            NeutralMessage(role="user", text="What do you remember about me?"),
            NeutralMessage(role="assistant", tool_name="recall", tool_call_id="call_1"),
            NeutralMessage(
                role="tool",
                tool_name="recall",
                tool_call_id="call_1",
                tool_result={"hits": [{"at": RECALLED_AT}]},
            ),
        ),
        tools=(_tool("recall"),),
    )
    transport = _transport(sent, _reply())
    await transport._generate(request, model="one-chat")
    [output] = [i for i in sent[0]["input"] if i.get("type") == "function_call_output"]
    assert json.loads(output["output"]) == {"hits": [{"at": RECALLED_AT.isoformat()}]}


@pytest.mark.parametrize(
    ("choice", "allowed", "expected_choice", "expected_tools"),
    [
        (None, (), "auto", ["recall", "save"]),
        ("none", (), "none", ["recall", "save"]),
        ("any", (), "required", ["recall", "save"]),
        ("any", ("save",), "required", ["save"]),
    ],
)
def test_the_agents_tool_mode_is_honoured(choice, allowed, expected_choice, expected_tools):
    request = NeutralRequest(
        messages=(NeutralMessage(role="user", text="hi"),),
        tools=(_tool("recall"), _tool("save")),
        tool_choice=choice,
        allowed_function_names=allowed,
    )
    kwargs = _transport([], _reply())._request_kwargs(request, model="one-chat")
    assert kwargs["tool_choice"] == expected_choice
    assert [t["name"] for t in kwargs["tools"]] == expected_tools


def test_a_name_the_wire_refuses_is_aliased_stably():
    alias = wire_name(LONG)
    assert len(LONG) > 64 and len(alias) == 64
    assert alias == wire_name(LONG)
    assert wire_name("recall") == "recall"
    assert wire_name("has space") != "has space" and " " not in wire_name("has space")


async def test_a_call_to_an_aliased_tool_comes_back_under_its_own_name():
    sent: list[dict[str, Any]] = []
    call = {
        "type": "function_call",
        "id": "fc_1",
        "call_id": "call_9",
        "name": wire_name(LONG),
        "arguments": "{}",
        "status": "completed",
    }
    request = NeutralRequest(
        messages=(NeutralMessage(role="user", text="go"),), tools=(_tool(LONG), _tool("recall"))
    )
    response = await _transport(sent, _reply(call))._generate(request, model="one-chat")
    assert [t["name"] for t in sent[0]["tools"]] == [wire_name(LONG), "recall"]
    assert [c.name for c in response.function_calls] == [LONG]


def test_a_gemini_thought_in_history_never_becomes_assistant_text():
    from google.genai import types

    from hushh_mcp.runtime_providers.translate import to_neutral_request

    history = [
        types.Content(
            role="model",
            parts=[
                types.Part(text="PRIVATE THOUGHT SUMMARY", thought=True),
                types.Part(text="answer"),
            ],
        )
    ]
    request = to_neutral_request(history, types.GenerateContentConfig())
    assert [m.text for m in request.messages] == ["answer"]
