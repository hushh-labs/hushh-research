from __future__ import annotations

import asyncio

import pytest
from google.adk.events import Event, EventActions
from google.genai import types as genai_types

from hushh_mcp.one_adk import text_runtime
from hushh_mcp.one_adk.agent_tree import (
    ONE_APP_NAME,
    STATE_CONSENT_TOKEN,
    STATE_PKM_CONTEXT,
    STATE_VOICE_CONTEXT,
)
from hushh_mcp.one_adk.text_runtime import OneTextStreamEvent
from hushh_mcp.services.agent_chat_service import AgentChatMessage


def test_managed_text_runtime_uses_explicit_vertex_contract(monkeypatch):
    monkeypatch.setenv("HUSHH_GENAI_AUTH_MODE", "vertex_adc")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "hushh-test")
    monkeypatch.setenv("GOOGLE_CLOUD_LOCATION", "asia-southeast1")

    model = text_runtime._runtime_model(
        runtime_model="gemini-test",
        runtime_mode="hushh_managed_vertex",
        runtime_credential=None,
    )

    assert model.model == "gemini-test"
    assert model.client_kwargs == {
        "vertexai": True,
        "project": "hushh-test",
        "location": "asia-southeast1",
    }


async def test_text_runtime_replays_history_and_extracts_generated_directive(monkeypatch):
    observed: dict = {}

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            assert app_name == ONE_APP_NAME
            observed["agent"] = agent
            self.session_service = session_service

        async def run_async(self, *, user_id, session_id, new_message, run_config):
            session = await self.session_service.get_session(
                app_name=ONE_APP_NAME,
                user_id=user_id,
                session_id=session_id,
            )
            assert session is not None
            observed["state"] = session.state
            observed["history"] = list(session.events)
            observed["message"] = new_message.parts[0].text
            yield Event(
                author="one",
                partial=True,
                content=genai_types.Content(
                    role="model",
                    parts=[genai_types.Part.from_text(text="Opening Location.")],
                ),
            )
            yield Event(
                author="one",
                actions=EventActions(
                    state_delta={
                        "hussh:pending_directive:route.one_location": {
                            "kind": "action",
                            "payload": {"actionId": "route.one_location", "slots": {}},
                        }
                    }
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    history = [
        AgentChatMessage(
            id="m1",
            conversation_id="c1",
            user_id="u1",
            role="assistant",
            status="complete",
            content="Where would you like to go?",
            model="gemini",
            created_at=None,
            completed_at=None,
        )
    ]

    opaque_token = "opaque-owner-" + "token"
    events: list[OneTextStreamEvent] = []
    async for event in text_runtime.stream_one_text_turn(
        user_id="u1",
        consent_token=opaque_token,
        conversation_id="c1",
        message="take me to location",
        history=history,
        timezone="America/Los_Angeles",
        screen_context={"screen": "one_home", "available_action_ids": []},
        pkm_context="bounded context",
        runtime_provider="gemini",
        runtime_model="gemini-test",
        runtime_mode="hushh_managed_vertex",
        runtime_credential=None,
    ):
        events.append(event)

    assert [event.kind for event in events] == ["token", "directive"]
    assert events[1].directive is not None
    assert events[1].directive.payload["actionId"] == "route.one_location"
    assert observed["message"] == "take me to location"
    assert observed["history"][0].content.parts[0].text == "Where would you like to go?"
    assert observed["state"][STATE_CONSENT_TOKEN] == opaque_token
    assert observed["state"][STATE_VOICE_CONTEXT]["screen"] == "one_home"
    assert observed["state"][STATE_PKM_CONTEXT] == "bounded context"


def test_text_runtime_rejects_unknown_client_action_directive():
    directive = text_runtime._directive_from_value(
        {
            "kind": "action",
            "payload": {"actionId": "route.not_in_generated_contract"},
        }
    )

    assert directive is None


@pytest.mark.asyncio
async def test_managed_text_runtime_fails_over_only_before_observable_output(monkeypatch):
    class _Unavailable(Exception):
        status_code = 503

    monkeypatch.setattr(
        text_runtime.ManagedGeminiRuntimeBinding,
        "from_environment",
        classmethod(
            lambda cls: type(
                "Binding",
                (),
                {
                    "locations_for_model": lambda self, _model: (
                        "primary",
                        "secondary",
                    )
                },
            )()
        ),
    )
    attempts: list[str | None] = []

    async def _attempt(**kwargs):
        location = kwargs["managed_location"]
        attempts.append(location)
        if location == "primary":
            raise _Unavailable("unavailable")
        yield OneTextStreamEvent(kind="token", text="Recovered")

    monkeypatch.setattr(text_runtime, "_stream_one_text_turn_once", _attempt)
    opaque_token = "opaque-" + "token"
    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="hello",
            history=[],
            timezone=None,
            screen_context={},
            pkm_context=None,
            runtime_provider="gemini",
            runtime_model="gemini-test",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        )
    ]

    assert [event.text for event in events] == ["Recovered"]
    assert attempts == ["primary", "secondary"]


@pytest.mark.asyncio
async def test_managed_text_runtime_never_replays_after_tool_boundary(monkeypatch):
    class _Unavailable(Exception):
        status_code = 503

    monkeypatch.setattr(
        text_runtime.ManagedGeminiRuntimeBinding,
        "from_environment",
        classmethod(
            lambda cls: type(
                "Binding",
                (),
                {
                    "locations_for_model": lambda self, _model: (
                        "primary",
                        "secondary",
                    )
                },
            )()
        ),
    )
    attempts: list[str | None] = []

    async def _attempt(**kwargs):
        attempts.append(kwargs["managed_location"])
        yield OneTextStreamEvent(kind="boundary")
        raise _Unavailable("failed after tool call")

    monkeypatch.setattr(text_runtime, "_stream_one_text_turn_once", _attempt)
    opaque_token = "opaque-" + "token"
    with pytest.raises(_Unavailable):
        async for _ in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="hello",
            history=[],
            timezone=None,
            screen_context={},
            pkm_context=None,
            runtime_provider="gemini",
            runtime_model="gemini-test",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        ):
            pass

    assert attempts == ["primary"]


async def test_text_runtime_emits_non_partial_final_memory_summary(monkeypatch):
    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service

        async def run_async(self, **kwargs):  # noqa: ANN003
            yield Event(
                author="one",
                partial=False,
                content=genai_types.Content(
                    role="model",
                    parts=[genai_types.Part.from_text(text="You prefer concise summaries.")],
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    opaque_token = "opaque-" + "token"

    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="list down a summary of my memory",
            history=[],
            timezone="America/Los_Angeles",
            screen_context={"screen": "one_home"},
            pkm_context="Writing preference: concise summaries.",
            runtime_provider="gemini",
            runtime_model="gemini-3.5-flash",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        )
    ]

    assert [event.text for event in events] == ["You prefer concise summaries."]


@pytest.mark.asyncio
async def test_bounded_adk_events_times_out_stalled_first_event(monkeypatch):
    async def stalled():
        await asyncio.sleep(0.05)
        yield object()

    monkeypatch.setattr(text_runtime, "_FIRST_EVENT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(text_runtime, "_TOTAL_TURN_TIMEOUT_SECONDS", 0.1)

    with pytest.raises(asyncio.TimeoutError):
        async for _ in text_runtime._bounded_adk_events(stalled()):
            pass


@pytest.mark.asyncio
async def test_bounded_adk_events_accepts_provider_first_event_budget():
    async def delayed():
        await asyncio.sleep(0.01)
        yield "ready"

    observed = [
        event
        async for event in text_runtime._bounded_adk_events(delayed(), first_event_timeout=0.05)
    ]

    assert observed == ["ready"]


@pytest.mark.asyncio
async def test_bounded_adk_events_times_out_stalled_followup(monkeypatch):
    first = object()

    async def stalled():
        yield first
        await asyncio.sleep(0.05)
        yield object()

    monkeypatch.setattr(text_runtime, "_BETWEEN_EVENT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(text_runtime, "_TOTAL_TURN_TIMEOUT_SECONDS", 0.1)

    observed = []
    with pytest.raises(asyncio.TimeoutError):
        async for event in text_runtime._bounded_adk_events(stalled()):
            observed.append(event)

    assert observed == [first]


async def test_text_runtime_rejects_silent_model_completion(monkeypatch):
    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service

        async def run_async(self, **kwargs):  # noqa: ANN003
            if False:
                yield None

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    opaque_token = "opaque-" + "token"

    with pytest.raises(text_runtime.OneTextEmptyResponseError):
        async for _ in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="list down a summary of my memory",
            history=[],
            timezone=None,
            screen_context={"screen": "one_home"},
            pkm_context="Writing preference: concise summaries.",
            runtime_provider="gemini",
            runtime_model="gemini-3.5-flash",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        ):
            pass


async def test_text_runtime_persists_the_aggregated_final_and_commits_it_to_memory(monkeypatch):
    """The aggregate is what memory reads; streamed partials are not duplicated.

    Mirrors what ADK's runner does with the provider adapter's output: partial
    token events stream through, and only the single non-partial aggregate is
    appended to the session. The turn must (a) emit each token once, never the
    aggregate a second time, and (b) hand memory a session that holds One's
    complete answer, which the old all-partial shape never did.
    """
    committed: list = []

    class _Recorder:
        async def add_session_to_memory(self, session):  # noqa: ANN001
            committed.append(session)

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service
            self.memory_service = memory_service

        async def run_async(self, *, user_id, session_id, new_message, run_config):
            session = await self.session_service.get_session(
                app_name=ONE_APP_NAME, user_id=user_id, session_id=session_id
            )
            for token in ("the answer ", "is 42"):
                yield Event(
                    author="one",
                    partial=True,
                    content=genai_types.Content(
                        role="model", parts=[genai_types.Part.from_text(text=token)]
                    ),
                )
            final = Event(
                author="one",
                partial=False,
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="the answer is 42")]
                ),
            )
            await self.session_service.append_event(session=session, event=final)
            yield final

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    monkeypatch.setattr(text_runtime, "_resolve_pod_memory_service", lambda: _Recorder())
    opaque_token = "opaque-" + "token"

    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="what is x",
            history=[],
            timezone="America/Los_Angeles",
            screen_context={"screen": "one_home"},
            pkm_context="",
            runtime_provider="puppy",
            runtime_model="local",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        )
    ]

    assert [event.text for event in events if event.kind == "token"] == ["the answer ", "is 42"]
    assert len(committed) == 1
    stored_texts = [
        "".join(part.text or "" for part in event.content.parts)
        for event in committed[0].events
        if getattr(event, "author", "") == "one" and event.content
    ]
    assert stored_texts == ["the answer is 42"], stored_texts


async def test_text_runtime_treats_an_all_partial_tool_call_turn_as_silent(monkeypatch):
    """Negative control for the adapter fix: the pre-fix shape is a silent turn.

    Only partial events carrying a function call, then nothing non-partial:
    no token, no directive, nothing for memory. The runtime must refuse it as
    an empty answer rather than report success.
    """
    committed: list = []

    class _Recorder:
        async def add_session_to_memory(self, session):  # noqa: ANN001
            committed.append(session)

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service

        async def run_async(self, **kwargs):  # noqa: ANN003
            yield Event(
                author="one",
                partial=True,
                content=genai_types.Content(
                    role="model",
                    parts=[
                        genai_types.Part(
                            function_call=genai_types.FunctionCall(
                                id="call-1", name="lookup", args={"q": "x"}
                            )
                        )
                    ],
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    monkeypatch.setattr(text_runtime, "_resolve_pod_memory_service", lambda: _Recorder())
    opaque_token = "opaque-" + "token"

    with pytest.raises(text_runtime.OneTextEmptyResponseError):
        async for _event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token=opaque_token,
            conversation_id="c1",
            message="what is x",
            history=[],
            timezone="America/Los_Angeles",
            screen_context={"screen": "one_home"},
            pkm_context="",
            runtime_provider="puppy",
            runtime_model="local",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        ):
            pass
    assert committed == [], "a silent turn must never be committed to memory"


async def test_text_runtime_stamps_the_reported_model_on_token_events(monkeypatch):
    """The provider's `model_version` rides on every token event so the pod turn
    route can report the model that answered rather than the one it asked for."""

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service

        async def run_async(self, *, user_id, session_id, new_message, run_config):
            yield Event(
                author="one",
                partial=True,
                model_version="qwen3-30b-a3b-mlx",
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="Hello")]
                ),
            )
            yield Event(
                author="one",
                partial=False,
                model_version="qwen3-30b-a3b-mlx",
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="Hello")]
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token="opaque-" + "token",
            conversation_id="c1",
            message="hi",
            history=[],
            timezone=None,
            screen_context=None,
            pkm_context=None,
            runtime_provider="gemini",
            runtime_model="gemini-test",
            runtime_mode="byok",
            runtime_credential="k",
        )
    ]
    tokens = [event for event in events if event.kind == "token"]
    assert tokens and all(event.model_version == "qwen3-30b-a3b-mlx" for event in tokens)


async def test_text_runtime_leaves_model_version_empty_when_unreported_negative_control(
    monkeypatch,
):
    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service

        async def run_async(self, *, user_id, session_id, new_message, run_config):
            yield Event(
                author="one",
                partial=True,
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="Hello")]
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token="opaque-" + "token",
            conversation_id="c1",
            message="hi",
            history=[],
            timezone=None,
            screen_context=None,
            pkm_context=None,
            runtime_provider="gemini",
            runtime_model="gemini-test",
            runtime_mode="byok",
            runtime_credential="k",
        )
    ]
    assert [event.model_version for event in events if event.kind == "token"] == [""]


async def test_text_runtime_reports_observed_recall_digest_and_catch_up(monkeypatch):
    """The learning loop on ONE turn, read from the runner's own events.

    * the curated digest is seeded into session state before the runner starts;
    * a `load_memory` call and its response are paired into `memory.recalls`
      ({queryChars, hits, backend}) off the function parts, never the answer;
    * the catch-up review ran on the SAME model object before the answer; and
    * the one `memory` event carries counts only.
    """
    from google.adk.agents.run_config import RunConfig

    from hushh_mcp.one_adk.agent_tree import STATE_MEMORY_AVAILABLE, STATE_MEMORY_DIGEST

    class _Memory:
        last_recall_backend = None
        last_written = 0
        provider_report = {"consent": "absent", "generate": "no_bank", "recall": "no_bank"}

        def __init__(self) -> None:
            self.pending = 2
            self.digest_calls: list[int] = []

        async def digest(self, max_chars: int) -> str:
            self.digest_calls.append(max_chars)
            return "- the dachshund is named Pushkin"

        def unreviewed_count(self) -> int:
            return self.pending

        async def add_session_to_memory(self, session) -> None:  # noqa: ANN001
            self.last_written = 3

    memory = _Memory()
    reviewed: dict = {}

    async def _review(**kwargs):
        from hushh_mcp.one_adk.memory_review import MemoryReviewResult

        reviewed.update(kwargs)
        memory.pending = 0
        return MemoryReviewResult(
            outcome="applied", reason="catch_up", through_seq=4, records=2, ops={"remember": 1}
        )

    observed: dict = {}

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service
            observed["agent_model"] = agent[1]

        async def run_async(self, *, user_id, session_id, new_message, run_config: RunConfig):
            session = await self.session_service.get_session(
                app_name=ONE_APP_NAME, user_id=user_id, session_id=session_id
            )
            observed["state"] = dict(session.state)
            memory.last_recall_backend = "commit_log"
            yield Event(
                author="one",
                content=genai_types.Content(
                    role="model",
                    parts=[
                        genai_types.Part.from_function_call(
                            name="load_memory", args={"query": "dog name"}
                        )
                    ],
                ),
            )
            yield Event(
                author="one",
                content=genai_types.Content(
                    role="user",
                    parts=[
                        genai_types.Part.from_function_response(
                            name="load_memory",
                            response={"result": {"memories": [{"content": "x"}]}},
                        )
                    ],
                ),
            )
            yield Event(
                author="one",
                partial=False,
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="Pushkin.")]
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    monkeypatch.setattr(text_runtime, "_runtime_model", lambda **_kw: "the-model-object")
    monkeypatch.setattr(text_runtime, "_resolve_pod_memory_service", lambda: memory)
    monkeypatch.setattr("hushh_mcp.one_adk.memory_review.run_memory_review", _review)

    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token="opaque-" + "token",
            conversation_id="c1",
            message="what is my dog called?",
            history=[],
            timezone="UTC",
            screen_context=None,
            pkm_context="",
            runtime_provider="gemini",
            runtime_model="gemini-test",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        )
    ]

    assert [e.text for e in events if e.kind == "token"] == ["Pushkin."]
    report = [e for e in events if e.kind == "memory"]
    assert len(report) == 1
    memory_report = report[0].memory
    assert memory_report["enabled"] is True
    assert memory_report["recalls"] == [{"queryChars": 8, "hits": 1, "backend": "commit_log"}]
    assert memory_report["written"] == 3
    assert memory_report["review"]["outcome"] == "applied"
    assert memory_report["provider"]["recall"] == "no_bank"
    assert "dog" not in str(memory_report) and "Pushkin" not in str(memory_report)
    # The digest was seeded before the runner started, bounded by the pod's record.
    assert observed["state"][STATE_MEMORY_AVAILABLE] is True
    assert observed["state"][STATE_MEMORY_DIGEST] == "- the dachshund is named Pushkin"
    assert memory.digest_calls == [1200]
    # The catch-up ran on the same model object the agent was built with.
    assert reviewed["model"] == "the-model-object" == observed["agent_model"]
    assert reviewed["reason"] == "catch_up"
    assert reviewed["budget_seconds"] == 45.0 and reviewed["max_records"] == 12
    # This turn was started with no policy, so the review is handed one that
    # retires nothing. Default-deny is made explicit at the boundary rather than
    # left to the callee's default, so what an unauthorised caller gets is visible
    # here rather than two modules away.
    assert reviewed["policy"].may_retire is False
    assert reviewed["policy"].authority == "unstated"


async def test_the_catch_up_review_carries_the_turns_verified_authority(monkeypatch):
    """The turn's door decided this, and the runtime carries it without reading it.

    The catch-up review is the stand-in for a close the person never sent, and two
    of its four tools retire a held fact. Passing nothing meant it could retire
    nothing for every caller, the full-authority owner included, so a correction
    they spoke was remembered while the stale fact stayed live. What this pins is
    the thread: what the route resolved is what the reviewer is asked for. Nothing
    in this module reads a session, a binding or a scope to reach it.
    """
    from hushh_mcp.one_adk.memory_review import MemoryReviewPolicy, MemoryReviewResult

    class _Memory:
        last_recall_backend = None
        last_written = 0
        provider_report: dict = {}
        pending = 1

        async def digest(self, max_chars: int) -> str:
            return ""

        def unreviewed_count(self) -> int:
            return self.pending

        async def add_session_to_memory(self, session) -> None:  # noqa: ANN001
            self.last_written = 1

    memory = _Memory()
    reviewed: dict = {}

    async def _review(**kwargs):
        reviewed.update(kwargs)
        memory.pending = 0
        return MemoryReviewResult(outcome="applied", reason="catch_up", through_seq=1, records=1)

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            pass

        async def run_async(self, *, user_id, session_id, new_message, run_config):
            yield Event(
                author="one",
                partial=False,
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="ok")]
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    monkeypatch.setattr(text_runtime, "_runtime_model", lambda **_kw: "the-model-object")
    monkeypatch.setattr(text_runtime, "_resolve_pod_memory_service", lambda: memory)
    monkeypatch.setattr("hushh_mcp.one_adk.memory_review.run_memory_review", _review)

    granted = MemoryReviewPolicy(may_retire=True, authority="binding_scope")
    async for _event in text_runtime.stream_one_text_turn(
        user_id="u1",
        consent_token="opaque-" + "token",
        conversation_id="c1",
        message="forget the meridian account",
        history=[],
        timezone=None,
        screen_context=None,
        pkm_context=None,
        runtime_provider="gemini",
        runtime_model="gemini-test",
        runtime_mode="byok",
        runtime_credential="k",
        memory_review_policy=granted,
    ):
        pass

    assert reviewed["policy"] is granted, "the door's own verdict, not a rebuilt one"
    assert reviewed["policy"].may_retire is True


def test_event_memory_recalls_reads_only_load_memory_parts():
    call = Event(
        author="one",
        content=genai_types.Content(
            role="model",
            parts=[
                genai_types.Part.from_function_call(name="load_memory", args={"query": "abcd"}),
                genai_types.Part.from_function_call(name="open_screen", args={"screen": "x"}),
            ],
        ),
    )
    reply = Event(
        author="one",
        content=genai_types.Content(
            role="user",
            parts=[
                genai_types.Part.from_function_response(
                    name="load_memory", response={"memories": [{"a": 1}, {"b": 2}]}
                ),
                genai_types.Part.from_function_response(name="open_screen", response={"ok": 1}),
            ],
        ),
    )
    foreign = Event(author="user", content=call.content)
    observed = (
        text_runtime._event_memory_recalls(call, backend="commit_log")
        + text_runtime._event_memory_recalls(reply, backend="commit_log")
        + text_runtime._event_memory_recalls(foreign)
    )
    assert text_runtime._pair_memory_recalls(observed) == [
        {"queryChars": 4, "hits": 2, "backend": "commit_log"}
    ]
    # An unanswered call still counts as an observed call with zero hits.
    assert text_runtime._pair_memory_recalls(text_runtime._event_memory_recalls(call)) == [
        {"queryChars": 4, "hits": 0, "backend": None}
    ]


async def test_a_second_model_step_answer_is_not_discarded_as_a_duplicate(monkeypatch):
    """The shape of the twenty characters both live Puppy turns delivered.

    A turn that calls a tool has more than one model step: a short preamble, the
    tool, then the real answer. `saw_partial_text` exists to stop a step's
    aggregate being emitted a second time after its own partials already went
    out. It was set once and never cleared, so it answered that question for the
    whole TURN: the preamble's partials latched it, and the answer that arrived
    in the next step was thrown away as a duplicate of text nobody had sent.

    Measured before the fix: this test delivered "Let me check. " and nothing
    else.
    """

    class _Recorder:
        async def add_session_to_memory(self, session):  # noqa: ANN001
            pass

    class _FakeRunner:
        def __init__(self, *, app_name, agent, session_service, memory_service=None):
            self.session_service = session_service

        async def run_async(self, *, user_id, session_id, new_message, run_config):
            # Step one: a preamble, streamed and then aggregated.
            yield Event(
                author="one",
                partial=True,
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="Let me check. ")]
                ),
            )
            yield Event(
                author="one",
                partial=False,
                content=genai_types.Content(
                    role="model", parts=[genai_types.Part.from_text(text="Let me check. ")]
                ),
            )
            # Step two, after the tool ran: the answer, aggregate only.
            yield Event(
                author="one",
                partial=False,
                content=genai_types.Content(
                    role="model",
                    parts=[genai_types.Part.from_text(text="Your dog is called Bo.")],
                ),
            )

    monkeypatch.setattr(text_runtime, "Runner", _FakeRunner)
    monkeypatch.setattr(text_runtime, "build_one_text_agent", lambda *, model: ("one", model))
    monkeypatch.setattr(text_runtime, "_resolve_pod_memory_service", lambda: _Recorder())

    events = [
        event
        async for event in text_runtime.stream_one_text_turn(
            user_id="u1",
            consent_token="opaque-" + "token",
            conversation_id="c1",
            message="what is my dog called",
            history=[],
            timezone="America/Los_Angeles",
            screen_context={"screen": "one_home"},
            pkm_context="",
            runtime_provider="puppy",
            runtime_model="local",
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        )
    ]

    delivered = "".join(event.text for event in events if event.kind == "token")
    assert "Your dog is called Bo." in delivered, delivered
    # And the preamble is still delivered exactly once, not twice: the aggregate
    # that duplicates a step's own partials is still suppressed.
    assert delivered.count("Let me check. ") == 1, delivered
