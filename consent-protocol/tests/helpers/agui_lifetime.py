"""Synthetic installed-SDK lifetime fixture shared by timing and pod tests."""

import asyncio

from ag_ui.core import RunAgentInput, UserMessage

from hushh_mcp.one_adk.agui_turn_timing import HEAD_ONE, TimedADKAgent

THREAD_ID = "thread-9f3c2a7e-secret-thread"


RUN_ID = "run-0123456789abcdef"


USER_ID = "user-7d1a-secret-owner"


MESSAGE_TEXT = "my private note about the holdings"


def _input() -> RunAgentInput:
    return RunAgentInput(
        thread_id=THREAD_ID,
        run_id=RUN_ID,
        state={"user_id": USER_ID, "hushh_pkm": "sealed"},
        messages=[UserMessage(id="m-1", role="user", content=MESSAGE_TEXT)],
        tools=[],
        context=[],
        forwarded_props={},
    )


DETACHED_ANSWER = "the answer written after the client left"


CHAT_KEY = bytes.fromhex("3c" * 32)


def _slow_answer_agent(delay: float = 0.2):
    from google.adk.agents import BaseAgent
    from google.adk.events import Event
    from google.genai import types

    class SlowAnswer(BaseAgent):
        async def _run_async_impl(self, ctx):
            yield Event(
                author=self.name,
                invocation_id=ctx.invocation_id,
                partial=True,
                content=types.Content(role="model", parts=[types.Part(text="working")]),
            )
            await asyncio.sleep(delay)
            yield Event(
                author=self.name,
                invocation_id=ctx.invocation_id,
                content=types.Content(role="model", parts=[types.Part(text=DETACHED_ANSWER)]),
            )

    return SlowAnswer(name="one")


def _bridge_agent(hook, delay: float = 0.2, *, agent_type=TimedADKAgent):
    from google.adk.sessions import InMemorySessionService

    store = InMemorySessionService()
    agent = agent_type(
        adk_agent=_slow_answer_agent(delay),
        app_name="one_detach_probe",
        user_id_extractor=lambda _input: USER_ID,
        session_service=store,
        use_in_memory_services=True,
        use_thread_id_as_session_id=True,
    )
    agent.head = HEAD_ONE
    agent.detached_turn_hook = hook
    return agent, store


async def _leave_mid_turn(stream) -> None:
    # The bridge starts the turn's task only after RUN_STARTED, so a client that
    # leaves on that first event never started a turn at all. Leave once the
    # turn is visibly running, as a person switching away mid-answer does.
    assert (await anext(stream)).type == "RUN_STARTED"
    await anext(stream)
    await stream.aclose()


def _owner_input() -> RunAgentInput:
    run = _input()
    run.state = {"hussh:user_id": USER_ID}
    run.forwarded_props = {"notifyOnDetach": True}  # the native app asks for the push
    return run


async def _stored_texts(store) -> list[str]:
    session = await store.get_session(
        app_name="one_detach_probe", user_id=USER_ID, session_id=THREAD_ID
    )
    return [
        part.text
        for event in session.events
        if event.content
        for part in (event.content.parts or [])
        if part.text
    ]
