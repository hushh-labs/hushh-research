"""Tests for the direct-Gemini control-plane chat runner.

The runner executes a Gemini function-calling loop INSIDE a HushhContext so each
@hushh_tool enforces consent scope. These tests inject a fake model_call (the
Gemini seam), real google.genai types (for building function-response contents),
and fake tools, so no live LLM or DB is required.
"""

from __future__ import annotations

from types import SimpleNamespace

from google.genai import types

from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.services.location_chat_service import LocationChatService

# --- fakes -----------------------------------------------------------------


class _Msg:
    def __init__(self, role: str, content: str) -> None:
        self.role = role
        self.content = content


class _Turn:
    def __init__(self, conversation_id: str, history: list) -> None:
        self.conversation_id = conversation_id
        self.history = history


class _FakeStore:
    def __init__(self, history=None) -> None:
        self.history = history or []
        self.added: list[dict] = []

    async def prepare_turn(self, *, user_id, message, conversation_id=None):
        return _Turn(conversation_id or "conv-new", self.history)

    async def add_message(self, *, conversation_id, user_id, role, content, status, model=None):
        self.added.append({"role": role, "content": content, "status": status})


def _fake_tool(
    name: str, recorder: list, *, raises: Exception | None = None, result: dict | None = None
):
    """Build a fake @hushh_tool-like async callable that records the live context."""

    async def _impl(**kwargs):
        ctx = HushhContext.current()
        recorder.append(
            {
                "name": name,
                "args": kwargs,
                "ctx_user": getattr(ctx, "user_id", None),
                "ctx_token": getattr(ctx, "consent_token", None),
            }
        )
        if raises is not None:
            raise raises
        return result if result is not None else {"ok": True}

    _impl._name = name
    _impl._hushh_tool = True
    return _impl


def _fc_response(name: str, args: dict):
    """A model response that requests one function call."""
    return SimpleNamespace(
        function_calls=[SimpleNamespace(name=name, args=args)],
        text="",
        candidates=[
            SimpleNamespace(content=types.Content(role="model", parts=[types.Part(text="")]))
        ],
    )


def _text_response(text: str):
    """A model response with a final natural-language answer (no tool calls)."""
    return SimpleNamespace(function_calls=[], text=text, candidates=[])


def _scripted_model_call(responses: list, captured: list):
    """Return an async model_call that yields the scripted responses in order."""
    seq = iter(responses)

    async def _call(contents, config):
        captured.append(list(contents))
        return next(seq)

    return _call


def _build_service(*, store, responses, captured, tools):
    return LocationChatService(
        chat_store=store,
        model_call=_scripted_model_call(responses, captured),
        genai_types=types,
        ready=lambda: True,
        tools=tools,
        system_prompt="test-system-prompt",
    )


# --- tests -----------------------------------------------------------------


async def test_mutating_tool_runs_in_consent_context_and_sets_state_changed():
    store = _FakeStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_public_link", calls, result={"status": "revoked"})]
    captured: list = []
    service = _build_service(
        store=store,
        responses=[
            _fc_response("revoke_public_link", {"invite_id": "link-1"}),
            _text_response("Revoked your public link."),
        ],
        captured=captured,
        tools=tools,
    )

    out = await service.handle_turn(
        user_id="user_123",
        message="revoke my public link",
        consent_token="vault-token",  # noqa: S106
    )

    assert out["conversationId"] == "conv-new"
    assert out["response"] == "Revoked your public link."
    assert out["isComplete"] is True
    assert out["stateChanged"] is True
    # tool executed with the right args, inside a HushhContext bound to the caller
    assert calls[0]["args"] == {"invite_id": "link-1"}
    assert calls[0]["ctx_user"] == "user_123"
    assert calls[0]["ctx_token"] == "vault-token"
    # assistant reply persisted as complete
    assert store.added[-1] == {
        "role": "assistant",
        "content": "Revoked your public link.",
        "status": "complete",
    }


async def test_query_tool_does_not_set_state_changed():
    store = _FakeStore()
    calls: list[dict] = []
    tools = [_fake_tool("list_public_links", calls, result={"publicLinks": []})]
    captured: list = []
    service = _build_service(
        store=store,
        responses=[
            _fc_response("list_public_links", {}),
            _text_response("You have no active public links."),
        ],
        captured=captured,
        tools=tools,
    )

    out = await service.handle_turn(user_id="u", message="do I have any links", consent_token="t")  # noqa: S106

    assert out["response"] == "You have no active public links."
    assert out["stateChanged"] is False
    assert out["isComplete"] is True


async def test_consent_denied_tool_is_handled_without_state_change():
    store = _FakeStore()
    calls: list[dict] = []
    tools = [_fake_tool("revoke_public_link", calls, raises=PermissionError("Consent Denied"))]
    captured: list = []
    service = _build_service(
        store=store,
        responses=[
            _fc_response("revoke_public_link", {"invite_id": "link-1"}),
            _text_response("I couldn't do that."),
        ],
        captured=captured,
        tools=tools,
    )

    out = await service.handle_turn(user_id="u", message="revoke my link", consent_token="t")  # noqa: S106

    # the loop recovers: denial is fed back, model produces a final answer
    assert out["response"] == "I couldn't do that."
    assert out["isComplete"] is True
    assert out["stateChanged"] is False


async def test_returns_unavailable_when_gemini_not_ready():
    store = _FakeStore()
    captured: list = []
    service = LocationChatService(
        chat_store=store,
        model_call=_scripted_model_call([], captured),
        genai_types=types,
        ready=lambda: False,
        tools=[_fake_tool("revoke_public_link", [])],
        system_prompt="test",
    )

    out = await service.handle_turn(user_id="u", message="revoke", consent_token="t")  # noqa: S106

    assert out["isComplete"] is False
    assert out["stateChanged"] is False
    assert "unavailable" in out["response"].lower()
    assert out["availability"] == {
        "state": "runtime_unavailable",
        "reasonCode": "managed_runtime_unavailable",
    }
    assert store.added[-1]["status"] == "error"
    # the model was never called
    assert captured == []


async def test_first_turn_sends_user_message_to_model():
    store = _FakeStore(
        history=[_Msg("user", "earlier question"), _Msg("assistant", "earlier answer")]
    )
    captured: list = []
    service = _build_service(
        store=store,
        responses=[_text_response("ok")],
        captured=captured,
        tools=[_fake_tool("list_public_links", [])],
    )

    await service.handle_turn(user_id="u", message="latest message", consent_token="t")  # noqa: S106

    first_contents = captured[0]
    # history folded in + the latest user message appended last
    texts = [p.text for c in first_contents for p in c.parts]
    assert "earlier question" in texts
    assert "earlier answer" in texts
    assert first_contents[-1].role == "user"
    assert first_contents[-1].parts[0].text == "latest message"


def _scripted_model_call_with_failures(responses: list, captured: list):
    """Like _scripted_model_call, but any Exception item in `responses` is raised
    when that step is reached (simulates a timed-out / transient model call)."""
    seq = iter(responses)

    async def _call(contents, config):
        captured.append(list(contents))
        item = next(seq)
        if isinstance(item, BaseException):
            raise item
        return item

    return _call


async def test_mutation_survives_followup_model_failure():
    # Regression (ll1/ll2): the public link is proposed, then the follow-up
    # summarization model call fails (timeout / transient error). The turn must
    # NOT report "temporarily unavailable" — the proposal already committed, so
    # it must report success and still surface the clientAction so the browser
    # creates the link after the owner confirms it.
    store = _FakeStore()
    calls: list[dict] = []
    tools = [
        _fake_tool(
            "propose_public_link",
            calls,
            result={"proposed": "create_public_link", "durationHours": 1.0},
        )
    ]
    captured: list = []
    service = LocationChatService(
        chat_store=store,
        model_call=_scripted_model_call_with_failures(
            [
                _fc_response("propose_public_link", {"duration_hours": 1}),
                TimeoutError("gemini summarization timed out"),
            ],
            captured,
        ),
        genai_types=types,
        ready=lambda: True,
        tools=tools,
        system_prompt="test-system-prompt",
    )

    out = await service.handle_turn(
        user_id="u",
        message="make a public link for an hour",
        consent_token="t",  # noqa: S106
    )

    # the proposal WAS made
    assert len(calls) == 1
    assert calls[0]["args"]["duration_hours"] == 1
    # ...so the turn must not claim it failed
    assert "unavailable" not in out["response"].lower()
    assert out["isComplete"] is True
    assert store.added[-1]["status"] == "complete"
    # and the browser still gets the create-link directive, which drives the
    # owner-confirmation card + the follow-up action_result that reports "Done"
    # (hence stateChanged is False here, deferred to that round-trip, not the
    # false-failure it used to be).
    assert out["clientAction"]["type"] == "create_public_link"
    assert out["clientAction"]["durationHours"] == 1.0
    assert out["stateChanged"] is False


async def test_server_side_mutation_survives_followup_model_failure():
    # A pure server-side mutation (referral) has no browser round-trip, so when
    # the follow-up model call fails the turn must report success AND
    # stateChanged=True so the UI refreshes — rather than the old false
    # "temporarily unavailable".
    store = _FakeStore()
    calls: list[dict] = []
    tools = [_fake_tool("refer_location_recipient", calls, result={"status": "referred"})]
    captured: list = []
    service = LocationChatService(
        chat_store=store,
        model_call=_scripted_model_call_with_failures(
            [
                _fc_response(
                    "refer_location_recipient",
                    {"grant_id": "g1", "referred_user_id": "u-bob"},
                ),
                TimeoutError("gemini summarization timed out"),
            ],
            captured,
        ),
        genai_types=types,
        ready=lambda: True,
        tools=tools,
        system_prompt="test-system-prompt",
    )

    out = await service.handle_turn(
        user_id="u",
        message="refer Bob into Abdul's share",
        consent_token="t",  # noqa: S106
    )

    assert len(calls) == 1
    assert "unavailable" not in out["response"].lower()
    assert out["isComplete"] is True
    assert out["stateChanged"] is True
    assert "clientAction" not in out
    assert store.added[-1]["status"] == "complete"


async def test_model_failure_before_any_mutation_still_unavailable():
    # Contrast: if the model fails BEFORE any tool commits a change, there is no
    # side effect to preserve, so the truthful answer is still "unavailable".
    store = _FakeStore()
    captured: list = []
    service = LocationChatService(
        chat_store=store,
        model_call=_scripted_model_call_with_failures([TimeoutError("down")], captured),
        genai_types=types,
        ready=lambda: True,
        tools=[_fake_tool("propose_public_link", [])],
        system_prompt="test-system-prompt",
    )

    out = await service.handle_turn(user_id="u", message="make a link", consent_token="t")  # noqa: S106

    assert "unavailable" in out["response"].lower()
    assert out["isComplete"] is False
    assert out["stateChanged"] is False
    assert store.added[-1]["status"] == "error"
