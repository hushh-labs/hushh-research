"""v2 tests for LocationChatService: client-action directives + action-result turn.

Tests inject tools + system_prompt so the v2 default agent is never constructed.
The four cases are:
  1. create_location_share emits a publish_share clientAction
  2. propose_public_link emits a create_public_link clientAction
  3. action_result completed/publish_share sets stateChanged=True + confirms
  4. action_result cancelled/publish_share sets stateChanged=False
"""

from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from hushh_mcp.services.location_chat_service import LocationChatService


class _Turn:
    def __init__(self, conversation_id, history):
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self):
        self.added = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", [])

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append({"role": role, "content": content, "status": status})


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


async def test_create_share_emits_publish_share_client_action():
    store = _FakeStore()
    grant = {
        "id": "11111111-1111-1111-1111-111111111111",
        "recipientUserId": "rcpt-1",
        "recipientKeyId": "key-1",
        "recipientDisplayName": "Mom",
    }
    tools = [_fake_tool("create_location_share", [], result=grant)]
    svc = _service(
        store,
        responses=[
            _fc_response(
                "create_location_share",
                {"recipient_user_id": "rcpt-1", "recipient_key_id": "key-1", "duration_hours": 1},
            ),
            _text_response("Ready to share with Mom for 1 hour."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(user_id="u", message="share with Mom", consent_token="t")  # noqa: S106

    action = out["clientAction"]
    assert action["type"] == "publish_share"
    assert action["shares"] == [
        {
            "grantId": "11111111-1111-1111-1111-111111111111",
            "recipientUserId": "rcpt-1",
            "recipientKeyId": "key-1",
            "label": "Mom",
        }
    ]
    assert "id" in action and action["summary"]
    # grant exists but no envelope yet -> do not refresh on this turn
    assert out["stateChanged"] is False


async def test_propose_public_link_emits_create_public_link_action():
    store = _FakeStore()
    tools = [
        _fake_tool(
            "propose_public_link",
            [],
            result={"proposed": "create_public_link", "durationHours": 2.0},
        )
    ]
    svc = _service(
        store,
        responses=[
            _fc_response("propose_public_link", {"duration_hours": 2}),
            _text_response("I'll create a public link valid for 2 hours."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(user_id="u", message="make a public link", consent_token="t")  # noqa: S106

    assert out["clientAction"]["type"] == "create_public_link"
    assert out["clientAction"]["durationHours"] == 2.0


async def test_action_result_completed_publish_confirms_and_sets_state_changed():
    store = _FakeStore()
    svc = _service(store, responses=[], tools=[])

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        action_result={"id": "a1", "type": "publish_share", "status": "completed"},
    )

    assert out["conversationId"] == "conv-1"
    assert out["stateChanged"] is True
    assert out["isComplete"] is True
    assert out["response"]  # non-empty confirmation
    assert store.added[-1]["role"] == "assistant"
    assert store.added[-1]["status"] == "complete"


async def test_action_result_cancelled_does_not_set_state_changed():
    store = _FakeStore()
    svc = _service(store, responses=[], tools=[])

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        action_result={"id": "a1", "type": "publish_share", "status": "cancelled"},
    )

    assert out["stateChanged"] is False
    assert out["isComplete"] is True
