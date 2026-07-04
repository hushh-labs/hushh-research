"""Tests for the propose_sos_panic tool and its sos_panic client-action directive.

Covers:
  1. propose_sos_panic is present in V2_LOCATION_TOOLS.
  2. propose_sos_panic appears in the v2 function declarations (LLM can call it).
  3. Calling the tool returns {"proposed": "sos_panic"}.
  4. _directive_from_tool maps a propose_sos_panic result to {"type": "sos_panic"}.
  5. _build_client_action folds a sos_panic directive into a client action with
     type == "sos_panic", a non-empty summary, and an id.
  6. propose_sos_panic is in _QUERY_TOOL_NAMES (so stateChanged stays False).
  7. End-to-end: handle_turn emits a sos_panic clientAction when the tool fires.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from google.genai import types

from hushh_mcp.agents.location.tools import V2_LOCATION_TOOLS, propose_sos_panic
from hushh_mcp.services.location_chat_service import (
    _QUERY_TOOL_NAMES,
    LocationChatService,
    _function_declarations_v2,
)

# ---------------------------------------------------------------------------
# Helpers shared with test_location_chat_service_v2 pattern
# ---------------------------------------------------------------------------


class _Turn:
    def __init__(self, conversation_id, history):
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self):
        self.added: list[dict] = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", [])

    async def add_message(
        self, *, conversation_id, user_id, role, content, status, model=None, metadata=None
    ):
        self.added.append(
            {"role": role, "content": content, "status": status, "metadata": metadata}
        )


def _fake_tool(name, recorder, *, result):
    async def _impl(**kwargs):
        recorder.append({"name": name, "args": kwargs})
        return result

    _impl._name = name
    _impl._hushh_tool = True
    return _impl


def _fc_response(name, args):
    return SimpleNamespace(
        function_calls=[SimpleNamespace(name=name, args=args)],
        text="",
        candidates=[
            SimpleNamespace(content=types.Content(role="model", parts=[types.Part(text="")]))
        ],
    )


def _text_response(text):
    return SimpleNamespace(function_calls=[], text=text, candidates=[])


def _scripted(responses):
    seq = iter(responses)

    async def _call(contents, config):
        return next(seq)

    return _call


def _service(store, responses, tools):
    return LocationChatService(
        chat_store=store,
        model_call=_scripted(responses),
        genai_types=types,
        ready=lambda: True,
        tools=tools,
        system_prompt="test",
    )


# ---------------------------------------------------------------------------
# Test 1: propose_sos_panic is in V2_LOCATION_TOOLS
# ---------------------------------------------------------------------------


def test_propose_sos_panic_in_v2_location_tools():
    assert propose_sos_panic in V2_LOCATION_TOOLS, (
        "propose_sos_panic must be in V2_LOCATION_TOOLS so the LLM can call it"
    )


# ---------------------------------------------------------------------------
# Test 2: propose_sos_panic appears in v2 function declarations
# ---------------------------------------------------------------------------


def test_propose_sos_panic_in_function_declarations_v2():
    decls = _function_declarations_v2(types)
    names = [d.name for d in decls]
    assert "propose_sos_panic" in names, (
        "propose_sos_panic must have a FunctionDeclaration so the LLM can invoke it"
    )


# ---------------------------------------------------------------------------
# Test 3: Calling the tool returns {"proposed": "sos_panic"}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_propose_sos_panic_returns_proposed_sos_panic():
    """The tool must return {"proposed": "sos_panic"} (coordinate-free).

    Uses .__wrapped__ to bypass @hushh_tool token/scope check (same pattern as
    test_location_chat_tools_behavior.py for propose_public_link).
    """
    from hushh_mcp.hushh_adk.context import HushhContext

    with HushhContext(user_id="u-test", consent_token="t", vault_keys={}):  # noqa: S106
        result = await propose_sos_panic.__wrapped__()
    assert result == {"proposed": "sos_panic"}


# ---------------------------------------------------------------------------
# Test 4: _directive_from_tool maps propose_sos_panic -> {"type": "sos_panic"}
# ---------------------------------------------------------------------------


def test_directive_from_tool_sos_panic():
    directive = LocationChatService._directive_from_tool(
        "propose_sos_panic", {"proposed": "sos_panic"}
    )
    assert directive == {"type": "sos_panic"}


def test_directive_from_tool_sos_panic_bad_result_returns_none():
    # If the result doesn't have proposed == "sos_panic" (e.g. an error), no directive.
    directive = LocationChatService._directive_from_tool(
        "propose_sos_panic", {"error": "consent_denied"}
    )
    assert directive is None


# ---------------------------------------------------------------------------
# Test 5: _build_client_action folds sos_panic directive into client action
# ---------------------------------------------------------------------------


def test_build_client_action_sos_panic():
    svc = LocationChatService.__new__(LocationChatService)
    action = svc._build_client_action([{"type": "sos_panic"}])
    assert action is not None
    assert action["type"] == "sos_panic"
    assert action["id"].startswith("act-")
    assert action["summary"]  # non-empty


# ---------------------------------------------------------------------------
# Test 6: propose_sos_panic is in _QUERY_TOOL_NAMES (no stateChanged flag)
# ---------------------------------------------------------------------------


def test_propose_sos_panic_is_query_tool():
    assert "propose_sos_panic" in _QUERY_TOOL_NAMES, (
        "propose_sos_panic must be in _QUERY_TOOL_NAMES so stateChanged stays False"
    )


# ---------------------------------------------------------------------------
# Test 7: End-to-end handle_turn emits sos_panic clientAction
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handle_turn_emits_sos_panic_client_action():
    store = _FakeStore()
    calls: list[dict] = []
    tools = [_fake_tool("propose_sos_panic", calls, result={"proposed": "sos_panic"})]
    svc = _service(
        store,
        responses=[
            _fc_response("propose_sos_panic", {}),
            _text_response("SOS sent to your trusted contacts."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(
        user_id="u",
        message="SOS! I need help!",
        consent_token="t",  # noqa: S106
    )

    action = out["clientAction"]
    assert action["type"] == "sos_panic"
    assert action["id"].startswith("act-")
    assert action["summary"]
    # propose_* tools are in _QUERY_TOOL_NAMES — no server-side mutation
    assert out["stateChanged"] is False
