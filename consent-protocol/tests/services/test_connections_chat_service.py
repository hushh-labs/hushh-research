from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.services.connections_chat_service import ConnectionsChatService

_TOKEN = "tok"  # noqa: S105


@pytest.mark.parametrize(
    "name,args",
    [
        ("list_my_connections", {}),
        ("list_pending_requests", {}),
        ("find_people", {"query": "Alex"}),
        ("request_person_choice", {"name": "Alex"}),
        ("propose_send_request", {"addressee_user_id": "u2"}),
        ("propose_accept_request", {"request_id": "r1"}),
        ("propose_reject_request", {"request_id": "r1"}),
        ("propose_remove_connection", {"connection_id": "c1"}),
    ],
)
async def test_composed_tools_revalidate_before_every_call(name, args):
    fake = MagicMock()
    fake.list_connections_page.return_value = {"items": []}
    fake.list_requests.return_value = []
    fake.search_directory.return_value = {"items": []}
    calls = []

    async def before_read():
        calls.append("checked")

    svc = ConnectionsChatService(service=fake, chat_store=MagicMock())
    tools = {t.name: t for t in svc.build_read_proposal_tools("u1", before_read)}
    context = SimpleNamespace(state={}, actions=SimpleNamespace(skip_summarization=False))
    await tools[name].run_async(args=args, tool_context=context)
    await tools[name].run_async(args=args, tool_context=context)
    assert calls == ["checked", "checked"]


async def test_revoked_composed_authority_blocks_service_access():
    fake = MagicMock()

    async def revoked():
        raise PermissionError("authority revoked")

    svc = ConnectionsChatService(service=fake, chat_store=MagicMock())
    fake.reset_mock()
    for tool in svc.build_read_proposal_tools("u1", revoked):
        with pytest.raises(PermissionError, match="authority revoked"):
            await tool.run_async(
                args={},
                tool_context=SimpleNamespace(state={}, actions=SimpleNamespace()),
            )
    assert fake.mock_calls == []


class _Turn:
    def __init__(self, conversation_id, history):
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self, history=None):
        self.history = history or []
        self.added = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", self.history)

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append({"role": role, "content": content, "status": status})


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


class ScriptedLlm(BaseLlm):
    _responses: list = PrivateAttr(default_factory=list)
    _requests: list = PrivateAttr(default_factory=list)

    def __init__(self, responses):
        super().__init__(model="gemini-3.7-flash")
        self._responses = list(responses)

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request)
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        calls = response.function_calls
        parts = (
            [
                types.Part(function_call=types.FunctionCall(name=call.name, args=call.args))
                for call in calls
            ]
            if calls
            else [types.Part(text=response.text)]
        )
        yield LlmResponse(content=types.Content(role="model", parts=parts))


def _loop_service(*, service, store, responses, ready=True):
    return ConnectionsChatService(
        service=service,
        chat_store=store,
        model=ScriptedLlm(responses),
        ready=lambda: ready,
    )


async def test_list_my_connections_tool_flow():
    fake = MagicMock()
    fake.list_connections_page.return_value = {
        "items": [{"connectionId": "cx", "userId": "u2", "displayName": "Priya Rao"}],
        "page": 1,
        "hasMore": False,
        "totalCount": 1,
        "audience": "all",
    }
    store = _FakeStore()
    svc = _loop_service(
        service=fake,
        store=store,
        responses=[
            _fc_response("list_my_connections", {}),
            _text_response("You're connected with Priya Rao."),
        ],
    )
    out = await svc.handle_turn(
        user_id="u1", message="who are my connections", consent_token=_TOKEN
    )
    fake.list_connections_page.assert_called_once_with("u1", query="", page=1, limit=25)
    assert out["response"] == "You're connected with Priya Rao."
    assert out["stateChanged"] is False
    assert out["isComplete"] is True


async def test_list_my_connections_tool_bounds_model_supplied_page_size():
    fake = MagicMock()
    fake.list_connections_page.return_value = {
        "items": [],
        "page": 2,
        "hasMore": True,
        "totalCount": 5000,
        "audience": "all",
    }
    svc = _loop_service(
        service=fake,
        store=_FakeStore(),
        responses=[
            _fc_response("list_my_connections", {"query": "Pat", "page": 2, "limit": 5000}),
            _text_response("There are more matching connections."),
        ],
    )
    await svc.handle_turn(user_id="u1", message="find Pat", consent_token=_TOKEN)
    fake.list_connections_page.assert_called_once_with("u1", query="Pat", page=2, limit=100)


async def test_find_people_tool_flow():
    fake = MagicMock()
    fake.search_directory.return_value = {
        "items": [{"userId": "u9", "displayName": "Sam Lee", "relationship": "none"}],
        "hasMore": False,
    }
    svc = _loop_service(
        service=fake,
        store=_FakeStore(),
        responses=[
            _fc_response("find_people", {"query": "Sam"}),
            _text_response("I found Sam Lee."),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="find people named Sam", consent_token=_TOKEN)
    fake.search_directory.assert_called_once_with("u1", query="Sam")
    assert out["response"] == "I found Sam Lee."


async def test_list_pending_requests_tool_flow():
    fake = MagicMock()
    fake.list_requests.return_value = [
        {
            "id": "r1",
            "counterpartUserId": "u2",
            "counterpartDisplayName": "Sam Lee",
            "status": "pending",
        }
    ]
    svc = _loop_service(
        service=fake,
        store=_FakeStore(),
        responses=[
            _fc_response("list_pending_requests", {"direction": "incoming"}),
            _text_response("Sam Lee asked to connect."),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="any pending requests", consent_token=_TOKEN)
    fake.list_requests.assert_called_once_with("u1", direction="incoming")
    assert "Sam Lee" in out["response"]


async def test_list_my_connections_survives_a_raw_datetime_from_the_service():
    """Regression guard for the fix already made at the source
    (ConnectionsService.list_connections now stringifies createdAt via
    _iso()) -- this integration point trusts that fix rather than doing its
    own stringifying, so if the source fix were ever reverted, this proves
    the failure mode: the tool result would carry a raw datetime straight
    into types.Part.from_function_response, the same class of bug that
    crashed the live voice session, just reached through the specialist
    pathway instead of the direct read-tool one."""
    fake = MagicMock()
    fake.list_connections.return_value = [
        {
            "connectionId": "cx",
            "userId": "u2",
            "displayName": "Priya Rao",
            "createdAt": datetime(2026, 7, 9, tzinfo=timezone.utc),
        }
    ]
    store = _FakeStore()
    svc = _loop_service(
        service=fake,
        store=store,
        responses=[
            _fc_response("list_my_connections", {}),
            _text_response("You're connected with Priya Rao."),
        ],
    )
    out = await svc.handle_turn(
        user_id="u1", message="who are my connections", consent_token=_TOKEN
    )
    assert out["response"] == "You're connected with Priya Rao."


async def test_unready_model_returns_unavailable():
    svc = _loop_service(service=MagicMock(), store=_FakeStore(), responses=[], ready=False)
    out = await svc.handle_turn(
        user_id="u1", message="who are my connections", consent_token=_TOKEN
    )
    assert "unavailable" in out["response"].lower()
    assert out["isComplete"] is False


async def test_proposal_stops_before_another_model_call():
    fake = MagicMock()
    model = ScriptedLlm(
        [
            _fc_response("propose_send_request", {"addressee_user_id": "u2", "label": "Alex"}),
        ]
    )
    svc = ConnectionsChatService(service=fake, chat_store=_FakeStore(), model=model)
    out = await svc.handle_turn(user_id="u1", message="Connect with Alex", consent_token=_TOKEN)
    assert len(model._requests) == 1
    assert out["clientPrompt"]["purpose"] == "confirm_send_request"
    assert out["isComplete"] is False and out["stateChanged"] is False
    fake.create_request.assert_not_called()


async def test_same_batch_tools_stop_after_proposal():
    fake = MagicMock()
    response = _fc_response("propose_send_request", {"addressee_user_id": "u2", "label": "Alex"})
    response.function_calls.append(SimpleNamespace(name="find_people", args={"query": "Other"}))
    model = ScriptedLlm([response])
    svc = ConnectionsChatService(service=fake, chat_store=_FakeStore(), model=model)
    out = await svc.handle_turn(user_id="u1", message="Connect with Alex", consent_token=_TOKEN)
    assert out["clientPrompt"]["purpose"] == "confirm_send_request"
    fake.search_directory.assert_not_called()
    fake.create_request.assert_not_called()


async def test_model_failure_after_read_does_not_replay():
    fake = MagicMock()
    fake.list_connections_page.return_value = {"items": [], "totalCount": 0}
    model = ScriptedLlm(
        [
            _fc_response("list_my_connections", {}),
            RuntimeError("fixture provider failed"),
        ]
    )
    store = _FakeStore()
    svc = ConnectionsChatService(service=fake, chat_store=store, model=model)
    out = await svc.handle_turn(user_id="u1", message="List connections", consent_token=_TOKEN)
    fake.list_connections_page.assert_called_once()
    assert out["isComplete"] is False
    assert store.added[-1]["status"] == "error"
    assert "unavailable" in out["response"]


async def test_prompt_state_does_not_leak_between_turns():
    fake = MagicMock()
    model = ScriptedLlm(
        [
            _fc_response("propose_remove_connection", {"connection_id": "c1", "label": "Alex"}),
            _text_response("Connections are people you trust."),
        ]
    )
    svc = ConnectionsChatService(service=fake, chat_store=_FakeStore(), model=model)
    first = await svc.handle_turn(user_id="u1", message="Remove Alex", consent_token=_TOKEN)
    second = await svc.handle_turn(
        user_id="u1", message="Explain connections", consent_token=_TOKEN
    )
    assert "clientPrompt" in first and "clientPrompt" not in second
    assert second["response"] == "Connections are people you trust."
    fake.remove_connection.assert_not_called()


def _svc_with_mock():
    fake = MagicMock()
    return ConnectionsChatService(service=fake), fake


def test_complete_action_send_request_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "send_request", "addresseeUserId": "u2", "label": "Priya Rao"}],
        "display": "Priya Rao",
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.create_request.assert_called_once_with("u1", addressee_user_id="u2")
    assert out["stateChanged"] is True
    assert "Priya Rao" in out["response"]


def test_complete_action_accept_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "accept", "requestId": "r1", "label": "Sam Lee"}],
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.accept_request.assert_called_once_with("u1", "r1")
    assert out["stateChanged"] is True
    assert "Sam Lee" in out["response"]


def test_complete_action_reject_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "reject", "requestId": "r2", "label": "Sam Lee"}],
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.reject_request.assert_called_once_with("u1", "r2")
    assert out["stateChanged"] is True


def test_complete_action_remove_executes():
    svc, fake = _svc_with_mock()
    sel = {
        "status": "answered",
        "selected": [{"op": "remove", "connectionId": "cx", "label": "Alex T"}],
    }
    out = svc._complete_action("u1", sel, "c1")
    fake.remove_connection.assert_called_once_with("u1", "cx")
    assert out["stateChanged"] is True
    assert "Alex T" in out["response"]


def test_complete_action_cancelled_is_noop():
    svc, fake = _svc_with_mock()
    out = svc._complete_action("u1", {"status": "cancelled", "selected": []}, "c1")
    fake.create_request.assert_not_called()
    fake.accept_request.assert_not_called()
    assert out["stateChanged"] is False


def test_complete_action_service_error_is_surfaced():
    from hushh_mcp.services.connections_service import ConnectionsError

    svc, fake = _svc_with_mock()
    fake.accept_request.side_effect = ConnectionsError("X", "Request is no longer pending.")
    sel = {"status": "answered", "selected": [{"op": "accept", "requestId": "r9", "label": "Sam"}]}
    out = svc._complete_action("u1", sel, "c1")
    assert out["response"] == "Request is no longer pending."
    assert out["stateChanged"] is False


async def test_propose_send_request_emits_confirm_prompt_no_write():
    fake = MagicMock()
    svc = _loop_service(
        service=fake,
        store=_FakeStore(),
        responses=[
            _fc_response("propose_send_request", {"addressee_user_id": "u2", "label": "Priya Rao"}),
            _text_response("Want me to send Priya Rao a connection request?"),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="connect me with Priya", consent_token=_TOKEN)
    fake.create_request.assert_not_called()  # confirm-before-write
    assert out["isComplete"] is False
    prompt = out["clientPrompt"]
    assert prompt["kind"] == "select"
    assert len(prompt["options"]) == 1
    ref = prompt["options"][0]["ref"]
    assert ref == {"op": "send_request", "addresseeUserId": "u2", "label": "Priya Rao"}


async def test_propose_remove_emits_confirm_prompt():
    fake = MagicMock()
    svc = _loop_service(
        service=fake,
        store=_FakeStore(),
        responses=[
            _fc_response("propose_remove_connection", {"connection_id": "cx", "label": "Alex T"}),
            _text_response("Remove Alex T?"),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="remove Alex", consent_token=_TOKEN)
    fake.remove_connection.assert_not_called()
    ref = out["clientPrompt"]["options"][0]["ref"]
    assert ref == {"op": "remove", "connectionId": "cx", "label": "Alex T"}


async def test_propose_accept_emits_confirm_prompt():
    svc = _loop_service(
        service=MagicMock(),
        store=_FakeStore(),
        responses=[
            _fc_response("propose_accept_request", {"request_id": "r1", "label": "Sam Lee"}),
            _text_response("Accept Sam Lee?"),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="accept Sam's request", consent_token=_TOKEN)
    ref = out["clientPrompt"]["options"][0]["ref"]
    assert ref == {"op": "accept", "requestId": "r1", "label": "Sam Lee"}


async def test_propose_reject_emits_confirm_prompt():
    fake = MagicMock()
    svc = _loop_service(
        service=fake,
        store=_FakeStore(),
        responses=[
            _fc_response("propose_reject_request", {"request_id": "r5", "label": "Bob Smith"}),
            _text_response("Decline Bob Smith?"),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="decline Bob's request", consent_token=_TOKEN)
    fake.reject_request.assert_not_called()  # confirm-before-write
    assert out["isComplete"] is False
    ref = out["clientPrompt"]["options"][0]["ref"]
    assert ref == {"op": "reject", "requestId": "r5", "label": "Bob Smith"}


async def test_confirm_roundtrip_executes_send(monkeypatch):
    # The prompt from turn 1 round-trips as a selection_result → _complete_action writes.
    fake = MagicMock()
    svc = ConnectionsChatService(service=fake)
    sel = {
        "status": "answered",
        "selected": [{"op": "send_request", "addresseeUserId": "u2", "label": "Priya Rao"}],
    }
    out = await svc.handle_turn(user_id="u1", message="", selection_result=sel)
    fake.create_request.assert_called_once_with("u1", addressee_user_id="u2")
    assert out["stateChanged"] is True


async def test_request_person_choice_multi_candidate_prompt():
    fake = MagicMock()
    fake.search_directory.return_value = {
        "items": [
            {"userId": "u2", "displayName": "Priya Rao", "relationship": "none"},
            {"userId": "u3", "displayName": "Priya Shah", "relationship": "none"},
        ],
        "hasMore": False,
    }
    svc = _loop_service(
        service=fake,
        store=_FakeStore(),
        responses=[
            _fc_response("request_person_choice", {"name": "Priya"}),
            _text_response("Which Priya?"),
        ],
    )
    out = await svc.handle_turn(user_id="u1", message="connect me with Priya", consent_token=_TOKEN)
    prompt = out["clientPrompt"]
    assert prompt["kind"] == "select"
    assert [o["ref"]["addresseeUserId"] for o in prompt["options"]] == ["u2", "u3"]
    assert all(o["ref"]["op"] == "send_request" for o in prompt["options"])
