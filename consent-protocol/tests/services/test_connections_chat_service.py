from types import SimpleNamespace
from unittest.mock import MagicMock

from google.genai import types

from hushh_mcp.services.connections_chat_service import ConnectionsChatService

_TOKEN = "tok"  # noqa: S105


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


def _scripted_model_call(responses):
    seq = iter(responses)

    async def _call(contents, config):
        return next(seq)

    return _call


def _loop_service(*, service, store, responses, ready=True):
    return ConnectionsChatService(
        service=service,
        chat_store=store,
        model_call=_scripted_model_call(responses),
        genai_types=types,
        ready=lambda: ready,
    )


async def test_list_my_connections_tool_flow():
    fake = MagicMock()
    fake.list_connections.return_value = [
        {"connectionId": "cx", "userId": "u2", "displayName": "Priya Rao"}
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
    fake.list_connections.assert_called_once_with("u1")
    assert out["response"] == "You're connected with Priya Rao."
    assert out["stateChanged"] is False
    assert out["isComplete"] is True


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


async def test_unready_model_returns_unavailable():
    svc = _loop_service(service=MagicMock(), store=_FakeStore(), responses=[], ready=False)
    out = await svc.handle_turn(
        user_id="u1", message="who are my connections", consent_token=_TOKEN
    )
    assert "unavailable" in out["response"].lower()
    assert out["isComplete"] is False


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
