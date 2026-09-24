from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.events import Event, EventActions
from google.adk.sessions import Session
from google.genai import types

from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
from hushh_mcp.one_adk.external_read_boundary import (
    STATE_EXECUTION_SURFACE,
    STATE_EXTERNAL_READ,
    external_read_active,
)
from hushh_mcp.one_adk.external_read_projection import (
    durable_external_read_projection,
    redacted_read_receipt,
)


def _event(parts, *, author="one", invocation="read-turn"):
    return Event(author=author, invocation_id=invocation, content=types.Content(parts=parts))


def test_encrypted_roundtrip_redacts_tools_but_preserves_answers_and_continuation():
    session = Session(
        id="thread",
        app_name="one",
        user_id="owner",
        state={STATE_EXECUTION_SURFACE: "typed_chat", STATE_EXTERNAL_READ: "read-turn", "other": 1},
        events=[
            Event(author="user", invocation_id="read-turn"),
            _event([types.Part(text="USER REQUEST")], author="user"),
            _event(
                [
                    types.Part(
                        function_call=types.FunctionCall(
                            id="call", name="ask_email_agent", args={"request": "PRIVATE_QUERY"}
                        ),
                        thought_signature=b"\xff\x00\x81",
                    )
                ]
            ),
            _event(
                [
                    types.Part(
                        function_response=types.FunctionResponse(
                            id="call",
                            name="ask_email_agent",
                            response={
                                "text": "PRIVATE_TOOL_TEXT",
                                "structured": {
                                    "connector": "mail",
                                    "status": "ok",
                                    "sources": [
                                        {
                                            "source_ref": "mail:1",
                                            "kind": "metadata",
                                            "label": "PRIVATE_SUBJECT",
                                        }
                                    ],
                                    "metadata_only": True,
                                },
                            },
                        )
                    )
                ]
            ),
            _event(
                [types.Part(text="PRIVATE_REASONING", thought=True, thought_signature=b"opaque")]
            ),
            _event([types.Part(text="NORMAL ASSISTANT ANSWER")]),
        ],
    )
    session.events[2].actions = EventActions(state_delta={STATE_EXTERNAL_READ: "read-turn"})
    service = EncryptedAdkSessionService()
    encoded = service._encode(session)
    decoded = service._decode({f"payload_{key}": value for key, value in encoded.items()})
    durable = decoded.model_dump_json()
    assert "PRIVATE_" not in durable
    assert "USER REQUEST" in durable and "NORMAL ASSISTANT ANSWER" in durable
    assert STATE_EXECUTION_SURFACE not in durable and STATE_EXTERNAL_READ not in durable
    call = decoded.events[2].content.parts[0]
    assert call.function_call.name == "ask_email_agent" and call.function_call.id == "call"
    assert call.function_call.args == {} and call.thought_signature == b"\xff\x00\x81"
    response = decoded.events[3].content.parts[0].function_response
    assert response.id == "call" and response.response["content_redacted"] is True
    assert response.response["structured"]["sources"][0]["label"] == "Mail"
    assert decoded.events[4].content.parts[0].thought_signature == b"opaque"
    # The live SDK still sees the current result; only the durable copy changes.
    assert session.events[2].content.parts[0].function_call.args == {"request": "PRIVATE_QUERY"}
    assert session.state[STATE_EXTERNAL_READ] == "read-turn"


@pytest.mark.parametrize(
    "payload", [None, [], {"structured": {"connector": "mail", "extra": "PRIVATE"}}]
)
def test_malformed_receipts_are_replaced_not_copied(payload):
    assert redacted_read_receipt(payload) == {"content_redacted": True}


def test_unrelated_sessions_and_events_are_preserved():
    session = Session(id="thread", app_name="one", user_id="owner", events=[Event(author="one")])
    assert durable_external_read_projection(session) is session


@pytest.mark.parametrize("in_state", [False, True])
def test_mcp_approval_reference_is_never_durable_even_in_event_only(in_state):
    key = "temp:hussh:mcp_approval"
    reference = "one_secret_ref:private-reference"
    session = Session(
        id="thread",
        app_name="one",
        user_id="owner",
        state={key: reference} if in_state else {},
        events=[Event(author="one", actions=EventActions(state_delta={key: reference}))],
    )
    projected = durable_external_read_projection(session)
    assert reference not in projected.model_dump_json()
    assert key not in projected.model_dump_json()
    assert session.events[0].actions.state_delta[key] == reference


def test_selected_gmail_reply_context_and_draft_body_are_not_durable():
    session = Session(
        id="thread",
        app_name="one",
        user_id="owner",
        state={
            "temp:hussh:gmail_information_request_context": "PRIVATE_SOURCE_EMAIL",
            "temp:hussh:gmail_information_request_workflow_id": "workflow-1",
        },
        events=[
            _event(
                [
                    types.Part(
                        function_call=types.FunctionCall(
                            id="call",
                            name="open_gmail_information_request_reply",
                            args={"body": "PRIVATE_DRAFT_BODY"},
                        )
                    )
                ],
                invocation="draft-turn",
            ),
            _event(
                [
                    types.Part(
                        function_response=types.FunctionResponse(
                            id="call",
                            name="open_gmail_information_request_reply",
                            response={"message": "PRIVATE_DRAFT_BODY"},
                        )
                    )
                ],
                invocation="draft-turn",
            ),
        ],
    )

    durable = durable_external_read_projection(session)

    assert "PRIVATE_" not in durable.model_dump_json()
    assert durable.events[0].content.parts[0].function_call.args == {}
    assert durable.events[1].content.parts[0].function_response.response == {
        "content_redacted": True
    }
    assert session.events[0].content.parts[0].function_call.args == {"body": "PRIVATE_DRAFT_BODY"}


async def test_compare_and_swap_retry_preserves_live_guard_without_persisting_it(monkeypatch):
    service = EncryptedAdkSessionService()
    session = Session(
        id="thread",
        app_name="one",
        user_id="owner",
        state={STATE_EXTERNAL_READ: "read-turn", STATE_EXECUTION_SURFACE: "typed_chat"},
    )
    durable = Session(id="thread", app_name="one", user_id="owner", state={"concurrent": 1})
    service._set_revision(session, 1)
    service._set_revision(durable, 2)
    monkeypatch.setattr(
        service,
        "_execute",
        AsyncMock(
            side_effect=[
                SimpleNamespace(data=[]),
                SimpleNamespace(data=[{"revision": 3}]),
            ]
        ),
    )
    monkeypatch.setattr(service, "get_session", AsyncMock(return_value=durable))
    event = _event(
        [
            types.Part(
                function_response=types.FunctionResponse(
                    id="call", name="ask_email_agent", response={"text": "PRIVATE_RESULT"}
                )
            )
        ]
    )
    await service.append_event(session, event)
    assert external_read_active(SimpleNamespace(invocation_id="read-turn", state=session.state))
    assert session.state[STATE_EXECUTION_SURFACE] == "typed_chat"
    assert session.state["concurrent"] == 1
    for call in service._execute.call_args_list:
        encoded = call.args[1]
        decoded = service._decode(
            {f"payload_{key}": encoded[key] for key in ("ciphertext", "iv", "tag", "algorithm")}
        )
        assert STATE_EXTERNAL_READ not in decoded.state
        assert "PRIVATE_RESULT" not in decoded.model_dump_json()


async def test_history_exposes_receipt_once_on_final_answer_without_private_tool_payload(
    monkeypatch,
):
    from api.routes.one import agent_chat

    session = Session(
        id="thread",
        app_name="one",
        user_id="owner",
        events=[
            _event([types.Part(text="User request")], author="user"),
            _event([types.Part(text="I will check.")]),
            _event(
                [
                    types.Part(
                        function_response=types.FunctionResponse(
                            name="ask_email_agent",
                            response={
                                "text": "PRIVATE_BODY",
                                "provider_subject": "PRIVATE_ID",
                                "structured": {
                                    "connector": "mail",
                                    "status": "ok",
                                    "metadata_only": True,
                                    "sources": [
                                        {
                                            "source_ref": "mail:1",
                                            "label": "PRIVATE_NAME",
                                            "kind": "metadata",
                                        }
                                    ],
                                },
                            },
                        )
                    )
                ]
            ),
            _event([types.Part(text="PRIVATE_REASONING", thought=True)]),
            _event([types.Part(text="Visible answer")]),
        ],
    )
    get_session = AsyncMock(return_value=session)
    monkeypatch.setattr(agent_chat._session_service, "get_session", get_session)
    result = await agent_chat.conversation_history("thread", limit=50, token={"user_id": "owner"})
    assert "PRIVATE_" not in str(result)
    assert len(result["messages"]) == 3
    assert result["messages"][0]["metadata"] is None and result["messages"][1]["metadata"] is None
    assert result["messages"][2]["metadata"]["specialist_read"]["sources"][0]["label"] == "Mail"
    get_session.assert_awaited_once_with(
        app_name=agent_chat.ONE_APP_NAME, user_id="owner", session_id="thread"
    )
