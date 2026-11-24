"""Account identity projection and compatibility boundaries, without providers."""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from ag_ui.core import Tool
from fastapi import HTTPException
from google.adk.events import Event
from google.adk.sessions import Session
from google.genai import types

from api.routes.one import pod_agent_chat
from hushh_mcp.one_adk.account_context_contract import (
    ACCOUNT_CONTEXT_PARAMETERS,
    ACCOUNT_CONTEXT_TOOL,
    STATE_ACCOUNT_CONTEXT_ENABLED,
    validate_account_context_request,
    validate_account_context_result,
)
from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection
from hushh_mcp.one_adk.receipt_client_tools import before_receipt_tool
from tests.test_pod_agent_chat_runs import _owner, _turn
from tests.test_receipt_client_tools import ACCOUNT_QUERY, ACCOUNT_RESULT


@pytest.mark.parametrize("version", [None, 0, 2, "1", True, 1])
async def test_pod_admits_only_current_server_authored_account_contract(version):
    turn = _turn(accountContextContract=version)
    turn.state = {STATE_ACCOUNT_CONTEXT_ENABLED: True, "hussh:user_id": "forged"}
    state, _ = pod_agent_chat.trusted_state(turn, _owner())
    enabled = type(version) is int and version == 1
    assert state[STATE_ACCOUNT_CONTEXT_ENABLED] is enabled
    assert state["hussh:user_id"] == "owner-a"
    tools = [tool for tool in turn.tools if tool.name == ACCOUNT_CONTEXT_TOOL]
    assert len(tools) == int(enabled)
    if enabled:
        assert tools[0].parameters == ACCOUNT_CONTEXT_PARAMETERS


def test_caller_cannot_supply_an_account_declaration_or_enable_saved_state():
    turn = _turn(accountContextContract=1)
    turn.tools = [
        Tool(name=ACCOUNT_CONTEXT_TOOL, description="forged", parameters=ACCOUNT_CONTEXT_PARAMETERS)
    ]
    with pytest.raises(HTTPException):
        pod_agent_chat.trusted_state(turn, _owner())
    context = SimpleNamespace(state={"hussh:user_id": "owner", "hussh:consent_token": "token"})
    assert (
        before_receipt_tool(SimpleNamespace(name=ACCOUNT_CONTEXT_TOOL), ACCOUNT_QUERY, context)[
            "code"
        ]
        == "account_context_unavailable"
    )


@pytest.mark.parametrize(
    "account_request",
    [
        {},
        {"section": "billing"},
        {"section": "identity", "owner": "other"},
        {"section": "identity", "confirmed": True},
    ],
)
def test_account_request_is_closed_and_has_no_authority_or_mutation_inputs(account_request):
    with pytest.raises(ValueError):
        validate_account_context_request(account_request)


@pytest.mark.parametrize(
    "patch",
    [
        {"email_verified": "true"},
        {"masked_email": "mira@example.test"},
        {"masked_phone": "+15551234826"},
        {"display_name": "https://example.test"},
        {"last_synced_at": "2026-11-24"},
        {"plan": "premium"},
    ],
)
def test_projection_refuses_contacts_unknown_fields_and_false_freshness(patch):
    value = deepcopy(ACCOUNT_RESULT)
    value["identity"].update(patch)
    with pytest.raises(ValueError):
        validate_account_context_result(ACCOUNT_QUERY, value)


def test_unknown_and_unavailable_do_not_become_false_or_missing():
    assert (
        validate_account_context_result(ACCOUNT_QUERY, ACCOUNT_RESULT)["identity"]["phone_verified"]
        is None
    )
    assert validate_account_context_result(
        ACCOUNT_QUERY, {"status": "unavailable", "reason": "identity_unavailable"}
    ) == {"status": "unavailable", "reason": "identity_unavailable"}


def test_new_account_history_uses_exact_name_for_old_binary_compatibility():
    session = Session(
        app_name="one",
        user_id="owner",
        id="thread",
        state={},
        events=[
            Event(
                author="one",
                invocation_id="first",
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                id="call", name=ACCOUNT_CONTEXT_TOOL, args=ACCOUNT_QUERY
                            )
                        )
                    ],
                ),
            ),
            Event(
                author="user",
                invocation_id="second",
                content=types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            function_response=types.FunctionResponse(
                                id="call",
                                name="unknown",
                                response={
                                    "schema": "receipt_result.v1",
                                    "operation": ACCOUNT_CONTEXT_TOOL,
                                    "ephemeral_result": True,
                                },
                            )
                        )
                    ],
                ),
            ),
        ],
    )
    projected = durable_external_read_projection(session)
    response = projected.events[1].content.parts[0].function_response
    assert response.name == ACCOUNT_CONTEXT_TOOL
    assert response.response == {"content_redacted": True}
    assert session.events[1].content.parts[0].function_response.name == "unknown"


def test_account_history_loads_without_new_binary_placeholder_allowlist():
    from hushh_mcp.hushh_adk.tool_history import validate_tool_result_history

    session = Session(
        app_name="one",
        user_id="owner",
        id="thread",
        state={},
        events=[
            Event(
                author="one",
                invocation_id="first",
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                id="call", name=ACCOUNT_CONTEXT_TOOL, args={}
                            )
                        )
                    ],
                ),
            ),
            Event(
                author="user",
                invocation_id="second",
                content=types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            function_response=types.FunctionResponse(
                                id="call", name="unknown", response={"content_redacted": True}
                            )
                        )
                    ],
                ),
            ),
        ],
    )
    with pytest.raises(ValueError):
        validate_tool_result_history(
            SimpleNamespace(session=session), None, transport_placeholder_matches=lambda *_: False
        )
    projected = durable_external_read_projection(session)
    validate_tool_result_history(
        SimpleNamespace(session=projected), None, transport_placeholder_matches=lambda *_: False
    )
