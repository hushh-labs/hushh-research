"""Tests for LocationChatService: client-action directives + action-result turn.

Tests inject tools + system_prompt so the default agent is never constructed.
The cases are:
  1. propose_public_link emits a create_public_link clientAction
  2. action_result completed/create_public_link sets stateChanged=True + confirms
  3. action_result cancelled/create_public_link sets stateChanged=False
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


async def test_action_result_completed_create_public_link_confirms_and_sets_state_changed():
    store = _FakeStore()
    svc = _service(store, responses=[], tools=[])

    out = await svc.handle_turn(
        user_id="u",
        consent_token="t",  # noqa: S106
        conversation_id="conv-1",
        action_result={"id": "a1", "type": "create_public_link", "status": "completed"},
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
        action_result={"id": "a1", "type": "create_public_link", "status": "cancelled"},
    )

    assert out["stateChanged"] is False
    assert out["isComplete"] is True


async def test_request_choice_tool_emits_client_prompt():
    store = _FakeStore()
    prompt_payload = {
        "prompt": {
            "kind": "select",
            "purpose": "select_incoming",
            "question": "Whose location do you want to see?",
            "options": [
                {"label": "Mom", "ref": {"grantId": "g1"}},
            ],
            "minSelections": 1,
            "maxSelections": 1,
            "allowFreeText": True,
        }
    }
    tools = [_fake_tool("request_incoming_choice", [], result=prompt_payload)]
    svc = _service(
        store,
        responses=[
            _fc_response("request_incoming_choice", {}),
            _text_response("Whose location do you want to see?"),
        ],
        tools=tools,
    )

    out = await svc.handle_turn(user_id="u", message="show me a shared location", consent_token="t")  # noqa: S106

    cp = out["clientPrompt"]
    assert cp["kind"] == "select" and cp["purpose"] == "select_incoming"
    assert cp["options"][0]["ref"] == {"grantId": "g1"}
    assert cp["id"].startswith("prm-")
    assert out["stateChanged"] is False
    assert "clientAction" not in out


class _HistoryStore(_FakeStore):
    async def get_recent_messages(self, conversation_id, *, user_id, limit=20):
        return []


async def test_selection_result_seeds_loop_and_acts_on_real_ids():
    store = _HistoryStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_public_link", calls, result={"status": "revoked"})]
    svc = _service(
        store,
        responses=[
            _fc_response("revoke_public_link", {"invite_id": "link-1"}),
            _text_response("Revoked that link."),
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
            "selected": [{"inviteId": "link-1"}],
            "status": "answered",
        },
    )

    assert out["conversationId"] == "conv-1"
    assert out["response"] == "Revoked that link."
    assert out["stateChanged"] is True
    assert calls[0]["args"] == {"invite_id": "link-1"}  # exact id, never guessed


async def test_selection_result_persists_user_choice_for_chaining():
    # Multi-step clarification (pick which incoming share -> then confirm viewing
    # it): the FIRST selection's chosen refs must be persisted so the SECOND
    # selection turn still knows which grant to view. Regression: previously only
    # the assistant reply was persisted, so the choice was lost on the next turn.
    store = _HistoryStore()
    confirm_prompt = {
        "prompt": {
            "kind": "confirm",
            "purpose": "confirm_action",
            "question": "Open Mom's shared location?",
        }
    }
    tools = [_fake_tool("request_confirmation", [], result=confirm_prompt)]
    svc = _service(
        store,
        responses=[
            _fc_response("request_confirmation", {"summary": "Open Mom's shared location?"}),
            _text_response("Open Mom's shared location?"),
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

    assert out["clientPrompt"]["purpose"] == "confirm_action"
    user_msgs = [m for m in store.added if m["role"] == "user"]
    assert any("g1" in m["content"] for m in user_msgs), (
        "the grant selection must be persisted so a later turn can use it"
    )


async def test_selection_result_cancelled_makes_no_tool_call():
    store = _HistoryStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_public_link", calls, result={"status": "revoked"})]
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
