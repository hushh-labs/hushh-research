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
    assert out["stateChanged"] is False


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


async def test_request_choice_tool_emits_client_prompt():
    store = _FakeStore()
    prompt_payload = {
        "prompt": {
            "kind": "select",
            "purpose": "select_share",
            "question": "Which sharing do you want to stop?",
            "options": [
                {"label": "Mom", "ref": {"grantId": "g1"}},
                {"label": "Stop all", "ref": {"all": True}},
            ],
            "minSelections": 1,
            "maxSelections": None,
            "allowFreeText": True,
        }
    }
    tools = [_fake_tool("request_active_share_choice", [], result=prompt_payload)]
    svc = _service(
        store,
        responses=[
            _fc_response("request_active_share_choice", {}),
            _text_response("Which sharing do you want to stop?"),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(user_id="u", message="stop sharing", consent_token="t")  # noqa: S106

    cp = out["clientPrompt"]
    assert cp["kind"] == "select" and cp["purpose"] == "select_share"
    assert cp["options"][0]["ref"] == {"grantId": "g1"}
    assert cp["id"].startswith("prm-")
    assert out["stateChanged"] is False
    assert "clientAction" not in out


async def test_approve_location_request_wrapped_grant_emits_publish_share():
    """approve_location_request with a wrapped {grant, request} shape must emit a
    publish_share clientAction whose shares[0] has grantId/recipientUserId/
    recipientKeyId/label extracted from the inner grant."""
    store = _FakeStore()
    wrapped_result = {
        "grant": {
            "id": "22222222-2222-2222-2222-222222222222",
            "recipientUserId": "rcpt-2",
            "recipientKeyId": "key-2",
            "recipientDisplayName": "Dad",
        },
        "request": {"id": "req-99", "status": "approved"},
    }
    tools = [_fake_tool("approve_location_request", [], result=wrapped_result)]
    svc = _service(
        store,
        responses=[
            _fc_response(
                "approve_location_request",
                {"request_id": "req-99", "duration_hours": 2},
            ),
            _text_response("Approved — sharing your location with Dad for 2 hours."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(
        user_id="u",
        message="approve Dad's request",
        consent_token="t",  # noqa: S106
    )

    action = out["clientAction"]
    assert action["type"] == "publish_share"
    share = action["shares"][0]
    assert share["grantId"] == "22222222-2222-2222-2222-222222222222"
    assert share["recipientUserId"] == "rcpt-2"
    assert share["recipientKeyId"] == "key-2"
    assert share["label"] == "Dad"
    # grant exists server-side but envelope not yet published -> no UI refresh
    assert out["stateChanged"] is False


class _HistoryStore(_FakeStore):
    async def get_recent_messages(self, conversation_id, *, user_id, limit=20):
        return []


async def test_selection_result_seeds_loop_and_acts_on_real_ids():
    store = _HistoryStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_location_share", calls, result={"status": "revoked"})]
    svc = _service(
        store,
        responses=[
            _fc_response("revoke_location_share", {"grant_id": "g1"}),
            _text_response("Stopped sharing with Mom."),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        selection_result={
            "id": "prm-1",
            "kind": "select",
            "selected": [{"grantId": "g1"}],
            "status": "answered",
        },
    )

    assert out["conversationId"] == "conv-1"
    assert out["response"] == "Stopped sharing with Mom."
    assert out["stateChanged"] is True
    assert calls[0]["args"] == {"grant_id": "g1"}  # exact id, never guessed


async def test_selection_result_persists_user_choice_for_chaining():
    # Multi-step clarification (pick recipient -> then pick duration): the FIRST
    # selection's chosen refs must be persisted so the SECOND selection turn still
    # knows who to share with. Regression: previously only the assistant reply was
    # persisted, so the recipient choice was lost on the next turn.
    store = _HistoryStore()
    duration_prompt = {
        "prompt": {
            "kind": "select",
            "purpose": "select_duration",
            "question": "How long?",
            "options": [{"label": "1 hour", "ref": {"hours": 1}}],
        }
    }
    tools = [_fake_tool("request_duration_choice", [], result=duration_prompt)]
    svc = _service(
        store,
        responses=[
            _fc_response("request_duration_choice", {}),
            _text_response("How long should this share last?"),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        selection_result={
            "id": "prm-1",
            "kind": "select",
            "selected": [{"recipientUserId": "rcpt-1", "recipientKeyId": "key-1"}],
            "status": "answered",
        },
    )

    assert out["clientPrompt"]["purpose"] == "select_duration"
    user_msgs = [m for m in store.added if m["role"] == "user"]
    assert any("rcpt-1" in m["content"] for m in user_msgs), (
        "the recipient selection must be persisted so a later turn can use it"
    )


async def test_selection_result_cancelled_makes_no_tool_call():
    store = _HistoryStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_location_share", calls, result={"status": "revoked"})]
    svc = _service(
        store,
        responses=[_text_response("No problem — nothing changed.")],
        tools=tools,
    )

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        selection_result={"id": "prm-1", "kind": "select", "status": "cancelled"},
    )

    assert calls == []
    assert out["stateChanged"] is False
    assert out["isComplete"] is True
