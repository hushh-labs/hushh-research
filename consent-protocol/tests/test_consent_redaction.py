"""After a grant ends, One's model context no longer holds what was shared (CONTRACT C3).

The regression, measured on UAT 2026-09-28: the owner revoked, the requester
asked the same chat again, and One answered "Nopa" with no tool call, because
its earlier answer was still replayed from the sealed session history.

These run the real One text agent through a real ADK Runner with a model that
records every request, so they prove what the provider would actually receive,
not what a helper returns. The negative control removes only the redaction
step and shows the answer comes back.
"""

from __future__ import annotations

from typing import Any

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.one_adk import agent_tree
from hushh_mcp.one_adk.consent_continuation import (
    STATE_CONSENT_CONTINUATION,
    consent_outcome_state_key,
    consent_shared_state_key,
)
from hushh_mcp.one_adk.consent_redaction import (
    consent_access_ended_state_key,
    consent_invocations_state_key,
    redaction_for_history,
)
from hushh_mcp.one_adk.request_secrets import store_request_secret

BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100"
OWNER = "requester-uid"


class _RecordingModel(BaseLlm):
    _answers: list = PrivateAttr()
    _requests: list = PrivateAttr(default_factory=list)

    def __init__(self, answers: list[str]) -> None:
        super().__init__(model="gemini-3.6-flash")
        self._answers = answers

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request.model_copy(deep=True))
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=self._answers.pop(0))])
        )


def _request_text(llm_request: Any) -> str:
    return "\n".join(
        str(part.text or "")
        for content in llm_request.contents or []
        for part in content.parts or []
    )


class _Ledger:
    """The requester-bound bundle view, switchable from granted to revoked."""

    def __init__(self) -> None:
        self.outcome = "granted"
        self.reads: list[tuple[str, str]] = []

    async def __call__(self, owner_id: str, bundle_id: str) -> dict[str, Any]:
        self.reads.append((owner_id, bundle_id))
        ended = self.outcome in {"revoked", "expired"}
        return {
            "bundleId": bundle_id,
            "progress": {
                "outcome": self.outcome,
                "ended_at": "2026-09-28T20:00:00+00:00" if ended else None,
            },
        }


async def _turn(runner: Runner, text: str, state_delta: dict | None = None) -> None:
    async for _event in runner.run_async(
        user_id=OWNER,
        session_id="chat",
        new_message=types.Content(role="user", parts=[types.Part(text=text)]),
        state_delta=state_delta,
    ):
        pass


async def _conversation(
    monkeypatch, *, redact: bool
) -> tuple[_RecordingModel, InMemorySessionService]:
    ledger = _Ledger()
    monkeypatch.setattr(agent_tree, "_requester_bundle", ledger)
    if not redact:
        # Negative control: everything else (tagging, the ledger read, the
        # latch) still runs; only the request rewrite is removed.
        monkeypatch.setattr(agent_tree, "redact_ended_consent_context", lambda *_: 0)
    model = _RecordingModel(
        [
            "Her favorite restaurant is Nopa.",
            "Nopa is on Divisadero.",
            "I no longer have that; I can ask her again.",
        ]
    )
    agent = agent_tree.build_one_text_agent(model=model)
    agent.instruction = "Fixture root."
    agent.tools = []
    sessions = InMemorySessionService()
    await sessions.create_session(app_name="one", user_id=OWNER, session_id="chat")
    runner = Runner(agent=agent, app_name="one", session_service=sessions)

    # 1. The answer turn: what the admission in agent_chat.py hands the agent.
    await _turn(
        runner,
        "Consent approved",
        {
            consent_outcome_state_key(BUNDLE): "granted",
            consent_shared_state_key(BUNDLE): {
                "personName": "Kushal",
                "labels": ["Food preferences"],
            },
            STATE_CONSENT_CONTINUATION: {
                "bundleId": BUNDLE,
                "outcome": "granted",
                "personName": "Kushal",
                "shared": store_request_secret("Favorite restaurant: Nopa"),
                "sharedLabels": ["Food preferences"],
                "declinedLabels": [],
            },
        },
    )
    # 2. A follow-up while access is live: its answer is derived from the share.
    await _turn(runner, "Where is it?")
    # 3. The owner revokes; the requester asks again in the same chat.
    ledger.outcome = "revoked"
    await _turn(runner, "Remind me where she likes to eat?")
    return model, sessions


@pytest.mark.asyncio
async def test_revoked_share_and_every_answer_derived_from_it_leave_the_model_context(
    monkeypatch,
) -> None:
    model, sessions = await _conversation(monkeypatch, redact=True)

    live_followup, after_revoke = model._requests[1], model._requests[2]
    # While access is live the earlier answer is context, as it should be.
    assert "Nopa" in _request_text(live_followup)
    # After revoke, neither the answer turn nor the follow-up survives.
    text = _request_text(after_revoke)
    assert "Nopa" not in text
    assert "Access to Food preferences from Kushal ended; do not use or repeat it." in text
    # The person's own words stay.
    assert "Where is it?" in text

    # The sealed events themselves are untouched; only the request changed.
    session = await sessions.get_session(app_name="one", user_id=OWNER, session_id="chat")
    stored = "\n".join(
        part.text or ""
        for event in session.events
        if event.content
        for part in event.content.parts or []
    )
    assert "Nopa is on Divisadero." in stored
    # Both tagged turns are projected as ended for the history the client renders.
    by_invocation, ended = redaction_for_history(session.state)
    assert ended == {BUNDLE: "revoked"}
    assert len(session.state[consent_invocations_state_key(BUNDLE)]) == 2
    assert set(by_invocation.values()) == {BUNDLE}
    assert session.state[consent_access_ended_state_key(BUNDLE)] == "revoked"


@pytest.mark.asyncio
async def test_negative_control_without_redaction_the_answer_is_replayed(monkeypatch) -> None:
    model, _sessions = await _conversation(monkeypatch, redact=False)
    assert "Nopa" in _request_text(model._requests[2])


@pytest.mark.asyncio
async def test_the_answer_turn_calls_no_tools_at_the_lowest_thinking_level(monkeypatch) -> None:
    model, _sessions = await _conversation(monkeypatch, redact=True)

    answer_turn, ordinary_turn = model._requests[0].config, model._requests[1].config
    assert answer_turn.tool_config.function_calling_config.mode == (
        types.FunctionCallingConfigMode.NONE
    )
    assert answer_turn.thinking_config.include_thoughts is False
    # MINIMAL is coerced to LOW for a supported release: the lowest it accepts.
    assert str(answer_turn.thinking_config.thinking_level).upper().endswith("LOW")
    # The fast path never leaks into the next turn through the shared agent config.
    assert ordinary_turn.tool_config is None


# ── Production shape (measured on localhost 2026-09-28, run 598321cd) ─────────
#
# Lane A's tests above use InMemorySessionService, which honours ADK's contract
# that ``temp:`` state never persists. Agent Chat seals the whole session with
# EncryptedAdkSessionService behind the AG-UI bridge, and that is where the
# leak lived. These run the real bridge, the real encrypted store (over an
# in-memory table), SSE streaming with thought parts, and a fresh bridge per
# turn, so every turn reads the sealed session back exactly as a new request,
# a restart or another worker would.


class _SessionTable:
    """``one_adk_sessions`` for the three statements the encrypted store issues."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str, str], dict[str, Any]] = {}

    def execute_raw(self, sql: str, params: dict[str, Any]) -> Any:
        from types import SimpleNamespace

        statement = " ".join(sql.split())
        if "session" not in params:
            return SimpleNamespace(data=[])  # list_sessions: the bridge's id lookup
        key = (params["app"], params["user"], params["session"])
        row = self.rows.get(key)
        if statement.startswith("INSERT"):
            if row is not None:
                return SimpleNamespace(data=[])
            self.rows[key] = {**params, "revision": 1}
            return SimpleNamespace(data=[{"revision": 1}])
        if statement.startswith("SELECT"):
            if row is None:
                return SimpleNamespace(data=[])
            payload = {f"payload_{name}": row[name] for name in ("ciphertext", "iv", "tag")}
            payload["payload_algorithm"] = row["algorithm"]
            return SimpleNamespace(data=[{**payload, "revision": row["revision"]}])
        if row is None or row["revision"] != params["revision"]:
            return SimpleNamespace(data=[])
        row.update({name: params[name] for name in ("ciphertext", "iv", "tag", "algorithm")})
        row["revision"] += 1
        return SimpleNamespace(data=[{"revision": row["revision"]}])


class _StreamingModel(BaseLlm):
    """Streams each scripted answer as SSE partials, then the aggregated final."""

    _script: list = PrivateAttr()
    _requests: list = PrivateAttr(default_factory=list)

    def __init__(self, script: list[list[types.Part]]) -> None:
        super().__init__(model="gemini-3.6-flash")
        self._script = script

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request.model_copy(deep=True))
        parts = self._script.pop(0)
        for part in parts if stream else []:
            if part.text and not part.thought:
                for chunk in (part.text[: len(part.text) // 2], part.text[len(part.text) // 2 :]):
                    yield LlmResponse(
                        content=types.Content(role="model", parts=[types.Part(text=chunk)]),
                        partial=True,
                    )
        yield LlmResponse(content=types.Content(role="model", parts=parts))


def _thought(text: str) -> types.Part:
    return types.Part(text=text, thought=True, thought_signature=b"signature")


def _everything_the_model_read(llm_request: Any) -> str:
    instruction = llm_request.config.system_instruction if llm_request.config else None
    return f"{instruction or ''}\n{_request_text(llm_request)}"


async def _agui_turn(service: Any, model: _StreamingModel, text: str, state: dict) -> str:
    from ag_ui.core import EventType

    events = await _agui_events(service, model, text, state)
    return "".join(e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT)


async def _agui_events(
    service: Any, model: _StreamingModel, text: str, state: dict, extra_tools: tuple = ()
) -> list[Any]:
    from ag_ui.core import RunAgentInput, UserMessage
    from google.adk.apps import App, ResumabilityConfig

    from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent
    from hushh_mcp.one_adk.external_read_boundary import STATE_EXECUTION_SURFACE

    root = agent_tree.build_one_text_agent(model=model, include_thought_summaries=True)
    root.tools = [*root.tools, *extra_tools]
    bridge = TimedADKAgent.from_app(
        App(
            name="hussh_one",
            root_agent=root,
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        head=HEAD_ONE,
        user_id_extractor=lambda _input: OWNER,
        session_service=service,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
        emit_messages_snapshot=True,
    )
    run_id = f"run-{len(model._requests)}"
    run = RunAgentInput(
        thread_id="chat",
        run_id=run_id,
        state={STATE_EXECUTION_SURFACE: "typed_chat", **state},
        context=[],
        forwarded_props={},
        messages=[UserMessage(id=f"message-{run_id}", role="user", content=text)],
        tools=[],
    )
    return [event async for event in bridge.run(run)]


def _ended_progress(ending: str) -> dict[str, Any]:
    if ending == "partial":
        # One field revoked while another stays granted.
        return {"outcome": "partially_granted", "ended_at": "2026-09-28T20:00:00+00:00"}
    return {"outcome": ending, "ended_at": "2026-09-28T20:00:00+00:00"}


async def _production_conversation(
    monkeypatch,
    *,
    ending: str = "revoked",
    follow_ups: int = 1,
    restart: bool = False,
    suggestions: bool = False,
) -> dict[str, Any]:
    from hushh_mcp.one_adk import encrypted_session_service, request_secrets
    from tests.helpers.chat_keys import static_chat_cipher

    table = _SessionTable()
    monkeypatch.setattr(encrypted_session_service, "get_db", lambda: table)
    ledger = _Ledger()
    monkeypatch.setattr(agent_tree, "_requester_bundle", ledger)
    shared_outcome = "partially_granted" if ending == "partial" else "granted"
    answers = [[_thought("Reading the shared block"), types.Part(text="It is Nopa.")]]
    for index in range(follow_ups):
        answer = types.Part(text=f"Nopa is on Divisadero ({index}).")
        if suggestions:
            # One's own follow-up chips end the turn in the same model call.
            chips = types.FunctionCall(
                name="suggest_follow_ups", args={"suggestions": ["Book a table", "Find similar"]}
            )
            answers.append([_thought("Answering"), answer, types.Part(function_call=chips)])
            continue
        clock = types.FunctionCall(name="get_current_time", args={})
        answers.append([_thought("Checking the time"), answer, types.Part(function_call=clock)])
        answers.append([types.Part(text=f"Nopa opens at five ({index}).")])
    answers.append([types.Part(text="I no longer have that; I can ask again.")])
    model = _StreamingModel(answers)
    service = encrypted_session_service.EncryptedAdkSessionService(static_chat_cipher())

    await _agui_turn(
        service,
        model,
        "Partly approved" if ending == "partial" else "Consent approved",
        {
            consent_outcome_state_key(BUNDLE): shared_outcome,
            consent_shared_state_key(BUNDLE): {"personName": "Kushal", "labels": ["Food"]},
            STATE_CONSENT_CONTINUATION: {
                "bundleId": BUNDLE,
                "outcome": shared_outcome,
                "personName": "Kushal",
                "shared": store_request_secret("Favorite restaurant: Nopa"),
                "sharedLabels": ["Food"],
                "declinedLabels": ["Drinks"] if ending == "partial" else [],
            },
        },
    )
    follow_up_texts = [
        await _agui_turn(service, model, f"Where is it? ({index})", {})
        for index in range(follow_ups)
    ]
    ledger.outcome = ending
    ledger_progress = _ended_progress(ending)

    async def ended_view(owner_id: str, bundle_id: str) -> dict[str, Any]:
        ledger.reads.append((owner_id, bundle_id))
        return {"bundleId": bundle_id, "progress": ledger_progress}

    monkeypatch.setattr(agent_tree, "_requester_bundle", ended_view)
    if restart:
        # A new process: nothing in memory survives, only the sealed row.
        monkeypatch.setattr(request_secrets, "_values", {})
        service = encrypted_session_service.EncryptedAdkSessionService(static_chat_cipher())
    await _agui_turn(service, model, "Remind me where she likes to eat?", {})
    session = await service.get_session(app_name="hussh_one", user_id=OWNER, session_id="chat")
    return {"model": model, "session": session, "follow_up_texts": follow_up_texts}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("ending", "follow_ups", "restart"),
    [
        ("revoked", 1, False),
        ("revoked", 3, False),
        ("revoked", 1, True),
        ("expired", 1, False),
        ("partial", 2, False),
    ],
)
async def test_production_shape_nothing_shared_reaches_the_model_after_access_ends(
    monkeypatch, ending, follow_ups, restart
) -> None:
    result = await _production_conversation(
        monkeypatch, ending=ending, follow_ups=follow_ups, restart=restart
    )
    requests = result["model"]._requests
    after_end = requests[-1]
    read = _everything_the_model_read(after_end)
    # Neither the shared block, nor the answer, nor any live follow-up survives.
    assert "Nopa" not in read
    assert "BEGIN SHARED-" not in read
    assert "Access to Food from Kushal ended; do not use or repeat it." in read
    # The person's own words stay.
    for index in range(follow_ups):
        assert f"Where is it? ({index})" in read
    # The shared block was in the answer turn only, never replayed after it.
    assert "BEGIN SHARED-" in _everything_the_model_read(requests[0])
    assert all("BEGIN SHARED-" not in _everything_the_model_read(r) for r in requests[1:])
    # Sealed state holds no per-invocation (``temp:``) value, so no later
    # turn, restart or other worker can inherit the answer turn's authority.
    assert not [key for key in result["session"].state if key.startswith("temp:")]
    assert result["session"].state[consent_access_ended_state_key(BUNDLE)] == (
        "revoked" if ending == "partial" else ending
    )


@pytest.mark.asyncio
async def test_production_shape_live_follow_up_runs_tools_and_answers_once(monkeypatch) -> None:
    """The duplicated follow-up sentence (run 476c20f1): the follow-up inherited the
    sealed answer-turn record, its tool call was refused as ``consent_answer_turn``,
    and the second model call restated the answer into the same message."""
    result = await _production_conversation(monkeypatch, follow_ups=1, suggestions=True)
    requests = result["model"]._requests
    # Answer turn, ONE follow-up call, then the turn after the end of access.
    assert len(requests) == 3
    assert requests[1].config.tool_config is None
    assert result["follow_up_texts"] == ["Nopa is on Divisadero (0)."]


# ── The auto-answer printed its sentence twice (localhost run 2da4bf9c) ───────
#
# The answer turn's model wrote the answer and, in the same response, called a
# tool. The consent-answer gate refused it, ADK asked the model again with the
# refusal, and the second call restated the answer into the same message. The
# provider emitted that call although the request carried mode NONE, so the
# guarantee has to hold in code whatever the model returns.

ANSWER = "Kushal's favorite restaurant is Nopa in San Francisco."


def _call(name: str, args: dict[str, Any]) -> types.Part:
    return types.Part(function_call=types.FunctionCall(name=name, args=args))


_CHIPS = _call("suggest_follow_ups", {"suggestions": ["Book a table", "Find similar places"]})
_READ = _call("read_saved_notes", {"topic": "restaurants"})


async def _consent_answer_turn(
    monkeypatch, script: list[list[types.Part]]
) -> tuple[_StreamingModel, list[Any], list[str]]:
    from hushh_mcp.one_adk import encrypted_session_service
    from tests.helpers.chat_keys import static_chat_cipher

    table = _SessionTable()
    monkeypatch.setattr(encrypted_session_service, "get_db", lambda: table)
    monkeypatch.setattr(agent_tree, "_requester_bundle", _Ledger())
    reads: list[str] = []

    async def read_saved_notes(topic: str) -> dict[str, Any]:
        """Read the person's saved notes on a topic."""
        reads.append(topic)
        return {"notes": []}

    model = _StreamingModel(script)
    service = encrypted_session_service.EncryptedAdkSessionService(static_chat_cipher())
    events = await _agui_events(
        service,
        model,
        "Consent approved",
        {
            consent_outcome_state_key(BUNDLE): "granted",
            consent_shared_state_key(BUNDLE): {"personName": "Kushal", "labels": ["Food"]},
            STATE_CONSENT_CONTINUATION: {
                "bundleId": BUNDLE,
                "outcome": "granted",
                "personName": "Kushal",
                "shared": store_request_secret("Favorite restaurant: Nopa"),
                "sharedLabels": ["Food"],
                "declinedLabels": [],
            },
        },
        (read_saved_notes,),
    )
    return model, events, reads


def _streamed_text(events: list[Any]) -> str:
    from ag_ui.core import EventType

    return "".join(e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT)


def _tool_results(events: list[Any]) -> dict[str, dict[str, Any]]:
    import json

    from ag_ui.core import EventType

    names = {
        e.tool_call_id: e.tool_call_name for e in events if e.type == EventType.TOOL_CALL_START
    }
    return {
        names[e.tool_call_id]: json.loads(e.content)
        for e in events
        if e.type == EventType.TOOL_CALL_RESULT and e.tool_call_id in names
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("script", "model_calls", "results"),
    [
        # The run 2da4bf9c shape: One's chips end the turn in the answering call.
        (
            [[_thought("Answering"), types.Part(text=ANSWER), _CHIPS]],
            1,
            {"suggest_follow_ups": "shown"},
        ),
        # Any other tool after the answer is refused, and the refusal ends the turn.
        ([[types.Part(text=ANSWER), _READ]], 1, {"read_saved_notes": "blocked"}),
        # A tool asked for before any answer keeps the retry: never a silent turn.
        ([[_READ], [types.Part(text=ANSWER)]], 2, {"read_saved_notes": "blocked"}),
    ],
    ids=["follow_ups", "tool_after_answer", "tool_before_answer"],
)
async def test_the_consent_answer_is_printed_once_and_reads_nothing(
    monkeypatch, script, model_calls, results
) -> None:
    model, events, reads = await _consent_answer_turn(monkeypatch, script)

    assert len(model._requests) == model_calls
    assert _streamed_text(events).count(ANSWER) == 1
    assert reads == []
    assert {name: result["status"] for name, result in _tool_results(events).items()} == results
    # Every model call of the answer turn is asked for no function calls.
    for request in model._requests:
        assert request.config.tool_config.function_calling_config.mode == (
            types.FunctionCallingConfigMode.NONE
        )


@pytest.mark.asyncio
async def test_negative_control_a_non_terminal_refusal_restates_the_answer(monkeypatch) -> None:
    """The pre-fix gate refused every tool, chips included, and let ADK call again."""

    def refuse_every_tool(tool: Any, args: dict, tool_context: Any) -> dict | None:
        del tool, args
        if tool_context.state.get(STATE_CONSENT_CONTINUATION):
            return {"status": "blocked", "reason": "consent_answer_turn"}
        return None

    monkeypatch.setattr(agent_tree, "_before_one_tool", refuse_every_tool)
    model, events, _reads = await _consent_answer_turn(
        monkeypatch, [[types.Part(text=ANSWER), _CHIPS], [types.Part(text=ANSWER)]]
    )

    assert len(model._requests) == 2
    assert _streamed_text(events).count(ANSWER) == 2


@pytest.mark.asyncio
async def test_production_shape_negative_control_without_redaction_it_leaks(monkeypatch) -> None:
    monkeypatch.setattr(agent_tree, "redact_ended_consent_context", lambda *_: 0)
    result = await _production_conversation(monkeypatch, follow_ups=2)
    assert "Nopa" in _request_text(result["model"]._requests[-1])


def test_an_unverifiable_shape_fails_closed_for_the_ended_bundle(caplog) -> None:
    """A tagged turn whose message the request no longer carries (a merged or
    compacted history ADK might produce) cannot be located by identity, so every
    agent-side content from the start is replaced; the person's words stay."""
    from types import SimpleNamespace

    from google.adk.events import Event
    from google.adk.models.llm_request import LlmRequest

    from hushh_mcp.one_adk.consent_redaction import (
        STATE_ENDED_CONSENT,
        redact_ended_consent_context,
    )

    def content(role: str, text: str) -> types.Content:
        return types.Content(role=role, parts=[types.Part(text=text)])

    events = [
        Event(invocation_id="answer", author="user", content=content("user", "Consent approved")),
        Event(invocation_id="answer", author="one", content=content("model", "It is Nopa.")),
        Event(invocation_id="now", author="user", content=content("user", "Where does she eat?")),
    ]
    state = {
        consent_invocations_state_key(BUNDLE): ["answer"],
        STATE_ENDED_CONSENT: {BUNDLE: "Access to Food from Kushal ended."},
    }
    request = LlmRequest(
        contents=[
            # The answer, merged into a shape no stored event has, without its turn's message.
            content("model", "Summary so far: her favorite restaurant is Nopa."),
            content("user", "Where does she eat?"),
        ]
    )
    context = SimpleNamespace(
        state=state, session=SimpleNamespace(events=events), invocation_id="now"
    )

    with caplog.at_level("INFO"):
        replaced = redact_ended_consent_context(context, request)

    assert replaced == 1
    assert "Nopa" not in _request_text(request)
    assert _request_text(request) == "Access to Food from Kushal ended.\nWhere does she eat?"
    assert "one.consent_redaction_unverified" in caplog.text
    # The suite-wide log redaction filter masks ids as [REDACTED], so assert the
    # behaviour (fail-closed replacement), not the literal bundle id.
    assert "one.consent_redaction_unverified" in caplog.text
    assert "mode=fail_closed" in caplog.text
    assert "replaced=0" not in caplog.text


@pytest.mark.asyncio
async def test_a_continuation_record_replayed_into_a_later_turn_is_refused(monkeypatch) -> None:
    """Defense in depth for the root cause: however a stale record comes back,
    it neither re-renders the shared block nor blocks tools nor skips the check."""
    ledger = _Ledger()
    monkeypatch.setattr(agent_tree, "_requester_bundle", ledger)
    model = _RecordingModel(["It is Nopa.", "Ask me anything.", "I no longer have that."])
    agent = agent_tree.build_one_text_agent(model=model)
    agent.instruction = agent_tree._one_runtime_instruction
    agent.tools = []
    sessions = InMemorySessionService()
    await sessions.create_session(app_name="one", user_id=OWNER, session_id="chat")
    runner = Runner(agent=agent, app_name="one", session_service=sessions)
    continuation = {
        STATE_CONSENT_CONTINUATION: {
            "bundleId": BUNDLE,
            "outcome": "granted",
            "personName": "Kushal",
            "shared": store_request_secret("Favorite restaurant: Nopa"),
            "sharedLabels": ["Food"],
            "declinedLabels": [],
        }
    }
    await _turn(
        runner,
        "Consent approved",
        {
            consent_outcome_state_key(BUNDLE): "granted",
            consent_shared_state_key(BUNDLE): {"personName": "Kushal", "labels": ["Food"]},
            **continuation,
        },
    )
    await _turn(runner, "Thanks", continuation)
    ledger.outcome = "revoked"
    await _turn(runner, "Where does she eat?", continuation)

    answer, live, ended = (str(r.config.system_instruction) for r in model._requests)
    assert "BEGIN SHARED-" in answer
    assert "BEGIN SHARED-" not in live and "BEGIN SHARED-" not in ended
    assert model._requests[1].config.tool_config is None
    assert "Nopa" not in _everything_the_model_read(model._requests[2])
