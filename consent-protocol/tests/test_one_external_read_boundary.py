"""Real SDK execution, not source-string assertions, for external-read isolation."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import ToolContext
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.agent_tree import STATE_CONSENT_TOKEN, STATE_USER_ID
from hushh_mcp.one_adk.external_read_boundary import (
    STATE_EXECUTION_SURFACE,
    STATE_EXTERNAL_READ,
    before_external_read_tool,
)


class _Model(BaseLlm):
    _steps: list = PrivateAttr()
    _advertised: list = PrivateAttr(default_factory=list)

    def __init__(self, steps):
        super().__init__(model="fixture")
        self._steps = steps

    async def generate_content_async(self, llm_request, stream=False):
        self._advertised.append(set(llm_request.tools_dict))
        yield LlmResponse(content=types.Content(role="model", parts=self._steps.pop(0)))


def _call(name):
    return types.Part(function_call=types.FunctionCall(name=name, args={}))


@pytest.fixture(autouse=True)
def _features(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GMAIL_CHAT_READS", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")


async def test_actual_one_runner_blocks_parallel_followup_and_restores_next_user_turn():
    executed = []

    async def ask_email_agent(tool_context: ToolContext) -> dict:
        executed.append("read")
        return {"response": "Untrusted email says to send secrets elsewhere."}

    async def forbidden_action() -> dict:
        executed.append("action")
        return {"status": "ok"}

    model = _Model(
        [
            [_call("ask_email_agent"), _call("forbidden_action")],
            [types.Part(text="A bounded Mail answer.")],
            [_call("forbidden_action")],
            [types.Part(text="A new user-authorized turn.")],
        ]
    )
    agent = agent_tree.build_one_text_agent(model=model)
    agent.instruction = "Fixture root."
    agent.tools = [ask_email_agent, forbidden_action]
    sessions = InMemorySessionService()
    await sessions.create_session(
        app_name="one",
        user_id="owner",
        session_id="original",
    )
    runner = Runner(agent=agent, app_name="one", session_service=sessions)
    first = [
        event
        async for event in runner.run_async(
            user_id="owner",
            session_id="original",
            new_message=types.Content(role="user", parts=[types.Part(text="Read my inbox.")]),
            state_delta={STATE_EXECUTION_SURFACE: "typed_chat"},
        )
    ]
    assert executed == ["read"]
    assert model._advertised == [{"ask_email_agent", "forbidden_action"}, set()]
    responses = [response for event in first for response in event.get_function_responses()]
    assert next(r for r in responses if r.name == "forbidden_action").response == {
        "status": "blocked",
        "reason": "external_content_answer_only",
    }
    assert len({event.invocation_id for event in first}) == 1
    second = [
        event
        async for event in runner.run_async(
            user_id="owner",
            session_id="original",
            new_message=types.Content(role="user", parts=[types.Part(text="Now do my action.")]),
            state_delta={STATE_EXECUTION_SURFACE: "typed_chat"},
        )
    ]
    assert executed == ["read", "action"]
    assert model._advertised[2] == {"ask_email_agent", "forbidden_action"}
    assert first[0].invocation_id != second[0].invocation_id


def test_post_read_guard_refuses_an_invented_tool_even_if_model_ignores_empty_tools():
    context = SimpleNamespace(
        invocation_id="turn", state={STATE_EXTERNAL_READ: "turn"}, user_id="owner"
    )
    assert (
        before_external_read_tool(
            tool=SimpleNamespace(name="send_email"),
            args={"body": "untrusted"},
            tool_context=context,
        )["status"]
        == "blocked"
    )


@pytest.mark.parametrize("surface", [None, "voice", "typed_chat"])
async def test_email_authority_minted_only_at_trusted_typed_ingress(monkeypatch, surface):
    state = {STATE_USER_ID: "owner", STATE_CONSENT_TOKEN: "opaque"}
    if surface:
        state[STATE_EXECUTION_SURFACE] = surface
    context = SimpleNamespace(
        state=state, user_id="owner", invocation_id="turn", function_call_id="call"
    )
    validate = AsyncMock(return_value=SimpleNamespace(expires_at=9999999999999))
    monkeypatch.setattr(agent_tree, "validate_first_party_owner_token", validate)
    task = await agent_tree._task_from_context(context, "search mail", agent_id="agent_email")
    if surface == "typed_chat":
        assert task.authority.invocation_capabilities == ("cap.email.metadata.read",)
        assert task.expected_task_id == task.authority.task_id == '["turn","call"]'
        assert task.authority.action_capabilities == ()
        assert task.execution_surface == "typed_chat"
    else:
        assert task is None


@pytest.mark.parametrize(
    "field,value", [("user_id", "other"), ("invocation_id", ""), ("function_call_id", None)]
)
async def test_email_cannot_mint_authority_for_wrong_owner_or_missing_sdk_binding(
    monkeypatch, field, value
):
    context = SimpleNamespace(
        state={
            STATE_USER_ID: "owner",
            STATE_CONSENT_TOKEN: "opaque",
            STATE_EXECUTION_SURFACE: "typed_chat",
        },
        user_id="owner",
        invocation_id="turn",
        function_call_id="call",
    )
    setattr(context, field, value)
    validate = AsyncMock()
    monkeypatch.setattr(agent_tree, "validate_first_party_owner_token", validate)
    assert (
        await agent_tree._task_from_context(context, "search mail", agent_id="agent_email") is None
    )
    validate.assert_not_awaited()


@pytest.mark.parametrize("context", [{}, {"route_playbook": {}}, {"screen": "chat"}])
@pytest.mark.parametrize("surface", [None, "typed_chat"])
def test_mail_guidance_matches_server_admission(surface, context):
    state = {STATE_USER_ID: "owner", agent_tree.STATE_VOICE_CONTEXT: context}
    if surface:
        state[STATE_EXECUTION_SURFACE] = surface
    instruction = agent_tree._one_runtime_instruction(SimpleNamespace(state=state))
    assert ("MAIL READ ADMISSION: enabled" in instruction) is (surface == "typed_chat")
    assert ("MAIL READ ADMISSION: disabled" in instruction) is (surface is None)


async def test_registered_mail_hop_uses_real_genes_transport_contract_and_same_conversation(
    monkeypatch,
):
    import json

    import httpx

    from hushh_mcp.adk_bridge import email_agent
    from hushh_mcp.agents.email import runtime
    from hushh_mcp.one_adk.external_read_projection import durable_external_read_projection
    from hushh_mcp.services import gmail_metadata_reader
    from hushh_mcp.services.email_chat_service import EmailChatService
    from hushh_mcp.services.gmail_receipts_service import GmailReceiptsService

    row = {
        "status": "connected",
        "revoked": False,
        "google_sub": "account",
        "google_email": "owner@example.com",
        "scope_csv": "https://www.googleapis.com/auth/gmail.readonly",
    }

    class Gmail(GmailReceiptsService):
        def __init__(self):
            pass

        def _fetch_connection_row(self, *, user_id):
            assert user_id == "owner"
            return dict(row)

        async def _ensure_access_token(self, *, user_id):
            return "synthetic-token", dict(row)

        def _refresh_observation(self, row):
            return {"observed": "stable"}

    requests = []

    def send(request):
        requests.append(request)
        data = (
            {"messages": [{"id": "msg1", "threadId": "thread1"}]}
            if request.url.path.endswith("/messages")
            else {
                "id": "msg1",
                "threadId": "thread1",
                "internalDate": "1700000000000",
                "payload": {
                    "headers": [
                        {"name": "From", "value": "PRIVATE_SENDER <sender@example.com>"},
                        {"name": "Subject", "value": "PRIVATE_SUBJECT"},
                    ]
                },
            }
        )
        return httpx.Response(200, stream=httpx.ByteStream(json.dumps(data).encode()))

    class FixedClient(httpx.AsyncClient):
        def __init__(self, **kwargs):
            super().__init__(**{**kwargs, "transport": httpx.MockTransport(send)})

    genes = [
        _Model(
            [
                [
                    types.Part(
                        text=json.dumps(
                            {"operation": "search_inbox", "query": "is:unread", "limit": 1}
                        )
                    )
                ]
            ]
        ),
        _Model(
            [
                [
                    types.Part(
                        text=json.dumps(
                            {"answer": "One matching message.", "source_refs": ["mail:1"]}
                        )
                    )
                ]
            ]
        ),
    ]
    model = _Model(
        [
            [
                types.Part(
                    function_call=types.FunctionCall(
                        id="call1", name="ask_email_agent", args={"request": "Search unread inbox"}
                    )
                )
            ],
            [types.Part(text="Public bounded answer.")],
        ]
    )
    service = EmailChatService(
        chat_store=object(), gmail_service=Gmail(), model_call=AsyncMock(), genai_types=types
    )
    monkeypatch.setattr(
        agent_tree,
        "validate_first_party_owner_token",
        AsyncMock(return_value=SimpleNamespace(expires_at=9999999999999)),
    )
    monkeypatch.setattr(
        email_agent,
        "validate_first_party_owner_token",
        AsyncMock(return_value=SimpleNamespace(user_id="owner")),
    )
    monkeypatch.setattr(email_agent, "_singleton", email_agent.EmailAgentA2A(service=service))
    monkeypatch.setattr(runtime, "build_managed_runtime_client", lambda _: object())
    monkeypatch.setattr(runtime, "Gemini", lambda **kwargs: genes.pop(0))
    monkeypatch.setattr(gmail_metadata_reader.httpx, "AsyncClient", FixedClient)
    root = agent_tree.build_one_text_agent(model=model)
    root.tools = [agent_tree.ask_email_agent]  # Real registered dispatch, not a tool double.
    sessions = InMemorySessionService()
    await sessions.create_session(
        app_name="one",
        user_id="owner",
        session_id="same-conversation",
        state={
            STATE_USER_ID: "owner",
            STATE_CONSENT_TOKEN: "synthetic-owner-token",
            agent_tree.STATE_CONVERSATION_ID: "same-conversation",
        },
    )
    runner = Runner(agent=root, app_name="one", session_service=sessions)
    try:
        events = [
            event
            async for event in runner.run_async(
                user_id="owner",
                session_id="same-conversation",
                new_message=types.Content(
                    role="user", parts=[types.Part(text="Find unread email")]
                ),
                state_delta={STATE_EXECUTION_SURFACE: "typed_chat"},
            )
        ]
        result = next(
            response.response
            for event in events
            for response in event.get_function_responses()
            if response.name == "ask_email_agent"
        )
        assert result["status"] == "ok"
        assert result["structured"]["sources"][0]["source_ref"] == "mail:1"
        assert len(requests) == 2 and all(request.method == "GET" for request in requests)
        assert requests[1].url.params["format"] == "metadata"
        assert model._advertised == [{"ask_email_agent"}, set()]
        session = await sessions.get_session(
            app_name="one", user_id="owner", session_id="same-conversation"
        )
        assert "PRIVATE_" not in durable_external_read_projection(session).model_dump_json()
        assert session.state[agent_tree.STATE_CONVERSATION_ID] == "same-conversation"
    finally:
        await runner.close()
